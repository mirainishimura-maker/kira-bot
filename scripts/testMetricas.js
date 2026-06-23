import { runMetricas } from '../src/services/mia/metricas.js';
const r = await runMetricas({ dry: true });
console.log('\n=== REPORTE ===\n');
console.log(r.texto || JSON.stringify(r));
console.log('\n=== IG raw ===', JSON.stringify(r.ig));
