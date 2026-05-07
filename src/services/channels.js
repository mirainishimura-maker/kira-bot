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

// El JID del grupo del equipo de marketing. Lo seteas en env como GROUP_JID.
// Cualquier mensaje de OTRO grupo se ignora.
export function getGroupJid() {
  return config.evolution.groupJid;
}

// ¿Este grupo es el del equipo de marketing?
export function isAuthorizedGroup(remoteJid) {
  const configured = config.evolution.groupJid;
  if (!configured) return false;
  return remoteJid === configured;
}

// Para ayudar a descubrir el JID correcto durante el setup inicial.
export function logGroupForDiscovery(remoteJid, senderName) {
  console.log(`[channels] mensaje de grupo no autorizado | JID=${remoteJid} | de=${senderName ?? '?'}`);
  console.log('[channels] Si ESTE es el grupo del equipo de marketing, copia el JID de arriba a la env var GROUP_JID y redespliega.');
}

// ¿El mensaje de grupo está dirigido a KIRA?
// Reglas: menciona "kira" (case insensitive) o es reply a un mensaje de KIRA.
export function isAddressedToKira(text, { isReplyToBot = false } = {}) {
  if (isReplyToBot) return true;
  if (!text) return false;
  return /\bkira\b/i.test(text);
}
