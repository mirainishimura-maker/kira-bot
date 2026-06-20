// Cliente HTTP del Apps Script de Mia CRM. Inserta/actualiza filas en el
// Sheet de Mirai cada vez que llega un lead nuevo o Mia recoge datos.
//
// Si MIA_SHEET_WEBHOOK_URL o MIA_SHEET_WEBHOOK_SECRET no están configurados,
// las funciones no hacen nada (no fallan). Util para que el bot funcione
// sin sheet en desarrollo.

const URL    = process.env.MIA_SHEET_WEBHOOK_URL    || '';
const SECRET = process.env.MIA_SHEET_WEBHOOK_SECRET || '';

function enabled() {
  return Boolean(URL && SECRET);
}

async function callSheet(action, payload) {
  if (!enabled()) {
    console.log(`[mia/crm] omitido (${action}): falta MIA_SHEET_WEBHOOK_URL o _SECRET`);
    return null;
  }
  try {
    const body = JSON.stringify({ action, secret: SECRET, ...payload });
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'follow', // Apps Script redirige
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[mia/crm] ${action} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    if (!json.ok) {
      console.error(`[mia/crm] ${action} fail: ${json.error}`);
      return null;
    }
    console.log(`[mia/crm] ${action} ok → ${JSON.stringify(json.data).slice(0, 120)}`);
    return json.data;
  } catch (err) {
    console.error(`[mia/crm] ${action} exception:`, err.message);
    return null;
  }
}

// Inserta/actualiza una fila por teléfono. Campos en `data`:
//   phone (requerido), nombre, estado, etiqueta, para_quien, edad,
//   procedencia, sede_ok, motivo, horarios_propuestos, nota_interna
export async function upsertLead(data) {
  if (!data?.phone) return null;
  // Limpiamos campos null/undefined antes de enviar.
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined && v !== '') clean[k] = v;
  }
  return callSheet('upsertLead', { data: clean });
}

// Escribe/actualiza la pestaña "Reporte" de la hoja CRM con el resumen ya
// calculado. Devuelve { url, tab } (el url de la hoja para mandárselo a Mirai)
// o null si el CRM no está configurado / falló.
export async function writeReport(report) {
  if (!report) return null;
  return callSheet('writeReport', { report });
}

export async function pingSheet() {
  return callSheet('ping', {});
}

export function isCrmEnabled() {
  return enabled();
}
