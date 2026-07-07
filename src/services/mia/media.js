// Procesamiento de medios entrantes para Mia: audio (Whisper) e imagen (visión).
// Usa la cuenta de OpenAI de Mirai (miraiOpenai), no la de la empresa.

import OpenAI from 'openai';
import { miraiOpenai, MIA_MODEL } from '../../lib/miraiOpenai.js';
import { config } from '../../config.js';

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

// Analiza una imagen con visión (gpt-4.1). Devuelve estructura:
//   { tipo: 'comprobante_pago'|'otro', descripcion, pago: {monto_pen, destinatario, numero, operacion, fecha}|null }
// Si es un comprobante de pago (Yape/Plin/transferencia), extrae los datos.
async function analizarImagen({ base64, mimetype = 'image/jpeg', caption = '' }) {
  if (!miraiOpenai || !base64) return null;
  const dataUrl = `data:${mimetype};base64,${base64}`;
  const hint = caption ? `El paciente adjuntó el caption: "${caption}". ` : '';
  const instruccion = `${hint}Analiza la imagen. Si es un COMPROBANTE DE PAGO (Yape, Plin, transferencia o depósito — apps/bancos peruanos), extrae sus datos. Responde SOLO con JSON:
{
  "tipo": "comprobante_pago" | "otro",
  "descripcion": "una oración breve de qué es la imagen",
  "pago": { "monto_pen": <número en soles o null>, "destinatario": <nombre de quien RECIBE el dinero o null>, "numero": <celular/cuenta del destino o null>, "operacion": <nro de operación o null>, "fecha": <fecha/hora o null> }
}
Reglas: "monto_pen" solo el número. "destinatario" = a QUIÉN se le envió (no quién paga). Si NO es comprobante: "tipo":"otro" y "pago": null.`;
  try {
    const result = await miraiOpenai.chat.completions.create({
      model: MIA_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruccion },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 400,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const raw = result.choices?.[0]?.message?.content ?? '{}';
    const p = JSON.parse(raw);
    return {
      tipo: p.tipo === 'comprobante_pago' ? 'comprobante_pago' : 'otro',
      descripcion: String(p.descripcion ?? '').trim(),
      pago: (p.pago && typeof p.pago === 'object') ? p.pago : null,
    };
  } catch (err) {
    console.error('[mia/media] analizarImagen error:', err.status ?? '', err.message);
    return null;
  }
}

// Verifica un comprobante contra el pago esperado (config.mia.pago) y arma el
// texto-marcador que Mia recibe, con un veredicto claro (VÁLIDO / NO COINCIDE).
function verificarComprobante(info, caption) {
  const cfg = config.mia.pago;
  const p = info.pago || {};
  const monto = Number(p.monto_pen) || 0;
  const dest  = String(p.destinatario || '');
  const num   = String(p.numero || '').replace(/\D/g, '');

  const montoOk  = monto >= cfg.monto;
  const primerNombreEsperado = cfg.nombre.toLowerCase().split(/\s+/)[0];
  const nombreOk = primerNombreEsperado && dest.toLowerCase().includes(primerNombreEsperado);
  const numOk    = cfg.numero && num.includes(cfg.numero);
  const destOk   = nombreOk || numOk;
  const valido   = montoOk && destOk;

  const datos = `monto S/${monto || '?'}, a ${dest || '?'}${num ? ' (' + num + ')' : ''}`;
  if (valido) {
    return `[COMPROBANTE DE PAGO ✓ VÁLIDO — ${datos}. Coincide con lo esperado (S/${cfg.monto} a ${cfg.nombre}). Si el paciente tiene un turno apartado, CONFÍRMALE la cita ahora.]`;
  }
  const razones = [];
  if (!montoOk) razones.push(`el monto es S/${monto || '?'} y se espera S/${cfg.monto}`);
  if (!destOk)  razones.push(`el destinatario no coincide con ${cfg.nombre} (${cfg.numero})`);
  return `[COMPROBANTE DE PAGO detectado pero NO COINCIDE: ${razones.join(' y ')}. NO confirmes la cita; con calidez avísale al paciente qué falta o pídele que revise el ${!montoOk ? 'monto' : 'número/nombre'} y reenvíe.${caption ? ' Caption del paciente: "' + caption + '".' : ''}]`;
}

// Punto de entrada para el webhook: devuelve el TEXTO que Mia debe ver para una
// imagen (comprobante verificado, o descripción general).
export async function analizarImagenParaMia({ base64, mimetype, caption = '' }) {
  const info = await analizarImagen({ base64, mimetype, caption });
  if (!info) return caption ? `[imagen, caption "${caption}"]` : '[imagen sin procesar]';
  if (info.tipo === 'comprobante_pago') return verificarComprobante(info, caption);
  const prefix = caption ? `[imagen, caption "${caption}"]` : '[imagen]';
  return info.descripcion ? `${prefix}: ${info.descripcion}` : prefix;
}

// Analiza una foto que MIRAI le manda a Mia desde su número personal.
// Clasifica en: 'pago' (Yape/Plin que un paciente le hizo A ELLA → extrae monto
// + quién le pagó), 'escrito' (nota/devocional a mano → transcribe), u 'otro'.
export async function analizarFotoMirai({ base64, mimetype = 'image/jpeg', caption = '' }) {
  if (!miraiOpenai || !base64) return null;
  const dataUrl = `data:${mimetype};base64,${base64}`;
  const hint = caption ? `Mirai adjuntó el caption: "${caption}". ` : '';
  const instruccion = `${hint}Eres la asistente de Mirai (psicóloga en Perú). ELLA te manda esta imagen desde su teléfono. Clasifícala y extrae lo pedido:
(a) COMPROBANTE DE PAGO (Yape/Plin/transferencia/depósito) que un paciente le hizo A ELLA → extrae el monto en soles y el NOMBRE DE QUIEN LE PAGÓ (el emisor/pagador, NO Mirai).
(b) TEXTO ESCRITO A MANO (devocional, reflexión, página de diario, apunte) → TRANSCRIBE el texto completo tal cual, respetando saltos de línea.
(c) OTRA COSA.
Responde SOLO con JSON:
{
  "tipo": "pago" | "escrito" | "otro",
  "descripcion": "una oración breve de qué es",
  "pago": { "monto_pen": <número o null>, "pagador": <nombre de quien le pagó o null>, "metodo": "yape"|"plin"|"transferencia"|"efectivo"|null } | null,
  "texto": <transcripción completa del texto a mano, o null>
}`;
  try {
    const result = await miraiOpenai.chat.completions.create({
      model: MIA_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruccion },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 900,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const p = JSON.parse(result.choices?.[0]?.message?.content ?? '{}');
    const tipo = ['pago', 'escrito', 'otro'].includes(p.tipo) ? p.tipo : 'otro';
    return {
      tipo,
      descripcion: String(p.descripcion ?? '').trim(),
      pago: (p.pago && typeof p.pago === 'object') ? p.pago : null,
      texto: p.texto ? String(p.texto).trim() : null,
    };
  } catch (err) {
    console.error('[mia/media] analizarFotoMirai error:', err.status ?? '', err.message);
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
