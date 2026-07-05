// Reordena la cola de NEURA para VACIAR el backlog en ~6 días a 5/día:
// intercala 2 reels + 3 (fotos/carruseles) por bloque de 5, y pone los reels de
// VIDEO REAL primero (rindieron mejor que los de imagen fija). DRY=1 previsualiza.

import fs from 'fs';
import path from 'path';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const DRY = process.env.DRY === '1';

const state = await loadState();
const q = state.queue || [];
const posted = q.filter(p => p.posted);
const pend = q.filter(p => !p.posted);

const reels = pend.filter(p => p.tipo === 'reel');
const realReels = reels.filter(p => String(p.id).includes('reel_real_'));
const imgReels  = reels.filter(p => !String(p.id).includes('reel_real_'));
const reelsOrdered = [...realReels, ...imgReels];   // video real primero
const otros = pend.filter(p => p.tipo !== 'reel');

const mixed = [];
let r = 0, o = 0;
while (r < reelsOrdered.length || o < otros.length) {
  for (let i = 0; i < 2 && r < reelsOrdered.length; i++) mixed.push(reelsOrdered[r++]);
  for (let i = 0; i < 3 && o < otros.length; i++) mixed.push(otros[o++]);
}

state.queue = [...posted, ...mixed];

// Backup.
const stamp = Date.now();
const backup = `C:/tmp/reels/auto/neura_state_backup_${stamp}.json`;
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.writeFileSync(backup, JSON.stringify({ queue: q }, null, 2));

console.log(`Reels: ${reelsOrdered.length} (real: ${realReels.length}, imagen: ${imgReels.length}) | Otros: ${otros.length}`);
console.log('\nPlan por día (bloques de 5):');
for (let d = 0; d < Math.ceil(mixed.length / 5); d++) {
  const dia = mixed.slice(d * 5, d * 5 + 5);
  console.log(`  Día ${d + 1}: ` + dia.map(p => p.tipo === 'reel' ? (String(p.id).includes('reel_real_') ? 'reel(video)' : 'reel(img)') : p.tipo).join(' · '));
}

if (DRY) { console.log('\n[DRY] no se guardó.'); }
else { await saveState(state); console.log(`\n✅ Cola reordenada y guardada. Backup: ${backup}`); }
