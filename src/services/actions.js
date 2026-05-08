// Ejecutor de las "actions" que GPT emite en su JSON.
// Hoy solo está implementado log_to_sheet (escribe en la hoja de productividad
// de Luisa via Apps Script). El resto se loggea como pendiente para Fase 3.

import { listActiveMembers } from './members.js';
import {
  upsertDailyEntry, todayLabel, memberToArea,
  statusLabel, priorityLabel,
} from './sheets.js';

export async function executeActions(actions, ctx = {}) {
  if (!actions?.length) return;
  for (const action of actions) {
    try {
      if (action?.type === 'log_to_sheet') {
        await runLogToSheet(action, ctx);
      } else {
        console.log('[actions] pendiente (TODO ejecutar):', JSON.stringify(action));
      }
    } catch (err) {
      console.error('[actions] error ejecutando', action?.type, err);
    }
  }
}

async function runLogToSheet(action, ctx) {
  const data = action?.data ?? {};
  const requestedName = (data.name ?? ctx.sender?.name ?? '').trim();
  const pendientes = (data.pendientes ?? '').trim();

  if (!requestedName || !pendientes) {
    console.warn('[actions] log_to_sheet sin name o pendientes:', JSON.stringify(action));
    return;
  }

  // Resolvemos al miembro canónico para evitar typos / acentos en la hoja.
  // (Luisa tiene inconsistencias históricas — KIRA escribe siempre la versión correcta.)
  const members = await listActiveMembers();
  const lower = requestedName.toLowerCase();
  const canonical =
    members.find((m) => m.name.toLowerCase() === lower) ??
    members.find((m) => m.name.toLowerCase().startsWith(lower)) ??
    members.find((m) => m.name.toLowerCase().includes(lower));

  const finalName = canonical?.name ?? requestedName;
  const area = data.area || memberToArea(canonical) || requestedName.toUpperCase();

  const estado    = data.estado    || statusLabel(data.status)     || 'EN PROCESO';
  const prioridad = data.prioridad || priorityLabel(data.priority) || 'NORMAL';

  const result = await upsertDailyEntry({
    date:          data.date || todayLabel(),
    name:          finalName,
    area,
    pendientes,
    estado,
    prioridad,
    seguimiento:   data.seguimiento || 'SI',
    observaciones: data.observaciones ?? '',
  });

  if (!result.ok) {
    console.error('[actions] log_to_sheet fallo:', result);
    return;
  }
  console.log(`[actions] log_to_sheet ✓ ${finalName} | ${pendientes.slice(0, 60)}`);
}
