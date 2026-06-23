import { runResumenDiario } from '../src/services/mia/resumenDiario.js';
const r = await runResumenDiario({ dry: true });
console.log('\n--- RESUMEN (dry-run) ---\n');
console.log(r.texto || JSON.stringify(r));
