// Cliente HTTP de la hoja de productividad de Luisa.
// El backend es un Apps Script desplegado como Web App (ver appsscript/Code.gs).

import { config } from '../config.js';

const ROLE_TO_AREA = {
  project_manager:  'PM',
  leader:           'LIDER',
  content_creator:  'CREADOR DE CONT',
  pautero:          'PAUTA',
  videographer:     'VIDEOGRAFO',
  designer:         'DISEÑO',
};

const STATUS_TO_ESTADO = {
  done:        'ENTREGADO',
  in_progress: 'EN PROCESO',
  blocked:     'BLOQUEADO',
  pending:     'POR REALIZAR',
};

const PRIORITY_TO_LABEL = {
  urgent: 'URGENTE',
  high:   'ALTA',
  normal: 'NORMAL',
  low:    'BAJA',
};

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

export function ping() {
  return call('ping', {});
}

// Convierte fecha a formato dd/mm que usa la hoja de Luisa.
export function todayLabel(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

// Mapea un miembro de la BD al "AREA" que usa la hoja.
export function memberToArea(member) {
  if (!member) return '';
  return ROLE_TO_AREA[member.role] ?? member.role.toUpperCase();
}

// Agrega una fila al final.
export function appendDailyEntry({
  date, name, area, pendientes, estado, prioridad, seguimiento = 'SI', observaciones = '',
}) {
  return call('append', { date, name, area, pendientes, estado, prioridad, seguimiento, observaciones });
}

// Actualiza la fila (date,name) más reciente. Si no existe, la crea.
export function upsertDailyEntry({
  date, name, area, pendientes, estado, prioridad, seguimiento, observaciones,
}) {
  return call('update', { date, name, area, pendientes, estado, prioridad, seguimiento, observaciones });
}

// Helpers para que el resto del bot no sepa de strings de Excel.
export function statusLabel(status) {
  return STATUS_TO_ESTADO[status] ?? '';
}
export function priorityLabel(priority) {
  return PRIORITY_TO_LABEL[priority] ?? '';
}
