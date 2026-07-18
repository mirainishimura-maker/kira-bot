// Webhook handler de Evolution API.
// Recibe POST /webhook con eventos de WhatsApp.
// Solo nos interesa MESSAGES_UPSERT con mensajes entrantes (fromMe=false).

import {
  detectChannel, isAuthorizedGroup, logGroupForDiscovery,
  isAddressedToKira, getGroupJid,
  isItacaGroup, recordGroupSighting,
  CHANNEL_GROUP, CHANNEL_PRIVATE,
} from '../services/channels.js';
import { findMemberByPhone, phoneFromJid } from '../services/members.js';
import { recentMemory, saveMemory, activeTasks } from '../services/memory.js';
import { ask } from '../services/ai.js';
import { executeActions } from '../services/actions.js';
import { sendText, fetchMessageMediaBase64 } from '../lib/evolution.js';
import { getMemberSpaceSlugs } from '../services/spaces.js';
import { config } from '../config.js';
import {
  findPatientByPhone, normalizePhone, isMiaCommand, handleMiaCommand,
  handleMiaMessage, handleMiraiManualOutbound, isMiaSentId,
  handleItacaGroupMessage,
} from '../services/mia/index.js';
import { enqueueMiaMessage } from '../services/mia/inbox.js';
import { transcribeAudio, analizarImagenParaMia } from '../services/mia/media.js';
import { detectLeadNote, handleLeadIntake, handleReferralNote } from '../services/mia/leadIntake.js';
import { detectOrganicLead, notifyMiraiAboutOrganicLead } from '../services/mia/organicLead.js';
import { createLeadAuto, setPatientEstado } from '../services/mia/patients.js';
import { stickerFingerprint, getStickerAction, consumeCapture } from '../services/mia/stickerControl.js';
import { nombreValido } from '../services/mia/text.js';
import { detectarHorarioYAvisar } from '../services/mia/horarioDetector.js';
import { handleNeuraInstruction, handleNeuraImage } from '../services/mia/neuraAssistant.js';
import { sendVoiceReply } from '../services/mia/voice.js';

export async function handleWebhook(req, res) {
  const payload = req.body;
  // Evolution envía formatos distintos según versión. Normalizamos.
  const event = payload?.event ?? payload?.type;
  const data  = payload?.data  ?? payload;

  // Respondemos rápido a Evolution; procesamos en background.
  res.status(202).json({ received: true });

  try {
    if (event && event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
      return; // ignoramos otros eventos por ahora
    }
    await processMessage(data);
  } catch (err) {
    console.error('[webhook] error procesando', err);
  }
}

// WhatsApp está migrando identidades a @lid (IDs opacos). phoneFromJid() no puede
// sacar el número de un @lid, así que los comandos de Mirai dejaban de reconocerse
// (llegaban como @lid en vez de su número). resolvePhone() mapea el/los @lid
// conocidos de Mirai a su número real; para cualquier otro jid = phoneFromJid.
function resolvePhone(jid) {
  const ph = phoneFromJid(jid);
  if (ph) return ph;
  const lid = String(jid || '').match(/^(\d+)@lid$/)?.[1];
  if (lid && config.mia.personalLids.includes(lid)) return config.mia.personalPhone;
  return null;
}

