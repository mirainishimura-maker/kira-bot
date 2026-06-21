// Sube un lote de reels (MP4 con audio) al bucket público `neura` y los agrega
// a la COLA de NEURA como items tipo:'reel', intercalados con los posts pendientes
// (1 reel cada ~2 posts) para un feed variado. El cron los publica solo.
//
// Uso:  node scripts/queueReels.js

import fs from 'fs';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const REELS = [
  {
    key: 'descansar',
    file: 'C:\\tmp\\reels\\batch\\reel_descansar.mp4',
    caption: `Descansar también es productivo 🌙

Tu cuerpo y tu mente también necesitan pausa. Date permiso de parar, sin culpa. En NEURA te acompañamos a cuidar tu bienestar, a tu ritmo 💛

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #autocuidado #bienestaremocional #terapiaonline #psicologia #saludmentalperu`,
  },
  {
    key: 'sentir',
    file: 'C:\\tmp\\reels\\batch\\reel_sentir.mp4',
    caption: `Sentir no te hace débil. Te hace humano. 🤍

Darte espacio para sentir es parte de sanar. En NEURA creemos en un acompañamiento sin juicios, en un espacio seguro para ti.

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #bienestaremocional #terapiaonline #psicologia #emociones #saludmentalperu`,
  },
  {
    key: 'salud',
    file: 'C:\\tmp\\reels\\batch\\reel_salud.mp4',
    caption: `Tu salud mental también es salud 🌿

Cuidarte por dentro importa tanto como cuidarte por fuera. Da el primer paso hoy, con acompañamiento profesional y a tu ritmo.

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #bienestar #terapiaonline #psicologia #autocuidado #saludmentalperu`,
  },
  {
    key: 'todo',
    file: 'C:\\tmp\\reels\\batch\\reel_todo.mp4',
    caption: `No tienes que poder con todo, todo el tiempo 🍃

Pedir ayuda también es una forma de cuidarte. En NEURA estamos para escucharte, a tu ritmo y en un espacio seguro 💛

📲 Escríbenos por WhatsApp — el link está en la bio.

#saludmental #autocuidado #bienestaremocional #terapiaonline #psicologia #saludmentalperu`,
  },
];

async function main() {
  if (!miraiSupabase) throw new Error('miraiSupabase null — faltan credenciales MIRAI_* en .env');
  const bucket = config.neura.bucket || 'neura';
  const state = await loadState();
  if (!Array.isArray(state.queue)) state.queue = [];

  const stamp = Date.now();
  const reelItems = [];
  for (const r of REELS) {
    if (!fs.existsSync(r.file)) throw new Error('no existe: ' + r.file);
    const buf = fs.readFileSync(r.file);
    const key = `reels/${r.key}_${stamp}.mp4`;
    const { error } = await miraiSupabase.storage.from(bucket)
      .upload(key, buf, { contentType: 'video/mp4', upsert: true });
    if (error) throw new Error('upload ' + r.key + ': ' + error.message);
    const { data } = miraiSupabase.storage.from(bucket).getPublicUrl(key);
    reelItems.push({ id: `reel_${r.key}_${stamp}`, tipo: 'reel', video: data.publicUrl, caption: r.caption, posted: false });
    console.log(`✓ subido reel_${r.key}`);
  }

  // Intercalar: 1 reel cada 2 posts pendientes, conservando el historial.
  const posted = state.queue.filter(p => p.posted);
  const pending = state.queue.filter(p => !p.posted);
  const mixed = [];
  let i = 0, j = 0;
  while (i < reelItems.length || j < pending.length) {
    if (i < reelItems.length) mixed.push(reelItems[i++]);
    if (j < pending.length) mixed.push(pending[j++]);
    if (j < pending.length) mixed.push(pending[j++]);
  }
  state.queue = [...posted, ...mixed];
  await saveState(state);

  const pend = state.queue.filter(p => !p.posted);
  console.log(`\n✅ ${reelItems.length} reels en cola | pendientes totales: ${pend.length}`);
  console.log('Próximos 6:', pend.slice(0, 6).map(p => `${p.tipo}:${p.id}`).join('  →  '));
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
