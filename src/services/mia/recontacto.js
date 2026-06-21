// Recontacto (follow-up) de leads que se enfriaron. Mia retoma sola, con
// calidez y sin ser pesada, a los leads que quedaron a mitad de camino.
//
// Cadencia (configurable abajo): 1er toque a las 24h de quedar callado el lead,
// 2do a +3 días, 3ro a +7 días, y una reactivación a +30 días. Máx esos toques.
// El 1er toque va solo texto; del 2do en adelante suma una imagen cálida.
//
// SEGURIDAD: solo envía si config.mia.recontacto.enabled === true. El modo
// dry-run calcula a quién contactaría SIN enviar nada (para revisar antes).
//
// Estado por paciente: NO usa columnas nuevas — se calcula del log de
// `conversations` (cuenta los mensajes con metadata.kind='recontacto' que se
// mandaron DESPUÉS del último mensaje del paciente). Si el paciente responde,
// el contador se reinicia solo.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText, sendImage } from '../../lib/evolution.js';
import { recentMessages, logMessage } from './conversations.js';
import { touchPatientInteraction } from './patients.js';
import { rememberMiaSentId } from './echoTracker.js';
import { getUpcoming } from './calendar.js';

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

// Gaps por toque ya enviado → cuánto esperar para el siguiente.
//   0 toques → 1er recontacto a las 24h | 1 → +3d | 2 → +7d | 3 → +30d (reactivación)
const GAPS = [24 * HORA, 3 * DIA, 7 * DIA, 30 * DIA];
const MAX_TOQUES = GAPS.length; // 4 (3 seguidos + 1 reactivación)

// Estados que YA cerraron el ciclo (no se recontactan).
const ESTADOS_EXCLUIDOS = new Set([
  'agendado', 'paciente_activo', 'cita_confirmada', 'rechazado',
  'alta', 'silenciada', 'no_responde',
]);

// ─── Plantillas por toque (varían; se elige una de forma estable por paciente) ──
// {nombre} se reemplaza por el primer nombre del paciente.
// Estilo corto y cálido (tipo @ineswillis): poco texto, mucho sentimiento. La
// frase va como burbuja de WhatsApp; del 2º toque en adelante la acompaña una
// imagen que combina con la frase (manos / sillón / planta).
const PLANTILLAS = [
  // Toque 1 — recordatorio suave (sin imagen)
  [
    'Hola {nombre} 🌸 ¿retomamos cuando puedas? Aquí sigo para acompañarte 💛',
    'Hola {nombre} ☺️ quedó algo pendiente y no quise dejarte sin seguimiento. ¿Seguimos cuando gustes? 🌸',
  ],
  // Toque 2 — manos / apoyo (con imagen)
  [
    'Dar el primer paso no siempre es fácil, y está bien ir a tu ritmo 💛',
    'Pedir ayuda también es un acto de valentía 🌸',
  ],
  // Toque 3 — espacio seguro / sillón (con imagen). NEUTRO (m/f).
  [
    'Cuando sea tu momento, aquí hay un espacio para ti 🌸',
    'Tu espacio sigue abierto, sin apuro 🌷',
  ],
  // Toque 4 — reactivación / planta (con imagen)
  [
    '¿Cómo has estado, {nombre}? Cada paso cuenta, incluso el primero 🌱',
    'Hola {nombre} 🌷 pasó un tiempo y quería saber de ti. Aquí seguimos para acompañarte 💛',
  ],
];

function primerNombre(nombre) {
  return String(nombre || '').trim().split(/\s+/)[0] || 'hola';
}

// Pick estable (mismo paciente+toque → misma variante) sin Math.random.
function pickVariante(arr, phone, touch) {
  if (arr.length === 1) return arr[0];
  let h = touch;
  for (const ch of String(phone)) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  return arr[h % arr.length];
}

function imagenParaToque(touch) {
  const imgs = config.mia.recontacto.images;
  if (!imgs.length) return null;
  // touch 2,3,4 llevan imagen; rotamos por el índice del toque.
  return imgs[(touch - 2) % imgs.length] || imgs[0];
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
// Devuelve { touch, refTime } donde touch es el número (1..MAX) a enviar.
async function evaluarPaciente(patient, now) {
  const msgs = await recentMessages(patient.id, 60); // cronológico asc
  if (!msgs.length) return null;

  const last = msgs[msgs.length - 1];
  // Solo recontactamos si el último que habló fue MIA (nosotros, en automático).
  // Si el último es el paciente → es nuestro turno de responder, no recontactar.
  // Si el último es Mirai → ella está atendiendo manual, no nos metemos.
  if (last.author !== 'mia') return null;

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
  const texto = pickVariante(PLANTILLAS[touch - 1], patient.phone, touch)
    .replaceAll('{nombre}', primerNombre(patient.nombre));

  // 1) Texto
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

  // 2) Imagen (del 2do toque en adelante, si hay set configurado)
  if (touch >= 2) {
    const url = imagenParaToque(touch);
    if (url) {
      try {
        const img = await sendImage(jid, url);
        const imgId = img?.key?.id ?? null;
        if (imgId) rememberMiaSentId(imgId);
        await logMessage({
          patientId: patient.id,
          author: 'mia',
          content: `[imagen recontacto]`,
          messageType: 'image',
          whatsappMessageId: imgId,
          metadata: { kind: 'recontacto', touch, image_url: url },
        });
      } catch (err) {
        console.error(`[mia/recontacto] error enviando imagen a ${patient.nombre}:`, err.message);
      }
    }
  }
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

  const enviar = !dry && config.mia.recontacto.enabled;
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

  const modo = dry ? 'DRY-RUN' : (config.mia.recontacto.enabled ? 'ENVIANDO' : 'DESACTIVADO (no envía)');
  console.log(`[mia/recontacto] ${modo} | candidatos=${candidatos.length} | a contactar=${aContactar.length}`);
  return {
    ok: true,
    dry,
    enabled: config.mia.recontacto.enabled,
    revisados: candidatos.length,
    aContactar: aContactar.length,
    detalle: resultados,
  };
}

// ─── Cron: ventanas de buena respuesta (11am y 7pm, lun-sáb, hora Lima) ──
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
  // 11:00 y 19:00, de lunes a sábado (evitamos domingo).
  cron.schedule('0 11 * * 1-6', job, { timezone: tz });
  cron.schedule('0 19 * * 1-6', job, { timezone: tz });
  console.log(`[mia/recontacto] cron activo | TZ=${tz} | 11:00 y 19:00 (lun-sáb)`);
}
