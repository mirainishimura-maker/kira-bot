// Comandos de admin de Mia. Solo se aceptan desde MIRAI_PERSONAL_PHONE.
// Mirai escribe a kiramkt (su Business) desde su personal:
//   /paciente +51987654321 Juan Pérez evaluacion
//   /paciente 51987654321 Juan Pérez       (etiqueta default: paciente_activo)
//   /pacientes                              (lista activos)
//   /quitar 51987654321                     (marca estado='alta')
//   /notas 51987654321 [texto largo]        (agrega nota privada)
//   /atender 51987654321 Nombre             (agrega lead_organico + envía saludo de bienvenida)
//   /silenciar 51987654321                   (Mia deja de responderle — reversible)
//   /activar 51987654321                     (Mia vuelve a responderle)
//   /notocar 51987654321                     (NO TOCAR: Mia nunca le responde, ni como lead nuevo)
//   /metricas                                (reporte del embudo: IG + leads + conversión)
//   /reporte                                 (resumen de leads en la hoja + WhatsApp)
//   /bloquear 7/7 tarde a 12/7 trabajo misionero   (Mia no ofrece esos turnos)
//   /desbloquear 7/7 a 12/7                  (quita el bloqueo de ese rango)
//   /bloqueos                                (lista los bloqueos activos)
//   (lote) varias líneas /bloquear en UN mensaje → las procesa todas y resume
//   /paquete 51999 Fran 6 Procesar la ansiedad  (arma tarjeta + preview; envía con /confirmar)
//   /agendar 51999 Fran                      (mensaje para coordinar cita; envía con /confirmar)
//   /confirmar                               (envía el último /paquete o /agendar pendiente)
//   /cancelar                                (descarta el envío pendiente)
//   /correcciones                            (lista las correcciones de ITACA pendientes)
//   /ok 7                                    (implementa la corrección #7 → issue + PR)
//   /descartar 7                             (descarta la corrección #7)
//   /grupos                                  (lista JIDs de grupos vistos → setear ITACA_GROUP_JID)

import { addPatient, listActivePatients, removePatient, addNoteToPatient, normalizePhone, findPatientByPhone, setPatientEstado } from './patients.js';
import { logMessage } from './conversations.js';
import { sendText, sendImage } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';
import { upsertLead } from './sheetCrm.js';
import { generateLeadReport } from './leadReport.js';
import { runMetricas } from './metricas.js';
import { blockRange, listBlocks, unblockRange, slotLabel } from './calendar.js';
import { generarYSubirPlan } from './planCard.js';
import { listPendientes, formatoListaPendientes, aprobarCorreccion, descartarCorreccion } from './itacaCorrecciones.js';
import { getRecentGroups } from '../channels.js';
import { config } from '../../config.js';

const COMMAND_RE = /^\/(paciente|pacientes|quitar|notas|atender|retomar|responder|silenciar|activar|notocar|metricas|reporte|bloquear|desbloquear|bloqueos|paquete|agendar|confirmar|cancelar|correcciones|correccion|ok|implementar|descartar|grupos)\b/i;

const SALUDO_ORGANICO = [
  'Hola! Te habla Mia, la asistente de la Psic. Mirai Nishimura 🌸',
  'Vi tu mensaje y te quiero acompañar con la info que necesites 🤍',
  '¿La consulta es para ti o para alguien más?',
];

export function isMiaCommand(text) {
  if (!text || typeof text !== 'string') return false;
  return COMMAND_RE.test(text.trim());
}

// Un mensaje puede traer varias líneas de comando (p. ej. un cronograma pegado
// como muchos /bloquear). Si detecto 2+ líneas que son comandos, las corro en
// lote y devuelvo un resumen; si no, sigue el flujo normal (que admite comandos
// multilínea como /notas).
export async function handleMiaCommand(text) {
  const cmdLines = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => COMMAND_RE.test(l));
  if (cmdLines.length >= 2) return await handleBatch(cmdLines);
  return await runSingleCommand(text);
}

