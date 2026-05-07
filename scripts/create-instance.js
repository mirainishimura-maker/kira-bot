// Crea la instancia "kira" en Evolution API y muestra el QR para vincular.
// Uso: node scripts/create-instance.js

import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';

const baseUrl  = config.evolution.url.replace(/\/$/, '');
const instance = config.evolution.instance;
const apikey   = config.evolution.apiKey;
const headers  = { 'Content-Type': 'application/json', apikey };

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function saveQrPng(base64DataUrl) {
  const b64 = base64DataUrl.replace(/^data:image\/png;base64,/, '');
  mkdirSync('.tmp', { recursive: true });
  const path = '.tmp/kira-qr.png';
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}

function openFile(path) {
  spawn('cmd', ['/c', 'start', '', path], { detached: true, stdio: 'ignore' }).unref();
}

console.log(`[kira] servidor: ${baseUrl}`);
console.log(`[kira] instancia: ${instance}\n`);

console.log('Creando instancia...');
const create = await http('POST', '/instance/create', {
  instanceName: instance,
  qrcode: true,
  integration: 'WHATSAPP-BAILEYS',
});

if (!create.ok) {
  const msg = typeof create.data === 'string' ? create.data : JSON.stringify(create.data);
  if (create.status === 403 || /already.*exist/i.test(msg)) {
    console.log(`(la instancia "${instance}" ya existe — pidiendo QR de conexión)`);
  } else {
    console.error(`Error ${create.status}:`, msg);
    process.exit(1);
  }
} else {
  console.log('Instancia creada.');
}

let qrBase64 =
  create.data?.qrcode?.base64 ??
  create.data?.qrcode?.code  ??
  null;

if (!qrBase64?.startsWith?.('data:image')) {
  console.log('Pidiendo QR de conexión...');
  const conn = await http('GET', `/instance/connect/${instance}`);
  if (!conn.ok) {
    console.error(`Error pidiendo QR (${conn.status}):`, conn.data);
    process.exit(1);
  }
  qrBase64 = conn.data?.base64 ?? conn.data?.qrcode?.base64 ?? null;
}

if (!qrBase64) {
  console.log('\nNo recibí un QR base64. Respuesta cruda:');
  console.dir(create.data, { depth: 5 });
  process.exit(1);
}

const qrPath = saveQrPng(qrBase64);
console.log(`\nQR guardado en: ${qrPath}`);
console.log('Abriendo el QR...');
openFile(qrPath);

console.log('\n--- Instrucciones ---');
console.log('1. En el celular del número nuevo: WhatsApp -> Configuración');
console.log('2. Dispositivos vinculados -> Vincular un dispositivo');
console.log('3. Escanea el QR que se abrió en pantalla');
console.log('4. El QR vence en ~40s. Si vence, vuelve a correr este script.\n');
