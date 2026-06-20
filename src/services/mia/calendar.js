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

async function callCal(action, data) {
  if (!isCalendarEnabled()) {
    return { ok: false, error: 'calendario no configurado (falta MIA_SHEET_WEBHOOK_URL/_SECRET)' };
  }
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, secret: SECRET, data }),
      redirect: 'follow', // Apps Script redirige
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
    console.error(`[mia/cal] ${action} exception:`, err.message);
    return { ok: false, error: err.message };
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

// Devuelve los slots libres ya con etiqueta lista para que Mia los ofrezca.
// → { ok, slots: [{ inicio_iso, etiqueta }], count }
export async function checkAvailability({ daysAhead } = {}) {
  const r = await callCal('checkAvailability', { daysAhead });
  if (!r.ok) return { ok: false, error: r.error, slots: [] };
  const slots = (r.data?.slots ?? []).map(s => ({
    inicio_iso: s.startISO,
    etiqueta: slotLabel(s.startISO),
  }));
  return { ok: true, slots, count: slots.length };
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
