// NEURA · Finanzas v2 — "segundo cerebro financiero".
// Maneja cuentas (saldos), deudas/préstamos en los dos sentidos y metas de
// ahorro, todo por voz. Escribe en el Supabase de Mirai (tablas de la
// migración 0010_finances_v2). Cada handler devuelve { handled, reply } listo
// para responderle a Mirai; neuraAssistant.js solo enruta la intención.
//
// Modelo de saldos:
//   cuenta líquida (banco/efectivo/billetera): saldo = opening + Σingresos − Σgastos
//   cuenta de crédito:                          deuda = opening + Σgastos − Σingresos
//   deuda:  saldo = principal − Σabonos
//   meta:   ahorrado = Σaportes ; falta = target − ahorrado

import { miraiSupabase } from '../../lib/miraiSupabase.js';

const fmt = (n, cur = 'PEN') =>
  cur === 'USD' ? `$ ${Number(Math.abs(n)).toFixed(2)}` : `S/ ${Number(Math.abs(n)).toFixed(2)}`;

const clean = (s) => (s || '').trim();

// ─── Cuentas ────────────────────────────────────────────────────────────────
export async function resolveAccount(name) {
  if (!clean(name)) return { error: '¿Con qué cuenta? (BCP, BBVA, Yape, efectivo…) 🙂' };
  const { data } = await miraiSupabase
    .from('accounts').select('*').eq('archived', false)
    .ilike('name', `%${clean(name)}%`).limit(6);
  const rows = data ?? [];
  if (!rows.length) return { error: `No tengo una cuenta que se llame "${clean(name)}". La creas en el panel o dime otra 🙂` };
  if (rows.length > 1) return { error: `Tengo varias que coinciden con "${clean(name)}": ${rows.map((r) => r.name).join(', ')}. ¿Cuál?` };
  return { account: rows[0] };
}

// Neto de movimientos de una cuenta ya orientado: líquida → +ingresos−gastos;
// crédito → +gastos−ingresos (o sea, cuánto sube la deuda).
async function movementsNet(acc) {
  const { data } = await miraiSupabase.from('finances').select('direction, amount').eq('account_id', acc.id);
  let ing = 0, gas = 0;
  for (const m of data ?? []) {
    const a = Number(m.amount || 0);
    if (m.direction === 'ingreso') ing += a; else gas += a;
  }
  return acc.kind === 'credito' ? gas - ing : ing - gas;
}

// Saldo (o deuda, si es crédito) actual de la cuenta.
export async function accountBalance(acc) {
  return Number(acc.opening_balance || 0) + (await movementsNet(acc));
}

export async function handleConsultarSaldo(s) {
  const target = clean(s?.account).toLowerCase();
  const esTotal = !target || ['total', 'todo', 'todas', 'todas mis cuentas', 'en total'].includes(target);

  if (!esTotal) {
    const { account, error } = await resolveAccount(s.account);
    if (error) return { handled: true, reply: error };
    const bal = await accountBalance(account);
    if (account.kind === 'credito') {
      return { handled: true, reply: `💳 *${account.name}* — debes ${fmt(bal, account.currency)}.` };
    }
    return { handled: true, reply: `🏦 *${account.name}* — tienes ${fmt(bal, account.currency)}.` };
  }

  const { data } = await miraiSupabase.from('accounts').select('*').eq('archived', false).order('sort');
  const cuentas = data ?? [];
  if (!cuentas.length) return { handled: true, reply: 'Aún no tienes cuentas configuradas ✦' };
  const liquidas = [], creditos = [];
  let totalPEN = 0;
  for (const c of cuentas) {
    const bal = await accountBalance(c);
    if (c.kind === 'credito') creditos.push([c, bal]);
    else { liquidas.push([c, bal]); if (c.currency === 'PEN') totalPEN += bal; }
  }
  const lines = liquidas.map(([c, b]) => `• ${c.name}: ${fmt(b, c.currency)}`);
  let out = `💰 *Tus cuentas:*\n${lines.join('\n')}\n\n*Total (soles):* ${fmt(totalPEN)}`;
  if (creditos.length) {
    const cl = creditos.map(([c, b]) => `• ${c.name}: debes ${fmt(b, c.currency)}`);
    out += `\n\n💳 *Créditos:*\n${cl.join('\n')}`;
  }
  return { handled: true, reply: `${out} ✦` };
}

