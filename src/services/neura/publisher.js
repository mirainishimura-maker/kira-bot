// NEURA — publicador automático a Instagram (@neurapsi2026).
//
// Publica de una COLA: cada disparo del cron toma el próximo post pendiente y lo
// sube a Instagram (post simple o carrusel) con su caption. La cola + el token
// viven en `neura_state.json` en el bucket `neura` del Supabase de Mirai, así se
// pueden actualizar sin redeploy y el token se refresca solo (~60 días).
//
// API: Instagram con login de Instagram → host graph.instagram.com.
//   1) POST /{ig-id}/media (image_url[, is_carousel_item]) → creation_id
//   2) (carrusel) POST /{ig-id}/media (media_type=CAROUSEL, children=...) → id
//   3) POST /{ig-id}/media_publish (creation_id)

import cron from 'node-cron';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';

const GRAPH = 'https://graph.instagram.com/v21.0';
const STATE_FILE = 'neura_state.json';
const REFRESH_CADA_DIAS = 50; // el token dura ~60d; lo refrescamos antes

// ─── Estado persistido (token + cola) en Supabase Storage ─────────────
async function loadState() {
  const def = { token: config.neura.igTokenSeed, tokenSavedAt: null, queue: [] };
  if (!miraiSupabase) return def;
  try {
    const { data, error } = await miraiSupabase.storage.from(config.neura.stateBucket).download(STATE_FILE);
    if (error || !data) return def;
    const txt = await data.text();
    const s = JSON.parse(txt);
    // El token del Storage manda; si no hay, usamos el seed del env.
    if (!s.token) s.token = config.neura.igTokenSeed;
    if (!Array.isArray(s.queue)) s.queue = [];
    return s;
  } catch (err) {
    console.error('[neura] loadState error:', err.message);
    return def;
  }
}

async function saveState(state) {
  if (!miraiSupabase) return;
  const buf = Buffer.from(JSON.stringify(state, null, 2));
  const { error } = await miraiSupabase.storage.from(config.neura.stateBucket)
    .upload(STATE_FILE, buf, { contentType: 'application/json', upsert: true });
  if (error) console.error('[neura] saveState error:', error.message);
}

// ─── Token: refresco automático ───────────────────────────────────────
async function refreshTokenSiHaceFalta(state, nowMs) {
  if (!state.token) return state;
  const savedMs = state.tokenSavedAt ? new Date(state.tokenSavedAt).getTime() : 0;
  const dias = (nowMs - savedMs) / 86400000;
  if (savedMs && dias < REFRESH_CADA_DIAS) return state; // todavía fresco
  try {
    const url = `${'https://graph.instagram.com'}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(state.token)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.access_token) {
      state.token = j.access_token;
      state.tokenSavedAt = new Date(nowMs).toISOString();
      await saveState(state);
      console.log('[neura] token refrescado, válido ~60 días más.');
    } else {
      console.warn('[neura] no pude refrescar token:', JSON.stringify(j).slice(0, 160));
    }
  } catch (err) {
    console.error('[neura] refresh token error:', err.message);
  }
  return state;
}

// ─── Llamadas a la API de publicación ─────────────────────────────────
async function igPost(path, params, token) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}`, { method: 'POST', body });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`IG ${path}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  return j;
}

// Espera a que un contenedor esté FINISHED (sobre todo para carruseles).
async function esperarListo(igId, containerId, token, intentos = 10) {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(`${GRAPH}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`);
      const j = await r.json();
      if (j.status_code === 'FINISHED') return true;
      if (j.status_code === 'ERROR') throw new Error('contenedor en ERROR');
    } catch (err) { /* reintentar */ }
    await new Promise(res => setTimeout(res, 3000));
  }
  return false; // seguimos igual; publish dará error claro si no está listo
}

async function publishSingle(igId, token, imageUrl, caption) {
  const cont = await igPost(`${igId}/media`, { image_url: imageUrl, caption }, token);
  const pub = await igPost(`${igId}/media_publish`, { creation_id: cont.id }, token);
  return pub.id;
}

async function publishCarousel(igId, token, imageUrls, caption) {
  const children = [];
  for (const url of imageUrls) {
    const c = await igPost(`${igId}/media`, { image_url: url, is_carousel_item: 'true' }, token);
    children.push(c.id);
  }
  const cont = await igPost(`${igId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption }, token);
  await esperarListo(igId, cont.id, token);
  const pub = await igPost(`${igId}/media_publish`, { creation_id: cont.id }, token);
  return pub.id;
}

// ─── Barrido: publica el PRÓXIMO pendiente de la cola ─────────────────
// dry=true → solo dice qué publicaría, sin publicar.
export async function runNeuraSweep({ dry = false } = {}) {
  if (!config.neura.enabled) return { ok: false, error: 'NEURA desactivado' };
  if (!config.neura.igUserId) return { ok: false, error: 'falta NEURA_IG_USER_ID' };

  const now = Date.now();
  let state = await loadState();
  if (!state.token) return { ok: false, error: 'falta token (NEURA_IG_TOKEN)' };
  if (!dry) state = await refreshTokenSiHaceFalta(state, now);

  const pendientes = state.queue.filter(p => !p.posted);
  const item = pendientes[0];
  if (!item) {
    console.log('[neura] cola vacía — nada para publicar.');
    return { ok: true, dry, publicado: null, pendientes: 0, mensaje: 'cola vacía' };
  }

  if (dry) {
    return { ok: true, dry: true, proximo: { id: item.id, tipo: item.tipo, caption: (item.caption || '').slice(0, 80) }, pendientes: pendientes.length };
  }

  try {
    const igId = config.neura.igUserId;
    const imgs = item.images || [];
    const mediaId = (item.tipo === 'carousel' || imgs.length > 1)
      ? await publishCarousel(igId, state.token, imgs, item.caption || '')
      : await publishSingle(igId, state.token, imgs[0], item.caption || '');

    item.posted = true;
    item.ig_media_id = mediaId;
    item.posted_at = new Date(now).toISOString();
    await saveState(state);
    console.log(`[neura] publicado "${item.id}" (${item.tipo}) → media ${mediaId} | quedan ${pendientes.length - 1}`);
    return { ok: true, publicado: { id: item.id, mediaId }, pendientes: pendientes.length - 1 };
  } catch (err) {
    console.error(`[neura] error publicando "${item.id}":`, err.message);
    return { ok: false, error: err.message, item: item.id };
  }
}

// ─── Cron: publica en las horas configuradas (Lima) ───────────────────
export function startNeuraCron() {
  if (!config.neura.enabled) {
    console.log('[neura] cron NO iniciado (NEURA_ENABLED no está en true).');
    return;
  }
  const tz = 'America/Lima';
  const horas = config.neura.horas.length ? config.neura.horas : [9, 14, 20];
  const job = async () => {
    try { await runNeuraSweep({ dry: false }); }
    catch (err) { console.error('[neura] sweep falló:', err); }
  };
  cron.schedule(`0 ${horas.join(',')} * * *`, job, { timezone: tz });
  console.log(`[neura] cron activo | publica a las ${horas.join(', ')}h (${tz})`);
}

// Helpers exportados para el setup (subir imágenes + sembrar la cola).
export { loadState, saveState };
