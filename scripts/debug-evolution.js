// Diagnostica conexión a Evolution API.
// Uso: node scripts/debug-evolution.js

import { config } from '../src/config.js';

const baseUrl  = config.evolution.url.replace(/\/$/, '');
const instance = config.evolution.instance;
const apikey   = config.evolution.apiKey;

console.log(`URL:      ${baseUrl}`);
console.log(`Instance: ${instance}`);
console.log(`Key:      ${apikey.slice(0, 4)}...${apikey.slice(-4)} (longitud ${apikey.length})\n`);

async function ping(label, path) {
  try {
    const res = await fetch(`${baseUrl}${path}`, { headers: { apikey } });
    const text = await res.text();
    console.log(`[${res.status}] ${label}  -> ${path}`);
    console.log(`         body: ${text.slice(0, 300)}\n`);
  } catch (err) {
    console.log(`[ERR] ${label}: ${err.message}\n`);
  }
}

await ping('fetchInstances (global)',     '/instance/fetchInstances');
await ping('connectionState (kira)',      `/instance/connectionState/${instance}`);