async function processMessage(data) {
  const remoteJid = data?.key?.remoteJid;
  const fromMe    = data?.key?.fromMe === true;
  const messageId = data?.key?.id ?? null;
  if (!remoteJid) return;

  // ---- Caso especial: mensaje fromMe=true ----
  // Si Mia está habilitada y el destino es un paciente etiquetado, hay que
  // distinguir si es eco de un mensaje nuestro (Mia) o si Mirai escribió
  // manualmente desde su Business al paciente.
  if (fromMe) {
    if (!config.mia.enabled) return; // KIRA puro: ignoramos como antes.
    if (isMiaSentId(messageId)) return; // eco de Mia, ignorar.
    const channel = detectChannel(remoteJid);
    if (channel !== CHANNEL_PRIVATE) return; // solo nos importan privados.
    const targetPhone = phoneFromJid(remoteJid);

    // ---- Control por STICKERS ----
    // Mirai manda su sticker de "parar"/"retomar" a un paciente. Se procesa
    // ANTES del lookup de paciente porque la CAPTURA (/sticker parar|retomar)
    // debe funcionar aunque el sticker se mande a un chat que no es paciente
    // (p. ej. Mirai se lo manda a sí misma para registrarlo).
    const sticker = data?.message?.stickerMessage;
    if (sticker) {
      const fp = stickerFingerprint(sticker);

      // 1) Modo captura: /sticker parar|retomar armó la captura.
      const cap = consumeCapture(fp);
      if (cap) {
        const etiqueta = cap.kind === 'stop' ? 'PARAR 🔇' : 'RETOMAR 🔊';
        const efecto = cap.kind === 'stop'
          ? 'Mia dejará de responderle'
          : 'Mia volverá a responderle';
        let msg = `✅ Guardé tu sticker de ${etiqueta}. Cuando se lo mandes a un paciente desde este WhatsApp, ${efecto}.`;
        if (cap.sameAsOther) {
          msg += '\n\n⚠️ Ojo: es el MISMO sticker que asignaste al otro. Usa dos distintos o Mia no podrá diferenciarlos.';
        }
        await notifyMiraiPersonal(msg);
        return;
      }

      // 2) Acción sobre el paciente del chat (solo si la huella coincide).
      const action = getStickerAction(fp);
      if (!action) return; // sticker cualquiera → no hace nada
      const patient = await findPatientByPhone(targetPhone);
      if (!patient) return; // Mia no le hablaba igual (no es paciente)
      try {
        if (action === 'stop') {
          await setPatientEstado(patient.phone, 'silenciada');
          await notifyMiraiPersonal(`🔇 Mia en silencio con ${patient.nombre} (${patient.phone}). Mándale tu sticker de retomar cuando quieras que vuelva.`);
        } else {
          await setPatientEstado(patient.phone, 'datos_parciales');
          await notifyMiraiPersonal(`🔊 Mia reactivada con ${patient.nombre} (${patient.phone}). Le vuelve a responder cuando escriba.`);
        }
      } catch (err) {
        console.error('[webhook] error aplicando sticker de control:', err.message);
      }
      return;
    }

    // ---- Texto manual de Mirai (flujo existente) ----
    const patient = await findPatientByPhone(targetPhone);
    if (!patient) return;
    const text = extractText(data);
    if (!text) return;
    try {
      await handleMiraiManualOutbound({ patient, text, messageId });
    } catch (err) {
      console.error('[webhook] error registrando outbound manual de Mirai:', err.message);
    }
    return;
  }

  const channel = detectChannel(remoteJid);
  if (!channel) {
    console.log('[webhook] canal desconocido:', remoteJid);
    return;
  }

  // ---- Grupo de correcciones de ITACA ("conversemos las tres") ----
  // Mia LEE este grupo en silencio (nunca postea ahí): digiere cada mensaje,
  // lo clasifica y le avisa a Mirai en privado. Tiene prioridad sobre todo el
  // resto del ruteo de grupos.
  if (channel === CHANNEL_GROUP && isItacaGroup(remoteJid)) {
    if (config.mia.enabled && config.mia.itaca?.enabled) {
      handleItacaGroupMessage(data).catch(e => console.error('[itaca] error procesando grupo:', e.message));
    }
    return; // NUNCA respondemos en este grupo
  }

  // Registramos cualquier OTRO grupo para el comando /grupos (descubrir su JID).
  if (channel === CHANNEL_GROUP) {
    recordGroupSighting(remoteJid, data?.pushName, extractText(data));
  }

  // Modo Mia-only: KIRA-mkt no corre. Mia no atiende grupos, así que cualquier
  // mensaje de grupo se ignora aquí mismo (el resto del flujo es solo Mia).
  if (config.miaOnly && channel === CHANNEL_GROUP) return;

  // text puede ser null si llegó audio/imagen sin caption — para Mia eso se
  // procesa más abajo via multimodalToText. Para mkt, sin texto, ignoramos.
  const text = extractText(data);

  // En grupo: solo el grupo del equipo de marketing, y solo si nos hablan.
  if (channel === CHANNEL_GROUP) {
    if (!text) return; // mkt no procesa media en grupo
    if (!isAuthorizedGroup(remoteJid)) {
      logGroupForDiscovery(remoteJid, data?.pushName);
      return;
    }
    if (!isAddressedToKira(text)) return;
  }

  // ---- NEURA · asistente personal de Mirai (voz/texto natural) ----
  // Detrás del flag config.mia.assistant.enabled. SOLO el número personal de
  // Mirai. Intercepta únicamente instrucciones reconocidas (gasto, recordatorio,
  // agenda); si no reconoce, cae al flujo de siempre (que hoy la ignora en
  // silencio). Nunca toca comandos "/..." ni notas de lead. Maneja también
  // AUDIO (que el bloque de abajo no procesa, porque exige `text`).
  if (channel === CHANNEL_PRIVATE && config.mia.enabled && config.mia.assistant?.enabled) {
    const miraiPhone = resolvePhone(remoteJid);
    if (miraiPhone === config.mia.personalPhone) {
      const clase = classifyMessage(data);
      // IMAGEN de Mirai: Yape → registra el pago; escrito a mano → transcribe y guarda.
      // (Aunque venga con caption; el caption se usa como pista para la visión.)
      if (clase.kind === 'image') {
        const media = await fetchMessageMediaBase64(data);
        if (media?.base64) {
          try {
            const resImg = await handleNeuraImage({ base64: media.base64, mimetype: media.mimetype, caption: clase.caption });
            if (resImg?.handled) {
              console.log('[neura] imagen de Mirai atendida');
              await dispatchMessages([{ channel: 'private', text: resImg.reply }], { senderJid: remoteJid });
              return;
            }
          } catch (err) { console.error('[neura] error en imagen:', err.message); }
        }
      }
      let instruction = text;
      if (!instruction && clase.kind === 'audio') {
        const media = await fetchMessageMediaBase64(data);
        if (media?.base64) {
          instruction = await transcribeAudio({ base64: media.base64, mimetype: media.mimetype });
        }
      }
      if (instruction && !isMiaCommand(instruction) && !detectLeadNote(instruction)) {
        try {
          const res = await handleNeuraInstruction(instruction);
          if (res?.handled) {
            console.log(`[neura] instrucción de Mirai atendida: "${instruction.slice(0, 80)}"`);
            await dispatchMessages([{ channel: 'private', text: res.reply }], { senderJid: remoteJid });
            if (res.speak && config.mia.assistant?.voiceReplies) {
              sendVoiceReply(res.reply).catch((e) => console.error('[neura/voice]', e.message));
            }
            return;
          }
        } catch (err) {
          console.error('[neura] error en asistente:', err.message);
        }
      }
    }
  }

  // ---- Comandos de Mia y notas de leads ----
  // Mirai personal: comandos + notas. Operadores (asistente): solo notas.
  if (channel === CHANNEL_PRIVATE && config.mia.enabled && text) {
    const senderPhone = resolvePhone(remoteJid);
    const isMirai     = senderPhone === config.mia.personalPhone;
    const isOperator  = config.mia.operatorPhones.includes(senderPhone);
    const isReferrer  = config.mia.referrerPhones.includes(senderPhone);

    // Clínica REFERIDORA (ej: Mont Sinai 51941697769): cualquier mensaje con un
    // número adentro → Mia registra al/los lead(s) y les manda el saludo. No
    // requiere palabra clave (el referidor solo manda interesados).
    if (isReferrer) {
      try {
        const result = await handleReferralNote(text, 'Mont Sinai');
        if (result?.messages) await dispatchMessages(result.messages, { senderJid: remoteJid });
        else console.log(`[webhook] referidor ${senderPhone}: mensaje sin número, ignoro.`);
      } catch (err) {
        console.error('[webhook] error en handleReferralNote:', err.message);
      }
      return;
    }

    if (isMirai || isOperator) {
      // 1) Comando explícito (solo Mirai puede ejecutarlo)
      if (isMiaCommand(text)) {
        if (!isMirai) {
          await dispatchMessages(
            [{ channel: 'private', text: 'Los comandos administrativos solo los puede ejecutar Mirai 🌸 Si quieres ingresar un lead, mándame la nota con el número y nombre como siempre.' }],
            { senderJid: remoteJid },
          );
          return;
        }
        console.log(`[webhook] comando Mia desde Mirai: ${text.slice(0, 80)}`);
        // Responder al NÚMERO real de Mirai, no al remoteJid: cuando su mensaje
        // llega como @lid, ese jid no siempre es enrutable al enviar. Su número
        // sí lo es (es el que usa notifyMiraiPersonal y por donde recibe todo).
        const miraiJid = `${config.mia.personalPhone}@s.whatsapp.net`;
        try {
          const result = await handleMiaCommand(text, { senderJid: miraiJid });
          await dispatchMessages(result.messages, { senderJid: miraiJid });
        } catch (err) {
          console.error('[webhook] error procesando comando Mia:', err.message);
          await dispatchMessages(
            [{ channel: 'private', text: `⚠️ Error en comando: ${err.message}` }],
            { senderJid: miraiJid },
          );
        }
        return;
      }
      // 2) Nota de lead (Mirai u operador autorizado)
      if (detectLeadNote(text)) {
        const sourceLabel = isMirai ? 'Mirai' : `operador ${senderPhone}`;
        console.log(`[webhook] nota de lead detectada desde ${sourceLabel}: ${text.slice(0, 100)}`);
        try {
          const result = await handleLeadIntake(text);
          if (result?.messages) await dispatchMessages(result.messages, { senderJid: remoteJid });
        } catch (err) {
          console.error('[webhook] error en handleLeadIntake:', err.message);
          await dispatchMessages(
            [{ channel: 'private', text: `⚠️ Error en intake: ${err.message}` }],
            { senderJid: remoteJid },
          );
        }
        return;
      }
      // 3) Operador escribió algo que no es comando ni nota de lead
      // (ej: "la paciente ya llegó", "voy a llegar tarde", "quieres café?").
      // Silencio total — Mirai ve el mensaje en kiramkt y responde manual.
      if (isOperator) {
        console.log(`[webhook] operador ${senderPhone} envió mensaje no-lead — silencio.`);
        return;
      }
    }
  }

  // Identificamos al miembro por el número.
  // Privado: senderJid = remoteJid.
  // Grupo: senderJid = key.participant (a veces @lid anónimo).
  // Probamos varios campos por si Evolution lo expone en distintos lugares.
  const candidateJids = channel === CHANNEL_GROUP
    ? [
        data?.key?.participant,
        data?.key?.participantPn,
        data?.participantPn,
        data?.key?.participantAlt,
      ].filter(Boolean)
    : [remoteJid];

  let phone = null;
  let matchedJid = null;
  for (const j of candidateJids) {
    const p = resolvePhone(j);
    if (p) { phone = p; matchedJid = j; break; }
  }
  // En modo Mia-only no hay equipo de marketing: saltamos el lookup de miembros
  // (usa el Supabase corporativo) y tratamos a todos como no-miembro → el flujo
  // de abajo rutea a Mia (paciente / lead orgánico).
  const member = config.miaOnly ? null : await findMemberByPhone(phone);

  if (!member) {
    // ¿Es paciente de Mirai (módulo Mia)? Solo en privado, solo si Mia activa.
    if (channel === CHANNEL_PRIVATE && config.mia.enabled) {
      // Salvavidas anti-olvido: si el contacto propuso una hora, avisar a Mirai
      // (aunque Mia esté en silencio para él y ella lo atienda manual). No bloquea.
      detectarHorarioYAvisar({ phone, nombre: data?.pushName, text }).catch(() => {});

      const patient = await findPatientByPhone(phone);
      if (patient) {
        // Gate: si el paciente fue silenciado (/silenciar) o dado de alta
        // (/quitar), Mia NO responde — silencio total. Mirai lo atiende manual.
        if (patient.estado === 'silenciada' || patient.estado === 'alta') {
          console.log(`[webhook] → Mia | ${patient.nombre} estado="${patient.estado}", Mia no responde (silencio).`);
          return;
        }
        // Para Mia, convertir audio/imagen a texto antes de encolar.
        const richText = await multimodalToText(data);
        if (!richText) {
          console.warn(`[webhook] → Mia | media sin procesar para ${patient.nombre}, ignorando`);
          return;
        }
        console.log(`[webhook] → Mia (buffer) | ${patient.nombre} (${phone}): ${richText.slice(0, 100)}`);
        enqueueMiaMessage({
          patient,
          text: richText,
          messageId,
          senderJid: remoteJid,
          debounceMs: config.mia.debounceMs,
          debounceMaxMs: config.mia.debounceMaxMs,
          onFlush: handleMiaMessage,
        });
        return;
      }

      // No es paciente conocido → AUTO-INTAKE (embudo NEURA): registramos el
      // número nuevo como lead orgánico y dejamos que Mia lo atienda sola
      // (saludo + guía si la pide + triage). Antes solo se notificaba a Mirai.
      // Guard: nunca auto-intakear a Mirai ni a operadores (si escribieron algo
      // que no es comando/nota, su mensaje lo ve Mirai en kiramkt — silencio).
      if (!phone || phone === config.mia.personalPhone || config.mia.operatorPhones.includes(phone) || config.mia.referrerPhones.includes(phone)) {
        console.log(`[webhook] ${phone || '(@lid sin número)'} = Mirai/operador/referidor o no identificable — silencio.`);
        return;
      }
      const leadText = await multimodalToText(data);
      // SOLO auto-intake si el mensaje muestra INTENCIÓN de lead (consulta, guía,
      // ansiedad, cita, precio...). Así Mia NO responde a contactos viejos que
      // escriben cosas casuales ("hola", "feliz cumple", etc.) — solo a leads reales.
      if (!leadText || !detectOrganicLead(leadText)) {
        console.log(`[webhook] ${phone}: sin intención de lead — Mia no responde (silencio).`);
        return;
      }
      const pushName = data?.pushName ?? null;
      const lead = await createLeadAuto({ phone, nombre: nombreValido(pushName) ? pushName : null });
      if (!lead) {
        console.warn(`[webhook] no pude crear el lead ${phone} — ignorando`);
        return;
      }
      console.log(`[webhook] AUTO-INTAKE | nuevo lead "${pushName ?? ''}" (${phone}) → Mia`);
      // Visibilidad: aviso en tiempo real a Mirai de que entró un lead nuevo (dedup 1h interno).
      notifyMiraiAboutOrganicLead({ phone, pushName, text: leadText }).catch(() => {});
      enqueueMiaMessage({
        patient: lead,
        text: leadText,
        messageId,
        senderJid: remoteJid,
        debounceMs: config.mia.debounceMs,
        debounceMaxMs: config.mia.debounceMaxMs,
        onFlush: handleMiaMessage,
      });
      return;
    }
    console.log(`[webhook] no identificado | channel=${channel} | tried=${JSON.stringify(candidateJids)} | parsed=${phone} | pushName=${data?.pushName ?? '?'}`);
    return;
  }
  if (matchedJid && matchedJid !== candidateJids[0]) {
    console.log(`[webhook] usado JID alterno (${matchedJid}) en lugar del primero`);
  }

  // Owners de espacios unidireccionales (Mattias/Piura, Diana/Lima): reciben
  // crons pero KIRA no entabla conversación. Si responden, se ignora en silencio.
  if (member.role === 'owner') {
    console.log(`[webhook] ignorando mensaje de owner ${member.name} (${phone}) — espacio unidireccional`);
    return;
  }

  // KIRA-mkt no procesa multimedia. Si llega audio/imagen sin texto, ignoramos.
  if (!text) {
    console.log(`[webhook] mkt | ${member.name} envió media sin texto, ignorado (mkt no procesa multimedia).`);
    return;
  }

  console.log(`[webhook] ${channel} | ${member.name}: ${text.slice(0, 80)}`);

  const [tasks, memory, memberSpaces] = await Promise.all([
    activeTasks(member.id),
    recentMemory(member.id, 5),
    getMemberSpaceSlugs(member.id),
  ]);

  // Ruteo de espacio: en privado, si el miembro pertenece a mirai_ops, usamos
  // ese contexto (prompt + tools personales). En grupo o si no pertenece a
  // mirai_ops, default a mkt.
  const spaceSlug = (channel === CHANNEL_PRIVATE && memberSpaces.includes('mirai_ops'))
    ? 'mirai_ops'
    : 'mkt';
  console.log(`[webhook] espacio activo: ${spaceSlug} (miembro en: ${memberSpaces.join(',') || 'ninguno'})`);

  const result = await ask({
    member,
    channel,
    message: text,
    context: { activeTasks: tasks, recentMemory: memory, spaceSlug },
  });

  const senderJid = channel === CHANNEL_GROUP ? matchedJid : remoteJid;
  await dispatchMessages(result.messages, { senderJid });
  await executeActions(result.actions, { sender: member, channel });
  logAlerts(result.alerts);

  await saveMemory({
    memberId: member.id,
    channel,
    summary: `${member.name} (${channel}): ${text.slice(0, 200)}`,
    actionItems: result.actions?.length ? result.actions : null,
  });
}

