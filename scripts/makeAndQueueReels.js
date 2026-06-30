// Convierte imágenes estáticas de NEURA (render17, 4:5) en REELS 9:16 con
// fondo borroso + imagen nítida centrada + zoom lento + fade + audio ambient,
// los sube al bucket público `neura` y reordena la cola REELS PRIMERO.
//
// El feed estático no crece una cuenta nueva; los reels sí tienen alcance.
// Esto da un lote de reels para liderar la cola mientras se mide el alcance.
//
// Requisitos: ffmpeg instalado. Pásalo por env si no está en PATH:
//   FFMPEG_PATH="C:\\...\\ffmpeg.exe" node scripts/makeAndQueueReels.js
// Audio: C:\tmp\reels\ambient.wav  ·  Fuente: neura_studio/render17 (1080x1350)
//
// Por seguridad guarda un backup del estado actual en C:\tmp\reels\auto\ antes
// de escribir. Para solo generar los MP4 sin tocar la cola: con DRY=1.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const FF     = process.env.FFMPEG_PATH || 'ffmpeg';
const AUD    = 'C:\\tmp\\reels\\ambient.wav';
const OUTDIR = 'C:\\tmp\\reels\\auto';
const SRC    = 'C:\\projects\\nowa\\neura_studio\\render17';
const DRY    = process.env.DRY === '1';

// Curaduría: imágenes con hook fuerte + su copy (reusado de queueNeuraPosts).
// `base` = prefijo del id del POST-foto equivalente, para sacarlo de la cola
// (no publicar la misma imagen como foto y como reel).
const ITEMS = [
  { key: 'dato', base: 'p_dato', file: '16_Dato.png', caption:
`1 de cada 3 personas vivirá ansiedad en algún momento de su vida. 🌿

No estás solx, y no estás exagerando. Pedir ayuda es válido y valiente.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #ansiedad #bienestaremocional #terapiaonline #saludmentalperu` },

  { key: 'mitos', base: 'p_mitos', file: '12_Mitos_vs_Realidad.png', caption:
`Mito: la terapia es solo para cuando estás en crisis. 🚫

Realidad: es para conocerte, cuidarte y crecer — no necesitas tocar fondo para empezar. 🤍

📲 Escríbenos — link en la bio.

#saludmental #terapia #mitos #psicologia #bienestaremocional` },

  { key: 'resuelto', base: 'p_resuelto', file: '04_Frase_iOS.png', caption:
`Spoiler: nadie lo tiene todo resuelto. 🤍 Y está bien.

Darte permiso de no saber, de equivocarte, de ir despacio — eso también es salud mental.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #autocompasion #bienestaremocional #terapiaonline #psicologia` },

  { key: 'pregunta', base: 'p_pregunta', file: '14_Pregunta.png', caption:
`Pregunta honesta: ¿cómo está tu descanso últimamente? 🌙

Reparador, interrumpido, o casi inexistente… Leerte es el primer paso — cuéntanos en los comentarios.

📲 ¿Necesitas apoyo? Escríbenos — link en la bio.

#saludmental #descanso #sueño #bienestaremocional #autocuidado` },

  { key: 'sentir', base: 'p_sentir', file: '11_Frase_texturizada.png', caption:
`No tienes que “estar bien” todo el tiempo. Sentir —incluso lo difícil— también es parte de sanar. 🌿

Darte permiso de sentir es un acto de cuidado.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #emociones #bienestaremocional #terapiaonline #autocuidado` },

  { key: 'limites', base: 'p_limites', file: '07_Lista_recursos.png', caption:
`Poner límites no te hace egoísta. Te cuida. 🤍

Decir “no” sin culpa, respetar tu descanso, alejarte de lo que te agota, pedir ayuda a tiempo. Empieza por uno.

📲 Escríbenos — link en la bio.

#saludmental #limites #autocuidado #bienestaremocional #terapiaonline` },

  { key: 'cita', base: 'p_cita', file: '18_Cita.png', caption:
`Sanar no siempre es avanzar rápido. A veces es volver — a tu cuerpo, a tu calma, a quien eras antes de cargar tanto. 🤍

En NEURA te acompañamos en ese camino, a tu ritmo y en un espacio seguro.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #sanar #bienestaremocional #terapiaonline #psicologia` },

  { key: 'autocuidado', base: 'p_autocuidado', file: '19_Checklist.png', caption:
`El autocuidado no es un spa de vez en cuando — son pequeñas cosas cada día. 🌿

Dormir, moverte, hablar lo que sientes, poner límites, pedir ayuda. ¿Cuál te falta hoy?

📲 Escríbenos — link en la bio.

#saludmental #autocuidado #rutina #bienestaremocional #habitos` },

  { key: 'recordatorio', base: 'p_recordatorio', file: '02_Recordatorio.png', caption:
`Respira. Ahora mismo, en este momento, estás a salvo. 🤍

A veces la mente corre hacia adelante; volver al presente es volver a casa.

📲 Si necesitas un espacio para hablar, escríbenos — link en la bio.

#saludmental #ansiedad #respira #bienestaremocional #terapiaonline #saludmentalperu` },

  { key: 'cta', base: 'p_cta', file: '21_CTA_final.png', caption:
`Dar el primer paso es lo más difícil — y lo más valiente. 🤍

Psicoterapia a tu ritmo y en un espacio seguro. Estamos para escucharte.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #terapiaonline #primerpaso #bienestaremocional #psicologia` },
];

