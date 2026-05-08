// Prueba rápida del integration con la hoja de Luisa (Apps Script).
// Uso:
//   node scripts/test-sheets.js ping
//   node scripts/test-sheets.js append
//   node scripts/test-sheets.js update
//   node scripts/test-sheets.js read [name] [status]

import {
  ping, appendDailyEntry, upsertDailyEntry, readEntries, todayLabel,
} from '../src/services/sheets.js';

const command = process.argv[2] ?? 'ping';

async function main() {
  if (command === 'ping') {
    const r = await ping();
    console.log('ping ->', r);
    return;
  }
  if (command === 'append') {
    const r = await appendDailyEntry({
      date: todayLabel(),
      name: 'KIRA TEST',
      area: 'TEST',
      pendientes: 'fila de prueba — borrar',
      estado: 'EN PROCESO',
      prioridad: 'NORMAL',
      seguimiento: 'SI',
      observaciones: 'enviado desde scripts/test-sheets.js',
    });
    console.log('append ->', r);
    return;
  }
  if (command === 'update') {
    const r = await upsertDailyEntry({
      date: todayLabel(),
      name: 'KIRA TEST',
      area: 'TEST',
      pendientes: 'fila actualizada — borrar',
      estado: 'ENTREGADO',
      prioridad: 'NORMAL',
      seguimiento: 'SI',
      observaciones: 'update desde scripts/test-sheets.js',
    });
    console.log('update ->', r);
    return;
  }
  if (command === 'read') {
    const name   = process.argv[3] || undefined;
    const status = process.argv[4] || undefined;
    const r = await readEntries({ name, status, limit: 20 });
    console.log('read ->', JSON.stringify(r, null, 2));
    return;
  }
  console.error('Comando desconocido. Usa: ping | append | update | read');
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
