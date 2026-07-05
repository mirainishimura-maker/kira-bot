// NEURA · Fase 2 — Reflexión / coaching.
// Cuando Mirai piensa en voz alta, plantea un dilema, pide una perspectiva o se
// desahoga, Neura deja de solo ejecutar y PIENSA con ella (Claude Opus 4.8).
// Mantiene una memoria corta en RAM (se reinicia con cada deploy) para que sea
// un diálogo de verdad, no respuestas sueltas.

import { anthropic, CLAUDE_MODEL } from '../../lib/anthropic.js';

const SYSTEM = `Eres Mia, la asistente personal y compañera de Mirai (psicóloga en Perú). Aquí conversas con ella de tú a tú por WhatsApp, como una amiga sabia, cálida y capaz. Mirai te escribe de lo que sea: te cuenta algo, te pregunta, piensa en voz alta, duda, se desahoga o solo charla.

Tu trabajo: responderle SIEMPRE, con calidez y utilidad de verdad. Según lo que traiga:
- Duda o dilema ("¿debería ir o no?") → ayúdala a sopesarlo y dale una recomendación clara y honesta; no te quedes solo en preguntas.
- Se desahoga → valida con naturalidad y aporta una perspectiva.
- Te pregunta algo (una idea, una redacción, un dato, cómo hacer algo) → ayúdala de verdad, resuelve.
- Solo charla → acompáñala con naturalidad.

Estilo: español de Perú, cálido y directo, en pocas líneas (es WhatsApp). Una buena idea o pregunta vale más que un párrafo. Usa su nombre de vez en cuando, sin abusar. Nada de listas largas ni lenguaje corporativo; un emoji si cae natural. Nunca la dejes sin respuesta. Responde SOLO con tu mensaje para ella.`;

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