export async function handleAjustarSaldo(s) {
  const monto = Number(s?.amount);
  if (!Number.isFinite(monto)) return { handled: true, reply: '¿En cuánto dejo el saldo? Ej: "tengo 50 en el BBVA" 🙂' };
  const { account, error } = await resolveAccount(s?.account);
  if (error) return { handled: true, reply: error };
  const nuevoOpening = monto - (await movementsNet(account)); // así el saldo calculado = monto
  const { error: e } = await miraiSupabase.from('accounts').update({ opening_balance: nuevoOpening }).eq('id', account.id);
  if (e) { console.error('[neura/fin] ajustar saldo:', e.message); return { handled: true, reply: 'Uy, no pude ajustarlo. ¿Me lo repites?' }; }
  const verbo = account.kind === 'credito' ? 'Deuda' : 'Saldo';
  return { handled: true, reply: `✅ ${verbo} de *${account.name}* quedó en ${fmt(monto, account.currency)}.\nLo ves en Neura → Finanzas ✦` };
}

// ─── Deudas / préstamos ───────────────────────────────────────────────────────
async function debtBalance(debt) {
  const { data } = await miraiSupabase.from('debt_payments').select('amount').eq('debt_id', debt.id);
  const pagado = (data ?? []).reduce((a, x) => a + Number(x.amount || 0), 0);
  return Number(debt.principal || 0) - pagado;
}

async function resolveDebt(counterparty, direction) {
  if (!clean(counterparty)) return { error: '¿Con quién es la deuda? Dime el nombre 🙂' };
  let q = miraiSupabase.from('debts').select('*').eq('status', 'activa').ilike('counterparty', `%${clean(counterparty)}%`);
  if (direction === 'debo' || direction === 'me_deben') q = q.eq('direction', direction);
  const { data } = await q.limit(6);
  const rows = data ?? [];
  if (!rows.length) return { error: null, debt: null };
  if (rows.length > 1) return { error: `Tengo varias deudas con "${clean(counterparty)}". Sé más específica 🙂`, debt: null };
  return { debt: rows[0] };
}

// Red de seguridad: el modelo a veces invierte la dirección ("me prestaron" →
// yo DEBO). Inferimos de la frase cuando es clara; si no, usamos lo del modelo.
function inferDireccion(raw, fallback) {
  const t = (raw || '').toLowerCase();
  if (/\ble\s+prest[ée]|\bles\s+prest[ée]|\bprest[ée]\s+a\b|\byo\s+le?\s*prest|me\s+deben?\b|me\s+tienen?\s+que\s+(devolver|pagar)/.test(t)) return 'me_deben';
  if (/me\s+prest(ó|o|aron)|me\s+hi(zo|cieron)\s+un\s+préstamo|le\s+debo|debo\s+a\b|qued[ée]\s+debiend/.test(t)) return 'debo';
  return fallback;
}

export async function handleRegistrarDeuda(d, raw) {
  const counter = clean(d?.counterparty);
  if (!counter) return { handled: true, reply: '¿Con quién es el préstamo? Dime el nombre 🙂' };
  const monto = Number(d?.amount);
  if (!Number.isFinite(monto) || monto <= 0) return { handled: true, reply: '¿De cuánto es? Ej: "le debo 500 a César" 🙂' };
  const direction = inferDireccion(raw, d?.direction === 'me_deben' ? 'me_deben' : 'debo');
  const currency = d?.currency === 'USD' ? 'USD' : 'PEN';
  const { error } = await miraiSupabase.from('debts').insert({
    counterparty: counter, direction, principal: monto, currency, note: raw ? `voz: ${raw}`.slice(0, 200) : null,
  });
  if (error) { console.error('[neura/fin] registrar deuda:', error.message); return { handled: true, reply: 'Uy, no pude registrar la deuda. ¿Me lo repites?' }; }
  const frase = direction === 'debo' ? `Le debes ${fmt(monto, currency)} a ${counter}` : `${counter} te debe ${fmt(monto, currency)}`;
  return { handled: true, reply: `🤝 Anotado: ${frase}.\nCuando abones/te abonen, dime y lo descuento ✦` };
}

