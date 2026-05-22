// Auto-intake de leads desde notas que Mirai recibe en su personal y reenvía
// a kiramkt. Ejemplos de mensajes que dispara este flujo:
//
//   "989 928 974
//    maykol Jhacson peña García
//    Moyobamba, San Martin, Perú
//    PACIENTE INTERESADA EN CONSULTA"
//
//   "993 858 424 pcte. Rosa interesada en campaña"
//
//   "991 156 035 pcte.Luciano interesado en campaña"
//
// Heurística: si el mensaje viene desde MIRAI_PERSONAL_PHONE y contiene un
// teléfono peruano de 9 dígitos (empezando con 9) MÁS alguna palabra clave
// de lead, lo tratamos como nota de intake.

import { addPatient, normalizePhone } from './patients.js';
import { logMessage } from './conversations.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';

// Palabras que indican "esto es un lead, no un comando ni una nota cualquiera".
const LEAD_KEYWORDS = /\b(pcte|paciente|interesad[ao]s?|campa[ñn]a|consulta|contacto|saluda[mr]?|saludo)\b/i;

// Palabras que NUNCA son un nombre propio (filtran falsos positivos).
const STOP_WORDS = /^(?:interesad[ao]?s?|paciente|pcte|consulta|consul|campa[ñn]a|contacto|saluda[mr]?|saluda|saludo|hola|hi|gracias|si|sí|no|de|en|por|para|con|sobre|desde|hasta|esta|este|ese|esa|le|la|el|los|las|un|una|y|o)$/i;

// Teléfono peruano: 9 dígitos empezando con 9. Puede tener espacios.
const PHONE_RE = /(?:\+?51)?\s*(9\d{2})\s*(\d{3})\s*(\d{3})\b/g;

function extractNombre(text) {
  // Patrón 1: "pcte. <NOMBRE>", "pcte.<NOMBRE>" o "paciente <NOMBRE>" hasta keyword/stop word.
  const m1 = text.match(/\b(?:pcte\.?|paciente)\.?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ][^\n]*)/i);
  if (m1) {
    const words = m1[1].trim().split(/\s+/);
    const nombreWords = [];
    for (const w of words) {
      const clean = w.replace(/[.,;:!?]+$/, '');
      if (!clean) break;
      if (STOP_WORDS.test(clean)) break;
      if (LEAD_KEYWORDS.test(clean)) break;
      nombreWords.push(clean);
      if (nombreWords.length >= 4) break;
    }
    if (nombreWords.length >= 1) {
      const cand = nombreWords.join(' ');
      // Validar que al menos una palabra empiece con letra (no número).
      if (/[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(cand)) return cand;
    }
  }

  // Patrón 2: línea con nombre propio al inicio (toma palabras hasta "..." o keyword).
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    PHONE_RE.lastIndex = 0;
    if (PHONE_RE.test(line)) { PHONE_RE.lastIndex = 0; continue; }
    const words = line.split(/\s+/);
    const nombreWords = [];
    for (const w of words) {
      // "..." o ":" indica fin del nombre.
      if (/^[.…:]+$/.test(w) || /[.…]{2,}/.test(w)) break;
      const clean = w.replace(/[.,;:!?]+$/, '');
      if (!clean) break;
      if (STOP_WORDS.test(clean)) break;
      if (LEAD_KEYWORDS.test(clean)) break;
      nombreWords.push(clean);
      if (nombreWords.length >= 5) break;
    }
    if (nombreWords.length >= 1) {
      // Requerir al menos una palabra con mayúscula inicial.
      const hasTitle = nombreWords.some(w => /^[A-ZÁÉÍÓÚÑ]/.test(w));
      if (hasTitle) return nombreWords.join(' ');
      // Si todas son minúscula pero hay 2+ palabras, asumir nombre escrito en lower (ej: "maykol jhacson").
      if (nombreWords.length >= 2 && /^[a-záéíóúñ]/.test(nombreWords[0])) {
        return nombreWords.join(' ');
      }
    }
  }

  return null;
}

export function detectLeadNote(text) {
  if (!text || typeof text !== 'string') return null;
  if (text.trim().startsWith('/')) return null;
  if (!LEAD_KEYWORDS.test(text)) return null;

  PHONE_RE.lastIndex = 0;
  const m = PHONE_RE.exec(text);
  if (!m) return null;

  const phone = `51${m[1]}${m[2]}${m[3]}`;
  let nombre = extractNombre(text);
  if (nombre) nombre = nombre.slice(0, 60).replace(/\s+/g, ' ').trim();

  return {
    phone,
    nombre: nombre || 'Lead pendiente',
    rawText: text,
  };
}

const SALUDO_BURBUJAS = [
  'Hola! Te habla Mia, la asistente de la Psic. Mirai Nishimura 🌸',
  'Recibí tu contacto para información de sesión psicológica 🤍',
  '¿La consulta es para ti o para alguien más?',
];

export async function handleLeadIntake(text) {
  const detected = detectLeadNote(text);
  if (!detected) return null;

  let result;
  try {
    result = await addPatient({
      phone: detected.phone,
      nombre: detected.nombre,
      etiqueta: 'lead_campaña',
    });
  } catch (err) {
    return { messages: [{ channel: 'private', text: `⚠️ No pude agregar al lead (${detected.phone}): ${err.message}` }] };
  }

  const patient = result.patient;
  const wasDuplicated = result.duplicated;

  // Si ya existía y no es lead nuevo, no enviamos saludo (evitamos spammear).
  if (wasDuplicated) {
    return {
      messages: [{
        channel: 'private',
        text: `ℹ️ ${patient.nombre} (${patient.phone}) ya estaba en la lista — no le envío saludo de nuevo.`,
      }],
    };
  }

  // Guardar la nota original como nota privada del paciente.
  // (Para que Mirai vea el contexto que le pasó la asistente.)
  try {
    await logMessage({
      patientId: patient.id,
      author: 'mirai',
      content: `[nota interna de Mirai] ${detected.rawText.slice(0, 1000)}`,
      messageType: 'system',
      metadata: { kind: 'intake_note' },
    });
  } catch (err) {
    console.warn('[mia/intake] no pude loguear nota interna:', err.message);
  }

  // Enviar saludo al lead.
  const recipientJid = `${patient.phone}@s.whatsapp.net`;
  const sentResults = [];
  for (const burbuja of SALUDO_BURBUJAS) {
    try {
      const sent = await sendText(recipientJid, burbuja);
      const sentId = sent?.key?.id ?? null;
      if (sentId) rememberMiaSentId(sentId);
      await logMessage({
        patientId: patient.id,
        author: 'mia',
        content: burbuja,
        whatsappMessageId: sentId,
        metadata: { kind: 'auto_intake_saludo' },
      });
      sentResults.push({ ok: true, sentId });
    } catch (err) {
      console.error('[mia/intake] error enviando saludo:', err.message);
      sentResults.push({ ok: false, error: err.message });
    }
  }

  const sentOk = sentResults.filter(r => r.ok).length;
  const sentFail = sentResults.length - sentOk;
  const fragmentoMsg = `✓ Lead agregado: ${patient.nombre} (${patient.phone})\n` +
    `Etiqueta: lead_campaña\n` +
    `Saludo enviado: ${sentOk}/${sentResults.length} burbujas` +
    (sentFail ? ' (alguna falló — revisar logs)' : '');

  return {
    messages: [{ channel: 'private', text: fragmentoMsg }],
  };
}
