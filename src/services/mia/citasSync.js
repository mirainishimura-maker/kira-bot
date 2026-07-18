// NEURA · Citas del panel → Google Calendar (módulo "Conversemos").
// Mirai (o la página pública /agendar) crea citas en la tabla `appointments`.
// Este cron las empuja al Google Calendar real vía Apps Script:
//   - nueva/reprogramada (gcal_pushed=false) → createHold confirmado, o
//     rescheduleAppointment si el paciente ya tenía cita en el calendario.
//   - cancelada (gcal_pushed y no gcal_cancelled) → cancelAppointment.
// Las reservas web además le avisan a Mirai por WhatsApp (una sola vez, al
// momento de empujarse con éxito).

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText } from '../../lib/evolution.js';
import { createHold, rescheduleAppointment, cancelAppointment, getUpcoming, isCalendarEnabled, slotLabel } from './calendar.js';

async function avisarMirai(texto) {
  if (!config.mia.personalPhone) return;
  try { await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, texto); }
  catch (e) { console.error('[neura/citas] aviso a Mirai:', e.message); }
}

export async function runCitasSync() {
  if (!miraiSupabase) return { ok: false, error: 'sin supabase' };
  if (!isCalendarEnabled()) return { ok: false, error: 'calendario no configurado' };

  let pushed = 0, cancelled = 0, failed = 0;

  // 1 · Citas nuevas o reprogramadas → al calendario.
  const { data: nuevas } = await miraiSupabase
    .from('appointments')
    .select('id, start_at, note, source, patient_id, patients(nombre, phone)')
    .eq('status', 'agendada').eq('gcal_pushed', false)
    .gte('start_at', new Date().toISOString())
    .order('start_at').limit(20);

  for (const c of nuevas ?? []) {
    const nombre = c.patients?.nombre || 'Paciente';
    const phone = c.patients?.phone;
    if (!phone) { failed++; console.warn(`[neura/citas] cita ${c.id} sin teléfono — no puedo llevarla al calendario.`); continue; }

    // Si ya tiene una cita en el calendario, esto es una reprogramación.
    let r;
    const up = await getUpcoming({ phone });
    if (up.ok && up.hasAppointment) {
      r = await rescheduleAppointment({ phone, newStartISO: c.start_at });
    } else {
      r = await createHold({ phone, startISO: c.start_at, nombre, motivo: c.note || 'Sesión', tentative: false });
    }
    if (!r.ok) { failed++; console.error(`[neura/citas] push ${nombre}: ${r.error}`); continue; }

    await miraiSupabase.from('appointments').update({ gcal_pushed: true }).eq('id', c.id);
    pushed++;
    if (c.source === 'web') {
      await avisarMirai(`📅 *Nueva reserva web* — ${nombre} (${phone})\n${slotLabel(c.start_at)}${c.note ? `\nMotivo: ${c.note}` : ''}\n\nYa está en tu Google Calendar y en Neura → Agenda ✦`);
    }
  }

  // 2 · Canceladas desde el panel → cancelar en el calendario.
  const { data: canceladas } = await miraiSupabase
    .from('appointments')
    .select('id, start_at, patients(nombre, phone)')
    .eq('status', 'cancelada').eq('gcal_pushed', true).eq('gcal_cancelled', false)
    .limit(20);

  for (const c of canceladas ?? []) {
    const phone = c.patients?.phone;
    if (phone) {
      const r = await cancelAppointment({ phone });
      if (!r.ok) console.warn(`[neura/citas] cancelar ${c.id}: ${r.error} (la marco igual)`);
    }
    await miraiSupabase.from('appointments').update({ gcal_cancelled: true }).eq('id', c.id);
    cancelled++;
  }

  return { ok: true, pushed, cancelled, failed };
}

export function startCitasSyncCron() {
  if (!config.mia.enabled) return;
  cron.schedule('*/3 6-23 * * *', () => {
    runCitasSync().catch((e) => console.error('[neura/citas] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[neura/citas] cron activo (cada 3 min · citas del panel → Google Calendar)');
}
