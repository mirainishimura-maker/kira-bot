// Sube las stories "frase del día" (PNG 1080x1920) al bucket `neura/stories/` y
// las agrega a la cola de stories (state.stories). El cron las publica 1/día a la
// hora config.neura.storyHora. (Esto es independiente de la cola del feed.)
//
// Uso:  node scripts/queueStories.js     (DRY=1 previsualiza)

import fs from 'fs';
import path from 'path';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const DIR = process.env.NEURA_STORY_DIR || 'C:\\projects\\nowa\\neura_studio\\stories';
const DRY = process.env.DRY === '1';

async function main() {
  if (!miraiSupabase) throw new Error('miraiSupabase null — faltan MIRAI_* en .env');
  const bucket = config.neura.bucket || 'neura';
  const state = await loadState();
  if (!Array.isArray(state.stories)) state.stories = [];
  const stamp = Date.now();

  const files = fs.readdirSync(DIR).filter(f => /^story_.*\.png$/i.test(f)).sort();
  if (!files.length) throw new Error('no hay story_*.png en ' + DIR);

  const nuevos = [];
  for (const f of files) {
    const key = f.replace(/\.png$/i, '');
    process.stdout.write(`⬆  ${key}… `);
    if (DRY) { nuevos.push({ id: `story_${key}_${stamp}`, image: '(dry)', posted: false }); console.log('(dry)'); continue; }
    const buf = fs.readFileSync(path.join(DIR, f));
    const okey = `stories/${key}_${stamp}.png`;
    const { error } = await miraiSupabase.storage.from(bucket).upload(okey, buf, { contentType: 'image/png', upsert: true });
    if (error) throw new Error('upload ' + key + ': ' + error.message);
    const url = miraiSupabase.storage.from(bucket).getPublicUrl(okey).data.publicUrl;
    nuevos.push({ id: `story_${key}_${stamp}`, image: url, posted: false });
    console.log('ok');
  }

  state.stories = [...state.stories, ...nuevos];
  if (DRY) console.log('\n[DRY] no se guardó.');
  else await saveState(state);

  const pend = state.stories.filter(s => !s.posted).length;
  console.log(`\n✅ ${nuevos.length} stories encoladas | stories pendientes: ${pend}`);
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
