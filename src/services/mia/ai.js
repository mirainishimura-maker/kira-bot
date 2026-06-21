// Núcleo de Mia: llama a OpenAI (cuenta de Mirai) con el prompt de Mia +
// historial conversacional. Fase 3: tools de calendario conectadas al Apps
// Script de Mirai (consulta disponibilidad real, hold tentativo, confirmar).
//
// Devuelve el formato de respuesta que el webhook ya sabe enviar:
//   { messages: [{ channel, text }], escalar_mirai: bool, crisis: bool, razon: string }

import { miraiOpenai, MIA_MODEL } from '../../lib/miraiOpenai.js';
import { MIA_SYSTEM_PROMPT, MIA_PROMPT_PLACEHOLDER } from './prompt.js';
import { recentMessages } from './conversations.js';
import { checkAvailability, createHold, confirmAppointment, getUpcoming, rescheduleAppointment, cancelAppointment } from './calendar.js';

const MAX_TOOL_ROUNDS = 4; // check → hold → (precio) → confirm caben en 4 rondas

// Tools de calendario (Fase 3). El `phone` NUNCA lo pone el modelo: lo inyecta
// executeTool desde el paciente real, para que Mia no pueda agendar a otro número.
const MIA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'check_calendar_availability',
      description: 'Consulta los turnos REALMENTE libres en la agenda de Mirai para los próximos días. Úsalo SIEMPRE antes de ofrecer horarios — nunca inventes disponibilidad. Devuelve solo slots libres con su etiqueta lista para mostrar.',
      parameters: {
        type: 'object',
        properties: {
          dias_adelante: { type: 'integer', description: 'Cuántos días hacia adelante mirar (default 14, máx 30).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_appointment_hold',
      description: 'Aparta TENTATIVAMENTE (hold) un turno concreto para el paciente. El turno solo queda asegurado cuando el paciente paga. Llámalo cuando el paciente eligió uno de los horarios libres que ofreciste. Reemplaza cualquier hold previo del paciente.',
      parameters: {
        type: 'object',
        properties: {
          inicio_iso: { type: 'string', description: 'Inicio del turno en ISO 8601 con offset de Lima, ej "2026-06-22T16:00:00-05:00". DEBE ser uno de los slots devueltos por check_calendar_availability.' },
          nombre: { type: 'string', description: 'Nombre del paciente (para el evento). Opcional.' },
          motivo: { type: 'string', description: 'Motivo breve de consulta. Opcional.' },
        },
        required: ['inicio_iso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_appointment',
      description: 'Confirma la cita tentativa (hold) del paciente. Llámalo SOLO cuando el paciente ya envió el comprobante de pago (captura de Yape/Plin). Convierte el hold en cita confirmada.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_upcoming_appointment',
      description: 'Consulta la próxima cita del paciente (confirmada o tentativa). Úsalo cuando el paciente pregunta cuándo es su cita o para recordar/reprogramar.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_appointment',
      description: 'Reprograma (mueve) la cita actual del paciente a un nuevo horario. Conserva su estado (si estaba confirmada/pagada sigue confirmada; no se vuelve a pagar). Primero consulta disponibilidad y deja que el paciente elija; el nuevo horario DEBE ser uno de los slots libres.',
      parameters: {
        type: 'object',
        properties: {
          nuevo_inicio_iso: { type: 'string', description: 'Nuevo inicio en ISO 8601 con offset de Lima, ej "2026-06-25T15:00:00-05:00". Debe ser un slot libre de check_calendar_availability.' },
        },
        required: ['nuevo_inicio_iso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancela la cita activa del paciente (hold o confirmada). Úsalo cuando el paciente quiere cancelar. Si la cita estaba pagada, además escala a la Psicóloga Mirai para que vea el tema del reembolso.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// Ejecuta una tool. El `phone` se inyecta desde el paciente real (no del modelo).
async function executeTool(name, args, { patient }) {
  const phone = patient.phone;
  switch (name) {
    case 'check_calendar_availability':
      return await checkAvailability({ daysAhead: args.dias_adelante });
    case 'create_appointment_hold':
      return await createHold({
        phone,
        startISO: args.inicio_iso,
        nombre:   args.nombre || patient.nombre,
        motivo:   args.motivo,
      });
    case 'confirm_appointment':
      return await confirmAppointment({ phone });
    case 'get_upcoming_appointment':
      return await getUpcoming({ phone });
    case 'reschedule_appointment':
      return await rescheduleAppointment({ phone, newStartISO: args.nuevo_inicio_iso });
    case 'cancel_appointment':
      return await cancelAppointment({ phone });
    default:
      return { ok: false, error: `Tool desconocida: ${name}` };
  }
}

export async function askMia({ patient, message }) {
  // Si el prompt no se ha rellenado todavía, no llamamos a OpenAI.
  if (MIA_PROMPT_PLACEHOLDER) {
    console.warn('[mia/ai] PROMPT_PENDIENTE — no llamo a OpenAI, escalo a Mirai.');
    return fallbackEscalate('Prompt de Mia aún no configurado en src/prompts/mia.txt');
  }
  if (!miraiOpenai) {
    return fallbackEscalate('Mia deshabilitada: faltan credenciales MIRAI_*');
  }

  const history = await recentMessages(patient.id, 20);
  const userBlock = buildUserBlock({ patient, message, history });

  const messages = [
    { role: 'system', content: MIA_SYSTEM_PROMPT },
    { role: 'user',   content: userBlock },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let completion;
    try {
      completion = await miraiOpenai.chat.completions.create({
        model: MIA_MODEL,
        messages,
        tools: MIA_TOOLS.length ? MIA_TOOLS : undefined,
        tool_choice: MIA_TOOLS.length ? 'auto' : undefined,
        temperature: 0.4,
        response_format: { type: 'json_object' },
      });
    } catch (err) {
      console.error('[mia/ai] OpenAI error:', err.message);
      return fallbackEscalate(`OpenAI error: ${err.message}`);
    }

    const msg = completion.choices?.[0]?.message;
    if (!msg) break;

    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); }
        catch { args = {}; }
        const result = await executeTool(call.function.name, args, { patient });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
        console.log(`[mia/ai] tool ${call.function.name}(${JSON.stringify(args)}) → ${result.ok ? 'ok' : 'err'}`);
      }
      continue;
    }

    return parseMiaResponse(msg.content);
  }

  console.warn(`[mia/ai] MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS} sin respuesta final`);
  return fallbackEscalate('Loop de tools agotado sin respuesta final');
}

function buildUserBlock({ patient, message, history }) {
  const lines = [];
  const today = new Date();
  const dd   = String(today.getDate()).padStart(2, '0');
  const mm   = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  const dia  = today.toLocaleDateString('es-PE', { weekday: 'long', timeZone: 'America/Lima' });

  lines.push(`# Contexto`);
  lines.push(`Hoy es: ${dia} ${dd}/${mm}/${yyyy} (TZ America/Lima)`);
  lines.push(`Paciente: ${patient.nombre} (tel ${patient.phone})`);
  if (patient.etiqueta)          lines.push(`Etiqueta interna: ${patient.etiqueta}`);
  if (patient.estado)            lines.push(`Estado: ${patient.estado}`);
  if (patient.modalidad_preferida) lines.push(`Modalidad preferida: ${patient.modalidad_preferida}`);
  lines.push('');

  if (history?.length) {
    lines.push('# Historial reciente (cronológico)');
    for (const m of history) {
      const stamp = m.created_at?.slice(11, 16) ?? '';
      const date  = m.created_at?.slice(0, 10) ?? '';
      const who   = m.author === 'patient' ? 'Paciente' : m.author === 'mirai' ? 'Mirai' : 'Mia';
      const tag   = m.message_type === 'text' ? '' : ` [${m.message_type}]`;
      lines.push(`[${date} ${stamp}] ${who}${tag}: ${m.content}`);
    }
    lines.push('');
  } else {
    lines.push('# Primera conversación con este paciente (no hay historial previo en este sistema).');
    lines.push('');
  }

  lines.push('# Mensaje recibido ahora');
  lines.push(`> ${message}`);
  lines.push('');
  lines.push('Responde SIEMPRE con un JSON válido siguiendo el formato del system prompt:');
  lines.push('{ "respuesta": "...", "escalar_mirai": false, "crisis": false, "razon_escalamiento": "" }');
  return lines.join('\n');
}

function parseMiaResponse(content) {
  const raw = content ?? '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[mia/ai] respuesta no-JSON, envolviendo:', raw.slice(0, 200));
    parsed = { respuesta: String(raw), imagenes: [], escalar_mirai: false, crisis: false, razon_escalamiento: '' };
  }

  const respuesta = String(parsed.respuesta ?? '').trim();
  const imagenes  = Array.isArray(parsed.imagenes) ? parsed.imagenes.filter(Boolean) : [];
  const escalar   = Boolean(parsed.escalar_mirai);
  const crisis    = Boolean(parsed.crisis);
  const razon     = String(parsed.razon_escalamiento ?? '');
  const datos     = parsed.datos_lead && typeof parsed.datos_lead === 'object' ? parsed.datos_lead : null;

  const burbujas = respuesta
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(text => ({ channel: 'private', text }));

  return {
    messages: burbujas.length ? burbujas : [{ channel: 'private', text: 'Estoy procesando, dame un momento 🌸' }],
    imagenes,
    escalar_mirai: escalar,
    crisis,
    razon,
    datos_lead: datos,
  };
}

function fallbackEscalate(razon) {
  return {
    messages: [{ channel: 'private', text: 'Estoy en mantenimiento un momento, Mirai ya te escribe 🌸' }],
    imagenes: [],
    escalar_mirai: true,
    crisis: false,
    razon,
    datos_lead: null,
  };
}
