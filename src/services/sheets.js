// Cliente HTTP de la hoja de productividad de Luisa (v2).
// El backend es un Apps Script desplegado como Web App (ver appsscript/Code.gs).
//
// Esquema v2 — 11 columnas:
//   fecha | responsable | area | clienteMarca | tarea | tipo | prioridad |
//   estado | fechaCompromiso | diasAtraso (fórmula) | observaciones

import { config } from '../config.js';

// ─── Mapeos semánticos ────────────────────────────────────────────────

// Rol del miembro → área tal como aparece en la hoja v2.
// Si el rol no está en este mapa, se devuelve el rol crudo en mayúscula
// inicial (mejor que vacío).
const ROLE_TO_AREA = {
  project_manager: 'PM',
  leader:          'Liderazgo',
  content_creator: 'Creación de Contenido',
  pautero:         'Pauta',
  videographer:    'Videografía',
  designer:        'Diseño',
};

// Estados con emoji exactamente como los acepta la hoja v2.
const STATUS_TO_ESTADO = {
  done:        '✅ Entregado',
  not_done:    '❌ No entregado',
  in_progress: '🔄 En proceso',
  pending:     '⬜ Por realizar',
  blocked:     '⏸️ Bloqueado',
};

// Prioridades con emoji.
const PRIORITY_TO_LABEL = {
  urgent: '🔴 Urgente',
  high:   '🟡 Alta',
  normal: '🔵 Normal',
  low:    '🟢 Baja',
};

// ─── HTTP ─────────────────────────────────────────────────────────────

function isEnabled() {
  return Boolean(config.sheets?.url && config.sheets?.secret);
}

async function call(action, payload) {
  if (!isEnabled()) {
    console.warn('[sheets] no configurado (faltan SHEETS_WEBHOOK_URL o SHEETS_WEBHOOK_SECRET) — skipping');
    return { ok: false, skipped: true };
  }
  const res = await fetch(config.sheets.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: config.sheets.secret, action, ...payload }),
    redirect: 'follow',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.ok === false) {
    console.error('[sheets] error', res.status, data);
    return { ok: false, status: res.status, data };
  }
  return { ok: true, data };
}

// ─── Public API ───────────────────────────────────────────────────────

export function ping() {
  return call('ping', {});
}

// Convierte fecha a formato dd/mm/yyyy que usa la hoja v2.
export function todayLabel(d = new Date()) {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function memberToArea(member) {
  if (!member?.role) return '';
  return ROLE_TO_AREA[member.role] ?? member.role;
}

export function statusLabel(status) {
  return STATUS_TO_ESTADO[status] ?? '';
}

export function priorityLabel(priority) {
  return PRIORITY_TO_LABEL[priority] ?? '';
}

// Agrega una fila al final.
export function appendDailyEntry({
  fecha, responsable, area, clienteMarca, tarea, tipo,
  prioridad, estado, fechaCompromiso, observaciones,
}) {
  return call('append', {
    fecha, responsable, area, clienteMarca, tarea, tipo,
    prioridad, estado, fechaCompromiso, observaciones,
  });
}

// Actualiza la fila (fecha, responsable) más reciente. Si no existe, la crea.
export function upsertDailyEntry({
  fecha, responsable, area, clienteMarca, tarea, tipo,
  prioridad, estado, fechaCompromiso, observaciones,
}) {
  return call('update', {
    fecha, responsable, area, clienteMarca, tarea, tipo,
    prioridad, estado, fechaCompromiso, observaciones,
  });
}

// Lee filas con filtros opcionales. Devuelve {ok, rows, count}.
// Filtros: fecha (exacta dd/mm/yyyy), responsable / clienteMarca / estado
// (substring case-insensitive), limit (max 200).
export function readEntries({ fecha, responsable, clienteMarca, estado, limit } = {}) {
  return call('read', { fecha, responsable, clienteMarca, estado, limit });
}

// Devuelve métricas agregadas por persona y la lista de tareas con atraso.
export function summarize({ responsable } = {}) {
  return call('summary', { responsable });
}
