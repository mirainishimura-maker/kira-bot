// Publica UN reel puntual en el Instagram de NEURA (@neurapsi2026) desde la PC,
// sin esperar al cron. Sube el MP4 al bucket público `neura` del Supabase de
// Mirai, toma el token vigente del bucket privado (loadState) y publica el reel.
//
// Uso:  node scripts/publishReelNow.js "C:\\ruta\\al\\reel.mp4"
//
// Nota: el IG user ID no está en el .env local (vive en EasyPanel), así que lo
// fijamos acá. El token SÍ se lee del bucket privado, que es el vigente.

import fs from 'fs';
import path from 'path';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, publishReel } from '../src/services/neura/publisher.js';

const IG_ID = '17841423773440647'; // @neurapsi2026 (CREATOR)

const VIDEO = process.argv[2] || 'C:\\tmp\\reels\\reel_pub.mp4';

const CAPTION = `A veces no es flojera. Es cansancio emocional. 🌿

Reconocerlo ya es un acto de cuidado. En NEURA te acompañamos con psicoterapia online, a tu ritmo y en un espacio seguro 💛

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #bienestaremocional #terapiaonline #psicologia #autocuidado #saludmentalperu`;

async function main() {
  if (!miraiSupabase) throw new Error('miraiSupabase null — faltan credenciales MIRAI_* en .env');
  if (!fs.existsSync(VIDEO)) throw new Error('no existe el video: ' + VIDEO);

  const buf = fs.readFileSync(VIDEO);
  const bucket = config.neura.bucket || 'neura';
  const key = `reels/${path.basename(VIDEO, path.extname(VIDEO))}_${Date.now()}.mp4`;

  console.log(`[reel] subiendo ${(buf.length / 1024).toFixed(0)} KB a ${bucket}/${key} …`);
  const { error: upErr } = await miraiSupabase.storage.from(bucket)
    .upload(key, buf, { contentType: 'video/mp4', upsert: true });
  if (upErr) throw new Error('upload: ' + upErr.message);

  const { data: pub } = miraiSupabase.storage.from(bucket).getPublicUrl(key);
  const videoUrl = pub.publicUrl;
  console.log('[reel] URL pública:', videoUrl);

  const state = await loadState();
  if (!state.token) throw new Error('no hay token en el bucket privado (neura_state.json)');
  console.log('[reel] token cargado; publicando reel (esto procesa el video, ~1 min)…');

  const mediaId = await publishReel(IG_ID, state.token, videoUrl, CAPTION);
  console.log('\n✅ REEL PUBLICADO — media id:', mediaId);
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
