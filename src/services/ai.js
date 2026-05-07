import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { openai, MODEL } from '../lib/openai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(
  resolve(__dirname, '../prompts/system.txt'),
  'utf8',
);

// Llama a GPT-4.1 con el system prompt + contexto + mensaje. Devuelve el JSON
// estructurado de KIRA (messages / actions / alerts).
export async function ask({ member, channel, message, context }) {
  const userBlock = buildUserBlock({ member, channel, message, context });

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userBlock },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.4,
  });

  const raw = completion.choices?.[0]?.message?.content ?? '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('[ai] JSON inválido de GPT:', raw);
    parsed = { messages: [], actions: [], alerts: [] };
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
