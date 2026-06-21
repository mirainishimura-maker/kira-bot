// Recordatorios de cita: Mia le recuerda al paciente su cita CONFIRMADA para
// bajar los no-shows. Dos recordatorios por cita:
//   R24 — "día antes" (cuando faltan entre 4h y 24h, una vez)
//   R3  — "mismo día" (cuando faltan entre 0 y 3h, una vez)
//
// SEGURIDAD: solo envía si config.mia.recordatorios.enabled === true y dentro de
// la ventana 8am–9pm Lima. Dry-run calcula a quién recordaría sin enviar.
//
// Dedup: lee la cita real del calendario (listUpcomingAppointments) y marca cada
// recordatorio en `conversations` con metadata { kind:'recordatorio', tipo,
// appt: <inicio_iso> }. Si la cita se reprograma (otro inicio_iso), se manda de
// nuevo. Si el paciente ya recibió ese tipo para esa cita, no se repite.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText } from '../../lib/evolution.js';
import { recentMessages, logMessage } from './conversations.js';
import { touchPatientInteraction, findPatientByPhone } from './patients.js';
import { rememberMiaSentId } from './echoTracker.js';
import { listUpcomingAppointments, slotLabel } from './calendar.js';
import { aplicarNombre, pickVariante } from './text.js';

const HORA = 60 * 60 * 1000;
const HORA_INI = 8;
const HORA_FIN = 21;

// Mensajes (NEUTROS m/f). {nombre}, {fecha_hora} (ej "martes 24 de junio, 4:00 p. m."), {hora} (ej "4 pm").
const MSG = {
  r24: [
    'Hola {nombre} 🌸 te recuerdo tu cita con la Psicóloga Mirai el {fecha_hora}. ¿Me confirmas que podrás asistir? 💛',
    'Hola {nombre} ☺️ un recordatorio cariñoso: tu cita con la Psicóloga Mirai es el {fecha_hora}. ¿La confirmamos? 🌸',
  ],
  r3: [
    'Hola {nombre} 🌸 te espero hoy a las {hora} para tu cita con la Psicóloga Mirai. ¡Nos vemos! 💛',
    '{nombre}, recordá que hoy a las {hora} es tu cita con la Psicóloga Mirai ☺️ aquí te esperamos 🌸',
  ],
};

function horaLima(now) {
  return Number(new Date(now).toLocaleString('sv-SE', { timeZone: 'America/Lima' }).slice(11, 13));
}
function enHorarioPermitido(now) {
  const h = horaLima(now);
  return h >= HORA_INI && h < HORA_FIN;
}

// "...T16:00:00-05:00" → "4 pm" / "4:30 pm" (la hora ya está en hora Lima).
function horaCorta(iso) {
  const h24 = parseInt(iso.slice(11, 13), 10);
  const min = iso.slice(14, 16);
  const h12 = (h24 % 12) || 12;
  const mer = h24 < 12 ? 'am' : 'pm';
  return min === '00' ? `${h12} ${mer}` : `${h12}:${min} ${mer}`;
}

// Decide qué recordatorio toca para una cita (o null).
function recordatorioPendiente(appt, msgs, now) {
  const start = new Date(appt.inicio_iso).getTime();
  const horasFalta = (start - now) / HORA;

  const enviados = new Set(
    (msgs || [])
      .filter(m => m.metadata && m.metadata.kind === 'recordatorio' && m.metadata.appt === appt.inicio_iso)
      .map(m => m.metadata.tipo),
  );

  if (horasFalta > 4 && horasFalta <= 24 && !enviados.has('r24')) return 'r24';
  if (horasFalta > 0 && horasFalta <= 3  && !enviados.has('r3'))  return 'r3';
  return null;
}

async function enviarRecordatorio(patient, appt, tipo) {
  const jid = `${patient.phone}@s.whatsapp.net`;
  const texto = aplicarNombre(pickVariante(MSG[tipo], patient.phone, tipo), patient.nombre)
    .replaceAll('{fecha_hora}', slotLabel(appt.inicio_iso))
    .replaceAll('{hora}', horaCorta(appt.inicio_iso));

  const sent = await sendText(jid, texto);
  const sentId = sent?.key?.id ?? null;
  if (sentId) rememberMiaSentId(sentId);
  await logMessage({
    patientId: patient.id,
    author: 'mia',
    content: texto,
    whatsappMessageId: sentId,
    metadata: { kind: 'recordatorio', tipo, appt: appt.inicio_iso },
  });
  await touchPatientInteraction(patient.id, { authorCounted: 'mia' });
}

// ─── Barrido principal ────────────────────────────────────────────────
export async function runRecordatoriosSweep({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'Mia no habilitada' };

  const now = Date.now();
  const r = await listUpcomingAppointments({ hoursAhead: 30 });
  if (!r.ok) return { ok: false, error: r.error || 'calendario no disponible' };

  const aRecordar = [];
  for (const appt of r.appointments) {
    try {
      const patient = await findPatientByPhone(appt.phone);
      if (!patient) continue;
      const msgs = await recentMessages(patient.id, 40);
      const tipo = recordatorioPendiente(appt, msgs, now);
      if (tipo) aRecordar.push({ patient, appt, tipo });
    } catch (err) {
      console.error('[mia/recordatorios] error evaluando cita:', err.message);
    }
  }

  const enHora = enHorarioPermitido(now);
  const enviar = !dry && config.mia.recordatorios.enabled && enHora;
  const detalle = [];
  for (const { patient, appt, tipo } of aRecordar) {
    if (enviar) {
      try {
        await enviarRecordatorio(patient, appt, tipo);
        detalle.push({ nombre: patient.nombre, phone: patient.phone, tipo, cita: appt.etiqueta, enviado: true });
      } catch (err) {
        console.error(`[mia/recordatorios] error enviando a ${patient.nombre}:`, err.message);
        detalle.push({ nombre: patient.nombre, phone: patient.phone, tipo, cita: appt.etiqueta, enviado: false, error: err.message });
      }
    } else {
      detalle.push({ nombre: patient.nombre, phone: patient.phone, tipo, cita: appt.etiqueta, enviado: false });
    }
  }

  let modo = 'DRY-RUN';
  if (!dry) {
    if (!config.mia.recordatorios.enabled) modo = 'DESACTIVADO (no envía)';
    else if (!enHora) modo = `FUERA DE HORARIO (${HORA_INI}-${HORA_FIN}h)`;
    else modo = 'ENVIANDO';
  }
  console.log(`[mia/recordatorios] ${modo} | citas próximas=${r.appointments.length} | a recordar=${aRecordar.length}`);
  return {
    ok: true,
    dry,
    enabled: config.mia.recordatorios.enabled,
    enHorario: enHora,
    citasProximas: r.appointments.length,
    aRecordar: aRecordar.length,
    detalle,
  };
}

// ─── Cron: cada 30 min (envía solo 8am–9pm) ───────────────────────────
export function startRecordatoriosCron() {
  if (!config.mia.recordatorios.enabled) {
    console.log('[mia/recordatorios] cron NO iniciado (MIA_RECORDATORIOS_ENABLED no está en true).');
    return;
  }
  const tz = 'America/Lima';
  const job = async () => {
    try { await runRecordatoriosSweep({ dry: false }); }
    catch (err) { console.error('[mia/recordatorios] sweep falló:', err); }
  };
  cron.schedule('*/30 * * * *', job, { timezone: tz });
  console.log(`[mia/recordatorios] cron activo | cada 30 min | envía ${HORA_INI}:00–${HORA_FIN}:00 ${tz}`);
}
