// Reporte de imperio → agregados de pagos de los últimos 7 días para la
// routine cloud de los lunes (endpoint /admin/imperio). Devuelve SOLO números
// (total, cuántos, verificados/por revisar): nada de nombres ni datos de
// pacientes.

import { miraiSupabase } from '../../lib/miraiSupabase.js';

export async function runImperio() {
  if (!miraiSupabase) return { ok: false, error: 'Mia no habilitada' };
  const desde = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data, error } = await miraiSupabase
    .from('payments')
    .select('amount, verified, paid_at')
    .gte('paid_at', desde);
  if (error) return { ok: false, error: error.message };
  const pagos = data || [];
  const total = pagos.reduce((a, p) => a + Number(p.amount || 0), 0);
  const verificados = pagos.filter((p) => p.verified === true).length;
  return {
    ok: true,
    pagos7d: {
      total,
      moneda: 'PEN',
      count: pagos.length,
      verificados,
      porRevisar: pagos.length - verificados,
    },
  };
}
