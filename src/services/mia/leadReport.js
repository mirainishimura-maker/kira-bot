// Reporte resumido de leads para Mirai. Lo dispara el comando /reporte.
//
// Flujo: lee los leads desde Supabase (la fuente real), calcula los números,
// escribe la pestaña "Reporte" en la hoja CRM y devuelve también el texto que
// Mia le manda a Mirai por WhatsApp.

import { listAllForReport } from './patients.js';
import { writeReport as writeReportToSheet } from './sheetCrm.js';

// Perú no tiene horario de verano: siempre UTC-5. Eso nos deja calcular los
// límites de "semana"/"mes" en hora Lima con un simple desfase fijo.
const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000;

// Devuelve un Date cuyos getUTC* dan los componentes de pared de Lima.
function toLimaParts(d) {
  return new Date(new Date(d).getTime() - LIMA_OFFSET_MS);
}

// Instante UTC del inicio (00:00 Lima) del mes actual.
function startOfMonthUtc(now) {
  const l = toLimaParts(now);
  return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1, 0, 0, 0) + LIMA_OFFSET_MS;
}

// Instante UTC del lunes 00:00 (Lima) de la semana actual.
function startOfWeekUtc(now) {
  const l = toLimaParts(now);
  const dow = l.getUTCDay();          // 0=domingo .. 6=sábado
  const sinceMonday = (dow + 6) % 7;  // lunes=0
  return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() - sinceMonday, 0, 0, 0) + LIMA_OFFSET_MS;
}

function fmtFechaHoraLima(now) {
  const l = toLimaParts(now);
  const dd  = String(l.getUTCDate()).padStart(2, '0');
  const mm  = String(l.getUTCMonth() + 1).padStart(2, '0');
  const yy  = l.getUTCFullYear();
  const hh  = String(l.getUTCHours()).padStart(2, '0');
  const min = String(l.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

// estado crudo → bucket legible del reporte.
const ESTADO_BUCKET = {
  nuevo:              'nuevo',
  datos_parciales:    'conversacion',
  motivo_dado:        'conversacion',
  ubicacion_ok:       'conversacion',
  horarios_dados:     'coordinando',
  precio_acordado:    'coordinando',
  listo_para_escalar: 'listo',
  agendado:           'agendado',
  paciente_activo:    'agendado',
  rechazado:          'rechazado',
  no_responde:        'no_responde',
};

// Orden de presentación + etiqueta legible. Todo lo que no mapea (alta,
// silenciada, vacío) cae en "otros", que solo se muestra si hay alguno.
const ESTADO_ORDEN = [
  ['nuevo',        'Nuevo / sin avanzar'],
  ['conversacion', 'En conversación'],
  ['coordinando',  'Coordinando horario'],
  ['listo',        'Listo para agendar'],
  ['agendado',     'Agendado / paciente'],
  ['rechazado',    'Rechazado'],
  ['no_responde',  'No responde'],
  ['otros',        'Otros'],
];

// Buckets que cuentan como "llegó a agendar" para la conversión. Es lo que
// Mia ve con certeza: el cierre real lo confirma Mirai aparte.
const LLEGO_A_AGENDAR = new Set(['listo', 'agendado']);

function fuenteBucket(etiqueta) {
  const e = String(etiqueta || '').toLowerCase();
  if (e.includes('campa'))   return 'campaña';  // lead_campaña / lead_campana
  if (e.includes('organic') || e.includes('orgánic')) return 'orgánico'; // lead_organico
  return 'otros';
}

// Calcula el reporte a partir de las filas crudas. `now` es inyectable para
// poder testearlo sin depender del reloj.
export function computeReport(rows, now = new Date()) {
  const inicioSemana = startOfWeekUtc(now);
  const inicioMes    = startOfMonthUtc(now);

  let semana = 0, mes = 0;
  const porEstado = {};                                  // bucket -> count (todos)
  const fuenteMes = { 'campaña': 0, 'orgánico': 0, 'otros': 0 };
  let mesTotal = 0, mesAgendar = 0;

  for (const r of rows) {
    const bucket = ESTADO_BUCKET[String(r.estado || '').toLowerCase()] || 'otros';
    porEstado[bucket] = (porEstado[bucket] || 0) + 1;

    const t = r.fecha_alta ? new Date(r.fecha_alta).getTime() : NaN;
    if (Number.isNaN(t)) continue;
    if (t >= inicioSemana) semana++;
    if (t >= inicioMes) {
      mes++;
      mesTotal++;
      fuenteMes[fuenteBucket(r.etiqueta)]++;
      if (LLEGO_A_AGENDAR.has(bucket)) mesAgendar++;
    }
  }

  const porEstadoArr = ESTADO_ORDEN
    .map(([key, label]) => ({ label, n: porEstado[key] || 0 }))
    .filter(x => x.label !== 'Otros' || x.n > 0);     // oculta "Otros" si es 0

  const porFuenteArr = [
    { label: 'Campaña',  n: fuenteMes['campaña'] },
    { label: 'Orgánico', n: fuenteMes['orgánico'] },
    { label: 'Otros',    n: fuenteMes['otros'] },
  ].filter(x => x.label !== 'Otros' || x.n > 0);

  const pct = mesTotal > 0 ? Math.round((mesAgendar / mesTotal) * 100) : 0;

  return {
    generadoEn: fmtFechaHoraLima(now),
    resumen:    { semana, mes, total: rows.length },
    porEstado:  porEstadoArr,
    porFuente:  porFuenteArr,
    conversion: { num: mesAgendar, den: mesTotal, pct },
  };
}

// Arma el texto que Mia manda por WhatsApp. Usa *negrita* de WhatsApp.
export function formatReportText(rep, sheetUrl) {
  const L = [];
  L.push('🌸 *Reporte de leads*');
  L.push(`_Actualizado: ${rep.generadoEn}_`);
  L.push('');
  L.push('*Resumen*');
  L.push(`• Esta semana: ${rep.resumen.semana}`);
  L.push(`• Este mes: ${rep.resumen.mes}`);
  L.push(`• En total: ${rep.resumen.total}`);
  L.push('');
  L.push('*Por estado (todos)*');
  for (const e of rep.porEstado) L.push(`• ${e.label}: ${e.n}`);
  L.push('');
  L.push('*Por fuente (este mes)*');
  for (const f of rep.porFuente) L.push(`• ${f.label}: ${f.n}`);
  L.push('');
  L.push(`*Llegaron a agendar (este mes):* ${rep.conversion.num} de ${rep.conversion.den} (${rep.conversion.pct}%)`);
  if (sheetUrl) {
    L.push('');
    L.push(`📄 Hoja completa: ${sheetUrl}`);
  }
  return L.join('\n');
}

// Orquesta todo: calcula, escribe la hoja y devuelve el texto listo para enviar.
// `sheetOk=false` si no se pudo escribir la hoja (el texto igual va al día).
export async function generateLeadReport() {
  const rows = await listAllForReport();
  const rep  = computeReport(rows);

  let sheetOk = false;
  let sheetUrl = null;
  try {
    const res = await writeReportToSheet(rep);
    if (res) { sheetOk = true; sheetUrl = res.url || null; }
  } catch (err) {
    console.warn('[mia/report] no pude escribir la hoja:', err.message);
  }

  const text = formatReportText(rep, sheetUrl);
  return { rep, text, sheetOk, sheetUrl };
}
