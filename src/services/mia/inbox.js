// Buffer / debounce de mensajes entrantes de pacientes.
//
// Problema: los pacientes mandan varios mensajes seguidos en pocos segundos
// ("hola", "una pregunta", "sobre la consulta"). Sin esto, Mia respondía
// a cada uno por separado, alocándose.
//
// Solución: cuando llega un mensaje, lo metemos en un buffer por phone.
// Esperamos N ms. Si llegan más mensajes del mismo paciente, reseteamos
// el timer y extendemos la ventana. Cuando el timer dispara, concatenamos
// todos los textos y llamamos handleMiaMessage UNA sola vez.
//
// Limitación: si el server reinicia entre enqueue y flush, los mensajes
// en buffer se pierden. Aceptable para v1 — los reinicios son raros y
// los pacientes vuelven a escribir.

const buffers = new Map(); // phone -> { patient, items, timer, senderJid }

export function enqueueMiaMessage({ patient, text, messageId, senderJid, debounceMs, onFlush }) {
  if (!patient?.phone) return;
  const key = patient.phone;
  let buf = buffers.get(key);
  if (!buf) {
    buf = { patient, items: [], timer: null, senderJid };
    buffers.set(key, buf);
  }
  buf.items.push({ text, messageId });
  // Mantén el senderJid más reciente y el patient actualizado por si cambian.
  buf.senderJid = senderJid;
  buf.patient = patient;

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flush(key, onFlush), debounceMs);
  console.log(`[mia/inbox] enqueue ${patient.nombre} | buffered=${buf.items.length} | wait=${debounceMs}ms`);
}

async function flush(key, onFlush) {
  const buf = buffers.get(key);
  if (!buf) return;
  buffers.delete(key);

  const concatenated = buf.items.map(i => i.text).join('\n');
  const firstMessageId = buf.items[0]?.messageId ?? null;
  const totalMessages = buf.items.length;

  console.log(`[mia/inbox] flush ${buf.patient.nombre} | mensajes=${totalMessages} | chars=${concatenated.length}`);

  try {
    await onFlush({
      patient: buf.patient,
      text: concatenated,
      messageId: firstMessageId,
      senderJid: buf.senderJid,
      bufferedCount: totalMessages,
    });
  } catch (err) {
    console.error('[mia/inbox] flush error:', err);
  }
}

// Utilidad para testing: limpiar buffers manualmente.
export function clearAllBuffers() {
  for (const buf of buffers.values()) {
    if (buf.timer) clearTimeout(buf.timer);
  }
  buffers.clear();
}
