// Detección de leads "orgánicos": cuando un desconocido escribe directo a
// kiramkt sin haber pasado por el intake de la asistente. Si el mensaje
// tiene keywords típicas de lead (consulta, terapia, ansiedad, etc.), Mia
// notifica a Mirai en su personal con un comando listo para pegar.
//
// Para no spammear, in-memory dedup: no se notifica el mismo número en
// menos de 1h.

import { config } from '../../config.js';
import { sendText } from '../../lib/evolution.js';

// Keywords que sugieren que el mensaje es de un posible lead.
// Lista pensada en español peruano + términos clínicos comunes.
// Sin \b al final para que matchee terminaciones como "consulta", "psicóloga", etc.
// Keywords que sugieren INTENCIÓN clara de lead (clínicas + de agenda + del
// embudo de la guía). Se quitaron las genéricas ("ayuda", "info", "atención")
// para no auto-responder a contactos viejos que escriben cosas casuales.
// 2 ago 2026: se devolvieron "información/informes/info" y se sumó "test"
// porque el CTA de los anuncios de Meta prellena "¡Hola! Quiero más
// información" — sin ellas, los leads PAGADOS caían en silencio (caso real:
// 936838751, 2 ago). El riesgo de contacto viejo se cubre con el aviso a
// Mirai de más abajo.
const LEAD_KEYWORDS = /\b(consult\w*|sesi[oó]n\w*|terapia\w*|terapeut\w*|psic[oó]log\w*|psicolog\w*|ansiedad\w*|depresi[oó]n|depre\w*|emdr|trauma\w*|autoestima\w*|duelo\w*|p[aá]nico\w*|crisis|agendar|agenda\w*|cita\w*|reserv\w*|precio\w*|costo\w*|cuesta\w*|inversi[oó]n\w*|s[aá]nar\w*|gu[íi]a\w*|ejercicio\w*|estr[eé]s\w*|insomnio\w*|informaci[oó]n|informes|info|test\w*)\b/i;

// Mensaje que llega desde un ANUNCIO de Meta (click-to-WhatsApp): WhatsApp
// adjunta la tarjeta del anuncio en contextInfo.externalAdReply / ctwaContext.
// Si viene de ahí es un lead pagado con certeza — se atiende sin exigir
// palabras clave (el CTA suele ser un "Hola" pelado).
export function detectAdReferral(data) {
  const m = data?.message;
  if (!m) return null;
  const ctx = m.extendedTextMessage?.contextInfo
    ?? m.imageMessage?.contextInfo
    ?? m.videoMessage?.contextInfo
    ?? m.contextInfo
    ?? null;
  const ad = ctx?.externalAdReply ?? ctx?.ctwaContext ?? null;
  if (!ad) return null;
  return {
    titulo: ad.title ?? ad.sourceUrl ?? 'anuncio',
    fuente: ad.sourceUrl ?? ad.sourceId ?? null,
  };
}

const NOTIFIED_RECENTLY = new Map(); // phone -> expiresAt
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1h

export function detectOrganicLead(text) {
  if (!text || typeof text !== 'string') return false;
  return LEAD_KEYWORDS.test(text);
}

// Lead del funnel del test de ansiedad (NEURA): el botón de la web llega con
// "...test de ansiedad de NEURA y salí en nivel <nivel> (<puntaje>/21)...".
// Devuelve { nivel, puntaje } o null si el texto no viene del test.
const TEST_ANSIEDAD_RE = /test de ansiedad de NEURA y sal[ií] en nivel\s+([a-záéíóúüñ]+)\s*\((\d{1,2})\/21\)/i;
export function parseTestAnsiedad(text) {
  const m = String(text || '').match(TEST_ANSIEDAD_RE);
  if (!m) return null;
  return { nivel: m[1].toLowerCase(), puntaje: parseInt(m[2], 10) };
}

export function wasRecentlyNotified(phone) {
  if (!phone) return false;
  const exp = NOTIFIED_RECENTLY.get(phone);
  if (!exp) return false;
  if (exp < Date.now()) {
    NOTIFIED_RECENTLY.delete(phone);
    return false;
  }
  return true;
}

function markNotified(phone) {
  if (!phone) return;
  NOTIFIED_RECENTLY.set(phone, Date.now() + DEDUP_TTL_MS);
}

// Sanitiza el pushName para usarlo como nombre/etiqueta en el comando.
// Quita caracteres raros, deja letras, números, espacios, máximo 30 chars.
function sanitizePushName(pushName) {
  if (!pushName) return 'LeadOrganico';
  const clean = pushName.replace(/[^\w\sáéíóúñÁÉÍÓÚÑ]/g, '').trim().slice(0, 30);
  return clean || 'LeadOrganico';
}

