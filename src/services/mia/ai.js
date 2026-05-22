// Núcleo de Mia: llama a OpenAI (cuenta de Mirai) con el prompt de Mia +
// historial conversacional. En v1 sin tools de calendario (esas llegan en Fase 3);
// solo info admin desde el prompt.
//
// Devuelve el formato de respuesta que el webhook ya sabe enviar:
//   { messages: [{ channel, text }], escalar_mirai: bool, crisis: bool, razon: string }

import { miraiOpenai, MIA_MODEL } from '../../lib/miraiOpenai.js';
import { MIA_SYSTEM_PROMPT, MIA_PROMPT_PLACEHOLDER } from './prompt.js';
import { recentMessages } from './conversations.js';

const MAX_TOOL_ROUNDS = 3; // sin tools en v1, pero el loop queda preparado

// Tools en v1: ninguna. Aquí se van a sumar check_calendar_availability,
// create_appointment, get_upcoming_appointment en Fase 3.
const MIA_TOOLS = [];

async function executeTool(name, args) {
  return { ok: false, error: `Tool "${name}" no implementada todavía (Fase 3)` };
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
        const result = await executeTool(call.function.name, args);
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
