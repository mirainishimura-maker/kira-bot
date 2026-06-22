// Lista los leads con etiqueta 'lead_organico' (sospechosos de haber sido creados
// por el auto-intake), para revisar y limpiar.
import { miraiSupabase } from '../src/lib/miraiSupabase.js';

const { data, error } = await miraiSupabase
  .from('patients')
  .select('phone, nombre, etiqueta, estado, fecha_alta, total_mensajes_paciente, total_mensajes_mia')
  .eq('etiqueta', 'lead_organico')
  .order('fecha_alta', { ascending: false })
  .limit(60);

if (error) { console.error('ERROR:', error.message); process.exit(1); }
console.log(`lead_organico total: ${data.length}\n`);
for (const p of data) {
  console.log(`${p.fecha_alta?.slice(0,16)} | ${p.estado.padEnd(16)} | msjs(pac/mia)=${p.total_mensajes_paciente ?? 0}/${p.total_mensajes_mia ?? 0} | ${p.nombre} | ${p.phone}`);
}
