// Prueba rápida del integration con la hoja v2 de Luisa (Apps Script).
// Uso:
//   node scripts/test-sheets.js ping
//   node scripts/test-sheets.js append
//   node scripts/test-sheets.js update
//   node scripts/test-sheets.js read [responsable] [estado]
//   node scripts/test-sheets.js summary [responsable]

import {
  ping, appendDailyEntry, upsertDailyEntry, readEntries, summarize, todayLabel,
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
      fecha: todayLabel(),
      responsable: 'KIRA TEST',
      area: 'TEST',
      clienteMarca: 'TEST',
      tarea: 'fila de prueba — borrar',
      tipo: 'Otro',
      prioridad: '🔵 Normal',
      estado: '🔄 En proceso',
      fechaCompromiso: '',
      observaciones: 'enviado desde scripts/test-sheets.js',
    });
    console.log('append ->', r);
    return;
  }
  if (command === 'update') {
    const r = await upsertDailyEntry({
      fecha: todayLabel(),
      responsable: 'KIRA TEST',
      area: 'TEST',
      clienteMarca: 'TEST',
      tarea: 'fila actualizada — borrar',
      tipo: 'Otro',
      prioridad: '🔵 Normal',
      estado: '✅ Entregado',
      fechaCompromiso: '',
      observaciones: 'update desde scripts/test-sheets.js',
    });
    console.log('update ->', r);
    return;
  }
  if (command === 'read') {
    const responsable = process.argv[3] || undefined;
    const estado      = process.argv[4] || undefined;
    const r = await readEntries({ responsable, estado, limit: 20 });
    console.log('read ->', JSON.stringify(r, null, 2));
    return;
  }
  if (command === 'summary') {
    const responsable = process.argv[3] || undefined;
    const r = await summarize({ responsable });
    console.log('summary ->', JSON.stringify(r, null, 2));
    return;
  }
  console.error('Comando desconocido. Usa: ping | append | update | read | summary');
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
