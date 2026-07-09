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

// ¿Este grupo es el de correcciones de ITACA ("conversemos las tres")?
export function isItacaGroup(remoteJid) {
  const configured = config.mia.itaca?.groupJid;
  if (!configured) return false;
  return remoteJid === configured;
}

// --- Descubrimiento de grupos para el comando /grupos ---
// Guardamos en memoria los últimos grupos de los que Mia vio un mensaje, para
// que Mirai pueda copiar el JID del grupo correcto sin bucear en los logs.
const groupSightings = new Map(); // jid -> { jid, sender, preview, count, lastAt }
const MAX_SIGHTINGS = 15;

export function recordGroupSighting(jid, sender, previewText) {
  if (!jid) return;
  const prev = groupSightings.get(jid);
  const preview = (previewText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // delete + set deja la clave al final (Map conserva orden de inserción).
  groupSightings.delete(jid);
  groupSightings.set(jid, {
    jid,
    sender: sender ?? prev?.sender ?? '?',
    preview: preview || prev?.preview || '',
    count: (prev?.count ?? 0) + 1,
    lastAt: Date.now(),
  });
  while (groupSightings.size > MAX_SIGHTINGS) {
    const oldest = groupSightings.keys().next().value;
    groupSightings.delete(oldest);
  }
}

export function getRecentGroups() {
  return [...groupSightings.values()].sort((a, b) => b.lastAt - a.lastAt);
}

// ¿El mensaje de grupo está dirigido a KIRA?
// Reglas: menciona "kira" (case insensitive) o es reply a un mensaje de KIRA.
export function isAddressedToKira(text, { isReplyToBot = false } = {}) {
  if (isReplyToBot) return true;
  if (!text) return false;
  return /\bkira\b/i.test(text);
}
