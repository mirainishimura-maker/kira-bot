// NEURA · Pagos fijos y suscripciones.
// Mirai tiene varias suscripciones (Netflix, Claude, Spotify…) y pagos
// recurrentes (tarjetas de crédito, crédito BCP) cada uno con su DÍA de pago.
// Aquí los captura por voz (tabla fixed_expenses, ya creada en 0010) y un cron
// diario le avisa por WhatsApp lo que vence hoy/mañana para que no se le pase.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';

const CATS = ['Suscripción', 'Tarjeta', 'Crédito', 'Servicio', 'Otro'];
const money = (n) => `S/ ${Number(Math.abs(n)).toFixed(2)}`;
const clamp31 = (n) => Math.min(31, Math.max(1, Math.round(n)));

// Día del mes de hoy y de mañana en Lima (mañana maneja el salto de mes).
function diasLima() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }); // YYYY-MM-DD
  const [y, m, d] = s.split('-').map(Number);
  const manana = new Date(Date.UTC(y, m - 1, d) + 86400000);
  return { hoy: d, manana: manana.getUTCDate() };
}

// Orden circular: cuántos días faltan (aprox) desde hoy hasta el día `dom`.
function faltanDias(dom, hoy) {
  const diff = dom - hoy;
  return diff >= 0 ? diff : diff + 31;
}

// ─── Voz ──────────────────────────────────────────────────────────────────────
export async function handleRegistrarPagoFijo(pf, raw) {
  if (!pf || !pf.concept || !pf.concept.trim()) {
    return { handled: true, reply: '¿Qué suscripción/pago anoto? Ej: "Netflix 30 soles el día 15" 🙂' };
  }
  const amount = Number.isFinite(Number(pf.amount)) && Number(pf.amount) > 0 ? Number(pf.amount) : null;
  const day = Number.isFinite(Number(pf.day)) ? clamp31(pf.day) : null;
  const category = CATS.includes(pf.category) ? pf.category : 'Suscripción';
  const { error } = await miraiSupabase.from('fixed_expenses').insert({
    concept: pf.concept.trim(), amount: amount ?? 0, category, day_of_month: day, active: true,
  });
  if (error) { console.error('[neura/pagos] insert:', error.message); return { handled: true, reply: 'Uy, no pude anotarlo. ¿Me lo repites?' }; }
  const partes = [];
  if (amount != null) partes.push(money(amount));
  if (day != null) partes.push(`día ${day}`);
  const det = partes.length ? ` (${partes.join(' · ')})` : '';
  return { handled: true, reply: `🔁 Anoté tu pago fijo: *${pf.concept.trim()}*${det}.\nTe avisaré cuando se acerque el día. Lo ves en Neura → Finanzas ✦` };
}

export async function handleConsultarPagosFijos() {
  const [fxRes, accRes] = await Promise.all([
    miraiSupabase.from('fixed_expenses').select('*').eq('active', true),
    miraiSupabase.from('accounts').select('name, payment_day').eq('kind', 'credito').eq('archived', false),
  ]);
  const fx = fxRes.data ?? [];
  const creditos = (accRes.data ?? []).filter((a) => a.payment_day);
  if (!fx.length && !creditos.length) {
    return { handled: true, reply: 'Aún no tienes suscripciones ni pagos fijos anotados. Dime "agrega Netflix 30 el día 15" 🙂' };
  }
  const { hoy } = diasLima();
  const items = [
    ...fx.map((f) => ({ nombre: f.concept, monto: Number(f.amount) || 0, dia: f.day_of_month })),
    ...creditos.map((a) => ({ nombre: `${a.name} (tarjeta)`, monto: 0, dia: a.payment_day })),
  ];
  items.sort((a, b) => (a.dia == null ? 99 : faltanDias(a.dia, hoy)) - (b.dia == null ? 99 : faltanDias(b.dia, hoy)));
  const total = fx.reduce((a, f) => a + (Number(f.amount) || 0), 0);
  const lines = items.map((i) => {
    const cuando = i.dia == null ? 'sin día' : `día ${i.dia}`;
    const monto = i.monto ? ` — ${money(i.monto)}` : '';
    return `• ${i.nombre}${monto} · ${cuando}`;
  });
  const totalLine = total > 0 ? `\n\n*Total suscripciones/mes:* ${money(total)}` : '';
  return { handled: true, reply: `🔁 *Tus pagos fijos:*\n${lines.join('\n')}${totalLine} ✦` };
}

// ─── Cron: recordatorio de lo que vence hoy/mañana ─────────────────────────────
export async function runPagosRecordatorio({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'sin supabase' };
  if (!config.mia.personalPhone) return { ok: false, error: 'falta MIRAI_PERSONAL_PHONE' };
  const { hoy, manana } = diasLima();

  const [fxRes, accRes] = await Promise.all([
    miraiSupabase.from('fixed_expenses').select('*').eq('active', true),
    miraiSupabase.from('accounts').select('name, payment_day').eq('kind', 'credito').eq('archived', false),
  ]);
  const fuentes = [
    ...(fxRes.data ?? []).map((f) => ({ nombre: f.concept, monto: Number(f.amount) || 0, dia: f.day_of_month })),
    ...(accRes.data ?? []).filter((a) => a.payment_day).map((a) => ({ nombre: `${a.name} (tarjeta)`, monto: 0, dia: a.payment_day })),
  ];

  const hoyList = [], mananaList = [];
  for (const f of fuentes) {
    const monto = f.monto ? ` (${money(f.monto)})` : '';
    if (f.dia === hoy) hoyList.push(`• ${f.nombre}${monto}`);
    else if (f.dia === manana) mananaList.push(`• ${f.nombre}${monto}`);
  }
  if (!hoyList.length && !mananaList.length) {
    return { ok: true, empty: true, count: 0 };
  }
  const bloques = [];
  if (hoyList.length) bloques.push(`💳 *Vence HOY:*\n${hoyList.join('\n')}`);
  if (mananaList.length) bloques.push(`📅 *Vence mañana:*\n${mananaList.join('\n')}`);
  const texto = `🔔 *Recordatorio de pagos*\n\n${bloques.join('\n\n')}\n\nNo te olvides 💛`;

  if (dry) return { ok: true, dry: true, texto, count: hoyList.length + mananaList.length };
  try {
    const sent = await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, texto);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  } catch (e) {
    console.error('[neura/pagos] no pude enviar:', e.message);
    return { ok: false, error: e.message };
  }
  return { ok: true, count: hoyList.length + mananaList.length };
}

export function startPagosCron() {
  if (!config.mia.enabled) return;
  // 08:30 Lima — recordatorio de lo que se paga hoy/mañana.
  cron.schedule('30 8 * * *', () => {
    runPagosRecordatorio({ dry: false }).catch((e) => console.error('[neura/pagos] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[neura/pagos] cron activo (08:30 Lima · recordatorio de pagos/suscripciones)');
}
