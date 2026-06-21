// Pedir reseña en Google tras la sesión. Mia le escribe al paciente unas horas
// después de su cita confirmada y le pide cariñosamente una reseña.
//
// - Una sola vez por paciente (no spamea aunque tenga varias sesiones).
// - Solo si la sesión terminó hace entre 2h y 24h (le damos espacio, no de noche).
// - SEGURIDAD: solo envía si config.mia.resenas.enabled === true, hay link
//   (MIA_RESENA_URL) y estamos en la ventana 8am–9pm Lima. Dry-run no envía.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText } from '../../lib/evolution.js';
import { logMessage } from './conversations.js';
import { touchPatientInteraction, findPatientByPhone } from './patients.js';
import { rememberMiaSentId } from './echoTracker.js';
import { listFinishedAppointments } from './calendar.js';
import { aplicarNombre, pickVariante } from './text.js';

const HORA = 60 * 60 * 1000;
const MIN_HORAS_TRAS_SESION = 2;   // no pedir antes de 2h de terminada
const HORA_INI = 8;
const HORA_FIN = 21;

// Mensajes (NEUTROS m/f). {nombre} y {link}.
const MSG = [
  'Hola {nombre} 🌸 espero que tu sesión con la Psicóloga Mirai te haya hecho bien 💛 Si te sentiste a gusto, ¿nos ayudarías con una reseñita en Google? Ayuda a que más personas encuentren este espacio 🌷\n{link}',
  '{nombre}, gracias por darte este espacio 🌸 Si tu experiencia con la Psicóloga Mirai fue buena, una reseñita en Google nos ayudaría muchísimo 💛\n{link}',
];

function horaLima(now) {
  return Number(new Date(now).toLocaleString('sv-SE', { timeZone: 'America/Lima' }).slice(11, 13));
}
function enHorarioPermitido(now) {
  const h = horaLima(now);
  return h >= HORA_INI && h < HORA_FIN;
}

// ¿Ya se le pidió reseña a este paciente alguna vez? (robusto, no limitado a N msgs)
async function yaPidioResena(patientId) {
  const { data, error } = await miraiSupabase
    .from('conversations')
    .select('id')
    .eq('patient_id', patientId)
    .eq('metadata->>kind', 'resena')
    .limit(1);
  if (error) {
    console.error('[mia/resenas] yaPidioResena error:', error.message);
    return true; // ante duda, NO re-pedir
  }
  return Boolean(data && data.length);
}

async function enviarResena(patient) {
  const jid = `${patient.phone}@s.whatsapp.net`;
  const texto = aplicarNombre(pickVariante(MSG, patient.phone, 'resena'), patient.nombre)
    .replaceAll('{link}', config.mia.resenas.url);
  const sent = await sendText(jid, texto);
  const sentId = sent?.key?.id ?? null;
  if (sentId) rememberMiaSentId(sentId);
  await logMessage({
    patientId: patient.id,
    author: 'mia',
    content: texto,
    whatsappMessageId: sentId,
    metadata: { kind: 'resena' },
  });
  await touchPatientInteraction(patient.id, { authorCounted: 'mia' });
}

// ─── Barrido principal ────────────────────────────────────────────────
export async function runResenasSweep({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'Mia no habilitada' };

  const now = Date.now();
  const r = await listFinishedAppointments({ hoursBack: 24 });
  if (!r.ok) return { ok: false, error: r.error || 'calendario no disponible' };

  const aPedir = [];
  const vistos = new Set();
  for (const appt of r.appointments) {
    try {
      const horasDesdeFin = (now - new Date(appt.fin_iso).getTime()) / HORA;
      if (horasDesdeFin < MIN_HORAS_TRAS_SESION) continue; // muy reciente
      const patient = await findPatientByPhone(appt.phone);
      if (!patient || vistos.has(patient.id)) continue;
      if (await yaPidioResena(patient.id)) continue;
      vistos.add(patient.id);
      aPedir.push({ patient, appt });
    } catch (err) {
      console.error('[mia/resenas] error evaluando cita:', err.message);
    }
  }

  const enHora = enHorarioPermitido(now);
  const tieneLink = Boolean(config.mia.resenas.url);
  const enviar = !dry && config.mia.resenas.enabled && enHora && tieneLink;
  const detalle = [];
  for (const { patient, appt } of aPedir) {
    if (enviar) {
      try {
        await enviarResena(patient);
        detalle.push({ nombre: patient.nombre, phone: patient.phone, cita: appt.etiqueta, enviado: true });
      } catch (err) {
        console.error(`[mia/resenas] error enviando a ${patient.nombre}:`, err.message);
        detalle.push({ nombre: patient.nombre, phone: patient.phone, cita: appt.etiqueta, enviado: false, error: err.message });
      }
    } else {
      detalle.push({ nombre: patient.nombre, phone: patient.phone, cita: appt.etiqueta, enviado: false });
    }
  }

  let modo = 'DRY-RUN';
  if (!dry) {
    if (!config.mia.resenas.enabled) modo = 'DESACTIVADO (no envía)';
    else if (!tieneLink) modo = 'SIN LINK (falta MIA_RESENA_URL)';
    else if (!enHora) modo = `FUERA DE HORARIO (${HORA_INI}-${HORA_FIN}h)`;
    else modo = 'ENVIANDO';
  }
  console.log(`[mia/resenas] ${modo} | citas terminadas=${r.appointments.length} | a pedir=${aPedir.length}`);
  return {
    ok: true,
    dry,
    enabled: config.mia.resenas.enabled,
    tieneLink,
    enHorario: enHora,
    citasTerminadas: r.appointments.length,
    aPedir: aPedir.length,
    detalle,
  };
}

// ─── Cron: cada 30 min (envía solo 8am–9pm) ───────────────────────────
export function startResenasCron() {
  if (!config.mia.resenas.enabled) {
    console.log('[mia/resenas] cron NO iniciado (MIA_RESENA_ENABLED no está en true).');
    return;
  }
  const tz = 'America/Lima';
  const job = async () => {
    try { await runResenasSweep({ dry: false }); }
    catch (err) { console.error('[mia/resenas] sweep falló:', err); }
  };
  cron.schedule('*/30 * * * *', job, { timezone: tz });
  console.log(`[mia/resenas] cron activo | cada 30 min | envía ${HORA_INI}:00–${HORA_FIN}:00 ${tz}`);
}
