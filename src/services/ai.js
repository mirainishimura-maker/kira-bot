import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { openai, MODEL } from '../lib/openai.js';
import { readEntries, summarize, todayLabel } from './sheets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(
  resolve(__dirname, '../prompts/system.txt'),
  'utf8',
);

const MAX_TOOL_ROUNDS = 4;

// Tools que GPT puede llamar durante una respuesta. Cada vez que GPT pide una
// tool, la ejecutamos y le devolvemos el resultado para que pueda continuar.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_sheet',
      description:
        'Lee filas de la hoja "SEGUIMIENTO MKT HUB v2.0" (Registro Diario). Úsala cuando alguien pida ver ' +
        'pendientes, tareas asignadas, qué entregó alguien, qué hay en proceso o bloqueado, qué hay por cliente, etc. ' +
        'Filtra por cualquier combinación de fecha, responsable, cliente o estado. Sin filtros devuelve las últimas ' +
        '50 filas (las más recientes primero). La fecha de hoy es "' + todayLabel() + '" (formato dd/mm/yyyy).',
      parameters: {
        type: 'object',
        properties: {
          fecha: {
            type: 'string',
            description: 'Fecha exacta en formato dd/mm/yyyy (ej: "08/05/2026"). Omite para no filtrar.',
          },
          responsable: {
            type: 'string',
            description: 'Nombre o substring del miembro (ej: "Piero", "analu"). Case-insensitive, coincidencia parcial.',
          },
          clienteMarca: {
            type: 'string',
            description: 'Cliente/marca o substring (ej: "Eco", "Itaca", "Arta"). Case-insensitive.',
          },
          estado: {
            type: 'string',
            description: 'Substring del estado: "Entregado" | "No entregado" | "En proceso" | "Por realizar" | "Bloqueado". Case-insensitive.',
          },
          limit: {
            type: 'integer',
            description: 'Máximo de filas (default 50, max 200).',
            minimum: 1,
            maximum: 200,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_team',
      description:
        'Devuelve métricas agregadas: totales por persona (entregadas, en proceso, por realizar, bloqueadas, ' +
        'tasa de cumplimiento) y la lista de tareas atrasadas ordenadas por días de atraso. Úsala para resúmenes ' +
        'ejecutivos a Luisa o Astrid, reportes vespertinos en grupo, o cuando alguien pida "el panorama" / ' +
        '"cómo va la semana" / "quién está más cargado".',
      parameters: {
        type: 'object',
        properties: {
          responsable: {
            type: 'string',
            description: 'Si quieres métricas de una sola persona, pasa su nombre o substring. Omite para resumen global.',
          },
        },
        additionalProperties: false,
      },
    },
  },
];

// Despachador de tools. Si agregas una nueva tool en TOOLS, agrega su handler aquí.
async function executeTool(name, args) {
  if (name === 'read_sheet') {
    const result = await readEntries(args ?? {});
    if (!result.ok) {
      return { ok: false, error: 'No pude leer la hoja en este momento.' };
    }
    return { ok: true, rows: result.data?.rows ?? [], count: result.data?.count ?? 0 };
  }
  if (name === 'summarize_team') {
    const result = await summarize(args ?? {});
    if (!result.ok) {
      return { ok: false, error: 'No pude calcular el resumen en este momento.' };
    }
    return {
      ok: true,
      global:          result.data?.global          ?? {},
      porPersona:      result.data?.porPersona      ?? {},
      tareasAtrasadas: result.data?.tareasAtrasadas ?? [],
    };
  }
  return { ok: false, error: `Tool desconocida: ${name}` };
}

// Llama a GPT-4.1 con el system prompt + contexto + mensaje. Si GPT decide
// llamar a tools, las ejecutamos y volvemos a llamarlo hasta que responda con
// el JSON estructurado de KIRA (messages / actions / alerts).
export async function ask({ member, channel, message, context }) {
  const userBlock = buildUserBlock({ member, channel, message, context });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userBlock },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.4,
    });

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
        console.log(`[ai] tool ${call.function.name}(${JSON.stringify(args)}) → ${result.ok ? 'ok' : 'err'} (${result.count ?? '?'})`);
      }
      continue;
    }

    return parseFinalResponse(msg.content);
  }

  console.warn(`[ai] alcanzado MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS} sin respuesta final`);
  return {
    messages: [{ channel: channel === 'group' ? 'group' : 'private', text: 'Tuve un problema procesando esto. ¿Me lo puedes repetir?' }],
    actions: [],
    alerts: [],
  };
}

function parseFinalResponse(content) {
  const raw = content ?? '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // GPT respondió texto plano cuando esperábamos JSON. Lo envolvemos.
    console.warn('[ai] respuesta no-JSON, envolviendo:', raw.slice(0, 200));
    parsed = { messages: [{ channel: 'private', text: String(raw) }], actions: [], alerts: [] };
  }
  parsed.messages = parsed.messages ?? [];
  parsed.actions  = parsed.actions  ?? [];
  parsed.alerts   = parsed.alerts   ?? [];
  return parsed;
}

function buildUserBlock({ member, channel, message, context }) {
  const lines = [];
  lines.push(`# Mensaje recibido`);
  lines.push(`Canal: ${channel}`);
  if (member) {
    lines.push(`De: ${member.name} (${member.role}${member.is_admin ? ', admin' : ''}) — tel ${member.phone ?? '(sin tel)'}`);
  } else {
    lines.push('De: número desconocido (no es miembro del equipo)');
  }
  lines.push('');
  lines.push(`> ${message}`);
  lines.push('');

  if (context?.activeTasks?.length) {
    lines.push('# Tareas activas del miembro');
    for (const t of context.activeTasks) {
      const cliente = t.project?.client?.name ?? '?';
      const proyecto = t.project?.title ?? '?';
      const due = t.due_date ?? '—';
      lines.push(`- [${t.status} / ${t.priority}] ${t.title} | ${cliente} → ${proyecto} | due ${due}`);
    }
    lines.push('');
  }

  if (context?.recentMemory?.length) {
    lines.push('# Conversaciones recientes contigo');
    for (const m of context.recentMemory) {
      lines.push(`- ${m.conversation_date} (${m.channel ?? '?'}): ${m.summary}`);
    }
    lines.push('');
  }

  lines.push('Responde SIEMPRE con un JSON válido siguiendo el formato del system prompt.');
  return lines.join('\n');
}
