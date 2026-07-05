// One-off: mueve al FRENTE de la cola los reels que ya tienen portada diseñada
// (campo `cover` con URL http) — los recién generados por makeAndQueueReels —
// conservando el orden relativo del resto. Backup del estado. DRY=1 previsualiza.
//
// Uso:  node scripts/reorderCoverReelsFront.js   (o DRY=1)

import fs from 'fs';
import path from 'path';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const DRY = process.env.DRY === '1';
const tieneCover = (p) => typeof p.cover === 'string' && p.cover.startsWith('http');

async function main() {
  const state = await loadState();
  if (!Array.isArray(state.queue)) state.queue = [];

  const stamp = Date.now();
  const backup = path.join('C:\\tmp\\reels\\auto', `neura_state_backup_${stamp}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(state, null, 2));
  console.log(`💾 backup del estado: ${backup}\n`);

  const posted   = state.queue.filter(p => p.posted);
  const pending  = state.queue.filter(p => !p.posted);
  const conCover = pending.filter(tieneCover);
  const resto    = pending.filter(p => !tieneCover(p));
  state.queue = [...posted, ...conCover, ...resto];

  if (DRY) console.log('[DRY] no se guardó.');
  else await saveState(state);

  console.log(`✅ ${conCover.length} reels con portada movidos al frente | pendientes: ${pending.length}`);
  console.log('Próximos 10:', state.queue.filter(p => !p.posted).slice(0, 10)
    .map(p => `${p.tipo}:${p.id.replace(/_\d+$/, '')}`).join('  →  '));
  if (DRY) console.log('\nPara aplicar de verdad, corre sin DRY=1.');
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
