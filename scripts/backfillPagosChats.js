// Backfill: lee TODOS los chats de Mia (tabla `conversations`) buscando los
// marcadores "[COMPROBANTE DE PAGO ...]" que dejó el análisis de visión, y
// registra cada pago en Neura (tabla `payments`) con la FECHA REAL del
// comprobante. Idempotente: se puede correr las veces que sea (dedupe por
// "chat:<conversation_id>" en raw_text).
//
// Uso (desde la raíz de kira-bot, con el .env cargado):
//   node scripts/backfillPagosChats.js --dry   ← solo muestra qué haría
//   node scripts/backfillPagosChats.js         ← inserta de verdad

import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { parseComprobante, registrarPagoDeChat } from '../src/services/mia/pagosChat.js';

const DRY = process.argv.includes('--dry');

if (!miraiSupabase) {
  console.error('Faltan env vars MIRAI_SUPABASE_* (corre desde la raíz de kira-bot).');
  process.exit(1);
}

const { data: rows, error } = await miraiSupabase
  .from('conversations')
  .select('id, patient_id, author, content, created_at')
  .eq('author', 'patient')
  .ilike('content', '%COMPROBANTE DE PAGO%')
  .order('created_at', { ascending: true })
  .limit(2000);
if (error) { console.error('Error leyendo conversations:', error.message); process.exit(1); }

// Nombres de pacientes para el reporte.
const { data: pats } = await miraiSupabase.from('patients').select('id, nombre, phone');
const nombreDe = new Map((pats ?? []).map((p) => [p.id, `${p.nombre} (${p.phone})`]));

console.log(`${DRY ? '[DRY-RUN] ' : ''}Comprobantes encontrados en chats: ${rows.length}\n`);

let registrados = 0, saltados = 0, descartados = 0;
let total = 0;

for (const r of rows) {
  const quien = nombreDe.get(r.patient_id) ?? r.patient_id;
  const fecha = r.created_at.slice(0, 10);
  const pago = parseComprobante(r.content);

  if (!pago || pago.descartado) {
    descartados++;
    console.log(`✗ DESCARTADO  ${fecha}  ${quien} — ${pago?.razon ?? 'sin marcador'}\n   "${r.content.slice(0, 120)}"`);
    continue;
  }

  const etiqueta = pago.verified ? 'verificado' : 'POR REVISAR (monto distinto al esperado)';
  if (DRY) {
    registrados++; total += pago.monto;
    console.log(`✓ registraría  ${fecha}  S/${pago.monto}  ${quien}  [${etiqueta}]`);
    continue;
  }

  const res = await registrarPagoDeChat({
    patientId: r.patient_id,
    refId: r.id,
    monto: pago.monto,
    verified: pago.verified,
    paidAt: r.created_at,
  });
  if (res.status === 'registrado') {
    registrados++; total += pago.monto;
    console.log(`✓ registrado   ${fecha}  S/${pago.monto}  ${quien}  [${etiqueta}]`);
  } else {
    saltados++;
    console.log(`— saltado (${res.status})  ${fecha}  S/${pago.monto}  ${quien}`);
  }
}

console.log(`\nResumen: ${registrados} ${DRY ? 'por registrar' : 'registrados'} (S/${total}), ${saltados} saltados, ${descartados} descartados.`);
