// Recontacto (follow-up) de leads que se enfriaron. Mia retoma sola, con
// calidez y sin ser pesada, a los leads que quedaron a mitad de camino.
//
// Cadencia (6 toques, gap desde el último mensaje):
//   1 → 1h | 2 → +2h | 3 → +24h | 4 → +3d | 5 → +7d | 6 → +30d
// Toques 1-3 (rápidos): mensaje de TEXTO personal (con el nombre).
// Toques 4-6 (lentos): NOTIFICACIÓN-IMAGEN (la frase va dentro de la imagen).
//
// SEGURIDAD: solo envía si config.mia.recontacto.enabled === true, y solo en la
// ventana horaria permitida (8am–9pm Lima). El cron corre cada 30 min. El modo
// dry-run calcula a quién contactaría SIN enviar nada.
//
// Estado por paciente: se calcula del log de `conversations` (cuenta los
// mensajes con metadata.kind='recontacto' posteriores al último mensaje del
// paciente). Si el paciente responde, el contador se reinicia solo.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText, sendImage } from '../../lib/evolution.js';
import { recentMessages, logMessage } from './conversations.js';
import { touchPatientInteraction } from './patients.js';
import { rememberMiaSentId } from './echoTracker.js';
import { getUpcoming } from './calendar.js';
import { aplicarNombre, pickVariante } from './text.js';

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

// Cadencia + tipo de cada toque. gap = cuánto esperar desde el último mensaje.
// notif=true → notificación-imagen (la frase está en la imagen, va sin texto).
const TOQUES = [
  { gap: 1 * HORA,  notif: false }, // 1
  { gap: 2 * HORA,  notif: false }, // 2
  { gap: 24 * HORA, notif: false }, // 3
  { gap: 3 * DIA,   notif: true  }, // 4
  { gap: 7 * DIA,   notif: true  }, // 5
  { gap: 30 * DIA,  notif: true  }, // 6
];
const GAPS = TOQUES.map(t => t.gap);
const MAX_TOQUES = TOQUES.length; // 6

// Ventana horaria de ENVÍO (hora Lima). Fuera de esto no se manda (lo vencido
// de madrugada espera al próximo tick dentro de hora).
const HORA_INI = 8;   // 8 am
const HORA_FIN = 21;  // 9 pm (no inclusive)

// Estados que YA cerraron el ciclo (no se recontactan).
const ESTADOS_EXCLUIDOS = new Set([
  'agendado', 'paciente_activo', 'cita_confirmada', 'rechazado',
  'alta', 'silenciada', 'no_responde',
]);

// ─── Plantillas por toque ─────────────────────────────────────────────
// Toques 1-3: texto personal (usan {nombre}). Toques 4-6: la frase que va
// DENTRO de la notificación-imagen (sin emoji, sin {nombre} — la imagen es fija).
const PLANTILLAS = [
  // 1 (1h)
  ['Hola {nombre} 🌸 ¿seguimos? quedé pendiente de tu respuesta 💛',
   '{nombre}, ¿te quedó alguna duda? Aquí sigo para ayudarte ☺️'],
  // 2 (+2h)
  ['{nombre}, cualquier cosa que necesites para decidir, aquí estoy 🌸',
   '¿Te ayudo con algo más para coordinar, {nombre}? 💛'],
  // 3 (+24h)
  ['Hola {nombre} 🌸 ¿retomamos cuando puedas? Aquí estoy 💛',
   'Hola {nombre} ☺️ quedó algo pendiente y no quise dejarte sin seguimiento. ¿Seguimos cuando gustes? 🌸'],
  // 4 (+3d) — frase de la notificación-imagen
  ['Dar el primer paso no siempre es fácil, y está bien ir a tu ritmo'],
  // 5 (+7d)
  ['Cuando sea tu momento, aquí hay un espacio para ti'],
  // 6 (+30d)
  ['¿Cómo has estado? Cada paso cuenta, incluso el primero'],
];