function extractText(data) {
  const m = data?.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    null
  );
}

// Detecta el tipo de mensaje entrante (text, audio, image, sticker, otro).
// Para audio/imagen devuelve el caption si el paciente puso texto junto.
function classifyMessage(data) {
  const m = data?.message;
  if (!m) return { kind: 'unknown' };
  if (m.audioMessage)       return { kind: 'audio',   caption: '' };
  if (m.imageMessage)       return { kind: 'image',   caption: m.imageMessage.caption ?? '' };
  if (m.stickerMessage)     return { kind: 'sticker', caption: '' };
  if (m.videoMessage)       return { kind: 'video',   caption: m.videoMessage.caption ?? '' };
  if (m.documentMessage)    return { kind: 'document', caption: m.documentMessage.caption ?? '' };
  const text = m.conversation ?? m.extendedTextMessage?.text ?? null;
  if (text) return { kind: 'text', text };
  return { kind: 'unknown' };
}

// Convierte un mensaje multimedia a texto que Mia puede procesar.
// - audio:    transcribe con Whisper → "[audio]: <transcripción>"
// - image:    visión con gpt-4o-mini → "[imagen]: <descripción>" (+ caption si hay)
// - sticker:  texto genérico para que Mia entienda
// Devuelve null si el media no pudo procesarse.
async function multimodalToText(data) {
  const c = classifyMessage(data);
  if (c.kind === 'text')    return c.text;
  if (c.kind === 'sticker') return '[El paciente envió un sticker.]';

  if (c.kind === 'audio' || c.kind === 'image') {
    const media = await fetchMessageMediaBase64(data);
    if (!media?.base64) {
      console.warn(`[webhook] no pude bajar media (${c.kind})`);
      return c.kind === 'image' && c.caption ? c.caption : null;
    }
    if (c.kind === 'audio') {
      const txt = await transcribeAudio({ base64: media.base64, mimetype: media.mimetype });
      return txt ? `[audio]: ${txt}` : null;
    }
    if (c.kind === 'image') {
      // Analiza la imagen: si es comprobante de pago, verifica monto+destinatario
      // y devuelve un veredicto claro para que Mia confirme (o no) la cita.
      return await analizarImagenParaMia({ base64: media.base64, mimetype: media.mimetype, caption: c.caption });
    }
  }

  if (c.kind === 'video') {
    return c.caption ? `[video con caption]: ${c.caption}` : '[El paciente envió un video.]';
  }
  if (c.kind === 'document') {
    return c.caption ? `[documento adjunto con caption]: ${c.caption}` : '[El paciente envió un documento adjunto.]';
  }
  return null;
}

