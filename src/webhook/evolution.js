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

  // Identificamos al miembro por el número que envió el mensaje.
  // En privado: el remoteJid ES el del miembro.
  // En grupo: lo trae participant.
  const senderJid = channel === CHANNEL_GROUP ? data?.key?.participant : remoteJid;
  const phone = phoneFromJid(senderJid);
  const member = await findMemberByPhone(phone);

  if (!member) {
    console.log(`[webhook] mensaje de número desconocido (${phone}). Ignorado por ahora.`);
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

  await dispatchMessages(result.messages, { senderJid });
  logActions(result.actions);
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

function logActions(actions) {
  if (!actions?.length) return;
  console.log('[webhook] actions pendientes (TODO ejecutar):', JSON.stringify(actions));
}

function logAlerts(alerts) {
  if (!alerts?.length) return;
  console.log('[webhook] alerts (TODO notificar admins):', JSON.stringify(alerts));
}
