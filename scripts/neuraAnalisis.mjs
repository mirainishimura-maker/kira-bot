// Análisis de métricas de @neurapsi2026: cuenta (seguidores, alcance, visitas,
// tendencia de seguidores) + rendimiento post por post (alcance, likes,
// guardados, compartidos, plays). Defensivo: cada métrica por separado.
//
// Uso: node scripts/neuraAnalisis.mjs

import { config } from '../src/config.js';
import { loadState } from '../src/services/neura/publisher.js';

const GRAPH = 'https://graph.instagram.com/v21.0';

async function ig(path, params, token) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}?${qs}`);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || `IG ${r.status}`);
  return j;
}
const tryf = async (fn, d = null) => { try { return await fn(); } catch { return d; } };

async function main() {
  const igId = config.neura.igUserId;
  const state = await loadState();
  const token = state?.token;
  if (!token || !igId) { console.log('❌ sin token o igUserId'); return; }

  console.log('════════ CUENTA @neurapsi2026 ════════');
  const me = await tryf(() => ig(igId, { fields: 'username,followers_count,follows_count,media_count' }, token), {});
  console.log(`Usuario:      @${me.username ?? '?'}`);
  console.log(`Seguidores:   ${me.followers_count ?? '?'}`);
  console.log(`Siguiendo:    ${me.follows_count ?? '?'}`);
  console.log(`Publicaciones:${me.media_count ?? '?'}`);

  const until = Math.floor(Date.now() / 1000);
  const since = until - 30 * 86400;
  const sumMetric = async (metric, extra = {}) => tryf(async () => {
    const ins = await ig(`${igId}/insights`, { metric, period: 'day', since, until, ...extra }, token);
    const vals = ins.data?.[0]?.values || [];
    return vals.reduce((a, v) => a + (Number(v.value) || 0), 0);
  });
  console.log('\n──── Últimos 30 días (cuenta) ────');
  console.log(`Alcance (reach):       ${await sumMetric('reach') ?? 'n/d'}`);
  console.log(`Visitas al perfil:     ${await sumMetric('profile_views') ?? 'n/d'}`);
  console.log(`Cuentas alcanzadas:    ${await sumMetric('accounts_engaged', { metric_type: 'total_value' }) ?? 'n/d'}`);
  console.log(`Interacciones totales: ${await sumMetric('total_interactions', { metric_type: 'total_value' }) ?? 'n/d'}`);

  // Tendencia de seguidores (serie diaria).
  const fc = await tryf(() => ig(`${igId}/insights`, { metric: 'follower_count', period: 'day', since, until }, token));
  if (fc?.data?.[0]?.values?.length) {
    const vals = fc.data[0].values.filter(v => v.value != null);
    if (vals.length) {
      console.log(`\nTendencia seguidores (30d): ${vals[0].value} → ${vals[vals.length-1].value} (Δ ${vals[vals.length-1].value - vals[0].value})`);
    }
  } else {
    console.log('\nTendencia seguidores: n/d (IG no la da con <100 seguidores).');
  }

  // Rendimiento post por post (los publicados en la cola).
  console.log('\n════════ POSTS PUBLICADOS ════════');
  const posted = (state.queue || []).filter(p => p.posted && p.ig_media_id);
  console.log(`En la cola hay ${posted.length} posts publicados con media_id.\n`);

  // Traemos también los medias reales de la cuenta (por si hay más).
  const mediaList = await tryf(() => ig(`${igId}/media`, { fields: 'id,media_type,media_product_type,timestamp,like_count,comments_count,caption', limit: 50 }, token));
  const medias = mediaList?.data || [];
  console.log(`La cuenta reporta ${medias.length} medias (via API).\n`);

  const rows = [];
  for (const m of medias) {
    const ins = await tryf(() => ig(`${m.id}/insights`, { metric: 'reach,saved,shares,total_interactions' }, token));
    const met = {};
    for (const d of (ins?.data || [])) met[d.name] = d.values?.[0]?.value ?? d.total_value?.value ?? null;
    rows.push({
      fecha: (m.timestamp || '').slice(0, 10),
      tipo: (m.media_product_type || m.media_type || '').toLowerCase(),
      reach: met.reach ?? '—',
      likes: m.like_count ?? '—',
      coment: m.comments_count ?? '—',
      guard: met.saved ?? '—',
      comp: met.shares ?? '—',
      cap: (m.caption || '').replace(/\n/g, ' ').slice(0, 34),
    });
  }
  rows.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  console.log('fecha       tipo       reach  likes  coment guard  comp  | caption');
  console.log('─'.repeat(92));
  for (const r of rows) {
    console.log(
      `${(r.fecha||'').padEnd(11)} ${String(r.tipo).padEnd(9)} ${String(r.reach).padStart(5)}  ${String(r.likes).padStart(5)}  ${String(r.coment).padStart(5)}  ${String(r.guard).padStart(5)} ${String(r.comp).padStart(5)}  | ${r.cap}`
    );
  }

  // Promedios por tipo.
  const byType = {};
  for (const r of rows) {
    const t = r.tipo || '?';
    byType[t] ??= { n: 0, reach: 0, eng: 0 };
    byType[t].n++;
    if (typeof r.reach === 'number') byType[t].reach += r.reach;
    const eng = (Number(r.likes)||0) + (Number(r.coment)||0) + (Number(r.guard)||0) + (Number(r.comp)||0);
    byType[t].eng += eng;
  }
  console.log('\n──── Promedio por tipo ────');
  for (const [t, s] of Object.entries(byType)) {
    console.log(`${t.padEnd(10)} n=${s.n}  reach prom=${(s.reach/s.n).toFixed(0)}  interacc prom=${(s.eng/s.n).toFixed(1)}`);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
