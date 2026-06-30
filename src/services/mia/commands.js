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

import { addPatient, listActivePatients, removePatient, addNoteToPatient, normalizePhone, findPatientByPhone, setPatientEstado } from './patients.js';
import { logMessage } from './conversations.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';
import { upsertLead } from './sheetCrm.js';
import { generateLeadReport } from './leadReport.js';
import { runMetricas } from './metricas.js';
import { blockRange, listBlocks, unblockRange } from './calendar.js';

const COMMAND_RE = /^\/(paciente|pacientes|quitar|notas|atender|retomar|responder|silenciar|activar|notocar|metricas|reporte|bloquear|desbloquear|bloqueos)\b/i;

const SALUDO_ORGANICO = [
  'Hola! Te habla Mia, la asistente de la Psic. Mirai Nishimura 🌸',
  'Vi tu mensaje y te quiero acompañar con la info que necesites 🤍',
  '¿La consulta es para ti o para alguien más?',
];

export function isMiaCommand(text) {
  if (!text || typeof text !== 'string') return false;
  return COMMAND_RE.test(text.trim());
}

export async function handleMiaCommand(text) {
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
const FILLER_WORDS  = new Set(['del', 'desde', 'de', 'el', 'la', 'los', 'las', 'dia', 'día', 'en', 'y']);
const CONNECT_WORDS = new Set(['a', 'al', 'hasta', '-', '—']);
const TIME_WORDS = { 'manana': '08:00', 'mañana': '08:00', 'mediodia': '12:00', 'mediodía': '12:00', 'tarde': '13:00', 'noche': '18:00' };
const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

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

// Consume una fecha desde toks[i] — sea un token numérico (7/7) o "7 [de] julio
// [de aaaa]". Devuelve { f, i } con el índice siguiente, o null.
function consumeFecha(toks, i) {
  while (i < toks.length && FILLER_WORDS.has(toks[i].toLowerCase())) i++;
  if (i >= toks.length) return null;

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

// Consume una hora opcional desde toks[i] (saltando relleno): HH:mm, 5pm, o
// palabra (mañana/mediodía/tarde/noche). Devuelve { hora, i } (i sin cambios si no hay).
function consumeHora(toks, i) {
  let j = i;
  while (j < toks.length && FILLER_WORDS.has(toks[j].toLowerCase())) j++;
  const tok = (toks[j] || '').toLowerCase();
  if (TIME_WORDS[tok]) return { hora: TIME_WORDS[tok], i: j + 1 };
  const m = tok.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (m) {
    let h = +m[1];
    const min = m[2] || '00';
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h <= 23 && +min <= 59) return { hora: `${String(h).padStart(2, '0')}:${min}`, i: j + 1 };
  }
  return { hora: null, i };
}

function isoLima(f, hhmm) {
  const p = (n) => String(n).padStart(2, '0');
  return `${f.y}-${p(f.mo)}-${p(f.d)}T${hhmm}:00-05:00`;
}

// Convierte el texto del comando en { startISO, endISO, motivo } o { error }.
function parseRangoBloqueo(rest) {
  const toks = (rest || '').trim().split(/\s+/).filter(Boolean);

  const a = consumeFecha(toks, 0);
  if (!a) return { error: 'No entiendo la fecha de inicio. Usa d/m (7/7) o "7 de julio".' };
  const ini = a.f;
  let h1 = consumeHora(toks, a.i);
  let i = h1.i;
  const iniHora = h1.hora || '00:00';

  while (i < toks.length && (FILLER_WORDS.has(toks[i].toLowerCase()) || CONNECT_WORDS.has(toks[i].toLowerCase()))) i++;

  const b = consumeFecha(toks, i);
  if (!b) return { error: 'No entiendo la fecha de fin. Usa d/m (12/7) o "12 de julio".' };
  const fin = b.f;
  let h2 = consumeHora(toks, b.i);
  i = h2.i;
  const finHora = h2.hora || '23:59';

  const motivo = toks.slice(i).join(' ').trim();

  // Año: si no se escribió, usa el actual; si el inicio ya pasó, salta al próximo.
  const now = new Date();
  const year = now.getFullYear();
  if (!ini.y) ini.y = year;
  if (!fin.y) fin.y = year;
  let startISO = isoLima(ini, iniHora);
  let endISO   = isoLima(fin, finHora);
  if (!ini.hadYear && new Date(startISO).getTime() < now.getTime()) {
    ini.y++; fin.y++;
    startISO = isoLima(ini, iniHora);
    endISO   = isoLima(fin, finHora);
  }
  if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
    return { error: 'El fin debe ser posterior al inicio. Revisa las fechas.' };
  }
  return { startISO, endISO, motivo };
}

const USO_BLOQUEAR =
  'Uso: /bloquear <inicio> a <fin> [motivo]\n' +
  'Ej: /bloquear 7/7 tarde a 12/7 trabajo misionero\n' +
  'Sin hora = día completo. Palabras de hora: mañana=8am, mediodía=12, tarde=1pm, noche=6pm.';

async function cmdBloquear(rest) {
  if (!rest.trim()) return reply(USO_BLOQUEAR);
  const p = parseRangoBloqueo(rest);
  if (p.error) return reply(`${p.error}\n\n${USO_BLOQUEAR}`);

  const motivo = p.motivo || 'No disponible';
  const r = await blockRange({ startISO: p.startISO, endISO: p.endISO, motivo });
  if (!r.ok) return reply(`⚠️ No pude bloquear: ${r.error}`);
  return reply(
    `🚫 Bloqueado: ${r.inicio_label}\n           → ${r.fin_label}\n` +
    `Motivo: ${r.motivo}\n\n` +
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

function reply(text) {
  return { messages: [{ channel: 'private', text }] };
}
