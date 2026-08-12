// Cliente HTTP del Apps Script de Mia para registrar ingresos/egresos.
// Reusa el MISMO Apps Script Web App que el CRM (sheetCrm.js) y el calendario
// (calendar.js) — mismas env vars MIA_SHEET_WEBHOOK_URL/_SECRET — pero llama
// la acción `logFinance`, que escribe en una hoja de cálculo APARTE (creada
// con setupFinanceSheet() en el Apps Script), separada del CRM de leads y de
// cualquier otra hoja de Mirai (ej. la de contraseñas).
//
// Decisión de Mirai (2026-07-18): los ingresos/egresos que dicta por voz ya
// NO se guardan en Supabase — viven SOLO en esa hoja. Cuentas/deudas/metas
// (Finanzas v2) siguen igual, sin tocar.

const URL    = process.env.MIA_SHEET_WEBHOOK_URL    || '';
const SECRET = process.env.MIA_SHEET_WEBHOOK_SECRET || '';

export function isFinanceSheetEnabled() {
  return Boolean(URL && SECRET);
}

async function callSheet(action, payload) {
  if (!isFinanceSheetEnabled()) {
    console.log(`[neura/finsheet] omitido (${action}): falta MIA_SHEET_WEBHOOK_URL o _SECRET`);
    return null;
  }
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, secret: SECRET, ...payload }),
      redirect: 'follow', // Apps Script redirige
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[neura/finsheet] ${action} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    if (!json.ok) {
      console.error(`[neura/finsheet] ${action} fail: ${json.error}`);
      return null;
    }
    return json.data;
  } catch (err) {
    console.error(`[neura/finsheet] ${action} exception:`, err.message);
    return null;
  }
}

// data: { direction: 'ingreso'|'gasto', amount, category, description, account, source }
export async function logFinanceToSheet(data) {
  const r = await callSheet('logFinance', { data });
  return r ? { ok: true } : { ok: false, error: 'no se pudo anotar' };
}

// Total del día (hora Lima) en la hoja: { count, ingresos, gastos } o null si
// falla (el resumen diario cae a solo lo de Supabase en ese caso).
export async function getFinanceToday() {
  return callSheet('financeToday', {});
}
