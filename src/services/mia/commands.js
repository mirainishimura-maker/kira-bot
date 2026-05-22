// Comandos de admin de Mia. Solo se aceptan desde MIRAI_PERSONAL_PHONE.
// Mirai escribe a kiramkt (su Business) desde su personal:
//   /paciente +51987654321 Juan Pérez evaluacion
//   /paciente 51987654321 Juan Pérez       (etiqueta default: paciente_activo)
//   /pacientes                              (lista activos)
//   /quitar 51987654321                     (marca estado='alta')
//   /notas 51987654321 [texto largo]        (agrega nota privada)

import { addPatient, listActivePatients, removePatient, addNoteToPatient, normalizePhone } from './patients.js';

const COMMAND_RE = /^\/(paciente|pacientes|quitar|notas)\b/i;

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
  } catch (err) {
    return reply(`⚠️ Error: ${err.message}`);
  }
  return reply(`Comando desconocido: /${cmd}`);
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