// Procesa varias líneas de comando de un solo mensaje (p. ej. un cronograma
// pegado como muchos /bloquear). Es IDEMPOTENTE: consulta los bloqueos que ya
// existen y NO recrea los que están, así reenviar el mismo bloque no duplica.
// Los comandos que no son /bloquear se ejecutan igual y su respuesta se adjunta.
async function handleBatch(lines) {
  console.log(`[mia/batch] recibí ${lines.length} líneas de comando`);
  const created = [];   // bloqueos nuevos
  const already = [];   // ya existían (dedup)
  const fail = [];      // { line, error }
  const extra = [];     // respuestas de comandos que no son /bloquear

  // 1) Parseo local de las líneas /bloquear (rápido, sin red). El resto se corre
  //    aparte para no ignorarlo.
  const bloqueos = [];  // { line, startISO, endISO, motivo }
  for (const line of lines) {
    const m = line.match(/^\/(\w+)\s*(.*)$/s);
    const command = (m?.[1] || '').toLowerCase();
    const rest = (m?.[2] || '').trim();

    if (command === 'bloquear') {
      if (!rest) { fail.push({ line, error: 'Falta el rango (fecha/hora).' }); continue; }
      const p = parseRangoBloqueo(rest);
      if (p.error) { fail.push({ line, error: p.error }); continue; }
      bloqueos.push({ line, startISO: p.startISO, endISO: p.endISO, motivo: p.motivo || 'No disponible' });
    } else {
      try {
        const r = await runSingleCommand(line);
        if (r?.messages) extra.push(...r.messages);
      } catch (err) {
        fail.push({ line, error: err.message });
      }
    }
  }

  // 2) Traigo los bloqueos ya existentes UNA vez para no duplicar en reenvíos.
  const existentes = new Set();
  const keyOf = (a, b) => `${new Date(a).getTime()}|${new Date(b).getTime()}`;
  if (bloqueos.length) {
    const cur = await listBlocks();
    if (cur.ok) for (const b of cur.blocks) existentes.add(keyOf(b.inicio_iso, b.fin_iso));
    else console.warn(`[mia/batch] no pude listar bloqueos existentes: ${cur.error}`);
  }

  // 3) Creo solo los que faltan.
  for (const b of bloqueos) {
    const key = keyOf(b.startISO, b.endISO);
    if (existentes.has(key)) { already.push(`${slotLabel(b.startISO)} — ${b.motivo}`); continue; }
    try {
      const r = await blockRange({ startISO: b.startISO, endISO: b.endISO, motivo: b.motivo });
      if (r.ok) { created.push(`${r.inicio_label} — ${r.motivo}`); existentes.add(key); }
      else fail.push({ line: b.line, error: r.error });
    } catch (err) {
      fail.push({ line: b.line, error: err.message });
    }
  }
  console.log(`[mia/batch] listo: ${created.length} creados, ${already.length} ya existían, ${fail.length} con error`);

  // 4) Resumen (siempre responde algo).
  const parts = [`📋 Recibí ${lines.length} comando${lines.length === 1 ? '' : 's'}:`];
  if (created.length) {
    parts.push('', `✅ ${created.length} bloqueado${created.length === 1 ? '' : 's'} nuevo${created.length === 1 ? '' : 's'}:`);
    parts.push(...created.map((l) => `  • ${l}`));
  }
  if (already.length) {
    parts.push('', `↺ ${already.length} ya estaba${already.length === 1 ? '' : 'n'} (no dupliqué):`);
    parts.push(...already.map((l) => `  • ${l}`));
  }
  if (fail.length) {
    parts.push('', `⚠️ ${fail.length} con error:`);
    parts.push(...fail.map((f) => `  • ${f.line}\n     → ${f.error}`));
  }
  if (!created.length && !already.length && !fail.length) parts.push('', 'No encontré nada para procesar.');
  return { messages: [{ channel: 'private', text: parts.join('\n') }, ...extra] };
}

async function runSingleCommand(text) {
  const trimmed = (text ?? '').trim();
  const match = trimmed.match(/^\/(\w+)\s*(.*)$/s);
  if (!match) return reply('No reconozco el comando. Usa /paciente, /pacientes, /quitar o /notas.');

  const [, cmd, rest] = match;
  const command = cmd.toLowerCase();

  try {
    if (command === 'paciente')  return await cmdAddPatient(rest);
    if (command === 'pacientes') return await cmdListPatients();
    if (command === 'quitar')    return await cmdRemovePatient(rest);
    if (command === 'notas')     return await cmdAddNote(rest);
    if (command === 'atender')   return await cmdAtenderLead(rest);
    if (command === 'retomar')   return await cmdRetomarLead(rest);
    if (command === 'responder') return await cmdResponderEnNombreDeLead(rest);
    if (command === 'silenciar') return await cmdSilenciar(rest);
    if (command === 'activar')   return await cmdActivar(rest);
    if (command === 'notocar')   return await cmdNoTocar(rest);
    if (command === 'metricas')  return await cmdMetricas();
    if (command === 'reporte')   return await cmdReporte();
    if (command === 'bloquear')    return await cmdBloquear(rest);
    if (command === 'desbloquear') return await cmdDesbloquear(rest);
    if (command === 'bloqueos')    return await cmdBloqueos();
    if (command === 'paquete')     return await cmdPaquete(rest);
    if (command === 'agendar')     return await cmdAgendar(rest);
    if (command === 'confirmar')   return await cmdConfirmar();
    if (command === 'cancelar')    return cmdCancelar();
    if (command === 'correcciones' || command === 'correccion') return await cmdCorrecciones();
    if (command === 'ok' || command === 'implementar')          return await cmdImplementar(rest);
    if (command === 'descartar')                                return await cmdDescartar(rest);
    if (command === 'grupos')                                   return cmdGrupos();
  } catch (err) {
    return reply(`⚠️ Error: ${err.message}`);
  }
  return reply(`Comando desconocido: /${cmd}`);
}