export async function handleAbonarDeuda(d, raw) {
  const counter = clean(d?.counterparty);
  if (!counter) return { handled: true, reply: '¿A quién le abonaste? Dime el nombre 🙂' };
  const monto = Number(d?.amount);
  if (!Number.isFinite(monto) || monto <= 0) return { handled: true, reply: '¿Cuánto se abonó? Ej: "le aboné 100 a César" 🙂' };
  const { debt, error } = await resolveDebt(counter, d?.direction);
  if (error) return { handled: true, reply: error };
  if (!debt) return { handled: true, reply: `No tengo una deuda activa con "${counter}". ¿La registro? Dime "le debo X a ${counter}" 🙂` };
  const { error: e } = await miraiSupabase.from('debt_payments').insert({
    debt_id: debt.id, amount: monto, note: raw ? `voz: ${raw}`.slice(0, 200) : null,
  });
  if (e) { console.error('[neura/fin] abonar deuda:', e.message); return { handled: true, reply: 'Uy, no pude registrar el abono. ¿Me lo repites?' }; }
  const saldo = await debtBalance(debt);
  if (saldo <= 0.5) {
    await miraiSupabase.from('debts').update({ status: 'pagada' }).eq('id', debt.id);
    return { handled: true, reply: `🎉 ¡Listo! Con ese abono la deuda con ${debt.counterparty} quedó *saldada*. ¡Bien ahí! 💪` };
  }
  const frase = debt.direction === 'debo' ? `Te queda por pagar` : `Aún te debe`;
  return { handled: true, reply: `✅ Abono de ${fmt(monto, debt.currency)} a ${debt.counterparty}.\n${frase}: *${fmt(saldo, debt.currency)}* ✦` };
}

export async function handleConsultarDeudaPersonal(d) {
  const counter = clean(d?.counterparty);
  if (counter) {
    const { debt, error } = await resolveDebt(counter, d?.direction);
    if (error) return { handled: true, reply: error };
    if (!debt) return { handled: true, reply: `No tengo deudas activas con "${counter}" 🤔` };
    const saldo = await debtBalance(debt);
    const frase = debt.direction === 'debo' ? `Le debes a ${debt.counterparty}` : `${debt.counterparty} te debe`;
    return { handled: true, reply: `🤝 ${frase}: *${fmt(saldo, debt.currency)}* ✦` };
  }
  const { data } = await miraiSupabase.from('debts').select('*').eq('status', 'activa');
  const rows = data ?? [];
  if (!rows.length) return { handled: true, reply: '✅ No tienes deudas ni préstamos activos 🎉' };
  const debo = [], meDeben = [];
  for (const dbt of rows) {
    const saldo = await debtBalance(dbt);
    if (saldo <= 0.5) continue;
    (dbt.direction === 'debo' ? debo : meDeben).push(`• ${dbt.counterparty}: ${fmt(saldo, dbt.currency)}`);
  }
  const partes = [];
  if (debo.length) partes.push(`🔴 *Debes:*\n${debo.join('\n')}`);
  if (meDeben.length) partes.push(`🟢 *Te deben:*\n${meDeben.join('\n')}`);
  if (!partes.length) return { handled: true, reply: '✅ No tienes deudas ni préstamos pendientes 🎉' };
  return { handled: true, reply: `${partes.join('\n\n')} ✦` };
}

// ─── Metas de ahorro ──────────────────────────────────────────────────────────
async function goalSaved(goal) {
  const { data } = await miraiSupabase.from('goal_contributions').select('amount').eq('goal_id', goal.id);
  return (data ?? []).reduce((a, x) => a + Number(x.amount || 0), 0);
}

async function resolveGoal(name) {
  if (!clean(name)) return { error: '¿Cuál meta? Ej: "mete 50 a Georgia" 🙂', goal: null };
  const { data } = await miraiSupabase.from('goals').select('*').neq('status', 'lograda').ilike('name', `%${clean(name)}%`).limit(6);
  const rows = data ?? [];
  if (!rows.length) return { error: null, goal: null };
  if (rows.length > 1) return { error: `Tengo varias metas con "${clean(name)}": ${rows.map((r) => r.name).join(', ')}. ¿Cuál?`, goal: null };
  return { goal: rows[0] };
}