async function dispatchMessages(messages, { senderJid }) {
  for (const msg of messages ?? []) {
    if (!msg?.text) continue;
    let jid;
    if (msg.channel === 'group') {
      jid = getGroupJid();
      if (!jid) {
        console.warn('[webhook] mensaje a grupo descartado: GROUP_JID aún no capturado');
        continue;
      }
    } else if (msg.recipient && msg.recipient !== 'group') {
      // recipient es teléfono E.164 sin +
      jid = `${msg.recipient}@s.whatsapp.net`;
    } else {
      // private al sender por defecto
      jid = senderJid;
    }
    try {
      await sendText(jid, msg.text);
    } catch (err) {
      console.error('[webhook] fallo enviando a', jid, err.message);
    }
  }
}

// Confirmación privada a Mirai (a su número personal, NO al chat del paciente,
// para que el paciente nunca vea estos avisos). Best-effort: si falla, se loguea.
async function notifyMiraiPersonal(text) {
  const p = config.mia.personalPhone;
  if (!p) return;
  try {
    await sendText(`${p}@s.whatsapp.net`, text);
  } catch (err) {
    console.error('[webhook] no pude avisar a Mirai (personal):', err.message);
  }
}

function logAlerts(alerts) {
  if (!alerts?.length) return;
  console.log('[webhook] alerts (TODO notificar admins):', JSON.stringify(alerts));
}
