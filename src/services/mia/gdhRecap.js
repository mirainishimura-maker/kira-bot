// NEURA · Fase 2 — Recap de GDH.
// Observa (MUDO) el grupo de trabajo "GDH - Ítaca HUB" de Mirai: lee los
// mensajes vía Evolution, Claude los resume + saca pendientes, y se lo manda a
// Mirai EN PRIVADO. Neura nunca escribe en el grupo (el webhook ignora todos
// los grupos que no son el suyo de marketing → mudo garantizado por diseño).

import cron from 'node-cron';
import { config } from '../../config.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';
import { anthropic, CLAUDE_MODEL } from '../../lib/anthropic.js';

const GDH_JID = config.mia.gdhGroupJid;

// Inicio de HOY en Lima como epoch (segundos) — para filtrar por messageTimestamp.
function inicioHoyLimaEpoch() {
  const hoy = new Date().toLocaleString('sv-SE', { timeZone: 'America/Lima' }).slice(0, 10);
  return Math.floor(new Date(`${hoy}T00:00:00-05:00`).getTime() / 1000);
}

// Baja los mensajes del grupo GDH desde Evolution.
async function fetchGdhMessages() {
  const url = `${config.evolution.url}/chat/findMessages/${config.evolution.instance}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
    body: JSON.stringify({ where: { key: { remoteJid: GDH_JID } } }),
  });
  if (!res.ok) throw new Error(`Evolution findMessages HTTP ${res.status}`);
  const json = await res.json();
  const recs = json?.messages?.records ?? json?.messages ?? json ?? [];
  return Array.isArray(recs) ? recs : [];
}

// dry:true → devuelve el texto sin enviar. sinceHours → ventana (default: hoy).
export async function runGdhRecap({ dry = false, sinceHours } = {}) {
  if (!anthropic) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
  if (!config.mia.personalPhone) return { ok: false, error: 'falta MIRAI_PERSONAL_PHONE' };

  let recs;
  try { recs = await fetchGdhMessages(); }
  catch (e) { console.error('[mia/gdh] fetch falló:', e.message); return { ok: false, error: e.message }; }

  const cutoff = sinceHours ? (Math.floor(Date.now() / 1000) - sinceHours * 3600) : inicioHoyLimaEpoch();
  const msgs = recs
    .filter((m) => Number(m.messageTimestamp) >= cutoff)
    .map((m) => {
      const texto = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
      return { autor: m.pushName || 'Alguien', texto };
    })
    .filter((m) => m.texto)
    .reverse(); // findMessages viene del más nuevo al más viejo → orden cronológico

  if (!msgs.length) {
    const texto = '🏢 *GDH* — sin mensajes de texto nuevos en el periodo ✦';
    if (dry) return { ok: true, dry: true, empty: true, texto, count: 0 };
    return { ok: true, empty: true, texto };
  }

  const transcript = msgs.map((m) => `${m.autor}: ${m.texto}`).join('\n').slice(0, 20000);

  const system = `Eres el asistente personal de Mirai. Te paso la conversación de HOY de su grupo de trabajo de WhatsApp "GDH - Ítaca HUB". Resúmesela a ELLA, en español, de forma clara y breve. Formato:

1) Un párrafo corto (2-4 líneas) con lo más importante que se conversó.
2) Una lista de *Pendientes* que salieron (acción concreta, y de quién si se menciona). Si no hay pendientes claros, escribe "Sin pendientes claros".

Reglas: no inventes nada; si algo no se entiende, omítelo; sé concreto y útil. No uses encabezados largos ni relleno.`;

  let summary;
  try {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: `Conversación del grupo GDH:\n\n${transcript}` }],
    });
    summary = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (e) {
    console.error('[mia/gdh] Claude falló:', e.message);
    return { ok: false, error: e.message };
  }
  if (!summary) return { ok: false, error: 'Claude devolvió vacío' };

  const texto = `🏢 *Recap GDH — hoy* (${msgs.length} mensajes)\n\n${summary}`;

  if (dry) return { ok: true, dry: true, texto, count: msgs.length };

  try {
    const sent = await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, texto);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  } catch (e) {
    console.error('[mia/gdh] no pude enviar:', e.message);
    return { ok: false, error: e.message };
  }
  console.log(`[mia/gdh] recap enviado a Mirai | ${msgs.length} mensajes`);
  return { ok: true, texto };
}

export function startGdhRecapCron() {
  if (!config.mia.enabled || !anthropic) {
    console.log('[mia/gdh] cron NO iniciado (Mia deshabilitada o falta ANTHROPIC_API_KEY).');
    return;
  }
  // Recap cada noche a las 20:00 Lima.
  cron.schedule('0 20 * * *', () => {
    runGdhRecap({ dry: false }).catch((e) => console.error('[mia/gdh] sweep falló:', e));
  }, { timezone: 'America/Lima' });
  console.log('[mia/gdh] cron activo | recap GDH 20:00 America/Lima');
}