export async function notifyMiraiAboutOrganicLead({ phone, pushName, text, test, ad }) {
  if (!config.mia.personalPhone) return;
  if (wasRecentlyNotified(phone)) {
    console.log(`[mia/organic] ${phone} ya fue notificado en la última hora, saltando.`);
    return;
  }

  const cleanName = sanitizePushName(pushName);
  const truncatedMsg = String(text || '').slice(0, 200).replace(/\n+/g, ' ');

  // Titular según origen: lead del test (con urgencia si nivel alta) o genérico.
  let titular = '🆕 *Lead nuevo en NEURA* — Mia ya lo está atendiendo 🌸';
  if (test) {
    titular = test.puntaje >= 15
      ? `🔴 *Lead del TEST — nivel ALTA (${test.puntaje}/21)* — prioridad: dale una mirada pronto. Mia ya lo está atendiendo 🌸`
      : `🧪 *Lead del test de ansiedad* — nivel ${test.nivel} (${test.puntaje}/21). Mia ya lo está atendiendo 🌸`;
  } else if (ad) {
    titular = `📣 *Lead desde tu ANUNCIO* ("${String(ad.titulo).slice(0, 60)}") — Mia ya lo está atendiendo 🌸`;
  }

  const aviso = [
    titular,
    '',
    `De: ${phone}` + (pushName ? ` (${pushName})` : ''),
    `Escribió: "${truncatedMsg}"`,
    '',
    `👉 Si NO es un lead (contacto viejo/equivocado), dile a Mia: "silencia al ${phone}"`,
  ].join('\n');

  try {
    await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, aviso);
    markNotified(phone);
    console.log(`[mia/organic] notificado Mirai sobre lead orgánico ${phone} (${pushName})`);
  } catch (err) {
    console.error('[mia/organic] no pude notificar a Mirai:', err.message);
  }
}

// Red de seguridad: número DESCONOCIDO que escribe algo sin intención clara
// de lead (ej. "Hola" pelado). Mia sigue sin responder — pero avisa a Mirai
// para que ella decida, en vez de perderlo en silencio. Dedup 24h por número.
const SIN_INTENCION_NOTIFICADO = new Map(); // phone -> expiresAt
const SIN_INTENCION_TTL_MS = 24 * 60 * 60 * 1000;

export async function notifyMiraiAboutSilentUnknown({ phone, pushName, text }) {
  if (!config.mia.personalPhone || !phone) return;
  const exp = SIN_INTENCION_NOTIFICADO.get(phone);
  if (exp && exp > Date.now()) return;
  SIN_INTENCION_NOTIFICADO.set(phone, Date.now() + SIN_INTENCION_TTL_MS);

  const snippet = text
    ? `"${String(text).slice(0, 150).replace(/\n+/g, ' ')}"`
    : '(sin texto)';
  const aviso =
    `🔔 *Número nuevo escribió y no le respondí* (no detecté intención de consulta)\n\n` +
    `De: ${phone}${pushName ? ` (${pushName})` : ''}\n` +
    `Escribió: ${snippet}\n\n` +
    `Si es un lead, dile a Mia: "atiende a ${pushName || '<nombre>'}, su número es ${phone}"\n` +
    `Si no lo es, ignóralo y no te vuelvo a avisar por él hoy 🌸`;

  try {
    await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, aviso);
    console.log(`[mia/organic] avisado a Mirai de desconocido sin intención ${phone}`);
  } catch (err) {
    console.error('[mia/organic] no pude avisar de desconocido:', err.message);
  }
}

// Contactos que escriben y NO se pueden identificar (@lid sin número real):
// antes se descartaban en silencio total — con pauta activa eso es un lead
// perdido sin que Mirai se entere. Se le avisa máx. 1 vez al día por chat.
const NO_ID_NOTIFIED = new Map(); // remoteJid -> expiresAt
const NO_ID_TTL_MS = 24 * 60 * 60 * 1000;

export async function notifyMiraiAboutUnidentifiable({ remoteJid, pushName, text }) {
  if (!config.mia.personalPhone || !remoteJid) return;
  const exp = NO_ID_NOTIFIED.get(remoteJid);
  if (exp && exp > Date.now()) return;
  NO_ID_NOTIFIED.set(remoteJid, Date.now() + NO_ID_TTL_MS);

  const quien = pushName ? `"${pushName}"` : 'Alguien';
  const snippet = text
    ? `\nEscribió: "${String(text).slice(0, 150).replace(/\n+/g, ' ')}"`
    : '\n(mensaje sin texto o solo multimedia)';
  const aviso =
    `👀 *${quien} me escribió y no pude identificar su número* (WhatsApp lo entrega como ID oculto).${snippet}\n\n` +
    `Búscalo en tu WhatsApp y, si es un lead, dile a Mia: "atiende a <nombre>, su número es <número>"\ny lo atiendo desde su siguiente mensaje 🌸`;

  try {
    await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, aviso);
    console.log(`[mia/organic] avisado a Mirai de contacto no identificable ${remoteJid}`);
  } catch (err) {
    console.error('[mia/organic] no pude avisar de no-identificable:', err.message);
  }
}

// Limpieza periódica del dedup (no crítica, evita crecimiento indefinido).
setInterval(() => {
  const now = Date.now();
  for (const [phone, exp] of NOTIFIED_RECENTLY.entries()) {
    if (exp < now) NOTIFIED_RECENTLY.delete(phone);
  }
  for (const [jid, exp] of NO_ID_NOTIFIED.entries()) {
    if (exp < now) NO_ID_NOTIFIED.delete(jid);
  }
  for (const [ph, exp] of SIN_INTENCION_NOTIFICADO.entries()) {
    if (exp < now) SIN_INTENCION_NOTIFICADO.delete(ph);
  }
}, 10 * 60 * 1000).unref?.();