async function cmdAtenderLead(rest) {
  // Formato: /atender <phone> <nombre>
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return reply('Uso: /atender <telefono> <nombre>\nEjemplo: /atender 51931107589 Milagros Vania');
  }
  const phone = tokens[0];
  const nombre = tokens.slice(1).join(' ');

  const result = await addPatient({ phone, nombre, etiqueta: 'lead_organico' });
  const patient = result.patient;
  if (result.duplicated) {
    return reply(`ℹ️ ${patient.nombre} (${patient.phone}) ya estaba en la lista. No le mando saludo de nuevo — Mia ya está atendiéndolo cuando escriba.`);
  }

  // Sheets CRM
  try {
    await upsertLead({
      phone: patient.phone,
      nombre: patient.nombre,
      estado: 'nuevo',
      etiqueta: 'lead_organico',
      nota_interna: 'Lead orgánico — escribió directo a kiramkt y Mirai lo activó manualmente.',
    });
  } catch (err) {
    console.warn('[mia/commands] no pude actualizar CRM:', err.message);
  }

  // Saludo de bienvenida al lead
  const recipientJid = `${patient.phone}@s.whatsapp.net`;
  let enviadas = 0;
  for (const burbuja of SALUDO_ORGANICO) {
    try {
      const sent = await sendText(recipientJid, burbuja);
      const sentId = sent?.key?.id ?? null;
      if (sentId) rememberMiaSentId(sentId);
      await logMessage({
        patientId: patient.id,
        author: 'mia',
        content: burbuja,
        whatsappMessageId: sentId,
        metadata: { kind: 'atender_lead_saludo' },
      });
      enviadas++;
    } catch (err) {
      console.error('[mia/commands] error enviando saludo orgánico:', err.message);
    }
  }

  return reply(
    `✓ Atendiendo a ${patient.nombre} (${patient.phone}) como lead orgánico.\n` +
    `Saludo enviado: ${enviadas}/${SALUDO_ORGANICO.length} burbujas.\n` +
    `Cuando responda, Mia toma el flujo de triage.`
  );
}

async function cmdReporte() {
  const { text, sheetOk } = await generateLeadReport();
  if (!sheetOk) {
    return reply(
      text +
      '\n\n⚠️ Ojo: no pude actualizar la hoja (revisa que el Apps Script de la hoja esté desplegado). ' +
      'El resumen de arriba sí está al día.'
    );
  }
  return reply(text);
}

async function cmdAddPatient(rest) {
  // Formato: <phone> <nombre completo> [etiqueta_opcional_al_final_sin_espacios]
  // La etiqueta opcional es la última "palabra" si no tiene espacios.
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return reply('Uso: /paciente <telefono> <nombre completo> [etiqueta]\nEjemplo: /paciente 51987654321 Juan Pérez evaluacion');
  }
  const phone = tokens[0];
  let nombre, etiqueta;
  // Si el último token NO tiene espacios y NO tiene mayúsculas iniciales típicas de apellido,
  // lo tratamos como etiqueta. Más simple: si hay 3+ tokens y el último es lowercase y sin tilde, es etiqueta.
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 3 && /^[a-z_]+$/.test(last)) {
    etiqueta = last;
    nombre = tokens.slice(1, -1).join(' ');
  } else {
    nombre = tokens.slice(1).join(' ');
    etiqueta = 'paciente_activo';
  }

  const result = await addPatient({ phone, nombre, etiqueta });
  if (result.duplicated) {
    return reply(`Ya existía: ${result.patient.nombre} (${result.patient.phone}). Etiqueta actual: ${result.patient.etiqueta ?? '—'}.`);
  }
  return reply(`✓ Agregado: ${result.patient.nombre} (${result.patient.phone}) como "${result.patient.etiqueta}".`);
}

async function cmdListPatients() {
  const rows = await listActivePatients();
  if (!rows.length) return reply('No tienes pacientes activos en la lista.');
  const lines = rows.map(p =>
    `• ${p.nombre} — ${p.phone} — ${p.etiqueta ?? 'sin etiqueta'} (${p.estado})`
  );
  return reply(`Pacientes activos (${rows.length}):\n${lines.join('\n')}`);
}

async function cmdRemovePatient(rest) {
  const phone = rest.trim().split(/\s+/)[0];
  if (!phone) return reply('Uso: /quitar <telefono>');
  const normalized = normalizePhone(phone);
  const updated = await removePatient(normalized);
  if (!updated) return reply(`No encontré paciente con ese número (${normalized}).`);
  return reply(`✓ ${updated.nombre} marcado como "alta". Mia ya no le responde (silencio total). Si fue por error, reactívala con /activar ${normalized}.`);
}

async function cmdSilenciar(rest) {
  const phone = rest.trim().split(/\s+/)[0];
  if (!phone) return reply('Uso: /silenciar <telefono>\nEjemplo: /silenciar 51987654321');
  const updated = await setPatientEstado(phone, 'silenciada');
  if (!updated) return reply(`No encontré paciente con ese número (${normalizePhone(phone)}).`);
  return reply(
    `🔇 Mia silenciada para ${updated.nombre} (${updated.phone}).\n` +
    `Ya no le responde aunque escriba. Tú puedes seguir atendiéndolo manual.\n` +
    `Para reactivarla: /activar ${updated.phone}`
  );
}

async function cmdActivar(rest) {
  const phone = rest.trim().split(/\s+/)[0];
  if (!phone) return reply('Uso: /activar <telefono>\nEjemplo: /activar 51987654321');
  const updated = await setPatientEstado(phone, 'datos_parciales');
  if (!updated) return reply(`No encontré paciente con ese número (${normalizePhone(phone)}).`);
  return reply(`🔊 Mia reactivada para ${updated.nombre} (${updated.phone}). Vuelve a responderle cuando escriba.`);
}