// Notificación-imagen del toque: toques 4,5,6 → images[0],[1],[2].
function imagenParaToque(touch) {
  const imgs = config.mia.recontacto.images;
  return imgs[touch - 4] || null;
}

// ─── Hora Lima / ventana de envío ─────────────────────────────────────
function horaLima(now) {
  // 'sv-SE' da "YYYY-MM-DD HH:MM:SS" → la hora sale en slice(11,13).
  return Number(new Date(now).toLocaleString('sv-SE', { timeZone: 'America/Lima' }).slice(11, 13));
}
function enHorarioPermitido(now) {
  const h = horaLima(now);
  return h >= HORA_INI && h < HORA_FIN;
}

// ─── Candidatos: pacientes en estado "abierto" (no cerrados) ──────────
async function listCandidatos() {
  if (!miraiSupabase) return [];
  const { data, error } = await miraiSupabase
    .from('patients')
    .select('id, nombre, phone, estado')
    .limit(500);
  if (error) {
    console.error('[mia/recontacto] listCandidatos error:', error.message);
    return [];
  }
  return (data ?? []).filter(p => !ESTADOS_EXCLUIDOS.has(String(p.estado || '')));
}

// ─── Decide el toque pendiente de un paciente (o null si no toca) ──────
async function evaluarPaciente(patient, now) {
  const msgs = await recentMessages(patient.id, 60); // cronológico asc
  if (!msgs.length) return null;

  const last = msgs[msgs.length - 1];
  // Solo recontactamos si el último que habló fue MIA (en automático). Si el
  // último es el paciente → es nuestro turno de responder. Si es Mirai → ella
  // está atendiendo manual, no nos metemos.
  if (last.author !== 'mia') return null;

  // Si el paciente YA RESPONDIÓ a un recontacto (hay un mensaje suyo DESPUÉS de
  // algún recontacto), se re-enganchó: NO se le manda más recontacto. De ahí en
  // adelante lo atiende el flujo normal de triage / Mirai.
  let ultimoRecontactoIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.author === 'mia' && m.metadata && m.metadata.kind === 'recontacto') { ultimoRecontactoIdx = i; break; }
  }
  if (ultimoRecontactoIdx >= 0) {
    for (let i = ultimoRecontactoIdx + 1; i < msgs.length; i++) {
      if (msgs[i].author === 'patient') return null; // contestó a un recontacto → stop
    }
  }

  // Último mensaje del paciente (para reiniciar el contador si respondió).
  let lastPatientTime = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].author === 'patient') { lastPatientTime = msgs[i].created_at; break; }
  }

  // Recontactos enviados DESPUÉS de la última respuesta del paciente.
  const toquesPrevios = msgs.filter(m =>
    m.author === 'mia' &&
    m.metadata && m.metadata.kind === 'recontacto' &&
    (!lastPatientTime || m.created_at > lastPatientTime),
  ).length;

  if (toquesPrevios >= MAX_TOQUES) return null; // ya agotamos los toques

  const refTime = new Date(last.created_at).getTime();
  const requiredGap = GAPS[toquesPrevios];
  if (now - refTime < requiredGap) return null; // todavía no toca

  // Backstop contra el calendario real: si el lead YA tiene una cita CONFIRMADA,
  // no se recontacta (ya agendó). Un hold sin pagar SÍ se puede nudgear.
  try {
    const up = await getUpcoming({ phone: patient.phone });
    if (up.ok && up.hasAppointment && up.estado === 'confirmada') return null;
  } catch { /* si la consulta de calendario falla, seguimos: el filtro de estado igual aplica */ }

  return { touch: toquesPrevios + 1, refTime };
}

