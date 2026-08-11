// NEURA · Resumen de plata — "¿en qué se me fue la plata?"
// Junta los gastos/ingresos de Mirai + lo facturado en el consultorio (pagos de
// pacientes) y Claude Opus se lo devuelve corto, cálido y con UN consejo.
// Se dispara por voz ("¿en qué se me fue la plata?") y por cron los domingos.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { anthropic, CLAUDE_MODEL } from '../../lib/anthropic.js';
import { sendPrivate } from '../../lib/evolution.js';

const money = (n) => `S/ ${Number(n).toFixed(2)}`;

function sinceISO(period) {
  const days = period === 'mes' ? 30 : 7;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Pacientes con saldo a favor de Mirai = cargos − pagos. Vive aquí (y no en
// neuraAssistant) para que lo usen tanto "¿quién me debe?" como el resumen
// dominical, sin duplicar el cálculo.
export async function deudoresPacientes() {
  if (!miraiSupabase) return { deudores: [], total: 0 };
  const [pRes, cRes, payRes] = await Promise.all([
    miraiSupabase.from('patients').select('id, nombre').neq('phone', config.mia.personalPhone),
    miraiSupabase.from('charges').select('patient_id, amount'),
    miraiSupabase.from('payments').select('patient_id, amount'),
  ]);
  const bal = new Map();
  for (const c of cRes.data ?? []) bal.set(c.patient_id, (bal.get(c.patient_id) || 0) + Number(c.amount || 0));
  for (const p of payRes.data ?? []) bal.set(p.patient_id, (bal.get(p.patient_id) || 0) - Number(p.amount || 0));
  const nameOf = new Map((pRes.data ?? []).map((p) => [p.id, p.nombre]));
  const deudores = [...bal.entries()]
    .filter(([id, v]) => v > 0.5 && nameOf.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => ({ id, nombre: nameOf.get(id), saldo: v }));
  return { deudores, total: deudores.reduce((a, d) => a + d.saldo, 0) };
}

export async function buildResumenFinanzas({ period = 'semana' } = {}) {
  if (!miraiSupabase) return 'No tengo tus finanzas conectadas ahora mismo.';
  const since = sinceISO(period);
  const label = period === 'mes' ? 'este mes' : 'esta semana';

  const [finRes, payRes, cobrar] = await Promise.all([
    miraiSupabase.from('finances').select('direction, amount, category').gte('occurred_at', since).limit(2000),
    miraiSupabase.from('payments').select('amount').gte('created_at', since).limit(2000),
    deudoresPacientes(),
  ]);
  const fin = finRes.data ?? [];
  const pays = payRes.data ?? [];
  const cobrarLines = cobrar.deudores.slice(0, 6).map((d) => `• ${d.nombre}: ${money(d.saldo)}`).join('\n');

  const gastos = fin.filter((f) => f.direction === 'gasto');
  const ingresos = fin.filter((f) => f.direction === 'ingreso');
  const totalGasto = gastos.reduce((a, f) => a + Number(f.amount || 0), 0);
  const totalIngreso = ingresos.reduce((a, f) => a + Number(f.amount || 0), 0);
  const facturado = pays.reduce((a, p) => a + Number(p.amount || 0), 0);

  const byCat = new Map();
  for (const g of gastos) {
    const c = g.category || 'Otros';
    byCat.set(c, (byCat.get(c) || 0) + Number(g.amount || 0));
  }
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const catLines = cats.length ? cats.map(([c, v]) => `• ${c}: ${money(v)}`).join('\n') : '• (sin gastos)';

  if (fin.length === 0 && pays.length === 0 && !cobrar.deudores.length) {
    return `💸 *Tu plata — ${label}*\n\nNo registraste movimientos ${label}. Cuando gastes algo dime "gasté 20 en el taxi" y lo anoto 🙂`;
  }

  const datos = [
    `Periodo: ${label}`,
    `Gastos totales: ${money(totalGasto)} en ${gastos.length} movimientos`,
    `Gastos por categoría:\n${catLines}`,
    `Ingresos personales registrados: ${money(totalIngreso)}`,
    `Facturado en el consultorio (pagos de pacientes): ${money(facturado)} en ${pays.length} pagos`,
    cobrar.deudores.length
      ? `Pacientes que deben (saldo por cobrar, total ${money(cobrar.total)}):\n${cobrarLines}`
      : 'Pacientes que deben: nadie, todos al día.',
  ].join('\n');

  if (anthropic) {
    try {
      const resp = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 550,
        system: `Eres Neura, la asistente de Mirai (psicóloga en Perú). Te paso sus números de plata de ${label}. Devuelve un resumen CORTO, cálido y claro en formato WhatsApp (usa *negritas*), en soles (S/). Estructura: un título con emoji; en qué se le fue la plata (las 2-3 categorías top); cuánto facturó en el consultorio; si hay pacientes con saldo por cobrar, nómbralos con su monto y el total (es plata que ya trabajó y no ha entrado); y CIERRA con UN solo consejo práctico y amable (nada de sermones). Máximo ~12 líneas. NO inventes cifras: usa solo las que te doy. Si algo es 0, no lo fuerces.`,
        messages: [{ role: 'user', content: datos }],
      });
      const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (txt) return txt;
    } catch (e) { console.error('[neura/finanzas] Claude:', e.message); }
  }

  const top = cats.slice(0, 3).map(([c, v]) => `${c} (${money(v)})`).join(', ');
  const bloqueCobrar = cobrar.deudores.length
    ? `\n\n🧾 *Por cobrar* (${money(cobrar.total)}):\n${cobrarLines}`
    : '';
  return `💸 *Tu plata — ${label}*\n\nGastaste *${money(totalGasto)}*${top ? ` — sobre todo en ${top}` : ''}.\nFacturaste *${money(facturado)}* en el consultorio (${pays.length} pagos).\n\nDetalle de gastos:\n${catLines}${bloqueCobrar}\n\nLo ves en Neura → Finanzas ✦`;
}

export async function runResumenFinanzas({ dry = false } = {}) {
  const texto = await buildResumenFinanzas({ period: 'semana' });
  if (dry) return { ok: true, texto };
  try {
    await sendPrivate(config.mia.personalPhone, texto);
    return { ok: true, texto, sent: true };
  } catch (e) {
    console.error('[neura/finanzas] envío:', e.message);
    return { ok: false, error: e.message, texto };
  }
}

export function startResumenFinanzasCron() {
  if (!config.mia.enabled) return;
  cron.schedule('0 19 * * 0', () => {
    runResumenFinanzas({ dry: false }).catch((e) => console.error('[neura/finanzas] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[neura/finanzas] cron activo (domingos 19:00 Lima)');
}
