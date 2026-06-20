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
//   /reporte                                 (resumen de leads en la hoja + WhatsApp)

import { addPatient, listActivePatients, removePatient, addNoteToPatient, normalizePhone, findPatientByPhone, setPatientEstado } from './patients.js';
import { logMessage } from './conversations.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';
import { upsertLead } from './sheetCrm.js';
import { generateLeadReport } from './leadReport.js';

const COMMAND_RE = /^\/(paciente|pacientes|quitar|notas|atender|retomar|responder|silenciar|activar|reporte)\b/i;

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
    if (command === 'reporte')   return await cmdReporte();
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

function reply(text) {
  return { messages: [{ channel: 'private', text }] };
}
