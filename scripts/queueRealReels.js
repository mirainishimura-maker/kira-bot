// Cablea los REELS de METRAJE REAL (stock Pexels / Canva) a la cola de NEURA.
// Toma el *_FINAL.mp4 más reciente de cada escena en C:\tmp\reels\real, lo sube a
// `neura/reels/`, y agrega items tipo:'reel' (id reel_real_*) INTERCALADOS 1:2 con
// los posts. MODE=replace (default) saca de la cola TODO reel que no sea real_
// (los viejos de tarjeta y los de IA reel_ia_*). Backup del estado. DRY=1 previsualiza.
//
// Uso:  node scripts/queueRealReels.js        (o  DRY=1 / MODE=add)

import fs from 'fs';
import path from 'path';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const DIR = process.env.NEURA_REAL_DIR || 'C:\\tmp\\reels\\real';
const DRY = process.env.DRY === '1';

const ESCENAS = [
  { key: 'te', caption:
`Date un momento. Respira. Estás a salvo. 🌿

En medio del día que corre y corre, una pausa de un minuto también es autocuidado. Tu té, tu respiración, tu calma.

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #ansiedad #respira #bienestaremocional #autocuidado #saludmentalperu` },

  { key: 'lectura', caption:
`Aprender a cuidarte también es terapia. 📖🌿

Leer, informarte, darte herramientas… es un acto de amor propio. Y cuando quieras un acompañamiento más cercano, aquí estamos.

📲 Escríbenos — el link está en la bio.

#saludmental #autocuidado #bienestaremocional #terapiaonline #crecimientopersonal #saludmentalperu` },

  { key: 'ventana', caption:
`Está bien ir despacio. 🌧️

No todos los días tienen que ser productivos. A veces cuidarte es quedarte quieta, mirar la lluvia y respirar. Tu ritmo está bien.

📲 ¿Necesitas hablar con alguien? Escríbenos — el link está en la bio.

#saludmental #calma #bienestaremocional #terapiaonline #autocuidado #saludmentalperu` },

  { key: 'cafe', caption:
`Empieza el día contigo. ☕

Antes de responder a todos, date un momento para ti: un respiro, un café tranquilo, una intención amable. Tú también importas.

📲 ¿Te acompañamos? Escríbenos — el link está en la bio.

#saludmental #autocuidado #mañanas #bienestaremocional #rutina #saludmentalperu` },

  { key: 'laptop', caption:
`Ir a tu ritmo también es avanzar. 🤍

No tienes que poder con todo hoy. Avanzar despacio sigue siendo avanzar — y descansar también es parte del proceso.

📲 ¿Necesitas un espacio para hablar? Escríbenos — el link está en la bio.

#saludmental #autocuidado #bienestaremocional #terapiaonline #productividad #saludmentalperu` },

  { key: 'naturaleza', caption:
`Respira. Estás justo donde necesitas estar. 🌿

El crecimiento toma tiempo — el tuyo también. Date la misma paciencia que le darías a una planta que apenas empieza a brotar.

📲 Escríbenos — el link está en la bio.

#saludmental #crecimientopersonal #bienestaremocional #terapiaonline #autocuidado #saludmentalperu` },

  { key: 'escribir', caption:
`Escribir lo que sientes también es soltarlo. 🤍

A veces no encontramos las palabras en voz alta, pero el papel las recibe sin juzgar. Un diario, una nota, un mensaje para ti misma… todo cuenta.

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #journaling #bienestaremocional #terapiaonline #autocuidado #saludmentalperu` },

  { key: 'vela', caption:
`Tu calma merece un espacio. 🕯️

Bajar el ritmo, encender una vela, respirar hondo. No necesitas mucho para volver a ti — solo permitirte la pausa.

📲 ¿Buscas un espacio seguro para hablar? Escríbenos — el link está en la bio.

#saludmental #calma #bienestaremocional #terapiaonline #autocuidado #saludmentalperu` },
];

function newestFinal(key) {
  const re = new RegExp(`^${key}_.*_FINAL\\.mp4$`, 'i');
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
  fs.mkdirSync(DIR, { recursive: true });
  const backup = path.join(DIR, `neura_state_backup_${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(state, null, 2));
  console.log(`💾 backup del estado: ${backup}\n`);

  const reelItems = [];
  for (const e of ESCENAS) {
    const file = newestFinal(e.key);
    if (!file) { console.warn(`  ⚠ falta FINAL de "${e.key}" — se omite`); continue; }
    process.stdout.write(`⬆  ${e.key}  (${path.basename(file)})… `);
    if (DRY) { reelItems.push({ id: `reel_real_${e.key}_${stamp}`, tipo: 'reel', video: '(dry)', caption: e.caption, posted: false }); console.log('(dry)'); continue; }
    const buf = fs.readFileSync(file);
    const okey = `reels/real_${e.key}_${stamp}.mp4`;
    const { error } = await miraiSupabase.storage.from(bucket).upload(okey, buf, { contentType: 'video/mp4', upsert: true });
    if (error) throw new Error('upload ' + e.key + ': ' + error.message);
    const { data } = miraiSupabase.storage.from(bucket).getPublicUrl(okey);
    reelItems.push({ id: `reel_real_${e.key}_${stamp}`, tipo: 'reel', video: data.publicUrl, caption: e.caption, posted: false });
    console.log('ok');
  }
  if (!reelItems.length) throw new Error('no se encontró ningún MP4 FINAL en ' + DIR);

  // MODE=replace (def): saca de la cola TODO reel que no sea real_ (tarjeta vieja + IA).
  const MODE = (process.env.MODE || 'replace').toLowerCase();
  const posted  = state.queue.filter(p => p.posted);
  let pending   = state.queue.filter(p => !p.posted);
  if (MODE === 'replace') {
    const before = pending.length;
    pending = pending.filter(p => !(p.tipo === 'reel' && !String(p.id).startsWith('reel_real_')));
    console.log(`🔁 modo REPLACE: ${before - pending.length} reels no-reales sacados de la cola`);
  }

  // Intercalar 1 reel : 2 posts.
  const mixed = [];
  let i = 0, j = 0;
  while (i < reelItems.length || j < pending.length) {
    if (i < reelItems.length) mixed.push(reelItems[i++]);
    if (j < pending.length) mixed.push(pending[j++]);
    if (j < pending.length) mixed.push(pending[j++]);
  }
  state.queue = [...posted, ...mixed];

  if (DRY) console.log('\n[DRY] no se guardó. La cola QUEDARÍA así.');
  else await saveState(state);

  const pend = state.queue.filter(p => !p.posted);
  const nReels = pend.filter(p => p.tipo === 'reel').length;
  console.log(`\n✅ ${reelItems.length} reels REALES encolados | pendientes: ${pend.length} (${nReels} reels, ${pend.length - nReels} posts)`);
  console.log('Próximos 10:', pend.slice(0, 10).map(p => `${p.tipo}:${p.id.replace(/_\d+$/, '')}`).join('  →  '));
  if (DRY) console.log('\nPara aplicar de verdad, corre sin DRY=1.');
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