// Lista de NO TOCAR: bloquea un número para que Mia NUNCA lo enganche — ni como
// paciente, ni como lead nuevo (aunque escriba con palabras clave). Sirve para
// tus contactos personales/de trabajo. Reversible con /activar.
async function cmdNoTocar(rest) {
  const phone = normalizePhone(rest.trim().split(/\s+/)[0]);
  if (!phone) return reply('Uso: /notocar <telefono>\nEjemplo: /notocar 51999138246');
  const existing = await findPatientByPhone(phone);
  if (existing) {
    await setPatientEstado(phone, 'silenciada');
    return reply(`🚫 ${existing.nombre} (${phone}) en NO TOCAR. Mia no le responde más. Reversible: /activar ${phone}`);
  }
  await addPatient({ phone, nombre: 'No tocar', etiqueta: 'no_tocar' });
  await setPatientEstado(phone, 'silenciada');
  return reply(`🚫 ${phone} agregado a NO TOCAR. Mia nunca le responderá, ni aunque escriba con palabras clave. Reversible: /activar ${phone}`);
}

// /metricas — reporte del embudo: Instagram (alcance) + WhatsApp (leads/guías) +
// conversión a cita. Lo calcula y lo responde en el mismo chat.
async function cmdMetricas() {
  const r = await runMetricas({ dry: true });
  return reply(r.texto || `⚠️ No pude calcular las métricas: ${r.error || 'error'}`);
}

async function cmdAddNote(rest) {
  const trimmed = rest.trim();
  const sp = trimmed.indexOf(' ');
  if (sp < 0) return reply('Uso: /notas <telefono> <texto de la nota>');
  const phone = trimmed.slice(0, sp);
  const nota  = trimmed.slice(sp + 1).trim();
  if (!nota) return reply('La nota está vacía.');
  const updated = await addNoteToPatient(phone, nota);
  if (!updated) return reply(`No encontré paciente con ese número (${normalizePhone(phone)}).`);
  return reply(`✓ Nota agregada a ${updated.nombre}.`);
}

async function cmdRetomarLead(rest) {
  // /retomar <phone> <nombre>
  // Para cuando ya saludaste manualmente al lead desde kiramkt antes de
  // agregarlo. Mia lo agrega, finge que ya saludó (inserta marker en
  // conversations) y cuando el lead responda continúa el flujo SIN
  // reintroducirse con "Hola! Soy Mia 🌸".
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return reply('Uso: /retomar <telefono> <nombre>\nEjemplo: /retomar 51931107589 Milagros Vania\n\nÚsalo cuando ya saludaste al lead manualmente y solo quieres que Mia continúe sin saludar de nuevo.');
  }
  const phone = tokens[0];
  const nombre = tokens.slice(1).join(' ');

  const result = await addPatient({ phone, nombre, etiqueta: 'lead_organico' });
  const patient = result.patient;
  if (result.duplicated) {
    return reply(`ℹ️ ${patient.nombre} (${patient.phone}) ya estaba en la lista.`);
  }

  // Insertar 3 burbujas históricas como mensajes de Mia, para que cuando
  // el lead responda Mia entre en Escenario B (conversación en curso).
  const saludoHistorico = [
    'Hola! Te habla Mia, la asistente de la Psic. Mirai Nishimura 🌸',
    'Recibí tu contacto para información de sesión psicológica 🤍',
    '¿La consulta es para ti o para alguien más?',
  ];
  for (const burbuja of saludoHistorico) {
    try {
      await logMessage({
        patientId: patient.id,
        author: 'mia',
        content: burbuja,
        metadata: { kind: 'retomar_marker', note: 'saludo previo enviado manualmente fuera de Mia' },
      });
    } catch (err) {
      console.warn('[mia/commands] no pude insertar marker:', err.message);
    }
  }

  // Sheets CRM
  try {
    await upsertLead({
      phone: patient.phone,
      nombre: patient.nombre,
      estado: 'datos_parciales',
      etiqueta: 'lead_organico',
      nota_interna: 'Retomado: saludo ya enviado manualmente por Mirai antes del intake.',
    });
  } catch (err) {
    console.warn('[mia/commands] no pude actualizar CRM:', err.message);
  }

  return reply(
    `✓ Retomado: ${patient.nombre} (${patient.phone}) como lead orgánico.\n` +
    `Mia NO le envía saludo de nuevo (porque ya lo saludaste tú).\n` +
    `Cuando responda, continúa el flujo de triage directo.`
  );
}

async function cmdResponderEnNombreDeLead(rest) {
  // /responder <phone> <texto que el lead ya escribió>
  // Útil cuando el lead ya respondió fuera de Mia (ej: respondió a un saludo
  // manual que Mirai le hizo antes del intake). Mia procesa el texto como
  // si el lead lo hubiera enviado en este momento.
  const trimmed = rest.trim();
  const sp = trimmed.indexOf(' ');
  if (sp < 0) {
    return reply('Uso: /responder <telefono> <texto>\nEjemplo: /responder 51931107589 Para mí\n\nMia procesa el texto como si el lead lo acabara de enviar.');
  }
  const phone = normalizePhone(trimmed.slice(0, sp));
  const texto = trimmed.slice(sp + 1).trim();
  if (!phone) return reply('Teléfono inválido.');
  if (!texto) return reply('Texto vacío — copia lo que el lead te escribió.');

  const patient = await findPatientByPhone(phone);
  if (!patient) {
    return reply(`No encontré paciente con phone ${phone}. Agrégalo primero con /atender, /retomar o /paciente.`);
  }

  // Dynamic import para evitar circular dep con index.js.
  const { handleMiaMessage } = await import('./index.js');
  try {
    await handleMiaMessage({
      patient,
      text: texto,
      messageId: null,
      senderJid: `${phone}@s.whatsapp.net`,
    });
    return reply(`✓ Mia procesó "${texto.slice(0, 80)}" como si fuera de ${patient.nombre}.\nSu respuesta ya va a ${phone}.`);
  } catch (err) {
    return reply(`⚠️ Error procesando: ${err.message}`);
  }
}

