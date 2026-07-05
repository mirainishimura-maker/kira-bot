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
  await esperarListo(igId, cont.id, token); // esperar a que IG termine de procesar la imagen
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

// Reel (video vertical 9:16). El contenedor tarda más en procesar (video),
// por eso esperamos más intentos a que quede FINISHED antes de publicar.
// share_to_feed=true → también aparece en el feed, no solo en la pestaña Reels.
//
// Portada: sin esto IG usa el frame 0, que en nuestros reels es el fade-in negro.
//   · coverUrl (imagen) → portada diseñada; gana si existe.
//   · si no, thumb_offset = un frame ya visible (default config.neura.reelThumbMs)
//     para evitar el negro. Aplica a TODO reel (cola, futuros y scripts a mano).
async function publishReel(igId, token, videoUrl, caption, { coverUrl = null, thumbOffset = config.neura.reelThumbMs } = {}) {
  const params = { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' };
  if (coverUrl) params.cover_url = coverUrl;
  else if (Number.isInteger(thumbOffset) && thumbOffset > 0) params.thumb_offset = String(thumbOffset);
  const cont = await igPost(`${igId}/media`, params, token);
  const listo = await esperarListo(igId, cont.id, token, 40); // hasta ~2 min
  if (!listo) console.warn('[neura] reel quizá no terminó de procesar; intento publicar igual…');
  const pub = await igPost(`${igId}/media_publish`, { creation_id: cont.id }, token);
  return pub.id;
}

// Story (efímera 24h), imagen o video vertical 9:16. media_type=STORIES.
async function publishStory(igId, token, { imageUrl, videoUrl }) {
  const params = videoUrl
    ? { media_type: 'STORIES', video_url: videoUrl }
    : { media_type: 'STORIES', image_url: imageUrl };
  const cont = await igPost(`${igId}/media`, params, token);
  await esperarListo(igId, cont.id, token, videoUrl ? 40 : 10);
  const pub = await igPost(`${igId}/media_publish`, { creation_id: cont.id }, token);
  return pub.id;
}

// ─── Barrido: publica el PRÓXIMO pendiente de la cola ─────────────────
// dry=true → solo dice qué publicaría, sin publicar.
export async function runNeuraSweep({ dry = false, prefer = null } = {}) {
  if (!config.neura.enabled) return { ok: false, error: 'NEURA desactivado' };
  if (!config.neura.igUserId) return { ok: false, error: 'falta NEURA_IG_USER_ID' };

  const now = Date.now();
  let state = await loadState();
  if (!state.token) return { ok: false, error: 'falta token (NEURA_IG_TOKEN)' };
  if (!dry) state = await refreshTokenSiHaceFalta(state, now);

  const pendientes = state.queue.filter(p => !p.posted);
  // prefer = prioridad de tipo para ESTE horario (ej. ['carousel','single','reel']).
  // Toma el 1er pendiente del tipo de mayor prioridad disponible; si ninguno, FIFO.
  let item = null;
  if (prefer && prefer.length) {
    for (const t of prefer) { item = pendientes.find(p => p.tipo === t); if (item) break; }
  }
  if (!item) item = pendientes[0];
  if (!item) {
    console.log('[neura] cola vacía — nada para publicar.');
    return { ok: true, dry, publicado: null, pendientes: 0, mensaje: 'cola vacía' };
  }

  if (dry) {
    return { ok: true, dry: true, prefer, proximo: { id: item.id, tipo: item.tipo, caption: (item.caption || '').slice(0, 80) }, pendientes: pendientes.length };
  }

  try {
    const igId = config.neura.igUserId;
    const imgs = item.images || [];
    let mediaId;
    if (item.tipo === 'reel') {
      mediaId = await publishReel(igId, state.token, item.video || imgs[0], item.caption || '', { coverUrl: item.cover || null });
    } else if (item.tipo === 'carousel' || imgs.length > 1) {
      mediaId = await publishCarousel(igId, state.token, imgs, item.caption || '');
    } else {
      mediaId = await publishSingle(igId, state.token, imgs[0], item.caption || '');
    }

    item.posted = true;
    item.ig_media_id = mediaId;
    item.posted_at = new Date(now).toISOString();
    await saveState(state);
    await writeNeuraStatus(state);
    console.log(`[neura] publicado "${item.id}" (${item.tipo}) → media ${mediaId} | quedan ${pendientes.length - 1}`);

    // Re-compartir la publicación recién hecha a una story (boost de alcance).
    if (config.neura.reshareStory) {
      try {
        const story = item.tipo === 'reel' ? { videoUrl: item.video || imgs[0] } : { imageUrl: imgs[0] };
        const sid = await publishStory(igId, state.token, story);
        console.log(`[neura] re-compartido a story → ${sid}`);
      } catch (e) { console.warn('[neura] reshare a story falló:', e.message); }
    }
    return { ok: true, publicado: { id: item.id, mediaId }, pendientes: pendientes.length - 1 };
  } catch (err) {
    console.error(`[neura] error publicando "${item.id}":`, err.message);
    return { ok: false, error: err.message, item: item.id };
  }
}

// ─── Story "frase del día": publica la próxima de la cola state.stories ──
export async function runNeuraStory({ dry = false } = {}) {
  if (!config.neura.enabled) return { ok: false, error: 'NEURA desactivado' };
  if (!config.neura.igUserId) return { ok: false, error: 'falta NEURA_IG_USER_ID' };
  const now = Date.now();
  let state = await loadState();
  if (!state.token) return { ok: false, error: 'falta token' };
  if (!Array.isArray(state.stories)) state.stories = [];
  const item = state.stories.find(s => !s.posted);
  if (!item) { console.log('[neura] sin stories en cola.'); return { ok: true, mensaje: 'sin stories' }; }
  if (dry) return { ok: true, dry: true, proximo: item.id, pendientes: state.stories.filter(s => !s.posted).length };
  state = await refreshTokenSiHaceFalta(state, now);
  try {
    const sid = await publishStory(config.neura.igUserId, state.token, { imageUrl: item.image });
    item.posted = true; item.ig_media_id = sid; item.posted_at = new Date(now).toISOString();
    await saveState(state);
    console.log(`[neura] story publicada "${item.id}" → ${sid}`);
    return { ok: true, publicado: sid };
  } catch (err) {
    console.error('[neura] story falló:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Status público para el panel Neura (sin token) ───────────────────
// Escribe un resumen sanitizado de la cola/estado a `neura_status.json` en el
// bucket PÚBLICO, para que el panel Neura lo lea sin credenciales ni token.
async function writeNeuraStatus(stateArg) {
  if (!miraiSupabase) return;
  try {
    const state = stateArg || await loadState();
    const q = Array.isArray(state.queue) ? state.queue : [];
    const pend = q.filter((p) => !p.posted);
    const posted = q.filter((p) => p.posted);
    const cap = (s) => (s || '').slice(0, 140);
    const status = {
      updated_at: new Date().toISOString(),
      enabled: config.neura.enabled,
      ig_user: '@neurapsi2026',
      horas: config.neura.horas,
      pendientes: pend.length,
      publicados: posted.length,
      stories_pendientes: Array.isArray(state.stories) ? state.stories.filter((s) => !s.posted).length : 0,
      proximo: pend[0] ? { tipo: pend[0].tipo, caption: cap(pend[0].caption) } : null,
      cola: pend.slice(0, 20).map((p) => ({ id: p.id, tipo: p.tipo, caption: cap(p.caption) })),
      recientes: posted.slice(-10).reverse().map((p) => ({ tipo: p.tipo, caption: cap(p.caption), posted_at: p.posted_at, ig_media_id: p.ig_media_id })),
    };
    const buf = Buffer.from(JSON.stringify(status));
    const { error } = await miraiSupabase.storage.from(config.neura.bucket)
      .upload('neura_status.json', buf, { contentType: 'application/json', upsert: true, cacheControl: '60' });
    if (error) console.error('[neura] writeNeuraStatus upload:', error.message);
  } catch (e) { console.error('[neura] writeNeuraStatus:', e.message); }
}

// ─── Cron: publica en las horas configuradas (Lima) ───────────────────
export function startNeuraCron() {
  if (!config.neura.enabled) {
    console.log('[neura] cron NO iniciado (NEURA_ENABLED no está en true).');
    return;
  }
  const tz = 'America/Lima';
  const horas = config.neura.horas.length ? config.neura.horas : [9, 12, 15, 18, 21];
  // Modo VACIADO DE BACKLOG: publicamos en el ORDEN de la cola (FIFO), que ya
  // viene intercalado (2 reels + relleno por día, video real primero). Sin
  // prioridad por tipo, para que el orden intercalado se respete tal cual.
  horas.forEach((h) => {
    cron.schedule(`0 ${h} * * *`, async () => {
      try { await runNeuraSweep({ dry: false, prefer: null }); }
      catch (err) { console.error('[neura] sweep falló:', err); }
    }, { timezone: tz });
  });
  console.log(`[neura] cron diario FIFO (vaciado backlog) | ${horas.join('h, ')}h (${tz})`);

  // Status público para el panel Neura: al arrancar y cada hora (minuto 7).
  writeNeuraStatus().catch(() => {});
  cron.schedule('7 * * * *', () => { writeNeuraStatus().catch(() => {}); }, { timezone: tz });

  // Story "frase del día" (cola state.stories) en su propio horario. 0 = off.
  const sh = config.neura.storyHora;
  if (Number.isInteger(sh) && sh >= 1 && sh <= 23) {
    cron.schedule(`0 ${sh} * * *`, async () => {
      try { await runNeuraStory({ dry: false }); }
      catch (err) { console.error('[neura] story cron falló:', err); }
    }, { timezone: tz });
    console.log(`[neura] story "frase del día" a las ${sh}h (${tz})`);
  }
}

// Helpers exportados para el setup (subir imágenes + sembrar la cola) y para
// publicar contenido puntual desde un script (reel, single o carrusel).
export { loadState, saveState, publishReel, publishSingle, publishCarousel, publishStory, writeNeuraStatus };
