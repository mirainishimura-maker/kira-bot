// Diagnóstico: estado de la cola de NEURA (token, publicados con fecha, pendientes).
import { loadState } from '../src/services/neura/publisher.js';
const s = await loadState();
const posted = (s.queue || []).filter(q => q.posted);
const pend = (s.queue || []).filter(q => !q.posted);
console.log('TOKEN:', s.token ? 'presente' : 'FALTA', '| tokenSavedAt:', s.tokenSavedAt || '(nunca)');
console.log('TOTAL en cola:', (s.queue || []).length, '| publicados:', posted.length, '| pendientes:', pend.length);
console.log('\n— Últimos publicados (con fecha) —');
posted.slice(-10).forEach(q => console.log('  ', q.posted_at || '(sin fecha)', '|', q.tipo, '|', q.id, '| media:', q.ig_media_id || '-'));
console.log('\n— Próximos pendientes —');
pend.slice(0, 6).forEach(q => console.log('  ', q.tipo, '|', q.id));
