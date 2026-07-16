// Cliente del calendario de Mia (Fase 3). Habla con el MISMO Apps Script Web
// App que el CRM (sheetCrm.js) — reusa MIA_SHEET_WEBHOOK_URL/_SECRET — pero
// llama las acciones de CalendarApp: checkAvailability, createAppointment,
// confirmAppointment, getUpcoming.
//
// El Apps Script corre "como Mirai", así que los eventos quedan en SU Google
// Calendar (calendario dedicado "Mia — Citas"). Si el webhook no está
// configurado, todas las funciones devuelven { ok:false } sin tirar — así Mia
// degrada con elegancia (ofrece la plantilla genérica y escala a Mirai).

const URL    = process.env.MIA_SHEET_WEBHOOK_URL    || '';
const SECRET = process.env.MIA_SHEET_WEBHOOK_SECRET || '';

export function isCalendarEnabled() {
  return Boolean(URL && SECRET);
}

async function callCal(action, data, { timeoutMs = 20000 } = {}) {
  if (!isCalendarEnabled()) {
    return { ok: false, error: 'calendario no configurado (falta MIA_SHEET_WEBHOOK_URL/_SECRET)' };
  }
  // Timeout duro: si Apps Script no responde, abortamos en vez de colgar el
  // handler para siempre (así Mia siempre puede responder, aunque sea el error).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, secret: SECRET, data }),
      redirect: 'follow', // Apps Script redirige
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[mia/cal] ${action} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    if (!json.ok) {
      console.error(`[mia/cal] ${action} fail: ${json.error}`);
      return { ok: false, error: json.error || 'error desconocido' };
    }
    return { ok: true, data: json.data };
  } catch (err) {
    const msg = err.name === 'AbortError' ? `sin respuesta tras ${timeoutMs}ms` : err.message;
    console.error(`[mia/cal] ${action} exception:`, msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// Etiqueta humana en español-Perú a partir de un ISO con offset de Lima.
// "2026-06-22T16:00:00-05:00" → "lunes 22 de junio, 4:00 p. m."
export function slotLabel(iso) {
  try {
    const d = new Date(iso);
    const fecha = d.toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
    });
    const hora = d.toLocaleTimeString('es-PE', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Lima',
    }).toLowerCase();
    return `${fecha}, ${hora}`;
  } catch {
    return iso;
  }
}

// Une opciones con comas y "o" antes de la última: ["9","10","11"] → "9, 10 o 11".
function joinOpciones(arr) {
  if (arr.length <= 1) return arr[0] || '';
  return arr.slice(0, -1).join(', ') + ' o ' + arr[arr.length - 1];
}

// Formatea las horas de un día. inicio_iso viene en hora Lima ("...T09:00:00-05:00"),
// así que la hora de pared se lee directo del string. Si todas son am o todas pm,
// el meridiano va una sola vez al final: "8, 9 o 10 am". Si están mezcladas, en cada
// una: "11 am o 1 pm".
function formatTimes(isos) {
  const parts = isos.map((iso) => {
    const h24 = parseInt(iso.slice(11, 13), 10);
    const min = iso.slice(14, 16);
    const h12 = (h24 % 12) || 12;
    const mer = h24 < 12 ? 'am' : 'pm';
    return { label: min === '00' ? String(h12) : `${h12}:${min}`, mer };
  });
  const allSame = parts.every((p) => p.mer === parts[0].mer);
  if (allSame) return joinOpciones(parts.map((p) => p.label)) + ' ' + parts[0].mer;
  return joinOpciones(parts.map((p) => `${p.label} ${p.mer}`));
}

// Arma el bloque de horarios YA FORMATEADO y prolijo (para que el modelo lo
// pegue TAL CUAL y no lo desordene). Un día por línea, día en *negrita* de
// WhatsApp, máx `maxDays` días y `maxPerDay` horas por día.
//   "*Lunes 22:* 9, 10 o 11 am\n*Martes 23:* 8, 10 o 11 am"
function buildResumen(slots, maxDays = 4, maxPerDay = 3) {
  const byDay = new Map();
  for (const s of slots) {
    const key = s.inicio_iso.slice(0, 10); // fecha Lima (el iso ya está en -05:00)
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s.inicio_iso);
  }
  const lines = [...byDay.keys()].sort().slice(0, maxDays).map((key) => {
    const isos = byDay.get(key).slice(0, maxPerDay);
    let dia = new Date(isos[0]).toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', timeZone: 'America/Lima',
    });
    dia = dia.charAt(0).toUpperCase() + dia.slice(1);
    return `*${dia}:* ${formatTimes(isos)}`;
  });
  return lines.join('\n');
}

// Devuelve los slots libres + un `resumen` ya formateado listo para enviar.
// → { ok, slots: [{ inicio_iso, etiqueta }], count, resumen }
export async function checkAvailability({ daysAhead } = {}) {
  const r = await callCal('checkAvailability', { daysAhead });
  if (!r.ok) return { ok: false, error: r.error, slots: [], resumen: '' };
  const slots = (r.data?.slots ?? []).map(s => ({
    inicio_iso: s.startISO,
    etiqueta: slotLabel(s.startISO),
  }));
  return { ok: true, slots, count: slots.length, resumen: buildResumen(slots) };
}

