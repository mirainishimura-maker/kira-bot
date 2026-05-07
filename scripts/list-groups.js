// Lista todos los grupos donde KIRA está, para identificar el JID del grupo
// del equipo de marketing.
// Uso: node scripts/list-groups.js

import { config } from '../src/config.js';

const baseUrl  = config.evolution.url.replace(/\/$/, '');
const instance = config.evolution.instance;
const apikey   = config.evolution.apiKey;

async function http(method, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { apikey, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

console.log(`Listando grupos de la instancia "${instance}"...\n`);

// Endpoint v2 de Evolution
const r = await http('GET', `/group/fetchAllGroups/${instance}?getParticipants=false`);

if (!r.ok) {
  console.error(`Error ${r.status}:`, r.data);
  process.exit(1);
}

const groups = Array.isArray(r.data) ? r.data : (r.data?.groups ?? []);
if (!groups.length) {
  console.log('(KIRA no está en ningún grupo todavía o el endpoint no devolvió datos)');
  console.log('Respuesta cruda:');
  console.dir(r.data, { depth: 4 });
  process.exit(0);
}

console.log(`Total grupos: ${groups.length}\n`);
for (const g of groups) {
  const jid     = g.id ?? g.remoteJid ?? g.jid;
  const subject = g.subject ?? g.name  ?? '(sin nombre)';
  const size    = g.size  ?? g.participantsCount ?? '?';
  console.log(`- ${subject}`);
  console.log(`  JID:           ${jid}`);
  console.log(`  Participantes: ${size}\n`);
}

console.log('Cuando identifiques el grupo del equipo de marketing,');
console.log('copia su JID a la variable GROUP_JID en EasyPanel y redespliega.');
