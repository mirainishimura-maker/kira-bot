// Detector de horarios (salvavidas anti-olvido). Escanea los mensajes ENTRANTES
// de los contactos y, si detectan una hora/cita propuesta, le manda un aviso a
// Mirai para que la agende (con /agendar o /bloquear) y no se le pase — como
// pasó con la cita que se cruzó por no quedar en el calendario.
//
// Solo AVISA a Mirai; nunca agenda solo. Throttle por contacto para no spamear.
// Se apaga con MIA_HORARIO_DETECTOR_ENABLED='false'.

import { config } from '../../config.js';
import { sendText } from '../../lib/evolution.js';
import { findPatientByPhone, normalizePhone } from './patients.js';
import { rememberMiaSentId } from './echoTracker.js';

const ENABLED = process.env.MIA_HORARIO_DETECTOR_ENABLED !== 'false';
const THROTTLE_MS = 15 * 60 * 1000;      // máx 1 aviso por contacto cada 15 min
const ultimoAviso = new Map();           // phone → timestamp (en memoria)

// Patrones de hora/cita en español-Perú. Afinados con chats reales:
// detectan "de las 5", "a las 4:45", "horario de 4", "jueves 4pm", "16:30"…
// y NO disparan con precios, teléfonos, "en 4 cuotas", saludos.
const PATTERNS = [
  /\b(?:a|de|para)?\s*las?\s+\d{1,2}(?::\d{2})?(?:\s?(?:h|hrs?|horas?|am|pm|a\.?\s?m\.?|p\.?\s?m\.?))?/i,
  /\b\d{1,2}:\d{2}\b/,
  /\b\d{1,2}\s?(?:am|pm|a\.?\s?m\.?|p\.?\s?m\.?)\b/i,
  /\b\d{1,2}\s+(?:de la|en la|por la)\s+(?:mañana|tarde|noche)\b/i,
  /\bhorario\s+(?:de\s+)?(?:las?\s+)?\d{1,2}(?::\d{2})?/i,
  /\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|hoy|ma[ñn]ana|pasado)\b[^.!?\n]{0,24}?\b(?:las?\s+)?\d{1,2}(?::\d{2})?\b/i,
];

export function detectarPropuestaHorario(text) {
  if (!text) return null;
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

// Escanea un mensaje entrante y, si hay horario, avisa a Mirai. No bloquea el
// flujo (se llama fire-and-forget desde el webhook).
export async function detectarHorarioYAvisar({ phone, nombre, text }) {
  try {
    if (!ENABLED || !config.mia.enabled || !config.mia.personalPhone || !text) return;
    const norm = normalizePhone(phone);
    if (!norm) return;
    // No avisar por mensajes de la propia Mirai / operadores / referidores.
    if (norm === config.mia.personalPhone
      || config.mia.operatorPhones.includes(norm)
      || config.mia.referrerPhones.includes(norm)) return;

    const hit = detectarPropuestaHorario(text);
    if (!hit) return;

    const last = ultimoAviso.get(norm) || 0;
    if (Date.now() - last < THROTTLE_MS) return; // ya avisé por este contacto hace poco
    ultimoAviso.set(norm, Date.now());

    const patient = await findPatientByPhone(norm).catch(() => null);
    const quien = patient?.nombre || (nombre && nombre.trim()) || norm;
    const primerNombre = String(quien).split(/\s+/)[0];

    const aviso =
      `📅 *Posible cita en un chat*\n` +
      `${quien} (${norm}) escribió:\n"${text.slice(0, 280)}"\n\n` +
      `⏰ Detecté: *${hit}*\n\n` +
      `Si es una cita, agéndala para que NO se te pase:\n` +
      `• /agendar ${norm} ${primerNombre}\n` +
      `• o resérvate el horario: /bloquear <cuándo> ${primerNombre}`;

    const sent = await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, aviso);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
    console.log(`[mia/detector] aviso de horario a Mirai por ${norm}: "${hit}"`);
  } catch (err) {
    console.warn('[mia/detector] error:', err.message);
  }
}