export async function handleCrearMeta(m, raw) {
  const name = clean(m?.name);
  if (!name) return { handled: true, reply: '¿Cómo se llama la meta? Ej: "quiero ahorrar 5000 para Georgia" 🙂' };
  const target = Number(m?.target);
  const currency = m?.currency === 'USD' ? 'USD' : 'PEN';
  const { error } = await miraiSupabase.from('goals').insert({
    name, target_amount: Number.isFinite(target) && target > 0 ? target : null, currency,
    note: raw ? `voz: ${raw}`.slice(0, 200) : null,
  });
  if (error) { console.error('[neura/fin] crear meta:', error.message); return { handled: true, reply: 'Uy, no pude crear la meta. ¿Me lo repites?' }; }
  const meta = Number.isFinite(target) && target > 0 ? ` de ${fmt(target, currency)}` : '';
  return { handled: true, reply: `🎯 Meta creada: *${name}*${meta}.\nCuando ahorres para esto, dime "mete X a ${name}" ✦` };
}

export async function handleAportarMeta(m, raw) {
  const monto = Number(m?.amount);
  if (!Number.isFinite(monto) || monto <= 0) return { handled: true, reply: '¿Cuánto le metes? Ej: "mete 50 a Georgia" 🙂' };
  const { goal, error } = await resolveGoal(m?.name);
  if (error) return { handled: true, reply: error };
  if (!goal) return { handled: true, reply: `No tengo una meta que se llame "${clean(m?.name)}". ¿La creo? Dime "quiero ahorrar X para ${clean(m?.name)}" 🙂` };
  const { error: e } = await miraiSupabase.from('goal_contributions').insert({
    goal_id: goal.id, amount: monto, note: raw ? `voz: ${raw}`.slice(0, 200) : null,
  });
  if (e) { console.error('[neura/fin] aportar meta:', e.message); return { handled: true, reply: 'Uy, no pude guardar el aporte. ¿Me lo repites?' }; }
  const ahorrado = await goalSaved(goal);
  let linea = `Llevas *${fmt(ahorrado, goal.currency)}*`;
  if (goal.target_amount) {
    const falta = Number(goal.target_amount) - ahorrado;
    const pct = Math.min(100, Math.round((ahorrado / Number(goal.target_amount)) * 100));
    linea = falta <= 0.5
      ? `¡Ya llegaste a la meta de ${fmt(goal.target_amount, goal.currency)}! 🎉`
      : `Llevas *${fmt(ahorrado, goal.currency)}* de ${fmt(goal.target_amount, goal.currency)} (${pct}%) · faltan ${fmt(falta, goal.currency)}`;
    if (falta <= 0.5) await miraiSupabase.from('goals').update({ status: 'lograda' }).eq('id', goal.id);
  }
  return { handled: true, reply: `💪 Aporte de ${fmt(monto, goal.currency)} a *${goal.name}*.\n${linea} ✦` };
}

export async function handleConsultarMetas() {
  const { data } = await miraiSupabase.from('goals').select('*').eq('status', 'activa').order('sort');
  const rows = data ?? [];
  if (!rows.length) return { handled: true, reply: 'Aún no tienes metas activas. Dime "quiero ahorrar X para Y" y la creamos 🙂' };
  const lines = [];
  for (const g of rows) {
    const ahorrado = await goalSaved(g);
    if (g.target_amount) {
      const pct = Math.min(100, Math.round((ahorrado / Number(g.target_amount)) * 100));
      const falta = Math.max(0, Number(g.target_amount) - ahorrado);
      lines.push(`${g.emoji || '🎯'} *${g.name}*: ${fmt(ahorrado, g.currency)} / ${fmt(g.target_amount, g.currency)} (${pct}%) · faltan ${fmt(falta, g.currency)}`);
    } else {
      lines.push(`${g.emoji || '🎯'} *${g.name}*: ${fmt(ahorrado, g.currency)} ahorrado`);
    }
  }
  return { handled: true, reply: `🎯 *Tus metas:*\n${lines.join('\n')} ✦` };
}