// Crea un HOLD tentativo (default) o una cita confirmada (tentative:false).
// → { ok, inicio_iso, etiqueta, estado } | { ok:false, error }
export async function createHold({ phone, startISO, nombre, motivo, tentative = true }) {
  const r = await callCal('createAppointment', { phone, startISO, nombre, motivo, tentative });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    inicio_iso: r.data.startISO,
    etiqueta: slotLabel(r.data.startISO),
    estado: r.data.estado,
  };
}

// Confirma el hold activo del paciente (tras recibir el comprobante de pago).
// → { ok, inicio_iso, etiqueta, nombre } | { ok:false, error }
export async function confirmAppointment({ phone }) {
  const r = await callCal('confirmAppointment', { phone });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    inicio_iso: r.data.startISO,
    etiqueta: slotLabel(r.data.startISO),
    nombre: r.data.nombre,
  };
}

// Próxima cita del paciente (confirmada o tentativa).
// → { ok, hasAppointment, inicio_iso?, etiqueta?, estado? }
export async function getUpcoming({ phone }) {
  const r = await callCal('getUpcoming', { phone });
  if (!r.ok) return { ok: false, error: r.error, hasAppointment: false };
  if (!r.data?.hasAppointment) return { ok: true, hasAppointment: false };
  return {
    ok: true,
    hasAppointment: true,
    inicio_iso: r.data.startISO,
    etiqueta: slotLabel(r.data.startISO),
    estado: r.data.estado,
  };
}

// Reprograma la cita del paciente al nuevo slot (conserva hold/confirmada).
// → { ok, inicio_iso, etiqueta, estado, nombre } | { ok:false, error }
export async function rescheduleAppointment({ phone, newStartISO }) {
  const r = await callCal('rescheduleAppointment', { phone, newStartISO });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    inicio_iso: r.data.startISO,
    etiqueta: slotLabel(r.data.startISO),
    estado: r.data.estado,
    nombre: r.data.nombre,
  };
}

// Cancela la cita activa del paciente. → { ok, inicio_iso, etiqueta, estado } | { ok:false, error }
export async function cancelAppointment({ phone }) {
  const r = await callCal('cancelAppointment', { phone });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    inicio_iso: r.data.startISO,
    etiqueta: slotLabel(r.data.startISO),
    estado: r.data.estado,
  };
}

// Lista las citas CONFIRMADAS próximas (todas, con su teléfono) — para los
// recordatorios. → { ok, appointments: [{ inicio_iso, phone, etiqueta }] }
export async function listUpcomingAppointments({ hoursAhead } = {}) {
  const r = await callCal('listUpcoming', { hoursAhead });
  if (!r.ok) return { ok: false, error: r.error, appointments: [] };
  const appointments = (r.data?.appointments ?? []).map(a => ({
    inicio_iso: a.startISO,
    phone: a.phone,
    etiqueta: slotLabel(a.startISO),
  }));
  return { ok: true, appointments };
}

// ─── Bloqueos: Mirai se marca NO DISPONIBLE en un rango (viaje, etc.) ──
// Crea un evento CON HORA que tapa [startISO, endISO); así Mia deja de ofrecer
// esos turnos. → { ok, inicio_iso, fin_iso, motivo, inicio_label, fin_label }
export async function blockRange({ startISO, endISO, motivo }) {
  const r = await callCal('blockTime', { startISO, endISO, motivo });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    inicio_iso: r.data.startISO,
    fin_iso: r.data.endISO,
    motivo: r.data.motivo,
    inicio_label: slotLabel(r.data.startISO),
    fin_label: slotLabel(r.data.endISO),
  };
}

// Lista los bloqueos futuros. → { ok, blocks: [{ eventId, inicio_iso, fin_iso, motivo, inicio_label, fin_label }] }
export async function listBlocks() {
  const r = await callCal('listBlocks', {});
  if (!r.ok) return { ok: false, error: r.error, blocks: [] };
  const blocks = (r.data?.blocks ?? []).map(b => ({
    eventId: b.eventId,
    inicio_iso: b.startISO,
    fin_iso: b.endISO,
    motivo: b.motivo,
    inicio_label: slotLabel(b.startISO),
    fin_label: slotLabel(b.endISO),
  }));
  return { ok: true, blocks };
}

// Quita bloqueos que se solapen con [startISO, endISO). → { ok, deleted }
export async function unblockRange({ startISO, endISO }) {
  const r = await callCal('unblockTime', { startISO, endISO });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, deleted: r.data?.deleted ?? 0 };
}

// Lista las citas CONFIRMADAS que YA TERMINARON (últimas `hoursBack` horas) —
// para pedir reseña. → { ok, appointments: [{ inicio_iso, fin_iso, phone, etiqueta }] }
export async function listFinishedAppointments({ hoursBack } = {}) {
  const r = await callCal('listFinished', { hoursBack });
  if (!r.ok) return { ok: false, error: r.error, appointments: [] };
  const appointments = (r.data?.appointments ?? []).map(a => ({
    inicio_iso: a.startISO,
    fin_iso: a.endISO,
    phone: a.phone,
    etiqueta: slotLabel(a.startISO),
  }));
  return { ok: true, appointments };
}