// ─── Envía un toque concreto ──────────────────────────────────────────
async function enviarToque(patient, touch) {
  const jid = `${patient.phone}@s.whatsapp.net`;
  const esNotif = TOQUES[touch - 1].notif;
  const url = esNotif ? imagenParaToque(touch) : null;

  if (esNotif && url) {
    // Notificación-imagen: la frase ya está en la imagen → mandamos solo la imagen.
    const img = await sendImage(jid, url);
    const imgId = img?.key?.id ?? null;
    if (imgId) rememberMiaSentId(imgId);
    await logMessage({
      patientId: patient.id,
      author: 'mia',
      content: `[recontacto notif] ${PLANTILLAS[touch - 1][0]}`,
      messageType: 'image',
      whatsappMessageId: imgId,
      metadata: { kind: 'recontacto', touch, image_url: url },
    });
    await touchPatientInteraction(patient.id, { authorCounted: 'mia' });
    return;
  }

  // Texto (toques rápidos, o fallback si no hay imagen configurada para un notif).
  const texto = aplicarNombre(pickVariante(PLANTILLAS[touch - 1], patient.phone, touch), patient.nombre);
  const sent = await sendText(jid, texto);
  const sentId = sent?.key?.id ?? null;
  if (sentId) rememberMiaSentId(sentId);
  await logMessage({
    patientId: patient.id,
    author: 'mia',
    content: texto,
    whatsappMessageId: sentId,
    metadata: { kind: 'recontacto', touch },
  });
  await touchPatientInteraction(patient.id, { authorCounted: 'mia' });
}

// ─── Barrido principal ────────────────────────────────────────────────
// dry=true → solo calcula a quién contactaría, NO envía.
export async function runRecontactoSweep({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'Mia no habilitada' };

  const now = Date.now();
  const candidatos = await listCandidatos();
  const aContactar = [];

  for (const p of candidatos) {
    try {
      const due = await evaluarPaciente(p, now);
      if (due) aContactar.push({ patient: p, touch: due.touch });
    } catch (err) {
      console.error(`[mia/recontacto] error evaluando ${p.nombre}:`, err.message);
    }
  }

  const enHora = enHorarioPermitido(now);
  const enviar = !dry && config.mia.recontacto.enabled && enHora;
  const resultados = [];
  for (const { patient, touch } of aContactar) {
    if (enviar) {
      try {
        await enviarToque(patient, touch);
        resultados.push({ nombre: patient.nombre, phone: patient.phone, touch, enviado: true });
      } catch (err) {
        console.error(`[mia/recontacto] error enviando a ${patient.nombre}:`, err.message);
        resultados.push({ nombre: patient.nombre, phone: patient.phone, touch, enviado: false, error: err.message });
      }
    } else {
      resultados.push({ nombre: patient.nombre, phone: patient.phone, touch, enviado: false });
    }
  }

  let modo = 'DRY-RUN';
  if (!dry) {
    if (!config.mia.recontacto.enabled) modo = 'DESACTIVADO (no envía)';
    else if (!enHora) modo = `FUERA DE HORARIO (${HORA_INI}-${HORA_FIN}h, no envía ahora)`;
    else modo = 'ENVIANDO';
  }
  console.log(`[mia/recontacto] ${modo} | candidatos=${candidatos.length} | a contactar=${aContactar.length}`);
  return {
    ok: true,
    dry,
    enabled: config.mia.recontacto.enabled,
    enHorario: enHora,
    revisados: candidatos.length,
    aContactar: aContactar.length,
    detalle: resultados,
  };
}

// ─── Cron: cada 30 min (envía solo en la ventana 8am–9pm) ─────────────
export function startRecontactoCron() {
  if (!config.mia.recontacto.enabled) {
    console.log('[mia/recontacto] cron NO iniciado (MIA_RECONTACTO_ENABLED no está en true).');
    return;
  }
  const tz = 'America/Lima';
  const job = async () => {
    try { await runRecontactoSweep({ dry: false }); }
    catch (err) { console.error('[mia/recontacto] sweep falló:', err); }
  };
  cron.schedule('*/30 * * * *', job, { timezone: tz });
  console.log(`[mia/recontacto] cron activo | cada 30 min | envía ${HORA_INI}:00–${HORA_FIN}:00 ${tz}`);
}
