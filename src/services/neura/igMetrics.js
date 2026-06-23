// Lee métricas básicas de Instagram de @neurapsi2026 (seguidores, alcance,
// visitas al perfil) vía graph.instagram.com. Defensivo: la API de insights de
// IG es caprichosa, así que cada métrica se intenta por separado y si falla se
// devuelve null (el reporte igual muestra lo que sí pudo traer).

import { config } from '../../config.js';
import { loadState } from './publisher.js';

const GRAPH = 'https://graph.instagram.com/v21.0';

async function ig(path, params, token) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}?${qs}`);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || `IG ${r.status}`);
  return j;
}

export async function fetchIgMetrics() {
  const out = { followers: null, media: null, reach7d: null, profileViews7d: null, error: null };
  try {
    const igId = config.neura.igUserId;
    const state = await loadState();
    const token = state?.token;
    if (!token || !igId) { out.error = 'sin token o igUserId'; return out; }

    // Seguidores + nº de publicaciones (campo simple, confiable).
    try {
      const me = await ig(igId, { fields: 'followers_count,media_count' }, token);
      out.followers = me.followers_count ?? null;
      out.media = me.media_count ?? null;
    } catch (e) { /* sigue */ }

    // Insights de los últimos 7 días (cada métrica por separado).
    const until = Math.floor(Date.now() / 1000);
    const since = until - 7 * 86400;
    const tryMetric = async (metric) => {
      try {
        const ins = await ig(`${igId}/insights`, { metric, period: 'day', since, until }, token);
        const vals = ins.data?.[0]?.values || [];
        return vals.reduce((a, v) => a + (Number(v.value) || 0), 0);
      } catch { return null; }
    };
    out.reach7d = await tryMetric('reach');
    out.profileViews7d = await tryMetric('profile_views');

    return out;
  } catch (e) {
    out.error = e.message;
    return out;
  }
}
