// Cablea los REELS "tras bambalinas" con IA (Sora) a la cola de NEURA.
// Toma el MP4 FINAL más reciente de cada escena en C:\tmp\reels\ia, lo sube al
// bucket público `neura/reels/`, y agrega items tipo:'reel' INTERCALADOS con los
// posts pendientes (1 reel cada 2 posts) — cadencia orgánica, el cron 3/día publica.
//
// Hace BACKUP del estado antes de escribir (reversible).
// Solo previsualizar sin tocar la cola:  DRY=1 node scripts/queueIAReels.js
//
// Uso:  node scripts/queueIAReels.js

import fs from 'fs';
import path from 'path';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const DIR = process.env.NEURA_IA_DIR || 'C:\\tmp\\reels\\ia';
const DRY = process.env.DRY === '1';

// Escenas (orden = orden en que lideran la cola) + caption anónimo con CTA.
const ESCENAS = [
  { key: 'escribir', caption:
`Escribir lo que sientes también es soltarlo. 🤍

A veces no encontramos las palabras en voz alta, pero el papel las recibe sin juzgar. Un diario, una nota, un mensaje para ti misma… todo cuenta.

📲 ¿Necesitas un espacio para hablar? Escríbenos — el link está en la bio.

#saludmental #journaling #bienestaremocional #terapiaonline #autocuidado #saludmentalperu` },

  { key: 'taza', caption:
`Date un momento. Respira. Estás a salvo. 🌿

En medio del día que corre y corre, una pausa de un minuto también es autocuidado. Tu té, tu respiración, tu calma.

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #ansiedad #respira #bienestaremocional #autocuidado #saludmentalperu` },

  { key: 'rincon', caption:
`Tu calma merece un espacio. 🌙

Un rincón tranquilo, tu taza, una respiración profunda. No necesitas mucho para volver a ti — solo permitirte la pausa.

📲 ¿Buscas un espacio seguro para hablar? Escríbenos — el link está en la bio.

#saludmental #calma #bienestaremocional #terapiaonline #autocuidado #saludmentalperu` },

  { key: 'moodboard', caption:
`Ordenar tus ideas también es ordenar tu mente. 🤍

Cuando todo se siente revuelto adentro, ponerlo afuera ayuda: una lista, un tablero, un par de notas. Pequeños pasos para aclarar la mente.

📲 ¿Te acompañamos en el proceso? Escríbenos — el link está en la bio.

#saludmental #bienestaremocional #terapiaonline #psicologia #autocuidado #saludmentalperu` },

  { key: 'libro', caption:
`Aprender a cuidarte también es terapia. 🌿

Leer, informarte, darte herramientas… es un acto de amor propio. Y cuando quieras un acompañamiento más cercano, aquí estamos.

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #autocuidado #bienestaremocional #terapiaonline #crecimientopersonal #saludmentalperu` },
];

// MP4 FINAL más reciente para una escena (incluye el demo de 'escribir').
function newestFinal(key) {
  const re = new RegExp(`^${key}.*_FINAL\\.mp4$`, 'i');
  const hits = fs.readdirSync(DIR)
    .filter(f => re.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return hits.length ? path.join(DIR, hits[0].f) : null;
}

async function main() {
  if (!miraiSupabase) throw new Error('miraiSupabase null — faltan credenciales MIRAI_* en .env');
  const bucket = config.neura.bucket || 'neura';
  const state = await loadState();
  if (!Array.isArray(state.queue)) state.queue = [];

  const stamp = Date.now();

  // Backup del estado actual (reversible).
  fs.mkdirSync(DIR, { recursive: true });
  const backup = path.join(DIR, `neura_state_backup_${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(state, null, 2));
  console.log(`💾 backup del estado: ${backup}\n`);

  const reelItems = [];
  for (const e of ESCENAS) {
    const file = newestFinal(e.key);
    if (!file) { console.warn(`  ⚠ falta FINAL de "${e.key}" — se omite`); continue; }
    process.stdout.write(`⬆  ${e.key}  (${path.basename(file)})… `);
    if (DRY) { reelItems.push({ id: `reel_ia_${e.key}_${stamp}`, tipo: 'reel', video: '(dry)', caption: e.caption, posted: false }); console.log('(dry)'); continue; }
    const buf = fs.readFileSync(file);
    const okey = `reels/ia_${e.key}_${stamp}.mp4`;
    const { error } = await miraiSupabase.storage.from(bucket).upload(okey, buf, { contentType: 'video/mp4', upsert: true });
    if (error) throw new Error('upload ' + e.key + ': ' + error.message);
    const { data } = miraiSupabase.storage.from(bucket).getPublicUrl(okey);
    reelItems.push({ id: `reel_ia_${e.key}_${stamp}`, tipo: 'reel', video: data.publicUrl, caption: e.caption, posted: false });
    console.log('ok');
  }

  if (!reelItems.length) throw new Error('no se encontró ningún MP4 FINAL en ' + DIR);

  // MODE=replace (def): saca los reels VIEJOS de tarjeta de la cola (los nuevos
  // IA tienen id reel_ia_*). MODE=add: deja todo y solo agrega.
  const MODE = (process.env.MODE || 'replace').toLowerCase();
  const posted  = state.queue.filter(p => p.posted);
  let pending   = state.queue.filter(p => !p.posted);
  let removedOld = 0;
  if (MODE === 'replace') {
    const before = pending.length;
    pending = pending.filter(p => !(p.tipo === 'reel' && !String(p.id).startsWith('reel_ia_')));
    removedOld = before - pending.length;
    console.log(`🔁 modo REPLACE: ${removedOld} reels viejos de tarjeta sacados de la cola`);
  }

  // Intercalar 1 reel : 2 posts, conservando historial y orden de lo pendiente.
  const mixed = [];
  let i = 0, j = 0;
  while (i < reelItems.length || j < pending.length) {
    if (i < reelItems.length) mixed.push(reelItems[i++]);
    if (j < pending.length) mixed.push(pending[j++]);
    if (j < pending.length) mixed.push(pending[j++]);
  }
  state.queue = [...posted, ...mixed];

  if (DRY) {
    console.log('\n[DRY] no se guardó. La cola QUEDARÍA así.');
  } else {
    await saveState(state);
  }

  const pend = state.queue.filter(p => !p.posted);
  const nReels = pend.filter(p => p.tipo === 'reel').length;
  console.log(`\n✅ ${reelItems.length} reels IA encolados | pendientes: ${pend.length} (${nReels} reels, ${pend.length - nReels} posts)`);
  console.log('Próximos 9:', pend.slice(0, 9).map(p => `${p.tipo}:${p.id.replace(/_\d+$/, '')}`).join('  →  '));
  if (DRY) console.log('\nPara aplicar de verdad, corre sin DRY=1.');
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