// ─── Bloqueos de agenda (viajes, días libres) ────────────────────────
// Mia crea un evento CON HORA en el calendario de Mirai para que deje de
// ofrecer esos turnos. Parser tolerante: acepta d/m, d-m, d/m/aaaa, aaaa-mm-dd;
// hora HH:mm o palabra (mañana=8, mediodía=12, tarde=13, noche=18); conectores
// "a"/"al"/"hasta"; ignora relleno "del/desde/de/el…". Sin hora: día completo.
const FILLER_WORDS  = new Set(['del', 'desde', 'de', 'el', 'la', 'los', 'las', 'dia', 'día', 'en', 'y', 'este', 'esta']);
const CONNECT_WORDS = new Set(['a', 'al', 'hasta', '-', '—']);
const TIME_WORDS = { 'manana': '08:00', 'mañana': '08:00', 'mediodia': '12:00', 'mediodía': '12:00', 'tarde': '13:00', 'noche': '18:00' };
const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const DOW = { 'domingo': 0, 'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3, 'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6 };
const pad2 = (n) => String(n).padStart(2, '0');

// Fecha Y/M/D de Lima a `offsetDays` de hoy (hoy=0, mañana=1, …).
function limaYMD(offsetDays) {
  const base = new Date(Date.now() + (offsetDays || 0) * 86400000);
  const s = base.toLocaleDateString('en-CA', { timeZone: 'America/Lima' }); // "YYYY-MM-DD"
  const [y, mo, d] = s.split('-').map(Number);
  return { y, mo, d, hadYear: true };
}
function dowOfYMD(f) { return new Date(`${f.y}-${pad2(f.mo)}-${pad2(f.d)}T12:00:00-05:00`).getUTCDay(); }
function nextWeekday(target) {                       // próxima ocurrencia (hoy cuenta)
  const hoy = limaYMD(0);
  return limaYMD((target - dowOfYMD(hoy) + 7) % 7);
}

// Parsea un token numérico de fecha: d/m, d-m, d/m/aaaa, aaaa-mm-dd.
function parseFechaTok(tok) {
  if (!tok) return null;
  let m = tok.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);             // aaaa-mm-dd
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], hadYear: true };
  m = tok.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/); // d/m[/aaaa]
  if (m) {
    let y = m[3] ? +m[3] : 0;
    if (y && y < 100) y += 2000;
    return { y, mo: +m[2], d: +m[1], hadYear: Boolean(m[3]) };
  }
  return null;
}

// Consume una fecha desde toks[i]: "hoy"/"mañana", día de semana (próximo),
// token numérico (7/7), o "7 [de] julio [de aaaa]". Devuelve { f, i } o null.
function consumeFecha(toks, i) {
  while (i < toks.length && FILLER_WORDS.has(toks[i].toLowerCase())) i++;
  if (i >= toks.length) return null;
  const w = toks[i].toLowerCase();

  // Relativos: hoy / mañana / pasado [mañana].
  let rel = null;
  if (w === 'hoy') rel = 0;
  else if (w === 'mañana' || w === 'manana') rel = 1;
  else if (w === 'pasado') rel = 2;
  if (rel !== null) {
    let k = i + 1;
    if (rel === 2 && k < toks.length && (toks[k].toLowerCase() === 'mañana' || toks[k].toLowerCase() === 'manana')) k++;
    if (k < toks.length && DOW.hasOwnProperty(toks[k].toLowerCase())) k++; // "mañana miércoles" → ignora confirmación
    return { f: limaYMD(rel), i: k };
  }

  if (DOW.hasOwnProperty(w)) return { f: nextWeekday(DOW[w]), i: i + 1 };

  const single = parseFechaTok(toks[i]);
  if (single) return { f: single, i: i + 1 };

  if (/^\d{1,2}$/.test(toks[i])) {                 // "7 de julio" / "7 julio"
    const d = +toks[i];
    let j = i + 1;
    while (j < toks.length && FILLER_WORDS.has(toks[j].toLowerCase())) j++;
    const mo = MESES[(toks[j] || '').toLowerCase()];
    if (mo) {
      let y = 0, k = j + 1, k2 = k;
      while (k2 < toks.length && FILLER_WORDS.has(toks[k2].toLowerCase())) k2++;
      if (k2 < toks.length && /^\d{4}$/.test(toks[k2])) { y = +toks[k2]; k = k2 + 1; }
      return { f: { y, mo, d, hadYear: Boolean(y) }, i: k };
    }
  }
  return null;
}

