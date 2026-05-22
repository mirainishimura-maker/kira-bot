// Comandos de admin de Mia. Solo se aceptan desde MIRAI_PERSONAL_PHONE.
// Mirai escribe a kiramkt (su Business) desde su personal:
//   /paciente +51987654321 Juan Pérez evaluacion
//   /paciente 51987654321 Juan Pérez       (etiqueta default: paciente_activo)
//   /pacientes                              (lista activos)
//   /quitar 51987654321                     (marca estado='alta')
//   /notas 51987654321 [texto largo]        (agrega nota privada)
//   /atender 51987654321 Nombre             (agrega lead_organico + envía saludo de bienvenida)

import { addPatient, listActivePatients, removePatient, addNoteToPatient, normalizePhone } from './patients.js';
import { logMessage } from './conversations.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';
import { upsertLead } from './sheetCrm.js';

const COMMAND_RE = /^\/(paciente|pacientes|quitar|notas|atender)\b/i;

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
  return reply(`✓ ${updated.nombre} marcado como "alta". Ya no recibirá respuestas de Mia.`);
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

function reply(text) {
  return { messages: [{ channel: 'private', text }] };
}
