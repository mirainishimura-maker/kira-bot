import { config } from '../config.js';

const baseUrl  = config.evolution.url.replace(/\/$/, '');
const instance = config.evolution.instance;

async function call(path, method, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.evolution.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Evolution API ${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

// Envía texto a un JID. Para grupo: 120363xxx@g.us. Para privado: 51xxx@s.whatsapp.net.
export function sendText(jid, text) {
  return call(`/message/sendText/${instance}`, 'POST', {
    number: jid,
    text,
  });
}

export function sendToGroup(text) {
  if (!config.evolution.groupJid) {
    throw new Error('GROUP_JID no configurado todavía. Captúralo desde el primer mensaje del grupo.');
  }
  return sendText(config.evolution.groupJid, text);
}

export function sendPrivate(phoneE164, text) {
  return sendText(`${phoneE164}@s.whatsapp.net`, text);
}

// Envía una imagen (URL pública) a un JID. Opcionalmente con caption.
export function sendImage(jid, imageUrl, caption = '') {
  return call(`/message/sendMedia/${instance}`, 'POST', {
    number: jid,
    mediatype: 'image',
    media: imageUrl,
    caption,
  });
}
