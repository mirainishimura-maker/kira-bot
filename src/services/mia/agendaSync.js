// NEURA · Sincroniza tu Google Calendar → panel.
// El bot lee tus próximas citas (listUpcomingAppointments, vía Apps Script) y
// escribe un snapshot en la tabla `agenda_cache`, que el panel lee para mostrar
// tu agenda REAL en Inicio y Agenda. Se refresca por cron cada 20 min.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { listUpcomingAppointments, isCalendarEnabled } from './calendar.js';

async function nameForPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const tail = digits.slice(-9);
  const { data } = await miraiSupabase
    .from('patients').select('nombre').ilike('phone', `%${tail}%`).limit(1);
  return data?.[0]?.nombre || null;
}

export async function runAgendaSync() {
  if (!miraiSupabase) return { ok: false, error: 'sin supabase', count: 0 };
  if (!isCalendarEnabled()) return { ok: false, error: 'calendario no configurado', count: 0 };

  const r = await listUpcomingAppointments({ hoursAhead: 72 });
  if (!r.ok) return { ok: false, error: r.error, count: 0 };

  const rows = [];
  for (const a of r.appointments) {
    const nombre = await nameForPhone(a.phone);
    rows.push({
      start_iso: a.inicio_iso,
      title: nombre ? `Sesión · ${nombre}` : 'Sesión',
      kind: 'sesion',
      phone: a.phone,
    });
  }

  // Reemplaza el snapshot completo (delete-all + insert).
  await miraiSupabase.from('agenda_cache').delete().gte('start_iso', '1970-01-01T00:00:00Z');
  if (rows.length) {
    const { error } = await miraiSupabase.from('agenda_cache').insert(rows);
    if (error) return { ok: false, error: error.message, count: 0 };
  }
  return { ok: true, count: rows.length };
}

export function startAgendaSyncCron() {
  if (!config.mia.enabled) return;
  cron.schedule('*/20 6-23 * * *', () => {
    runAgendaSync().catch((e) => console.error('[neura/agenda] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[neura/agenda] cron activo (cada 20 min · sincroniza el calendario al panel)');
}
