// Ejecutor de las "actions" que GPT emite en su JSON.
// Hoy solo está implementado log_to_sheet (escribe en la hoja v2 de productividad
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

  // El campo principal antes se llamaba "pendientes"; la v2 lo llama "tarea".
  // Aceptamos ambos nombres por si GPT usa el viejo (durante la migración).
  const tarea = (data.tarea ?? data.pendientes ?? '').trim();
  const requestedName = (data.responsable ?? data.name ?? ctx.sender?.name ?? '').trim();

  if (!requestedName || !tarea) {
    console.warn('[actions] log_to_sheet sin responsable o tarea:', JSON.stringify(action));
    return;
  }

  // Resolvemos al miembro canónico para evitar typos / acentos en la hoja.
  const members = await listActiveMembers();
  const lower = requestedName.toLowerCase();
  const canonical =
    members.find((m) => m.name.toLowerCase() === lower) ??
    members.find((m) => m.name.toLowerCase().startsWith(lower)) ??
    members.find((m) => m.name.toLowerCase().includes(lower));

  const responsable = canonical?.name ?? requestedName;
  const area = data.area || memberToArea(canonical);

  // Estado y prioridad: aceptamos keywords (preferido) o el string literal.
  const estado    = data.estado    || statusLabel(data.status)     || '';
  const prioridad = data.prioridad || priorityLabel(data.priority) || '';

  const result = await upsertDailyEntry({
    fecha:           data.fecha || todayLabel(),
    responsable,
    area,
    clienteMarca:    data.clienteMarca ?? data.cliente ?? '',
    tarea,
    tipo:            data.tipo ?? '',
    prioridad,
    estado,
    fechaCompromiso: data.fechaCompromiso ?? '',
    observaciones:   data.observaciones ?? '',
  });

  if (!result.ok) {
    console.error('[actions] log_to_sheet fallo:', result);
    return;
  }
  console.log(`[actions] log_to_sheet ✓ ${responsable} | ${tarea.slice(0, 60)}`);
}
