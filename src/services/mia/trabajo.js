// NEURA · Trabajo GDH — bitácora + reporte mensual a gerencia.
// Mirai (locadora en GDH / Ítaca HUB) va capturando por voz sus logros,
// ahorros, ventas y pendientes; el bot los guarda en `work_log` y arma el
// reporte MENSUAL para gerencia (Brian, Brandon Soto) enfatizando NÚMEROS +
// FECHAS. El reporte se puede pasar a PDF con "en PDF" (usa reporte.js).

import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { anthropic, CLAUDE_MODEL } from '../../lib/anthropic.js';
import { pushExternalReport } from './reporte.js';

const KINDS = ['logro', 'pendiente', 'tarea', 'ahorro', 'venta', 'nota'];
const EMO = { logro: '🏆', pendiente: '📌', tarea: '✅', ahorro: '💰', venta: '📈', nota: '📝' };
const LABEL = { logro: 'Logro', pendiente: 'Pendiente', tarea: 'Tarea', ahorro: 'Ahorro', venta: 'Venta', nota: 'Nota' };
const money = (n) => `S/ ${Number(Math.abs(n)).toFixed(2)}`;

// Primer día del mes actual en Lima → 'YYYY-MM-01' (para filtrar por occurred_at).
function inicioMesLima() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }); // YYYY-MM-DD
  return `${s.slice(0, 7)}-01`;
}

export async function handleRegistrarTrabajo(t, raw) {
  if (!t || !t.content || !t.content.trim()) return { handled: false };
  const kind = KINDS.includes(t.kind) ? t.kind : 'nota';
  const impact = Number.isFinite(Number(t.impact)) ? Number(t.impact) : null;
  const status = (kind === 'pendiente' || kind === 'tarea') ? 'abierto' : 'abierto';
  const { error } = await miraiSupabase.from('work_log').insert({
    kind, content: t.content.trim(), impact, status, source: 'voz', raw_text: raw,
  });
  if (error) { console.error('[neura/trabajo] insert:', error.message); return { handled: true, reply: 'Uy, no pude anotarlo. ¿Me lo repites?' }; }
  const extra = impact != null ? ` (${money(impact)})` : '';
  return { handled: true, reply: `${EMO[kind]} ${LABEL[kind]} de GDH anotado${extra}.\nCuando quieras armamos tu reporte: "hazme el reporte de GDH" ✦` };
}

export async function handleConsultarTrabajo() {
  const { data } = await miraiSupabase.from('work_log')
    .select('*').gte('occurred_at', inicioMesLima()).order('occurred_at', { ascending: false }).limit(80);
  const rows = data ?? [];
  if (!rows.length) return { handled: true, reply: 'Aún no tienes nada anotado de GDH este mes. Dime "apunta un logro de GDH: ..." 🙂' };
  const byKind = {};
  for (const r of rows) (byKind[r.kind] ||= []).push(r);
  const order = [['logro', '🏆 Logros'], ['ahorro', '💰 Ahorros'], ['venta', '📈 Ventas'], ['pendiente', '📌 Pendientes'], ['tarea', '✅ Tareas'], ['nota', '📝 Notas']];
  const partes = [];
  for (const [k, titulo] of order) {
    if (byKind[k]?.length) {
      partes.push(`*${titulo}:*\n${byKind[k].map((r) => `• ${r.content}${r.impact != null ? ` (${money(r.impact)})` : ''}`).join('\n')}`);
    }
  }
  return { handled: true, reply: `🏢 *GDH — este mes:*\n\n${partes.join('\n\n')} ✦` };
}

export async function handleReporteGdh() {
  if (!anthropic) return { handled: true, reply: 'No tengo el cerebro de reportes conectado ahora mismo ✦' };
  const { data } = await miraiSupabase.from('work_log')
    .select('*').gte('occurred_at', inicioMesLima()).order('occurred_at', { ascending: true }).limit(200);
  const rows = data ?? [];
  if (!rows.length) {
    return { handled: true, reply: 'No tengo logros/pendientes anotados este mes para el reporte. Dicta algunos: "apunta un logro de GDH: ..." 🙂' };
  }
  const items = rows.map((r) =>
    `- [${r.occurred_at}] (${r.kind}) ${r.content}${r.impact != null ? ` | impacto: ${money(r.impact)}` : ''}`).join('\n');
  const mes = new Date().toLocaleDateString('es-PE', { month: 'long', year: 'numeric', timeZone: 'America/Lima' });

  const system = `Eres la asistente de Mirai, locadora en GDH / Ítaca HUB, que entrega un REPORTE MENSUAL a gerencia (Brian y Brandon Soto). Con la bitácora que te paso, arma un reporte profesional y BREVE para gerencia.
REGLA DE ORO: enfatiza el IMPACTO EN NÚMEROS (ahorros, ventas, montos, %) y las FECHAS concretas. Nada de relleno ni frases vacías.
Formato WhatsApp (*negritas* con asteriscos): un *título* con el mes; 2-3 líneas de resumen ejecutivo; sección *Logros del mes* (cada uno con su número y fecha); sección *Pendientes / próximos pasos*. Si un logro no trae número, déjalo entre [corchetes] para que Mirai lo complete. Devuelve SOLO el reporte, listo para copiar.`;

  let reply;
  try {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 1600, system,
      messages: [{ role: 'user', content: `Mes: ${mes}.\nBitácora de trabajo (GDH):\n${items}` }],
    });
    reply = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (e) {
    console.error('[neura/trabajo] reporte Claude:', e.message);
    return { handled: true, reply: 'No pude armar el reporte ahora ✦' };
  }
  if (!reply) return { handled: true, reply: 'No pude armar el reporte ahora ✦' };

  pushExternalReport(reply); // deja el reporte disponible para "en PDF"
  return { handled: true, reply: `${reply}\n\n— _¿te lo mando en PDF? dime "en PDF"_ ✦` };
}
