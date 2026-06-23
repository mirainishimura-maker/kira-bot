// Muestra la actividad reciente de Mia (últimos mensajes) con el paciente,
// para identificar a quién le respondió y poder silenciarlo.
import { miraiSupabase } from '../src/lib/miraiSupabase.js';

const { data, error } = await miraiSupabase
  .from('conversations')
  .select('created_at, author, content, patients(phone, nombre, estado, etiqueta)')
  .order('created_at', { ascending: false })
  .limit(30);

if (error) { console.error('ERROR:', error.message); process.exit(1); }
for (const m of data) {
  const p = m.patients || {};
  console.log(
    `${(m.created_at || '').slice(5, 16)} | ${String(m.author).padEnd(6)} | ` +
    `${String(p.nombre || '?').slice(0, 14).padEnd(14)} | ${String(p.phone || '?').padEnd(13)} | ` +
    `${String(p.estado || '').padEnd(15)} | ${String(p.etiqueta || '').padEnd(14)} | ` +
    `${String(m.content || '').replace(/\n/g, ' ').slice(0, 38)}`
  );
}
