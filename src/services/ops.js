// Cron operativo de mirai_ops: lee tareas pendientes y manda un resumen
// por DM al owner del espacio. Bidireccional, pero por ahora el cron
// solo lee; el bot acepta comandos vía webhook normal.

import { callSpaceEndpoint, getSpaceBySlug, getSpaceOwner } from './spaces.js';
import { sendPrivate } from '../lib/evolution.js';

function formatTaskLine(t) {
  const prio   = (t.prioridad || '').trim();
  const proy   = (t.proyecto  || '').trim();
  const tarea  = (t.tarea     || '').trim();
  const fechaC = (t.fechaCompromiso || '').trim();
  const atraso = (t.diasAtraso || '').trim();

  const head = [prio, proy].filter(Boolean).join(' · ');
  const lines = [head ? `${head}: ${tarea}` : tarea];
  if (fechaC || atraso) {
    const meta = [];
    if (fechaC) meta.push(`📅 ${fechaC}`);
    if (atraso) meta.push(`atraso ${atraso}d`);
    lines.push('   ' + meta.join(' · '));
  }
  return lines.join('\n');
}

export function formatOpsMessage(tasks) {
  if (!tasks?.length) return '🌅 Buenos días, Mirai. Hoy no tienes tareas operativas pendientes. ✨';
  const header = `🌅 Buenos días, Mirai. Tienes ${tasks.length} tarea${tasks.length === 1 ? '' : 's'} pendiente${tasks.length === 1 ? '' : 's'}:`;
  return [header, '', ...tasks.map(t => '• ' + formatTaskLine(t))].join('\n');
}

export async function runMiraiOpsCron({ dry = false } = {}) {
  const space = await getSpaceBySlug('mirai_ops');
  if (!space) {
    console.warn('[ops] espacio mirai_ops no encontrado');
    return { sent: false, reason: 'sin_espacio' };
  }
  try {
    const owner = await getSpaceOwner(space.id);
    if (!owner?.phone) {
      console.warn('[ops] mirai_ops sin owner');
      return { sent: false, reason: 'sin_owner' };
    }
    const data = await callSpaceEndpoint(space, 'tasksToday');
    const tasks = data.tasks ?? [];
    const text = formatOpsMessage(tasks);
    if (dry) {
      console.log(`[ops][DRY] mirai_ops → ${owner.name} (${owner.phone}):\n${text}`);
      return { sent: false, count: tasks.length, dry: true, preview: text, to: owner.phone };
    }
    await sendPrivate(owner.phone, text);
    console.log(`[ops] mirai_ops | sent=true count=${tasks.length}`);
    return { sent: true, count: tasks.length };
  } catch (err) {
    console.error('[ops] fallo en mirai_ops:', err.message);
    return { sent: false, reason: 'error', error: err.message };
  }
}
