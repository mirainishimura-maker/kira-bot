// Publica los próximos N items pendientes de la cola de NEURA, AHORA, desde la
// PC (token del bucket privado). Marca cada uno como posted en el estado
// compartido (neura_state.json), así el cron del server nunca los re-publica.
//
// Uso:  node scripts/publishNext.js [N]   (default 1)

import { loadState, saveState, publishSingle, publishCarousel, publishReel }
  from '../src/services/neura/publisher.js';

const IG = '17841423773440647';
const N = Math.max(1, Number(process.argv[2] || 1));

async function main() {
  const s = await loadState();
  if (!s.token) throw new Error('no hay token en el bucket');
  let done = 0;
  for (const item of s.queue.filter(q => !q.posted)) {
    if (done >= N) break;
    try {
      const imgs = item.images || [];
      let media;
      if (item.tipo === 'reel') media = await publishReel(IG, s.token, item.video || imgs[0], item.caption || '');
      else if (item.tipo === 'carousel' || imgs.length > 1) media = await publishCarousel(IG, s.token, imgs, item.caption || '');
      else media = await publishSingle(IG, s.token, imgs[0], item.caption || '');
      item.posted = true; item.ig_media_id = media; item.posted_at = new Date().toISOString();
      await saveState(s);
      console.log(`✓ publicado ${item.id} (${item.tipo}) → media ${media}`);
      done++;
    } catch (e) {
      console.error(`✗ falló ${item.id}: ${e.message}`);
      break;
    }
  }
  const pend = s.queue.filter(q => !q.posted).length;
  console.log(`\nListo. Publicados ahora: ${done} | pendientes restantes: ${pend}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