// Filtro: fondo borroso (cubre 9:16) + imagen nítida 1000px centrada + zoom
// lento + fade out. Mismo look verificado en la prueba. SIN fade-in: el reel ya
// abre con la imagen visible (antes arrancaba en negro ~0.5s, que se veía feo).
const VF =
  "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.05[bg];" +
  "[0:v]scale=1000:-1[fg];" +
  "[bg][fg]overlay=(W-w)/2:(H-h)/2[comp];" +
  "[comp]zoompan=z='min(zoom+0.0004,1.07)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=25," +
  "fade=t=out:st=7.5:d=0.5,format=yuv420p[v]";

// Portada 9:16: mismo bg borroso + imagen nítida centrada, pero estática (sin
// zoom ni fade) → un solo frame siempre visible. Se sube como `cover` y IG la
// usa de cover_url (gana sobre el thumb_offset). Así la portada nunca es negra.
const COVER_VF =
  "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.05[bg];" +
  "[0:v]scale=1000:-1[fg];" +
  "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]";

function makeReel(imgPath, outPath) {
  execFileSync(FF, [
    '-y', '-loglevel', 'error',
    '-loop', '1', '-framerate', '25', '-t', '8', '-i', imgPath,
    '-i', AUD,
    '-filter_complex', VF,
    '-map', '[v]', '-map', '1:a',
    '-t', '8',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '25',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    outPath,
  ], { stdio: 'inherit' });
}

function makeCover(imgPath, outPath) {
  execFileSync(FF, [
    '-y', '-loglevel', 'error',
    '-i', imgPath,
    '-filter_complex', COVER_VF,
    '-map', '[v]', '-frames:v', '1', '-qscale:v', '2',
    outPath,
  ], { stdio: 'inherit' });
}

async function main() {
  if (!miraiSupabase) throw new Error('miraiSupabase null — faltan MIRAI_* en .env');
  if (!fs.existsSync(AUD)) throw new Error('no existe el audio: ' + AUD);
  fs.mkdirSync(OUTDIR, { recursive: true });

  const bucket = config.neura.bucket || 'neura';
  const state = await loadState();
  if (!Array.isArray(state.queue)) state.queue = [];

  // Backup del estado actual (reversible).
  const stamp = Date.now();
  const backup = path.join(OUTDIR, `neura_state_backup_${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(state, null, 2));
  console.log(`💾 backup del estado: ${backup}\n`);

  const newReels = [];
  for (const it of ITEMS) {
    const img = path.join(SRC, it.file);
    if (!fs.existsSync(img)) { console.warn('  ⚠ falta imagen:', it.file); continue; }
    const out = path.join(OUTDIR, `${it.key}_${stamp}.mp4`);
    const cov = path.join(OUTDIR, `${it.key}_${stamp}_cover.jpg`);
    process.stdout.write(`🎬 generando reel ${it.key}… `);
    makeReel(img, out);
    makeCover(img, cov); // portada 9:16 estática (nunca negra)
    console.log('ok');

    if (DRY) { newReels.push({ id: `reel_${it.key}_${stamp}`, base: it.base, tipo: 'reel', video: '(dry)', cover: '(dry)', caption: it.caption, posted: false }); continue; }

    const buf = fs.readFileSync(out);
    const key = `reels/${it.key}_${stamp}.mp4`;
    const { error } = await miraiSupabase.storage.from(bucket).upload(key, buf, { contentType: 'video/mp4', upsert: true });
    if (error) throw new Error('upload ' + it.key + ': ' + error.message);
    const { data } = miraiSupabase.storage.from(bucket).getPublicUrl(key);

    // Portada: subir el JPG y exponer su URL pública (IG la usa como cover_url).
    const covBuf = fs.readFileSync(cov);
    const covKey = `reels/${it.key}_${stamp}_cover.jpg`;
    const { error: covErr } = await miraiSupabase.storage.from(bucket).upload(covKey, covBuf, { contentType: 'image/jpeg', upsert: true });
    if (covErr) throw new Error('upload cover ' + it.key + ': ' + covErr.message);
    const { data: covData } = miraiSupabase.storage.from(bucket).getPublicUrl(covKey);

    newReels.push({ id: `reel_${it.key}_${stamp}`, base: it.base, tipo: 'reel', video: data.publicUrl, cover: covData.publicUrl, caption: it.caption, posted: false });
    console.log(`   ✓ subido ${key} (+ portada)`);
  }

  // Reordenar: publicados → reels (los que ya había + los nuevos) → fotos.
  // Y sacar de las fotos pendientes las que convertimos a reel (no duplicar).
  const removeBases = new Set(ITEMS.map(i => i.base));
  const matchesRemoved = (id) => [...removeBases].some(b => id.startsWith(b + '_'));

  const posted     = state.queue.filter(q => q.posted);
  const pendReels  = state.queue.filter(q => !q.posted && q.tipo === 'reel');
  const pendFotos  = state.queue.filter(q => !q.posted && q.tipo !== 'reel' && !matchesRemoved(q.id));
  const quitadas   = state.queue.filter(q => !q.posted && q.tipo !== 'reel' && matchesRemoved(q.id)).length;

  state.queue = [...posted, ...pendReels, ...newReels, ...pendFotos];

  if (DRY) {
    console.log('\n[DRY] no se guardó el estado. La cola QUEDARÍA así:');
  } else {
    await saveState(state);
  }

  const pend = state.queue.filter(q => !q.posted);
  const nReels = pend.filter(q => q.tipo === 'reel').length;
  console.log(`\n✅ ${newReels.length} reels nuevos | reels pendientes: ${nReels} | fotos pendientes: ${pend.length - nReels}`);
  console.log(`   (${quitadas} fotos duplicadas sacadas de la cola)`);
  console.log('Próximos 10:', pend.slice(0, 10).map(q => `${q.tipo}:${q.id}`).join('  →  '));
  if (DRY) console.log('\nPara aplicar de verdad, corre sin DRY=1.');
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
