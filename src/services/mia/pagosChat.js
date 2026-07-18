// Pagos que llegan POR EL CHAT del paciente: cuando alguien manda su captura
// de Yape/Plin, media.js la analiza con visión y deja en la conversación un
// texto-marcador "[COMPROBANTE DE PAGO ...]". Este módulo lee ese marcador y
// registra el pago en Neura (tabla `payments`), para que las finanzas de
// pacientes estén al día sin que Mirai dicte nada.
//
// Lo usan: el flujo live (index.js, al loguear el mensaje del paciente) y el
// backfill histórico (scripts/backfillPagosChats.js).

import { miraiSupabase } from '../../lib/miraiSupabase.js';

// Concepto según el modelo de precios de Mirai. Montos fuera de tabla → null.
const CONCEPTOS = { 75: 'primera consulta', 105: 'sesión', 420: 'paquete 4', 630: 'paquete 6' };

const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Extrae el pago de un texto-marcador de comprobante (los dos formatos que
// genera media.js). Devuelve null si el contenido no trae marcador.
//   { monto, verified, descartado, razon }
//   verified=true  → comprobante VÁLIDO (monto y destinatario coinciden)
//   verified=false → comprobante real pero con monto distinto al esperado
//   descartado=true → no registrable (sin monto legible o fue a otra persona)
export function parseComprobante(content) {
  if (!content || !content.includes('[COMPROBANTE DE PAGO')) return null;

  const valido = /\[COMPROBANTE DE PAGO ✓ VÁLIDO — monto S\/([\d.,]+)/.exec(content);
  if (valido) {
    const monto = num(valido[1]);
    if (!monto) return { monto: null, verified: false, descartado: true, razon: 'monto ilegible' };
    return { monto, verified: true, descartado: false };
  }

  const noCoincide = /\[COMPROBANTE DE PAGO detectado pero NO COINCIDE: ([^\]]+)/.exec(content);
  if (noCoincide) {
    const razones = noCoincide[1];
    const m = /el monto es S\/([\d.,]+)/.exec(razones);
    const monto = m ? num(m[1]) : null;
    // Si el destinatario no era Mirai, el dinero no fue para ella → no registrar.
    const destinoOk = !/destinatario/i.test(razones);
    if (!monto || !destinoOk) {
      return { monto, verified: false, descartado: true, razon: !monto ? 'monto ilegible' : 'destinatario no es Mirai' };
    }
    return { monto, verified: false, descartado: false };
  }

  return { monto: null, verified: false, descartado: true, razon: 'marcador no reconocido' };
}

// Inserta el pago en `payments` con dos protecciones:
//   1. Idempotencia: raw_text lleva "chat:<id>"; si ya existe, no duplica.
//   2. Dedupe vs registro manual/voz: mismo paciente + mismo monto ± 3 días.
// Devuelve { status: 'registrado' | 'ya_registrado' | 'duplicado' | 'error' }.
export async function registrarPagoDeChat({ patientId, refId, monto, verified, paidAt }) {
  if (!miraiSupabase || !patientId || !monto || !refId) return { status: 'error' };
  const tag = `chat:${refId}`;

  const { data: prev } = await miraiSupabase
    .from('payments').select('id').like('raw_text', `${tag}%`).limit(1);
  if (prev?.length) return { status: 'ya_registrado' };

  const cuando = paidAt ? new Date(paidAt) : new Date();
  const desde = new Date(cuando.getTime() - 3 * 86400000).toISOString();
  const hasta = new Date(cuando.getTime() + 3 * 86400000).toISOString();
  const { data: cerca } = await miraiSupabase
    .from('payments').select('id')
    .eq('patient_id', patientId).eq('amount', monto)
    .gte('paid_at', desde).lte('paid_at', hasta)
    .limit(1);
  if (cerca?.length) return { status: 'duplicado' };

  const { error } = await miraiSupabase.from('payments').insert({
    patient_id: patientId,
    amount: monto,
    currency: 'PEN',
    paid_at: cuando.toISOString(),
    method: 'yape',
    concept: CONCEPTOS[monto] ?? null,
    verified,
    source: 'chat-comprobante',
    raw_text: tag,
  });
  if (error) {
    console.error('[mia/pagosChat] insert payment:', error.message);
    return { status: 'error' };
  }
  return { status: 'registrado' };
}

// Punto de entrada del flujo live: mira el contenido recién logueado del
// paciente y, si trae comprobante registrable, guarda el pago. Best-effort.
export async function registrarPagoSiComprobante({ patientId, content, refId }) {
  const pago = parseComprobante(content);
  if (!pago || pago.descartado) return null;
  const res = await registrarPagoDeChat({ patientId, refId, monto: pago.monto, verified: pago.verified });
  return { ...res, monto: pago.monto, verified: pago.verified };
}