// Consume una hora opcional desde toks[i] (saltando relleno y "a las"): HH:mm,
// 5pm, "5 pm", o palabra (mañana/mediodía/tarde/noche). Devuelve metadata para
// poder propagar el meridiano del fin al inicio ("de 5 a 6pm" → 5pm).
function consumeHora(toks, i) {
  let j = i, skippedConnector = false;
  while (j < toks.length) {
    const w = toks[j].toLowerCase();
    if (FILLER_WORDS.has(w)) { j++; continue; }
    if (w === 'a' || w === 'al') { skippedConnector = true; j++; continue; }
    break;
  }
  const tok = (toks[j] || '').toLowerCase();
  if (TIME_WORDS[tok]) return { hora: TIME_WORDS[tok], i: j + 1, isNumeric: false, hadMer: true, mer: null };
  const m = tok.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (m) {
    const h = +m[1], min = m[2] || '00';
    let mer = m[3], nextI = j + 1;
    if (!mer) { const nx = (toks[j + 1] || '').toLowerCase().replace(/\./g, ''); if (nx === 'am' || nx === 'pm') { mer = nx; nextI = j + 2; } }
    const bare = !m[2] && !mer;
    if (bare && skippedConnector) return { hora: null, i }; // no comerse un día tras "a/al"
    let hh = h;
    if (mer === 'pm' && hh < 12) hh += 12;
    if (mer === 'am' && hh === 12) hh = 0;
    if (hh <= 23 && +min <= 59) return { hora: `${pad2(hh)}:${min}`, i: nextI, isNumeric: true, hadMer: Boolean(mer), mer: mer || null, rawHour: h, min };
  }
  return { hora: null, i };
}

// "de 5 a 6pm" → si el inicio va pelado (sin am/pm) y el fin trae meridiano, se
// lo aplica al inicio (5pm, no 5am). Devuelve la hora de inicio ya resuelta.
function aplicarMeridianoFin(iniHora, h1, h2) {
  if (!h1 || !h1.isNumeric || h1.hadMer || h1.rawHour > 12) return iniHora;
  if (!h2 || !h2.isNumeric || !h2.mer) return iniHora;
  let h = h1.rawHour;
  if (h2.mer === 'pm' && h < 12) h += 12;
  if (h2.mer === 'am' && h === 12) h = 0;
  return `${pad2(h)}:${h1.min}`;
}

function isoLima(f, hhmm) {
  return `${f.y}-${pad2(f.mo)}-${pad2(f.d)}T${hhmm}:00-05:00`;
}

// Convierte el texto del comando en { startISO, endISO, motivo } o { error }.
// Soporta rango multi-día ("7/7 a 12/7"), mismo día con horas ("mañana de 5pm a
// 6pm") y una sola hora ("hoy a las 5pm" → de esa hora al fin del día).
function parseRangoBloqueo(rest) {
  const toks = (rest || '').trim().split(/\s+/).filter(Boolean);

  const a = consumeFecha(toks, 0);
  if (!a) return { error: 'No entiendo el inicio. Usa "hoy", "mañana", d/m (8/7) o "7 de julio".' };
  const ini = a.f;
  const h1 = consumeHora(toks, a.i);
  let i = h1.i;
  let iniHora = h1.hora || '00:00';

  while (i < toks.length && (FILLER_WORDS.has(toks[i].toLowerCase()) || CONNECT_WORDS.has(toks[i].toLowerCase()))) i++;

  let fin, finHora, sameDay = false, h2 = null;
  const b = consumeFecha(toks, i);
  if (b) {
    fin = b.f;
    h2 = consumeHora(toks, b.i);
    finHora = h2.hora || '23:59';
    i = h2.i;
  } else {
    h2 = consumeHora(toks, i);
    if (h2.hora) { sameDay = true; finHora = h2.hora; i = h2.i; }       // "de 5pm a 6pm"
    else if (h1.hora) { sameDay = true; finHora = '23:59'; }            // "a las 5pm" → fin del día
    else return { error: 'No entiendo el fin. Di "de 5pm a 6pm" o una fecha (ej: 12/7).' };
  }

  iniHora = aplicarMeridianoFin(iniHora, h1, h2);

  // Año: si no se escribió, usa el actual; si el inicio ya pasó, salta al próximo.
  const now = new Date();
  const year = now.getFullYear();
  if (!ini.y) ini.y = year;
  if (sameDay) fin = { y: ini.y, mo: ini.mo, d: ini.d, hadYear: ini.hadYear };
  else if (!fin.y) fin.y = year;

  let startISO = isoLima(ini, iniHora);
  let endISO   = isoLima(fin, finHora);
  if (!ini.hadYear && new Date(startISO).getTime() < now.getTime()) {
    ini.y++; if (sameDay) fin.y = ini.y; else fin.y++;
    startISO = isoLima(ini, iniHora);
    endISO   = isoLima(fin, finHora);
  }
  if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
    return { error: 'El fin debe ser posterior al inicio. Revisa las horas/fechas.' };
  }
  return { startISO, endISO, motivo: toks.slice(i).join(' ').trim() };
}

const USO_BLOQUEAR =
  'Uso: /bloquear <cuándo> [motivo]\n' +
  'Ejemplos:\n' +
  '• /bloquear mañana de 5pm a 6pm dentista\n' +
  '• /bloquear hoy a las 5pm  (de esa hora al fin del día)\n' +
  '• /bloquear viernes de 3 a 4pm\n' +
  '• /bloquear 7/7 tarde a 12/7 trabajo misionero  (varios días)\n' +
  'Entiende hoy/mañana, días de semana, "7 de julio", y horas tipo 5pm o 17:00.';

