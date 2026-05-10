// Webhook handler de Evolution API.
// Recibe POST /webhook con eventos de WhatsApp.
// Solo nos interesa MESSAGES_UPSERT con mensajes entrantes (fromMe=false).

import {
  detectChannel, isAuthorizedGroup, logGroupForDiscovery,
  isAddressedToKira, getGroupJid,
  CHANNEL_GROUP, CHANNEL_PRIVATE,
} from '../services/channels.js';
import { findMemberByPhone, phoneFromJid } from '../services/members.js';
import { recentMemory, saveMemory, activeTasks } from '../services/memory.js';
import { ask } from '../services/ai.js';
import { executeActions } from '../services/actions.js';
import { sendText } from '../lib/evolution.js';

export async function handleWebhook(req, res) {
  const payload = req.body;
  // Evolution envía formatos distintos según versión. Normalizamos.
  const event = payload?.event ?? payload?.type;
  const data  = payload?.data  ?? payload;

  // Respondemos rápido a Evolution; procesamos en background.
  res.status(202).json({ received: true });

  try {
    if (event && event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
      return; // ignoramos otros eventos por ahora
    }
    await processMessage(data);
  } catch (err) {
    console.error('[webhook] error procesando', err);
  }
}

async function processMessage(data) {
  const remoteJid = data?.key?.remoteJid;
  const fromMe    = data?.key?.fromMe === true;
  if (!remoteJid || fromMe) return;

  const channel = detectChannel(remoteJid);
  if (!channel) {
    console.log('[webhook] canal desconocido:', remoteJid);
    return;
  }

  const text = extractText(data);
  if (!text) return;

  // En grupo: solo el grupo del equipo de marketing, y solo si nos hablan.
  if (channel === CHANNEL_GROUP) {
    if (!isAuthorizedGroup(remoteJid)) {
      logGroupForDiscovery(remoteJid, data?.pushName);
      return;
    }
    if (!isAddressedToKira(text)) return;
  }

  // Identificamos al miembro por el número.
  // Privado: senderJid = remoteJid.
  // Grupo: senderJid = key.participant (a veces @lid anónimo).
  // Probamos varios campos por si Evolution lo expone en distintos lugares.
  const candidateJids = channel === CHANNEL_GROUP
    ? [
        data?.key?.participant,
        data?.key?.participantPn,
        data?.participantPn,
        data?.key?.participantAlt,
      ].filter(Boolean)
    : [remoteJid];

  let phone = null;
  let matchedJid = null;
  for (const j of candidateJids) {
    const p = phoneFromJid(j);
    if (p) { phone = p; matchedJid = j; break; }
  }
  const member = await findMemberByPhone(phone);

  if (!member) {
    console.log(`[webhook] no identificado | channel=${channel} | tried=${JSON.stringify(candidateJids)} | parsed=${phone} | pushName=${data?.pushName ?? '?'}`);
    return;
  }
  if (matchedJid && matchedJid !== candidateJids[0]) {
    console.log(`[webhook] usado JID alterno (${matchedJid}) en lugar del primero`);
  }

  // Owners de espacios unidireccionales (Mattias/Piura, Diana/Lima): reciben
  // crons pero KIRA no entabla conversación. Si responden, se ignora en silencio.
  if (member.role === 'owner') {
    console.log(`[webhook] ignorando mensaje de owner ${member.name} (${phone}) — espacio unidireccional`);
    return;
  }

  console.log(`[webhook] ${channel} | ${member.name}: ${text.slice(0, 80)}`);

  const [tasks, memory] = await Promise.all([
    activeTasks(member.id),
    recentMemory(member.id, 5),
  ]);

  const result = await ask({
    member,
    channel,
    message: text,
    context: { activeTasks: tasks, recentMemory: memory },
  });

  const senderJid = channel === CHANNEL_GROUP ? matchedJid : remoteJid;
  await dispatchMessages(result.messages, { senderJid });
  await executeActions(result.actions, { sender: member, channel });
  logAlerts(result.alerts);

  await saveMemory({
    memberId: member.id,
    channel,
    summary: `${member.name} (${channel}): ${text.slice(0, 200)}`,
    actionItems: result.actions?.length ? result.actions : null,
  });
}

function extractText(data) {
  const m = data?.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    null
  );
}

async function dispatchMessages(messages, { senderJid }) {
  for (const msg of messages ?? []) {
    if (!msg?.text) continue;
    let jid;
    if (msg.channel === 'group') {
      jid = getGroupJid();
      if (!jid) {
        console.warn('[webhook] mensaje a grupo descartado: GROUP_JID aún no capturado');
        continue;
      }
    } else if (msg.recipient && msg.recipient !== 'group') {
      // recipient es teléfono E.164 sin +
      jid = `${msg.recipient}@s.whatsapp.net`;
    } else {
      // private al sender por defecto
      jid = senderJid;
    }
    try {
      await sendText(jid, msg.text);
    } catch (err) {
      console.error('[webhook] fallo enviando a', jid, err.message);
    }
  }
}

function logAlerts(alerts) {
  if (!alerts?.length) return;
  console.log('[webhook] alerts (TODO notificar admins):', JSON.stringify(alerts));
}
