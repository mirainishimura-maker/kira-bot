// Procesamiento de medios entrantes para Mia: audio (Whisper) e imagen (visión).
// Usa la cuenta de OpenAI de Mirai (miraiOpenai), no la de la empresa.

import OpenAI from 'openai';
import { miraiOpenai, MIA_MODEL } from '../../lib/miraiOpenai.js';

// Transcribe un audio en base64 usando Whisper. Devuelve el texto o null.
export async function transcribeAudio({ base64, mimetype = 'audio/ogg' }) {
  if (!miraiOpenai) return null;
  if (!base64) return null;
  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = mimetypeToExt(mimetype);
    const file = await OpenAI.toFile(buffer, `audio.${ext}`, { type: mimetype });
    const result = await miraiOpenai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'es',
    });
    return (result?.text ?? '').trim() || null;
  } catch (err) {
    console.error('[mia/media] transcribeAudio error:', err.status ?? '', err.message);
    return null;
  }
}

// Analiza una imagen con visión usando gpt-4o-mini (multimodal). Devuelve un
// texto descriptivo / interpretación. Si el paciente mandó un caption, lo
// pasamos como hint adicional.
export async function describeImage({ base64, mimetype = 'image/jpeg', caption = '' }) {
  if (!miraiOpenai) return null;
  if (!base64) return null;
  try {
    const dataUrl = `data:${mimetype};base64,${base64}`;
    const userText = caption
      ? `El paciente envió esta imagen con el caption: "${caption}". Describe brevemente qué muestra la imagen y qué intención puede tener (ej: comprobante de pago, foto de identificación, foto del lugar, captura de pantalla, etc.). Máximo 2 oraciones.`
      : 'El paciente envió esta imagen sin caption. Describe brevemente qué muestra y qué intención puede tener (ej: comprobante de pago, captura, foto, etc.). Máximo 2 oraciones.';
    const result = await miraiOpenai.chat.completions.create({
      model: MIA_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 200,
      temperature: 0.2,
    });
    return result.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    console.error('[mia/media] describeImage error:', err.status ?? '', err.message);
    return null;
  }
}

function mimetypeToExt(m) {
  if (!m) return 'ogg';
  if (m.includes('ogg'))  return 'ogg';
  if (m.includes('mp4'))  return 'm4a';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('wav'))  return 'wav';
  if (m.includes('webm')) return 'webm';
  return 'ogg';
}