// Núcleo compartido por el comando individual y el modo lote: valida el rango,
// crea el bloqueo y devuelve estado en vez de texto.
async function tryBloquear(rest) {
  const p = parseRangoBloqueo(rest);
  if (p.error) return { ok: false, error: p.error, usage: true };
  const motivo = p.motivo || 'No disponible';
  const r = await blockRange({ startISO: p.startISO, endISO: p.endISO, motivo });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    inicio_label: r.inicio_label,
    fin_label: r.fin_label,
    motivo: r.motivo,
    label: `${r.inicio_label} → ${r.fin_label}${r.motivo ? ` — ${r.motivo}` : ''}`,
  };
}

async function cmdBloquear(rest) {
  if (!rest.trim()) return reply(USO_BLOQUEAR);
  const st = await tryBloquear(rest);
  if (!st.ok) {
    return st.usage
      ? reply(`${st.error}\n\n${USO_BLOQUEAR}`)
      : reply(`⚠️ No pude bloquear: ${st.error}`);
  }
  return reply(
    `🚫 Bloqueado: ${st.inicio_label}\n           → ${st.fin_label}\n` +
    `Motivo: ${st.motivo}\n\n` +
    `Mia no ofrecerá esos turnos. Para quitarlo: /desbloquear ${rest.trim()}`
  );
}

async function cmdDesbloquear(rest) {
  if (!rest.trim()) return reply('Uso: /desbloquear <inicio> a <fin>\nEj: /desbloquear 7/7 a 12/7\n(Mira los activos con /bloqueos.)');
  const p = parseRangoBloqueo(rest);
  if (p.error) return reply(p.error);
  const r = await unblockRange({ startISO: p.startISO, endISO: p.endISO });
  if (!r.ok) return reply(`⚠️ No pude desbloquear: ${r.error}`);
  if (!r.deleted) return reply('No había bloqueos en ese rango. (Mira los activos con /bloqueos.)');
  return reply(`✓ Quité ${r.deleted} bloqueo${r.deleted === 1 ? '' : 's'} de ese rango. Mia vuelve a ofrecer esos turnos.`);
}

async function cmdBloqueos() {
  const r = await listBlocks();
  if (!r.ok) return reply(`⚠️ No pude leer los bloqueos: ${r.error}`);
  if (!r.blocks.length) return reply('No tienes bloqueos activos. La agenda está abierta según tu plantilla.');
  const lines = r.blocks.map(b => `🚫 ${b.inicio_label} → ${b.fin_label}${b.motivo ? ` — ${b.motivo}` : ''}`);
  return reply(`Bloqueos activos (${r.blocks.length}):\n${lines.join('\n')}`);
}

// ─── Coordinación de pacientes: /paquete y /agendar (con confirmación) ──
// Mirai arma el envío; Mia lo PREVISUALIZA y NO envía nada hasta /confirmar.
// Un solo pendiente a la vez (solo Mirai usa esto). En memoria: si el server
// reinicia entre el preview y el confirmar, se pierde (basta repetir el comando).
let pendingEnvio = null;

const miraiJid = () => `${config.mia.personalPhone}@s.whatsapp.net`;

const USO_PAQUETE =
  'Uso: /paquete <telefono> <nombre> <4|6> <objetivo>\n' +
  'Ej: /paquete 51987654321 Fran 6 Procesar y manejar la ansiedad\n' +
  'Mia arma la tarjeta y te la muestra; NO se envía hasta que respondas /confirmar.';
const USO_AGENDAR =
  'Uso: /agendar <telefono> <nombre>\n' +
  'Ej: /agendar 51987654321 Fran\n' +
  'Mia te muestra el mensaje; NO se envía hasta que respondas /confirmar.';

// Envía la secuencia de mensajes al paciente, registrando + marcando ecos.
async function enviarAPaciente(phone, nombre, mensajes) {
  const norm = normalizePhone(phone);
  const jid = `${norm}@s.whatsapp.net`;
  const patient = await findPatientByPhone(norm);
  for (const m of mensajes) {
    let sent;
    if (m.kind === 'image') sent = await sendImage(jid, m.url, m.caption || '');
    else sent = await sendText(jid, m.text);
    const id = sent?.key?.id ?? null;
    if (id) rememberMiaSentId(id);
    if (patient) {
      await logMessage({
        patientId: patient.id,
        author: 'mia',
        content: m.kind === 'image' ? '[plan enviado por WhatsApp]' : m.text,
        messageType: m.kind === 'image' ? 'image' : 'text',
        whatsappMessageId: id,
        metadata: { kind: m.metaKind || 'coordinacion_manual' },
      });
    }
  }
  return { patient };
}

