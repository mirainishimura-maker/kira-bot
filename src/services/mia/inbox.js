// Buffer / debounce de mensajes entrantes de pacientes.
//
// Problema: los pacientes mandan varios mensajes seguidos en pocos segundos
// ("hola", "una pregunta", "sobre la consulta"). Sin esto, Mia respondía
// a cada uno por separado, alocándose.
//
// Solución: cuando llega un mensaje, lo metemos en un buffer por phone y
// arrancamos una ventana de espera. Cada mensaje nuevo del mismo paciente
// REINICIA la ventana (debounce deslizante), así esperamos a que termine
// de escribir. Cuando la ventana cierra, concatenamos todos los textos y
// llamamos handleMiaMessage UNA sola vez.
//
// Tres protecciones extra para que "agrupe bien":
//   1. Tope máximo (debounceMaxMs): aunque el paciente siga escribiendo sin
//      parar y reinicie la ventana, el lote se cierra a la fuerza al llegar
//      al tope. Evita que un paciente muy hablador retrase la respuesta
//      indefinidamente.
//   2. Modo "processing": mientras Mia genera y envía su respuesta (askMia +
//      burbujas tardan varios segundos), el buffer queda marcado. Los
//      mensajes que lleguen en ese rato se re-encolan y se procesan en un
//      lote nuevo al terminar, en vez de que Mia responda "encima de sí misma".
//   3. Dedup por messageId: Evolution a veces entrega el mismo mensaje dos
//      veces; lo ignoramos si ya está en el buffer.
//
// Limitación: si el server reinicia entre enqueue y flush, los mensajes en
// buffer se pierden. Aceptable para v1 — los reinicios son raros y los
// pacientes vuelven a escribir.

const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_DEBOUNCE_MAX_MS = 120_000;

const buffers = new Map();
// key (phone) -> {
//   patient, senderJid,
//   items: [{ text, messageId }],
//   seenIds: Set<string>,
//   timer, maxTimer,          // timers de la ventana actual
//   debounceMs, debounceMaxMs, onFlush,
//   processing: boolean,      // true mientras corre onFlush
// }

export function enqueueMiaMessage({
  patient,
  text,
  messageId,
  senderJid,
  debounceMs,
  debounceMaxMs,
  onFlush,
}) {
  if (!patient?.phone) return;
  const key = patient.phone;
  const waitMs = Number.isFinite(debounceMs) && debounceMs > 0 ? debounceMs : DEFAULT_DEBOUNCE_MS;
  const maxMs = Number.isFinite(debounceMaxMs) && debounceMaxMs > 0
    ? Math.max(debounceMaxMs, waitMs)
    : Math.max(DEFAULT_DEBOUNCE_MAX_MS, waitMs);

  let buf = buffers.get(key);
  if (!buf) {
    buf = {
      patient,
      senderJid,
      items: [],
      seenIds: new Set(),
      timer: null,
      maxTimer: null,
      debounceMs: waitMs,
      debounceMaxMs: maxMs,
      onFlush,
      processing: false,
    };
    buffers.set(key, buf);
  }

  // Dedup: Evolution puede reentregar el mismo mensaje.
  if (messageId && buf.seenIds.has(messageId)) {
    console.log(`[mia/inbox] dedup ${patient.nombre} | messageId repetido, ignorado`);
    return;
  }
  if (messageId) buf.seenIds.add(messageId);

  buf.items.push({ text, messageId });
  // Mantén lo más reciente por si cambian entre mensajes.
  buf.senderJid = senderJid;
  buf.patient = patient;
  buf.debounceMs = waitMs;
  buf.debounceMaxMs = maxMs;
  buf.onFlush = onFlush;

  // Si Mia está respondiendo ahora mismo, no armamos timers: estos mensajes
  // se procesarán en un lote nuevo cuando termine el flush en curso.
  if (buf.processing) {
    console.log(`[mia/inbox] enqueue (durante respuesta) ${patient.nombre} | pendientes=${buf.items.length}`);
    return;
  }

  armTimers(key, buf);
  console.log(`[mia/inbox] enqueue ${patient.nombre} | buffered=${buf.items.length} | wait=${waitMs}ms | cap=${maxMs}ms`);
}

// Arma (o reinicia) la ventana deslizante y, si no existe, el tope máximo.
function armTimers(key, buf) {
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flush(key, 'silencio'), buf.debounceMs);
  // El tope se arma UNA sola vez por lote y no se reinicia con cada mensaje.
  if (!buf.maxTimer) {
    buf.maxTimer = setTimeout(() => flush(key, 'tope-maximo'), buf.debounceMaxMs);
  }
}

function clearTimers(buf) {
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  if (buf.maxTimer) { clearTimeout(buf.maxTimer); buf.maxTimer = null; }
}

async function flush(key, reason) {
  const buf = buffers.get(key);
  if (!buf || buf.processing || buf.items.length === 0) return;

  clearTimers(buf);
  buf.processing = true;

  // Sacamos el lote actual; lo que llegue durante onFlush se acumula en
  // buf.items de nuevo (pero no dispara timers hasta que terminemos).
  const batch = buf.items;
  buf.items = [];

  const concatenated = batch.map(i => i.text).join('\n');
  const firstMessageId = batch[0]?.messageId ?? null;
  const totalMessages = batch.length;
  const onFlush = buf.onFlush;

  console.log(`[mia/inbox] flush ${buf.patient.nombre} | motivo=${reason} | mensajes=${totalMessages} | chars=${concatenated.length}`);

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
  } finally {
    buf.processing = false;
    // El buffer puede haberse limpiado externamente mientras corría onFlush.
    if (buffers.get(key) !== buf) return;
    if (buf.items.length > 0) {
      // Llegaron mensajes mientras Mia respondía: nuevo lote.
      buf.maxTimer = null; // tope fresco para este lote nuevo
      armTimers(key, buf);
      console.log(`[mia/inbox] re-lote ${buf.patient.nombre} | pendientes=${buf.items.length} llegados durante la respuesta`);
    } else {
      buf.seenIds.clear();
      buffers.delete(key);
    }
  }
}

// Utilidad para testing: limpiar buffers manualmente.
export function clearAllBuffers() {
  for (const buf of buffers.values()) {
    clearTimers(buf);
  }
  buffers.clear();
}
