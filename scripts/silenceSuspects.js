// Silencia los leads sospechosos de ser contactos viejos auto-agregados:
//  - Emma (contacto de trabajo, nº fijo) y
//  - lead_organico con nombre "basura" (hola.../paciente/nuevo lead) y <=2 msgs del paciente.
// NO toca: lead_campaña (campaña real) ni lead_organico con nombre real / conversación real.
import { miraiSupabase } from '../src/lib/miraiSupabase.js';

const EXTRA_PHONES = ['51999138246']; // Emma (contacto de trabajo)
const junkRe = /^(hola|paciente|nuevo lead|lead\b)/i;

const { data: organicos, error } = await miraiSupabase
  .from('patients')
  .select('phone, nombre, estado, etiqueta, total_mensajes_paciente')
  .eq('etiqueta', 'lead_organico')
  .not('estado', 'in', '(silenciada,alta)');
if (error) { console.error('ERROR:', error.message); process.exit(1); }

const toSilence = (organicos || []).filter(p =>
  EXTRA_PHONES.includes(p.phone) ||
  (junkRe.test((p.nombre || '').trim()) && (p.total_mensajes_paciente ?? 0) <= 2)
);

for (const p of toSilence) {
  await miraiSupabase.from('patients').update({ estado: 'silenciada' }).eq('phone', p.phone);
  console.log(`🔇 silenciado: ${p.nombre} | ${p.phone}`);
}
console.log(`\nTotal silenciados: ${toSilence.length}`);

const restoOrg = (organicos || []).filter(p => !toSilence.some(s => s.phone === p.phone));
console.log('\n— lead_organico que NO toqué (tienen nombre real o conversación; revisá si alguno es contacto viejo) —');
for (const p of restoOrg) console.log(`   ${p.nombre} | ${p.phone} | msgs_pac=${p.total_mensajes_paciente ?? 0} | ${p.estado}`);
