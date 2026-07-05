// NEURA · Tu gente — Neura te ayuda a cuidar tus vínculos.
// Cada mañana revisa a las personas que amas: te avisa de cumpleaños y de con
// quién llevas mucho sin hablar (según su cadencia). Mensaje cálido, sin culpa.

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendPrivate } from '../../lib/evolution.js';

const limaMD = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' }).slice(5); // MM-DD

export async function runGenteCheck({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'sin supabase', texto: null };
  const { data } = await miraiSupabase.from('people').select('*');
  const people = data ?? [];
  const now = Date.now();
  const todayMD = limaMD();

  const cumples = [];
  const overdue = [];
  for (const p of people) {
    if (p.birthday && String(p.birthday).slice(5) === todayMD) cumples.push(p);
    const ref = p.last_contact ? new Date(p.last_contact).getTime() : new Date(p.created_at).getTime();
    const days = Math.floor((now - ref) / 864e5);
    if (days >= (p.cadence_days || 14)) overdue.push({ ...p, days });
  }

  const partes = [];
  if (cumples.length) {
    partes.push(`🎂 *Hoy cumple años:* ${cumples.map((p) => p.name).join(', ')}. ¡Escríbele un saludito! 💛`);
  }
  if (overdue.length) {
    const top = overdue.sort((a, b) => b.days - a.days).slice(0, 4);
    partes.push(
      `🫂 *Hace rato no hablas con:*\n${top.map((p) => `• ${p.name}${p.relation ? ` (${p.relation})` : ''} — ${p.days} días`).join('\n')}\n_Quizá hoy sea un buen día para saludar 💛_`,
    );
  }
  if (!partes.length) return { ok: true, texto: null };

  const texto = partes.join('\n\n');
  if (!dry) {
    try { await sendPrivate(config.mia.personalPhone, texto); }
    catch (e) { console.error('[neura/gente] envío:', e.message); return { ok: false, error: e.message, texto }; }
  }
  return { ok: true, texto };
}

export function startGenteCron() {
  if (!config.mia.enabled) return;
  cron.schedule('0 10 * * *', () => {
    runGenteCheck({ dry: false }).catch((e) => console.error('[neura/gente] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[neura/gente] cron activo (10:00 Lima · cuidar tus vínculos)');
}
