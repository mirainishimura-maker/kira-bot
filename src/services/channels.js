// Detección y captura del canal a partir del remoteJid de Evolution API.

import { config } from '../config.js';

const GROUP_SUFFIX   = '@g.us';
const PRIVATE_SUFFIX = '@s.whatsapp.net';

export const CHANNEL_GROUP   = 'group';
export const CHANNEL_PRIVATE = 'private';

export function detectChannel(remoteJid) {
  if (!remoteJid) return null;
  if (remoteJid.endsWith(GROUP_SUFFIX))   return CHANNEL_GROUP;
  if (remoteJid.endsWith(PRIVATE_SUFFIX)) return CHANNEL_PRIVATE;
  return null;
}

// El primer mensaje del grupo nos da su JID. Lo cacheamos en memoria del proceso.
// El siguiente paso natural es persistirlo (env, BD), pero por ahora alcanza.
let cachedGroupJid = config.evolution.groupJid;

export function getGroupJid() {
  return cachedGroupJid;
}

export function rememberGroupJid(remoteJid) {
  if (!remoteJid?.endsWith(GROUP_SUFFIX)) return;
  if (cachedGroupJid === remoteJid) return;
  cachedGroupJid = remoteJid;
  console.log(`[channels] GROUP_JID capturado: ${remoteJid}`);
  console.log('[channels] Guarda este valor en EasyPanel como GROUP_JID para persistirlo entre reinicios.');
}

// ¿El mensaje de grupo está dirigido a KIRA?
// Reglas: menciona "kira" (case insensitive) o es reply a un mensaje de KIRA.
export function isAddressedToKira(text, { isReplyToBot = false } = {}) {
  if (isReplyToBot) return true;
  if (!text) return false;
  return /\bkira\b/i.test(text);
}
