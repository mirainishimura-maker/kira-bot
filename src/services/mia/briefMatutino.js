// Brief matutino de Neura: cada mañana (07:00 Lima) Mia le manda a Mirai su día
// POR DELANTE — agenda (sesiones de hoy) + pendientes/recordatorios. Complementa
// el resumen NOCTURNO (resumenDiario.js), que es el recap de lo que ya pasó.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';
import { listUpcomingAppointments } from './calendar.js';

function hoyLimaDate() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Lima' }).slice(0, 10); // "2026-07-05"
}
function inicioHoyLimaISO() { return new Date(`${hoyLimaDate()}T00:00:00-05:00`).toISOString(); }
function finHoyLimaISO()    { return new Date(`${hoyLimaDate()}T23:59:59-05:00`).toISOString(); }
function fechaLegible() {
  return new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long' });
}
function horaLima(iso) {
  try {
    return new Date(iso).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  } catch { return ''; }
}

export async function runBriefMatutino({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'Mia no habilitada' };
  if (!config.mia.personalPhone) return { ok: false, error: 'falta MIRAI_PERSONAL_PHONE' };

  // 1) Agenda de HOY: sesiones confirmadas (próx. 24h) filtradas al día de hoy.
  let agendaLines = [];
  try {
    const cal = await listUpcomingAppointments({ hoursAhead: 24 });
    if (cal.ok) {
      const hoy = hoyLimaDate();
      agendaLines = (cal.appointments || [])
        .filter((a) => (a.inicio_iso || '').slice(0, 10) === hoy)
        .map((a) => `   • ${horaLima(a.inicio_iso)} — sesión`);
    }
  } catch (e) { console.error('[mia/brief] agenda falló:', e.message); }

  // 2) Pendientes de hoy: recordatorios pendientes que sean diarios, sin hora, o
  //    con hora dentro de hoy.
  const inicioHoy = inicioHoyLimaISO();
  const finHoy = finHoyLimaISO();
  const { data: rems } = await miraiSupabase
    .from('reminders').select('title, remind_at, recurrence, status')
    .eq('status', 'pendiente').order('remind_at', { ascending: true }).limit(100);
  const pendientes = (rems || []).filter((r) =>
    r.recurrence === 'daily' || !r.remind_at || (r.remind_at >= inicioHoy && r.remind_at <= finHoy)
  );
  const pendLines = pendientes.slice(0, 12).map((r) => {
    const cada = r.recurrence === 'daily' ? ' · cada día' : '';
    const hora = r.remind_at && r.recurrence !== 'daily' ? ` (${horaLima(r.remind_at)})` : '';
    const ic = r.recurrence === 'daily' ? '💊' : '•';
    return `   ${ic} ${r.title}${hora}${cada}`;
  });

  const texto = [
    `☀️ *Buenos días, Mirai* — ${fechaLegible()}`,
    '',
    '🗓️ *Hoy:*',
    agendaLines.length ? agendaLines.join('\n') : '   (sin sesiones agendadas)',
    '',
    '📝 *Pendientes:*',
    pendLines.length ? pendLines.join('\n') : '   (nada pendiente ✦)',
    '',
    'Que tengas un lindo día 🌿',
  ].join('\n');

  if (dry) return { ok: true, dry: true, texto, agenda: agendaLines.length, pendientes: pendientes.length };

  try {
    const sent = await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, texto);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  } catch (e) {
    console.error('[mia/brief] no pude enviar:', e.message);
    return { ok: false, error: e.message };
  }
  console.log(`[mia/brief] enviado a Mirai | agenda=${agendaLines.length} pendientes=${pendientes.length}`);
  return { ok: true, texto };
}

export function startBriefCron() {
  if (!config.mia.enabled) {
    console.log('[mia/brief] cron NO iniciado (Mia no habilitada).');
    return;
  }
  cron.schedule('0 7 * * *', () => {
    runBriefMatutino({ dry: false }).catch((e) => console.error('[mia/brief] sweep falló:', e));
  }, { timezone: 'America/Lima' });
  console.log('[mia/brief] cron activo | brief matutino 07:00 America/Lima');
}
