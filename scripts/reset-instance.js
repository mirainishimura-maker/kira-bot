// Borra la instancia "kira" si existe, para luego recrearla limpia.
// Uso: node scripts/reset-instance.js

import { config } from '../src/config.js';

const baseUrl  = config.evolution.url.replace(/\/$/, '');
const instance = config.evolution.instance;
const apikey   = config.evolution.apiKey;
const headers  = { 'Content-Type': 'application/json', apikey };

async function http(method, path) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

console.log(`Limpiando instancia "${instance}" en ${baseUrl}\n`);

// 1) logout (si está conectada)
const logout = await http('DELETE', `/instance/logout/${instance}`);
console.log(`logout -> ${logout.status}: ${JSON.stringify(logout.data).slice(0, 200)}`);

// 2) delete
const del = await http('DELETE', `/instance/delete/${instance}`);
console.log(`delete -> ${del.status}: ${JSON.stringify(del.data).slice(0, 200)}`);

// 3) verificar
const list = await http('GET', '/instance/fetchInstances');
const names = Array.isArray(list.data) ? list.data.map(i => i.name) : [];
console.log(`\nInstancias actuales: ${JSON.stringify(names)}`);
