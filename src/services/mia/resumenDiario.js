// Resumen diario de Mia/NEURA: cada noche (21:00 Lima) le manda a Mirai un
// resumen de la actividad del día — leads nuevos, personas atendidas, guías
// enviadas. Visibilidad sin que tenga que vigilar nada.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';

// Inicio del día de HOY en Lima (UTC-5), como ISO, para filtrar por created_at.
function inicioHoyLima() {
  const limaStr = new Date().toLocaleString('sv-SE', { timeZone: 'America/Lima' }); // "2026-06-23 14:00:00"
  return new Date(`${limaStr.slice(0, 10)}T00:00:00-05:00`).toISOString();
}
function fechaLegible() {
  return new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long' });
}

export async function runResumenDiario({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'Mia no habilitada' };
  if (!config.mia.personalPhone) return { ok: false, error: 'falta MIRAI_PERSONAL_PHONE' };
  const desde = inicioHoyLima();

  // Leads nuevos hoy
  const { data: nuevos } = await miraiSupabase
    .from('patients').select('nombre, phone, etiqueta')
    .gte('fecha_alta', desde).order('fecha_alta', { ascending: false }).limit(50);

  // Guías gratis enviadas hoy
  const { count: guias } = await miraiSupabase
    .from('conversations').select('id', { count: 'exact', head: true })
    .eq('metadata->>kind', 'guia').gte('created_at', desde);

  // Personas distintas que Mia atendió hoy
  const { data: miaMsgs } = await miraiSupabase
    .from('conversations').select('patient_id').eq('author', 'mia').gte('created_at', desde).limit(3000);
  const atendidos = new Set((miaMsgs || []).map(m => m.patient_id)).size;

  const listaLeads = (nuevos || []).slice(0, 8).map(l => `   • ${l.nombre} (${l.phone})`).join('\n');
  const masLeads = (nuevos || []).length > 8 ? `   …y ${(nuevos || []).length - 8} más` : '';

  const texto = [
    `🌙 *Resumen de hoy* — ${fechaLegible()}`,
    '',
    `🆕 Leads nuevos: *${(nuevos || []).length}*`,
    listaLeads,
    masLeads,
    `💬 Mia atendió a *${atendidos}* persona(s)`,
    `📎 Guías gratis enviadas: *${guias ?? 0}*`,
    '',
    'Que descanses 🌸',
  ].filter(Boolean).join('\n');

  if (dry) return { ok: true, dry: true, texto, leads: (nuevos || []).length, atendidos, guias: guias ?? 0 };

  try {
    const sent = await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, texto);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  } catch (e) {
    console.error('[mia/resumen] no pude enviar:', e.message);
    return { ok: false, error: e.message };
  }
  console.log(`[mia/resumen] enviado a Mirai | leads=${(nuevos || []).length} atendidos=${atendidos} guias=${guias ?? 0}`);
  return { ok: true, texto };
}

export function startResumenCron() {
  if (!config.mia.enabled) {
    console.log('[mia/resumen] cron NO iniciado (Mia no habilitada).');
    return;
  }
  cron.schedule('0 21 * * *', () => {
    runResumenDiario({ dry: false }).catch(e => console.error('[mia/resumen] sweep falló:', e));
  }, { timezone: 'America/Lima' });
  console.log('[mia/resumen] cron activo | resumen diario 21:00 America/Lima');
}
