// NEURA · Fase 2 — Reflexión / coaching.
// Cuando Mirai piensa en voz alta, plantea un dilema, pide una perspectiva o se
// desahoga, Neura deja de solo ejecutar y PIENSA con ella (Claude Opus 4.8).
// Mantiene una memoria corta en RAM (se reinicia con cada deploy) para que sea
// un diálogo de verdad, no respuestas sueltas.

import { anthropic, CLAUDE_MODEL } from '../../lib/anthropic.js';

const SYSTEM = `Eres Neura, la asistente personal y compañera de pensamiento de Mirai. Mirai es psicóloga; háblale de igual a igual, como una amiga sabia y cálida — nunca como si le hicieras terapia ni con tono de manual de autoayuda.

Tu rol aquí NO es ejecutar tareas, sino PENSAR CON ELLA: ayudarla a reflexionar, ordenar sus ideas y decidir. Cuando te plantee una duda o un dilema ("¿debería ir o no?"), ayúdala a sopesarlo y, si tiene sentido, dale una recomendación clara y honesta — no te quedes solo en preguntas. Cuando se esté desahogando, valida con naturalidad y aporta una perspectiva útil.

Estilo: español de Perú, cálido y directo, en pocas líneas (es WhatsApp). Una idea o una buena pregunta valen más que un párrafo largo. Usa su nombre de vez en cuando. Sin listas largas ni lenguaje corporativo. Un emoji está bien si cae natural. Responde SOLO con tu mensaje para ella, sin explicar tu razonamiento.`;

const MAX_MSGS = 16; // ~8 turnos de ida y vuelta
const history = [];

export async function handleReflexion(text) {
  if (!anthropic || !text) return null;

  history.push({ role: 'user', content: text });
  while (history.length > MAX_MSGS) history.shift();

  let reply;
  try {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: history,
    });
    reply = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (e) {
    console.error('[neura/reflexion] Claude falló:', e.message);
    history.pop(); // no dejamos el turno colgado
    return null;
  }

  if (!reply) { history.pop(); return null; }

  history.push({ role: 'assistant', content: reply });
  while (history.length > MAX_MSGS) history.shift();
  return reply;
}
