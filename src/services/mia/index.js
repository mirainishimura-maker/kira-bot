// Entry point del módulo Mia. Lo llama el webhook cuando ya identificó que
// el mensaje viene de un paciente etiquetado.
//
// Responsabilidades:
//   1. Loguear el mensaje entrante del paciente.
//   2. Aplicar modo silencio si Mirai escribió manualmente hace poco.
//   3. Llamar a Mia (askMia) para obtener la respuesta.
//   4. Enviar cada burbuja por Evolution, guardando los message_ids para
//      distinguir luego los ecos fromMe.
//   5. Loguear cada burbuja de Mia.
//   6. Si Mia escala o detecta crisis, notificar a Mirai a su personal.

import { config } from '../../config.js';
import { sendText } from '../../lib/evolution.js';
import { askMia } from './ai.js';
import { logMessage, lastMiraiManualMessageWithinMinutes } from './conversations.js';
import { touchPatientInteraction } from './patients.js';
import { rememberMiaSentId } from './echoTracker.js';

export { isMiaCommand, handleMiaCommand } from './commands.js';
export { findPatientByPhone, normalizePhone } from './patients.js';
export { isMiaSentId } from './echoTracker.js';
export { logMessage } from './conversations.js';

export async function handleMiaMessage({ patient, text, messageId, senderJid }) {
  // 1. Loguear mensaje entrante del paciente.
  await logMessage({
    patientId: patient.id,
    author: 'patient',
    content: text,
    whatsappMessageId: messageId,
  });
  await touchPatientInteraction(patient.id, { authorCounted: 'patient' });

  // 2. Modo silencio: si Mirai escribió a este paciente hace <silenceAfterMiraiMinutes>,
  // Mia se calla para no interrumpir una conversación humana en curso.
  const silenced = await lastMiraiManualMessageWithinMinutes(
    patient.id,
    config.mia.silenceAfterMiraiMinutes,
  );
  if (silenced) {
    console.log(`[mia] silencio activo para ${patient.nombre} — Mirai habló recientemente.`);
    return;
  }

  // 3. Llamar a Mia (OpenAI con prompt + historial).
  console.log(`[mia] generando respuesta para ${patient.nombre}: "${text.slice(0, 80)}"`);
  const result = await askMia({ patient, message: text });

  // 4 + 5. Enviar cada burbuja y loguearla.
  for (const msg of result.messages ?? []) {
    if (!msg?.text) continue;
    try {
      const sent = await sendText(senderJid, msg.text);
      const sentId = sent?.key?.id ?? null;
      if (sentId) rememberMiaSentId(sentId);
      await logMessage({
        patientId: patient.id,
        author: 'mia',
        content: msg.text,
        whatsappMessageId: sentId,
        metadata: {
          escalar_mirai: Boolean(result.escalar_mirai),
          crisis: Boolean(result.crisis),
        },
      });
      await touchPatientInteraction(patient.id, { authorCounted: 'mia' });
    } catch (err) {
      console.error('[mia] error enviando burbuja:', err.message);
    }
  }

  // 6. Si Mia escaló o detectó crisis, avisar a Mirai por su personal.
  if (result.escalar_mirai || result.crisis) {
    const tag = result.crisis ? '🚨 CRISIS' : '⚠️ Mia escaló';
    const aviso =
      `${tag} — ${patient.nombre} (${patient.phone})\n\n` +
      `Último mensaje del paciente:\n> ${text}\n\n` +
      `Razón: ${result.razon || '(sin razón explícita)'}\n\n` +
      `Mia ya respondió y derivó a ti.`;
    try {
      await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, aviso);
    } catch (err) {
      console.error('[mia] no pude avisar a Mirai personal:', err.message);
    }
  }
}

// Maneja mensajes fromMe=true que NO son ecos de Mia. Es decir: Mirai
// escribiendo manualmente desde su Business a un paciente etiquetado.
// Los guardamos como author='mirai' para que (a) Mia tenga contexto y
// (b) el modo silencio se active.
export async function handleMiraiManualOutbound({ patient, text, messageId }) {
  if (!patient || !text) return;
  await logMessage({
    patientId: patient.id,
    author: 'mirai',
    content: text,
    whatsappMessageId: messageId,
  });
  await touchPatientInteraction(patient.id, { authorCounted: 'mirai' });
  console.log(`[mia] mensaje manual de Mirai a ${patient.nombre} guardado (silencio se activa ${config.mia.silenceAfterMiraiMinutes}m).`);
}
