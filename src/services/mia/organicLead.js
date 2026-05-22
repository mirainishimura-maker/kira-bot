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
const LEAD_KEYWORDS = /\b(consult\w*|sesi[oó]n\w*|terapia\w*|terapeut\w*|psic[oó]log\w*|psicolog\w*|ansiedad\w*|depresi[oó]n|depre\w*|emdr|trauma\w*|autoestima\w*|duelo\w*|p[aá]nico\w*|crisis|agendar|agenda\w*|cita\w*|atenci[oó]n|ayuda\w*|ay[úu]dame\w*|info\w*|precio\w*|costo\w*|cuesta\w*|inversi[oó]n\w*|emocional\w*|pareja\w*|familiar\w*|s[aá]nar\w*)\b/i;

const NOTIFIED_RECENTLY = new Map(); // phone -> expiresAt
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1h

export function detectOrganicLead(text) {
  if (!text || typeof text !== 'string') return false;
  return LEAD_KEYWORDS.test(text);
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

export async function notifyMiraiAboutOrganicLead({ phone, pushName, text }) {
  if (!config.mia.personalPhone) return;
  if (wasRecentlyNotified(phone)) {
    console.log(`[mia/organic] ${phone} ya fue notificado en la última hora, saltando.`);
    return;
  }

  const cleanName = sanitizePushName(pushName);
  const truncatedMsg = String(text || '').slice(0, 200).replace(/\n+/g, ' ');

  const aviso = [
    '📌 *Lead orgánico nuevo*',
    '',
    `De: ${phone}` + (pushName ? ` (${pushName})` : ''),
    `Mensaje: "${truncatedMsg}"`,
    '',
    'Pega esto para que Mia lo salude y arranque el flujo:',
    `/atender ${phone} ${cleanName}`,
    '',
    'O solo etiquetarlo sin saludo:',
    `/paciente ${phone} ${cleanName} lead_organico`,
  ].join('\n');

  try {
    await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, aviso);
    markNotified(phone);
    console.log(`[mia/organic] notificado Mirai sobre lead orgánico ${phone} (${pushName})`);
  } catch (err) {
    console.error('[mia/organic] no pude notificar a Mirai:', err.message);
  }
}

// Limpieza periódica del dedup (no crítica, evita crecimiento indefinido).
setInterval(() => {
  const now = Date.now();
  for (const [phone, exp] of NOTIFIED_RECENTLY.entries()) {
    if (exp < now) NOTIFIED_RECENTLY.delete(phone);
  }
}, 10 * 60 * 1000).unref?.();
