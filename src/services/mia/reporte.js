// NEURA · Fase 2 — Reportes por voz.
// Mirai le dicta (a veces por audio, medio desordenado) y Claude Opus 4.8 le
// arma un reporte/informe redondo y bien estructurado. Memoria corta en RAM
// para poder pedir ajustes ("hazlo más corto", "agrega una sección de X").

import { anthropic, CLAUDE_MODEL } from '../../lib/anthropic.js';

const SYSTEM = `Eres Neura, la asistente de Mirai. Tu trabajo aquí es redactar REPORTES / INFORMES claros y profesionales a partir de lo que Mirai te dicta (a veces por audio, medio desordenado). Ella es psicóloga y trabaja en GDH / Ítaca HUB.

Convierte lo que te diga en un reporte bien estructurado en español:
- Un *título* claro al inicio.
- Si aplica, un breve resumen de 1-2 líneas.
- Secciones con viñetas (•) o párrafos cortos, según el contenido.
- Cierre con *Conclusiones* o *Próximos pasos* si tiene sentido.

Reglas: usa formato de WhatsApp (*negritas* con asteriscos). Claro y conciso, sin relleno. Si falta un dato importante, asume lo razonable y déjalo entre [corchetes] para que ella lo complete. Si Mirai te pide ajustar el reporte anterior, modifícalo. Devuelve SOLO el reporte, listo para copiar y pegar.`;

const MAX_MSGS = 10;
const history = [];

export async function handleReporte(text) {
  if (!anthropic || !text) return null;

  history.push({ role: 'user', content: text });
  while (history.length > MAX_MSGS) history.shift();

  let reply;
  try {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1600,
      system: SYSTEM,
      messages: history,
    });
    reply = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (e) {
    console.error('[neura/reporte] Claude falló:', e.message);
    history.pop();
    return null;
  }

  if (!reply) { history.pop(); return null; }

  history.push({ role: 'assistant', content: reply });
  while (history.length > MAX_MSGS) history.shift();
  return reply;
}

// Inyecta un reporte generado por otro módulo (ej. el reporte mensual de GDH)
// para que "en PDF" (getLastReport) lo tome. Empuja user+assistant para no
// romper la alternancia si luego Mirai dicta otro reporte.
export function pushExternalReport(text) {
  if (!text) return;
  history.push({ role: 'user', content: '(reporte generado automáticamente)' });
  history.push({ role: 'assistant', content: text });
  while (history.length > MAX_MSGS) history.shift();
}

// Devuelve el último reporte redactado (para pasarlo a PDF), o null si no hay.
export function getLastReport() {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') return history[i].content;
  }
  return null;
}
