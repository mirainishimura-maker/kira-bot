// NEURA · Cierre de sesión.
// ~15 min DESPUÉS de que termina cada sesión, Mia le pregunta a Mirai cómo le
// fue, para que dicte la nota clínica por voz mientras la tiene fresca (el
// clasificador de neuraAssistant la guarda como nota_sesion). Complementa a
// sesionPrep.js, que la prepara ANTES.
//
// Las citas de Mirai viven en su Google Calendar (la tabla neura_citas está
// vacía), y listUpcomingAppointments solo devuelve FUTURAS — así que este
// módulo va viendo las sesiones del día mientras aún son futuras y las guarda
// en RAM para avisar cuando ya terminaron. Se reinicia cada día (y en cada
// redeploy: en el peor caso Mirai no recibe el aviso de esa sesión).

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendPrivate } from '../../lib/evolution.js';
import { listUpcomingAppointments, isCalendarEnabled } from './calendar.js';

// Sesión de 45-55 min → a los 70 min del inicio ya terminó hace un ratito.
const MIN_TRAS_INICIO = 70;
// Pasada esta ventana ya no tiene sentido preguntar (se le pasó el día).
const MAX_TRAS_INICIO = 300;

const vistas = new Map();   // "phone|inicio_iso" → { nombre, phone, inicioMs, avisado }
let diaActual = '';

const limaDay = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' });
const inicioHoyISO = () =>
  new Date(`${limaDay()}T00:00:00-05:00`).toISOString();

async function patientByPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const tail = digits.slice(-9);
  const { data } = await miraiSupabase
    .from('patients').select('id, nombre, phone').ilike('phone', `%${tail}%`).limit(1);
  return (data && data[0]) || null;
}

// ¿Ya dictó la nota de esta paciente hoy? Entonces no la molestamos.
async function yaTieneNotaHoy(patientId) {
  if (!patientId) return false;
  const { data } = await miraiSupabase
    .from('sessions').select('id')
    .eq('patient_id', patientId).gte('created_at', inicioHoyISO()).limit(1);
  return (data ?? []).length > 0;
}

function mensajeCierre(nombre) {
  return (
    `🧠 *¿Cómo te fue con ${nombre}?*\n\n` +
    'Cuéntame por voz mientras lo tienes fresco y guardo la nota: qué trabajaron, ' +
    'qué tarea le dejaste y qué quieres ver la próxima.\n\n' +
    '_Si prefieres, dímelo más tarde — no te vuelvo a preguntar por esta sesión_ ✦'
  );
}

export async function runSesionCierre({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'sin supabase', avisadas: [] };
  if (!isCalendarEnabled()) return { ok: false, error: 'calendario no configurado', avisadas: [] };

  const hoy = limaDay();
  if (hoy !== diaActual) { vistas.clear(); diaActual = hoy; }

  // 1 · Descubrir las sesiones que vienen y anotarlas para después.
  try {
    const r = await listUpcomingAppointments({ hoursAhead: 3 });
    if (r.ok) {
      for (const a of r.appointments) {
        const key = `${a.phone}|${a.inicio_iso}`;
        if (vistas.has(key)) continue;
        vistas.set(key, {
          phone: a.phone,
          inicioMs: new Date(a.inicio_iso).getTime(),
          nombre: null,          // se resuelve al momento de avisar
          avisado: false,
        });
      }
    }
  } catch (e) {
    console.error('[neura/cierre] no pude listar citas:', e.message);
  }

  // 2 · Avisar por las que ya terminaron.
  const avisadas = [];
  for (const [key, s] of vistas) {
    if (s.avisado) continue;
    const mins = (Date.now() - s.inicioMs) / 60000;
    if (mins < MIN_TRAS_INICIO || mins > MAX_TRAS_INICIO) continue;

    const patient = await patientByPhone(s.phone);
    if (patient && await yaTieneNotaHoy(patient.id)) {
      s.avisado = true;                      // ya la dictó sola
      continue;
    }
    const nombre = patient?.nombre || 'tu paciente';
    const msg = mensajeCierre(nombre);

    if (!dry) {
      try { await sendPrivate(config.mia.personalPhone, msg); s.avisado = true; }
      catch (e) { console.error('[neura/cierre] envío:', e.message); continue; }
    }
    avisadas.push({ nombre, key, mins: Math.round(mins), msg });
  }

  return { ok: true, avisadas, enSeguimiento: vistas.size };
}

export function startSesionCierreCron() {
  if (!config.mia.enabled) return;
  if (process.env.SESION_CIERRE_ENABLED === 'false') {
    console.log('[neura/cierre] cierre de sesión APAGADO por env');
    return;
  }
  // Cada 15 min, 6am-11pm Lima: descubre las sesiones del día y avisa ~15 min
  // después de que cada una termina.
  cron.schedule('*/15 6-23 * * *', () => {
    runSesionCierre({ dry: false }).catch((e) => console.error('[neura/cierre] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[neura/cierre] cron activo (cada 15 min · nota de sesión ~15 min después de cada cita)');
}
