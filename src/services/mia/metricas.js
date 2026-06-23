// Reporte de métricas del embudo NEURA → Mia. Junta: Instagram (alcance),
// WhatsApp/Mia (leads, guías, atendidos, últimos 7 días) y el embudo por estado
// de los leads (en proceso / con cita → % conversión). Se manda a Mirai por
// WhatsApp con el comando /metricas (y endpoint /admin/metricas).

import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';
import { fetchIgMetrics } from '../neura/igMetrics.js';

// Inicio de la ventana de 7 días (incluye hoy), en Lima.
function desde7d() {
  const limaStr = new Date().toLocaleString('sv-SE', { timeZone: 'America/Lima' });
  const hoy = new Date(`${limaStr.slice(0, 10)}T00:00:00-05:00`);
  return new Date(hoy.getTime() - 6 * 86400000).toISOString();
}

export async function runMetricas({ dry = false } = {}) {
  if (!miraiSupabase) return { ok: false, error: 'Mia no habilitada' };
  if (!config.mia.personalPhone) return { ok: false, error: 'falta MIRAI_PERSONAL_PHONE' };
  const desde = desde7d();

  // Embudo: snapshot por estado (excluye silenciada/alta).
  const { data: activos } = await miraiSupabase
    .from('patients').select('estado').not('estado', 'in', '(silenciada,alta)').limit(5000);
  const c = {};
  for (const p of (activos || [])) c[p.estado] = (c[p.estado] || 0) + 1;
  const total = (activos || []).length;
  const conCita = (c['cita_confirmada'] || 0) + (c['hold_tentativo'] || 0) + (c['agendado'] || 0);
  const enProceso = (c['nuevo'] || 0) + (c['datos_parciales'] || 0);
  const pct = total ? Math.round((conCita / total) * 100) : 0;

  // Actividad últimos 7 días.
  const { count: leads7d } = await miraiSupabase
    .from('patients').select('id', { count: 'exact', head: true }).gte('fecha_alta', desde);
  const { count: guias7d } = await miraiSupabase
    .from('conversations').select('id', { count: 'exact', head: true })
    .eq('metadata->>kind', 'guia').gte('created_at', desde);
  const { data: miaMsgs } = await miraiSupabase
    .from('conversations').select('patient_id').eq('author', 'mia').gte('created_at', desde).limit(5000);
  const atendidos7d = new Set((miaMsgs || []).map(m => m.patient_id)).size;

  // Instagram (best-effort).
  const ig = await fetchIgMetrics();

  const texto = [
    '📊 *Métricas NEURA — últimos 7 días*',
    '',
    '📱 *Instagram* (@neurapsi2026)',
    `   Seguidores: ${ig.followers ?? '—'}`,
    `   Alcance (7d): ${ig.reach7d ?? '—'}`,
    `   Visitas al perfil (7d): ${ig.profileViews7d ?? '—'}`,
    '',
    '💬 *WhatsApp / Mia* (7d)',
    `   Leads nuevos: ${leads7d ?? 0}`,
    `   Guías enviadas: ${guias7d ?? 0}`,
    `   Personas atendidas: ${atendidos7d}`,
    '',
    '🎯 *Embudo* (estado de tus leads)',
    `   Total activos: ${total}`,
    `   En proceso: ${enProceso}`,
    `   Con cita: ${conCita}  →  *${pct}%* de conversión`,
    '',
    '💡 La conversión sube con buen seguimiento (recontacto + reseñas activas).',
  ].join('\n');

  if (dry) return { ok: true, dry: true, texto, ig, total, conCita, pct };

  try {
    const sent = await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, texto);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  } catch (e) {
    console.error('[mia/metricas] no pude enviar:', e.message);
    return { ok: false, error: e.message };
  }
  return { ok: true, texto };
}
