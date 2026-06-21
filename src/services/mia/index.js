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
import { sendText, sendImage } from '../../lib/evolution.js';
import { askMia } from './ai.js';
import { logMessage, shouldMiaBeSilent } from './conversations.js';
import { touchPatientInteraction, setPatientEstado } from './patients.js';
import { rememberMiaSentId } from './echoTracker.js';
import { upsertLead } from './sheetCrm.js';

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

  // 2. Modo silencio INTELIGENTE: solo silenciar si Mirai retomó manual
  // EN MEDIO de un flujo donde Mia ya respondió. La apertura inicial NO
  // silencia (Mia debe tomar control del triage).
  const silenced = await shouldMiaBeSilent(
    patient.id,
    config.mia.silenceAfterMiraiMinutes,
  );
  if (silenced) {
    console.log(`[mia] silencio activo para ${patient.nombre} — Mirai retomó manual hace <${config.mia.silenceAfterMiraiMinutes}m.`);
    return;
  }

  // 3. Llamar a Mia (OpenAI con prompt + historial).
  const t0 = Date.now();
  console.log(`[mia] generando respuesta para ${patient.nombre}: "${text.slice(0, 80)}"`);
  const result = await askMia({ patient, message: text });
  const elapsed = Date.now() - t0;
  const burbujas = result?.messages?.length ?? 0;
  console.log(`[mia] askMia OK | ${patient.nombre} | ${elapsed}ms | burbujas=${burbujas} | escalar=${result?.escalar_mirai} | crisis=${result?.crisis}`);
  if (burbujas === 0) {
    console.warn(`[mia] ⚠️ askMia retornó CERO burbujas para ${patient.nombre}. Fallback usado para no dejar al paciente sin respuesta.`);
    result.messages = [{ channel: 'private', text: 'Dame un momentito, ahí te respondo 🌸' }];
  }

  // 4 + 5. Enviar burbujas + imágenes. datos_lead se guarda solo en la
  // primera burbuja del turno (representa el snapshot tras este intercambio).
  //
  // Orden de envío: PRIMERA burbuja → imágenes → resto de burbujas. Así, en
  // el turno de la sede, el paciente recibe [dirección+link] → [foto] →
  // [pregunta combinada], que es como se ve más natural. Si no hay imágenes,
  // el orden es simplemente todas las burbujas en secuencia.
  const bubbles = (result.messages ?? []).filter(m => m?.text);
  let burbujasEnviadas = 0;

  const sendBubble = async (msg, withDatosLead) => {
    try {
      const sent = await sendText(senderJid, msg.text);
      const sentId = sent?.key?.id ?? null;
      if (sentId) rememberMiaSentId(sentId);
      const metadata = {
        escalar_mirai: Boolean(result.escalar_mirai),
        crisis: Boolean(result.crisis),
      };
      if (withDatosLead && result.datos_lead) metadata.datos_lead = result.datos_lead;
      await logMessage({
        patientId: patient.id,
        author: 'mia',
        content: msg.text,
        whatsappMessageId: sentId,
        metadata,
      });
      await touchPatientInteraction(patient.id, { authorCounted: 'mia' });
      burbujasEnviadas++;
    } catch (err) {
      console.error(`[mia] ⚠️ error enviando burbuja a ${patient.nombre}:`, err.message);
    }
  };

  const sendImages = async () => {
    for (const imgKey of result.imagenes ?? []) {
      const url = config.mia.images?.[imgKey];
      if (!url) {
        console.warn(`[mia] imagen "${imgKey}" pedida pero URL no configurada en env (MIA_IMG_${imgKey.toUpperCase()}).`);
        continue;
      }
      try {
        const sent = await sendImage(senderJid, url);
        const sentId = sent?.key?.id ?? null;
        if (sentId) rememberMiaSentId(sentId);
        await logMessage({
          patientId: patient.id,
          author: 'mia',
          content: `[imagen: ${imgKey}]`,
          messageType: 'image',
          whatsappMessageId: sentId,
          metadata: { image_key: imgKey, image_url: url },
        });
      } catch (err) {
        console.error(`[mia] error enviando imagen "${imgKey}":`, err.message);
      }
    }
  };

  if (bubbles.length) {
    await sendBubble(bubbles[0], true);   // 1ª burbuja (lleva datos_lead)
    await sendImages();                   // foto justo después de la 1ª burbuja
    for (let i = 1; i < bubbles.length; i++) await sendBubble(bubbles[i], false);
  } else {
    await sendImages();
  }
  console.log(`[mia] envío completo | ${patient.nombre} | ${burbujasEnviadas}/${burbujas} burbujas enviadas`);

  // 4c. Sheets CRM: actualizar la fila del paciente con los datos recogidos.
  if (result.datos_lead) {
    const dl = result.datos_lead;
    try {
      await upsertLead({
        phone:              patient.phone,
        nombre:             dl.nombre || patient.nombre,
        estado:             dl.estado || null,
        para_quien:         dl.para_quien || null,
        edad:               dl.edad || null,
        procedencia:        dl.procedencia || null,
        motivo:             dl.motivo || null,
        horarios_propuestos:
          Array.isArray(dl.horarios_propuestos)
            ? dl.horarios_propuestos.join(' | ')
            : (dl.horarios_propuestos || null),
      });
    } catch (err) {
      console.warn('[mia] no pude actualizar CRM con datos_lead:', err.message);
    }

    // Reflejar el avance del lead en patients.estado (Supabase). Lo usa el
    // recontacto para NO molestar a quienes ya cerraron: cita_confirmada,
    // agendado, rechazado, etc. Si el lead agendó, deja de ser candidato.
    if (dl.estado) {
      try { await setPatientEstado(patient.phone, dl.estado); }
      catch (err) { console.warn('[mia] no pude actualizar patients.estado:', err.message); }
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
