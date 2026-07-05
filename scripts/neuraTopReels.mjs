import { config } from '../src/config.js';
import { loadState } from '../src/services/neura/publisher.js';
const GRAPH = 'https://graph.instagram.com/v21.0';
async function ig(path, params, token){ const qs=new URLSearchParams({...params,access_token:token}); const r=await fetch(`${GRAPH}/${path}?${qs}`); const j=await r.json(); if(!r.ok||j.error) throw new Error(j.error?.message||`IG ${r.status}`); return j; }
const tryf=async(fn,d=null)=>{try{return await fn();}catch{return d;}};

const igId=config.neura.igUserId; const state=await loadState(); const token=state.token;
const list=await ig(`${igId}/media`,{fields:'id,media_product_type,media_type,caption,timestamp,like_count,comments_count,permalink',limit:50},token);
const reels=(list.data||[]).filter(m=>(m.media_product_type||'').toUpperCase()==='REELS' || (m.media_type||'').toUpperCase()==='VIDEO');
const rows=[];
for(const m of reels){
  const ins=await tryf(()=>ig(`${m.id}/insights`,{metric:'reach,saved,shares,plays'},token));
  const met={}; for(const d of (ins?.data||[])) met[d.name]=d.values?.[0]?.value ?? null;
  const likes=m.like_count||0, com=m.comments_count||0, sav=met.saved||0, sh=met.shares||0;
  rows.push({ fecha:(m.timestamp||'').slice(0,10), reach:met.reach??'—', plays:met.plays??'—', likes, com, sav, sh,
    score: likes + com*2 + sav*5 + sh*5, link:m.permalink, cap:(m.caption||'').replace(/\n/g,' ').slice(0,50) });
}
rows.sort((a,b)=>b.score-a.score);
console.log('TOP REELS por ENGAGEMENT (score = likes + com*2 + guardados*5 + compartidos*5)\n');
for(const r of rows.slice(0,6)){
  console.log(`★ score ${r.score} | ${r.fecha} | reach ${r.reach} plays ${r.plays} | 👍${r.likes} 💬${r.com} 🔖${r.sav} ↗️${r.sh}`);
  console.log(`  "${r.cap}"`);
  console.log(`  ${r.link}\n`);
}
