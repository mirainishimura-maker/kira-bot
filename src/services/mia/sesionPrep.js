// NEURA · Preparación de sesión.
// ~1h antes de cada cita CONFIRMADA, Mia le manda a Mirai el recap del paciente
// (última sesión, tarea que le dejó, en qué quedaron) para que llegue lista y
// dé continuidad de lujo. Lee el calendario (listUpcomingAppointments) y cruza
// el teléfono con la ficha del paciente. Dedup en RAM (una sola vez por cita).

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendPrivate } from '../../lib/evolution.js';
import { listUpcomingAppointments, isCalendarEnabled } from './calendar.js';

const prepped = new Set();
let preppedDay = '';

const limaDay = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' });
const minutesUntil = (iso) => (new Date(iso).getTime() - Date.now()) / 60000;

async function patientByPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const tail = digits.slice(-9); // últimos 9 dígitos (celular Perú)
  const { data } = await miraiSupabase
    .from('patients').select('id, nombre, phone').ilike('phone', `%${tail}%`).limit(1);
  return (data && data[0]) || null;
}

async function lastSession(patientId) {
  const { data } = await miraiSupabase
    .from('sessions').select('summary, homework, next_focus, created_at')
    .eq('patient_id', patientId).order('created_at', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

function buildPrepMessage(nombre, etiqueta, mins, sesion) {
  const cuando = mins <= 12 ? 'en un ratito' : `en ~${Math.round(mins)} min`;
  let body;
  if (!sesion || !sesion.summary) {
    body = 'Sin notas previas — probablemente es su primera sesión contigo. ¡A conocerla! 🌱';
  } else {
    const parts = [`*Última sesión:* ${sesion.summary}`];
    if (sesion.homework) parts.push(`*Tarea que le dejaste:* ${sesion.homework}`);
    if (sesion.next_focus) parts.push(`*Iban a trabajar:* ${sesion.next_focus}`);
    body = parts.join('\n');
  }
  return `🧠 *Prepárate* — ${cuando} tienes a *${nombre}*\n(${etiqueta})\n\n${body}\n\n_Neura · continuidad de tus sesiones_ ✦`;
}

export async function runSesionPrep({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'sin supabase', prepared: [] };
  if (!isCalendarEnabled()) return { ok: false, error: 'calendario no configurado', prepared: [] };

  const today = limaDay();
  if (today !== preppedDay) { prepped.clear(); preppedDay = today; }

  const r = await listUpcomingAppointments({ hoursAhead: 2 });
  if (!r.ok) return { ok: false, error: r.error, prepared: [] };

  const prepared = [];
  for (const a of r.appointments) {
    const mins = minutesUntil(a.inicio_iso);
    if (mins <= 0 || mins > 75) continue; // ventana: hasta 75 min antes
    const key = `${a.phone}|${a.inicio_iso}`;
    if (!dry && prepped.has(key)) continue;

    const patient = await patientByPhone(a.phone);
    const nombre = patient?.nombre || 'tu paciente';
    const sesion = patient ? await lastSession(patient.id) : null;
    const msg = buildPrepMessage(nombre, a.etiqueta, mins, sesion);

    if (!dry) {
      try { await sendPrivate(config.mia.personalPhone, msg); prepped.add(key); }
      catch (e) { console.error('[neura/prep] envío:', e.message); }
    }
    prepared.push({ nombre, etiqueta: a.etiqueta, mins: Math.round(mins), msg });
  }
  return { ok: true, prepared };
}

export function startSesionPrepCron() {
  if (!config.mia.enabled) return;
  // cada 15 min, de 6am a 11pm Lima → captura cada cita una vez, ~1h antes.
  cron.schedule('*/15 6-23 * * *', () => {
    runSesionPrep({ dry: false }).catch((e) => console.error('[neura/prep] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[neura/prep] cron activo (cada 15 min · recap ~1h antes de cada sesión)');
}
