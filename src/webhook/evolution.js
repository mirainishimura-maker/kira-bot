// Webhook handler de Evolution API.
// Recibe POST /webhook con eventos de WhatsApp.
// Solo nos interesa MESSAGES_UPSERT con mensajes entrantes (fromMe=false).

import {
  detectChannel, isAuthorizedGroup, logGroupForDiscovery,
  isAddressedToKira, getGroupJid,
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
} from '../services/mia/index.js';
import { enqueueMiaMessage } from '../services/mia/inbox.js';
import { transcribeAudio, describeImage } from '../services/mia/media.js';
import { detectLeadNote, handleLeadIntake } from '../services/mia/leadIntake.js';
import { detectOrganicLead, notifyMiraiAboutOrganicLead } from '../services/mia/organicLead.js';

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

  // ---- Comandos de Mia y notas de leads ----
  // Mirai personal: comandos + notas. Operadores (asistente): solo notas.
  if (channel === CHANNEL_PRIVATE && config.mia.enabled && text) {
    const senderPhone = phoneFromJid(remoteJid);
    const isMirai     = senderPhone === config.mia.personalPhone;
    const isOperator  = config.mia.operatorPhones.includes(senderPhone);

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
        try {
          const result = await handleMiaCommand(text);
          await dispatchMessages(result.messages, { senderJid: remoteJid });
        } catch (err) {
          console.error('[webhook] error procesando comando Mia:', err.message);
          await dispatchMessages(
            [{ channel: 'private', text: `⚠️ Error en comando: ${err.message}` }],
            { senderJid: remoteJid },
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
    const p = phoneFromJid(j);
    if (p) { phone = p; matchedJid = j; break; }
  }
  // En modo Mia-only no hay equipo de marketing: saltamos el lookup de miembros
  // (usa el Supabase corporativo) y tratamos a todos como no-miembro → el flujo
  // de abajo rutea a Mia (paciente / lead orgánico).
  const member = config.miaOnly ? null : await findMemberByPhone(phone);

  if (!member) {
    // ¿Es paciente de Mirai (módulo Mia)? Solo en privado, solo si Mia activa.
    if (channel === CHANNEL_PRIVATE && config.mia.enabled) {
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

      // No es paciente conocido. ¿Parece lead orgánico (keywords de consulta)?
      // Si sí, notificar a Mirai en su personal con comando pre-armado.
      if (text && detectOrganicLead(text)) {
        const pushName = data?.pushName ?? null;
        console.log(`[webhook] lead orgánico potencial | ${phone} (${pushName}) — notificando a Mirai`);
        try {
          await notifyMiraiAboutOrganicLead({ phone, pushName, text });
        } catch (err) {
          console.error('[webhook] error notificando lead orgánico:', err.message);
        }
        return;
      }
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
      const desc = await describeImage({ base64: media.base64, mimetype: media.mimetype, caption: c.caption });
      const prefix = c.caption ? `[imagen, caption "${c.caption}"]` : '[imagen]';
      return desc ? `${prefix}: ${desc}` : prefix;
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

function logAlerts(alerts) {
  if (!alerts?.length) return;
  console.log('[webhook] alerts (TODO notificar admins):', JSON.stringify(alerts));
}
