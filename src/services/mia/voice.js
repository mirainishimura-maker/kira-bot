// NEURA · Voz de Mia — respuestas por nota de voz.
// Convierte el texto de la respuesta a audio con OpenAI TTS y lo manda como
// nota de voz (PTT) a Mirai. Es best-effort: el texto SIEMPRE se envía aparte,
// así que si el audio falla, no se pierde nada.

import { miraiOpenai } from '../../lib/miraiOpenai.js';
import { config } from '../../config.js';
import { sendWhatsAppAudio } from '../../lib/evolution.js';

// Limpia el texto para que suene natural (sin asteriscos, links ni saltos raros).
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/[*_`~#>]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 1000);
}

export async function speakToBase64(text) {
  if (!miraiOpenai) return null;
  const input = cleanForSpeech(text);
  if (!input) return null;
  try {
    const resp = await miraiOpenai.audio.speech.create({
      model: 'tts-1', voice: 'nova', input,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.toString('base64');
  } catch (e) {
    console.error('[neura/voice] tts:', e.message);
    return null;
  }
}

export async function sendVoiceReply(text) {
  const b64 = await speakToBase64(text);
  if (!b64) return false;
  try {
    await sendWhatsAppAudio(`${config.mia.personalPhone}@s.whatsapp.net`, b64);
    return true;
  } catch (e) {
    console.error('[neura/voice] send:', e.message);
    return false;
  }
}