async function cmdPaquete(rest) {
  const toks = (rest || '').trim().split(/\s+/).filter(Boolean);
  if (toks.length < 4) return reply(USO_PAQUETE);
  const phone = toks[0];
  let nIdx = -1;
  for (let i = 2; i < toks.length; i++) { if (/^\d{1,2}$/.test(toks[i])) { nIdx = i; break; } }
  if (nIdx < 0) return reply('Falta el número de sesiones (4 o 6).\n\n' + USO_PAQUETE);
  const nombre = toks.slice(1, nIdx).join(' ');
  const n = parseInt(toks[nIdx], 10);
  const objetivo = toks.slice(nIdx + 1).join(' ');
  if (!nombre || !objetivo) return reply(USO_PAQUETE);

  // Generar la tarjeta personalizada.
  const card = await generarYSubirPlan({ phone, nombre, nSesiones: n, objetivo });
  if (!card.ok) return reply(`⚠️ No pude generar la tarjeta: ${card.error}`);

  const intro =
    `Hola ${nombre} 🌸 Te escribe Mia, de parte de la Lic. Mirai.\n\n` +
    `Pensamos en ti 🤍 ¿Cómo te has sentido desde tu primera sesión?\n\n` +
    `Si quieres retomar tu proceso, la Lic. preparó un paquete de ${n} sesiones a tarifa preferente ` +
    `(S/105 c/u en vez de S/120) y se puede pagar hasta en 4 cuotas. Te dejo el detalle 👇`;
  const cierre = `¿Coordinamos tu siguiente sesión? 🌿`;

  pendingEnvio = {
    tipo: 'paquete', phone, nombre,
    mensajes: [
      { kind: 'text', text: intro, metaKind: 'paquete_intro' },
      { kind: 'image', url: card.url, metaKind: 'paquete_plan' },
      { kind: 'text', text: cierre, metaKind: 'paquete_cierre' },
    ],
  };

  // Vista previa de la tarjeta a Mirai.
  try {
    const sent = await sendImage(miraiJid(), card.url, `Vista previa — así le llegará la tarjeta a ${nombre}`);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  } catch (e) { console.warn('[mia/commands] no pude enviar preview a Mirai:', e.message); }

  return reply(
    `📋 *Vista previa — PAQUETE para ${nombre}* (${normalizePhone(phone)})\n\n` +
    `Se enviarán, en orden:\n1) el mensaje de saludo\n2) la tarjeta del plan (arriba ⬆️)\n3) "${cierre}"\n\n` +
    `⚠️ AÚN NO se envió nada. Para enviarlo a ${nombre}: */confirmar*\nPara descartar: */cancelar*`
  );
}

async function cmdAgendar(rest) {
  const toks = (rest || '').trim().split(/\s+/).filter(Boolean);
  if (toks.length < 2) return reply(USO_AGENDAR);
  const phone = toks[0];
  const nombre = toks.slice(1).join(' ');

  const texto =
    `Hola ${nombre} 🌸 Te escribe Mia, asistente de la Lic. Mirai.\n\n` +
    `¿Coordinamos tu próxima sesión? Cuéntame qué días y horas te quedan mejor y te paso la disponibilidad 🌿`;

  pendingEnvio = {
    tipo: 'agendar', phone, nombre,
    mensajes: [{ kind: 'text', text: texto, metaKind: 'agendar_opener' }],
  };

  return reply(
    `📋 *Vista previa — AGENDAR con ${nombre}* (${normalizePhone(phone)})\n\n` +
    `Mensaje que se enviará:\n— — —\n${texto}\n— — —\n\n` +
    `⚠️ AÚN NO se envió. Para enviarlo: */confirmar*\nPara descartar: */cancelar*`
  );
}

async function cmdConfirmar() {
  if (!pendingEnvio) return reply('No hay ningún envío pendiente. Usa /paquete o /agendar primero.');
  const p = pendingEnvio;
  pendingEnvio = null;
  try {
    const { patient } = await enviarAPaciente(p.phone, p.nombre, p.mensajes);
    const aviso = patient ? '' :
      `\n\n⚠️ Ojo: ${normalizePhone(p.phone)} no está en tu lista de pacientes, así que cuando responda Mia no le seguirá el flujo automático. ` +
      `Si quieres que lo atienda, agrégalo con /atender ${normalizePhone(p.phone)} ${p.nombre}.`;
    return reply(`✅ Enviado a ${p.nombre} (${normalizePhone(p.phone)}).${aviso}`);
  } catch (e) {
    return reply(`⚠️ Error enviando a ${p.nombre}: ${e.message}\nNo se reintentó; vuelve a correr el comando si quieres.`);
  }
}

function cmdCancelar() {
  if (!pendingEnvio) return reply('No había nada pendiente.');
  const n = pendingEnvio.nombre;
  pendingEnvio = null;
  return reply(`Cancelado. No se envió nada a ${n}.`);
}

// ---- ITACA · correcciones desde el grupo "conversemos las tres" ----
async function cmdCorrecciones() {
  const tickets = await listPendientes();
  return reply(formatoListaPendientes(tickets));
}

async function cmdImplementar(rest) {
  const id = parseInt(String(rest).trim(), 10);
  if (!Number.isInteger(id)) return reply('Uso: /ok N  (ej. /ok 7). Mira los números con /correcciones.');
  return reply(await aprobarCorreccion(id));
}

async function cmdDescartar(rest) {
  const id = parseInt(String(rest).trim(), 10);
  if (!Number.isInteger(id)) return reply('Uso: /descartar N  (ej. /descartar 7).');
  return reply(await descartarCorreccion(id));
}

function cmdGrupos() {
  const grupos = getRecentGroups();
  if (!grupos.length) {
    return reply('Todavía no vi mensajes de ningún grupo. Manda un mensaje en el grupo "conversemos las tres" y vuelve a probar /grupos.');
  }
  const lineas = grupos.map(g => `• ${g.jid}\n   últ: ${g.sender}${g.preview ? ` — "${g.preview}"` : ''} (${g.count} msj)`);
  return reply(`*Grupos que Mia vio hace poco:*\n\n${lineas.join('\n')}\n\nCopia el JID del grupo "conversemos las tres" a la env var *ITACA_GROUP_JID* en EasyPanel y redespliega.`);
}

function reply(text) {
  return { messages: [{ channel: 'private', text }] };
}
