// Sube los carruseles renderizados (carpetas de slides) al bucket `neura/carousels/`
// y los agrega a la cola como items tipo:'carousel' con images:[urls]. El cron los
// publica en el slot de las 14h (cadencia diaria 1 post/1 carrusel/1 reel).
//
// Uso:  node scripts/queueCarousels.js     (DRY=1 previsualiza)

import fs from 'fs';
import path from 'path';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const ROOT = process.env.NEURA_CAR_DIR || 'C:\\projects\\nowa\\neura_studio\\carruseles';
const DRY = process.env.DRY === '1';

const CARRUSELES = [
  { key: 'c_pausa', caption:
`5 señales de que tu cuerpo te pide una pausa 🌿

Dormir mal, irritarte por todo, vivir cansadx, desconectarte, exigirte de más… tu cuerpo habla. Escúchalo.

Guarda este post 🤍 Y si te identificas, recuerda: no tienes que con todo solx.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #burnout #autocuidado #bienestaremocional #ansiedad #saludmentalperu` },

  { key: 'c_mitos', caption:
`3 mitos sobre ir a terapia 🤍

La terapia no es solo para crisis, no es “para toda la vida”, y no significa estar mal. Es un espacio para conocerte, cuidarte y crecer.

📲 ¿Lista para empezar? Escríbenos — link en la bio.

#saludmental #terapia #mitos #psicologia #bienestaremocional #saludmentalperu` },

  { key: 'c_limites', caption:
`Poner límites sin culpa, en 4 pasos 🌿

Nota cómo te sientes, di “no” sin justificarte de más, sostén tu decisión y cuídate después. Tus límites también son autocuidado.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #limites #autocuidado #bienestaremocional #terapiaonline #saludmentalperu` },

  { key: 'c_calma', caption:
`Calma tu ansiedad en 5 minutos 🤍

Respira 4-7-8, nombra 5 cosas que ves, suelta los hombros y háblate con cariño. Pequeños gestos que devuelven la calma.

Guárdalo para cuando lo necesites.

📲 ¿Necesitas apoyo? Escríbenos — link en la bio.

#saludmental #ansiedad #calma #mindfulness #bienestaremocional #saludmentalperu` },
];

function slides(key) {
  const dir = path.join(ROOT, key);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^slide_\d+\.png$/i.test(f)).sort()
    .map(f => path.join(dir, f));
}

async function main() {
  if (!miraiSupabase) throw new Error('miraiSupabase null — faltan MIRAI_* en .env');
  const bucket = config.neura.bucket || 'neura';
  const state = await loadState();
  if (!Array.isArray(state.queue)) state.queue = [];
  const stamp = Date.now();

  const backup = path.join(ROOT, `neura_state_backup_${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(state, null, 2));
  console.log(`💾 backup del estado: ${backup}\n`);

  const nuevos = [];
  for (const c of CARRUSELES) {
    const files = slides(c.key);
    if (files.length < 2) { console.warn(`  ⚠ "${c.key}" tiene <2 slides — se omite`); continue; }
    process.stdout.write(`⬆  ${c.key} (${files.length} slides)… `);
    if (DRY) { nuevos.push({ id: `car_${c.key}_${stamp}`, tipo: 'carousel', images: files.map(() => '(dry)'), caption: c.caption, posted: false }); console.log('(dry)'); continue; }
    const urls = [];
    for (let i = 0; i < files.length; i++) {
      const buf = fs.readFileSync(files[i]);
      const okey = `carousels/${c.key}_${stamp}/slide_${String(i + 1).padStart(2, '0')}.png`;
      const { error } = await miraiSupabase.storage.from(bucket).upload(okey, buf, { contentType: 'image/png', upsert: true });
      if (error) throw new Error('upload ' + okey + ': ' + error.message);
      urls.push(miraiSupabase.storage.from(bucket).getPublicUrl(okey).data.publicUrl);
    }
    nuevos.push({ id: `car_${c.key}_${stamp}`, tipo: 'carousel', images: urls, caption: c.caption, posted: false });
    console.log('ok');
  }
  if (!nuevos.length) throw new Error('no se encoló ningún carrusel');

  // Los agrego al final de los pendientes (el slot 14h los toma por tipo, en orden).
  const posted  = state.queue.filter(p => p.posted);
  const pending = state.queue.filter(p => !p.posted);
  state.queue = [...posted, ...pending, ...nuevos];

  if (DRY) console.log('\n[DRY] no se guardó.');
  else await saveState(state);

  const pend = state.queue.filter(p => !p.posted);
  const by = {}; for (const p of pend) by[p.tipo] = (by[p.tipo] || 0) + 1;
  console.log(`\n✅ ${nuevos.length} carruseles encolados | pendientes: ${pend.length} ${JSON.stringify(by)}`);
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
