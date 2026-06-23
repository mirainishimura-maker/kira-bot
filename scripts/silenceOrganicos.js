// Aprobado por la usuaria: silencia TODOS los leads etiqueta 'lead_organico'
// (los que el auto-intake agregó mal, incl. contactos viejos). NO toca
// 'lead_campaña' (campaña real). Reversible: estado -> 'silenciada'.
import { miraiSupabase } from '../src/lib/miraiSupabase.js';

const { data, error } = await miraiSupabase
  .from('patients')
  .select('phone, nombre, estado, total_mensajes_paciente')
  .eq('etiqueta', 'lead_organico')
  .not('estado', 'in', '(silenciada,alta)');
if (error) { console.error('ERROR:', error.message); process.exit(1); }

let n = 0;
const conConversacion = [];
for (const p of data) {
  const { error: e } = await miraiSupabase.from('patients').update({ estado: 'silenciada' }).eq('phone', p.phone);
  if (e) { console.error('  ✗', p.phone, e.message); continue; }
  n++;
  const msgs = p.total_mensajes_paciente ?? 0;
  if (msgs >= 3) conConversacion.push(`${p.nombre} (${p.phone})`);
  console.log(`🔇 ${p.nombre} | ${p.phone}${msgs >= 3 ? '  ⚠️ tuvo conversación' : ''}`);
}
console.log(`\n✅ ${n} lead_organico silenciados. La campaña (lead_campaña) quedó intacta.`);
if (conConversacion.length) {
  console.log('\n⚠️ Estos habían tenido conversación de verdad — si alguno es lead REAL, decime y lo reactivo:');
  conConversacion.forEach(s => console.log('   -', s));
}
