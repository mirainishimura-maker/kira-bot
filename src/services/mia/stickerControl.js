// Control de Mia por STICKERS que Mirai envía desde su WhatsApp de trabajo.
//
// Mirai elige DOS stickers (una sola vez, con /sticker parar y /sticker retomar):
//   - sticker "PARAR"   → cuando se lo manda a un paciente, Mia deja de
//                         responderle (estado 'silenciada').
//   - sticker "RETOMAR" → Mia vuelve a responderle (estado 'datos_parciales').
//
// Cada sticker de WhatsApp trae un `fileSha256` estable (el mismo sticker
// siempre tiene el mismo hash), que usamos como HUELLA para reconocerlo.
//
// Persistencia: los 2 hashes se guardan en data/mia-stickers.json al capturarlos
// en runtime. Las env vars MIA_STICKER_STOP / MIA_STICKER_RESUME los fijan de
// forma permanente (útil si el disco del contenedor no persiste entre deploys).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../../data');
const DATA_FILE = join(DATA_DIR, 'mia-stickers.json');

// Huellas configuradas: { stop: <fp>|null, resume: <fp>|null }.
let store = { stop: null, resume: null };

// 1) Cargar del archivo (si ya se capturó antes).
try {
  const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  if (raw && typeof raw === 'object') {
    store = { stop: raw.stop || null, resume: raw.resume || null };
  }
} catch { /* el archivo aún no existe: normal en el primer arranque */ }

// 2) Las env vars pisan al archivo (fijación permanente).
if (config.mia?.stickers?.stop)   store.stop   = config.mia.stickers.stop;
if (config.mia?.stickers?.resume) store.resume = config.mia.stickers.resume;

// Normaliza el fileSha256 de un stickerMessage a un string base64 estable.
// Evolution/Baileys lo puede entregar como base64 string, array de bytes,
// Buffer serializado ({type:'Buffer',data:[...]}) u objeto indexado ({0:..}).
export function stickerFingerprint(sticker) {
  const raw = sticker?.fileSha256;
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.from(raw).toString('base64');
  if (raw.type === 'Buffer' && Array.isArray(raw.data)) return Buffer.from(raw.data).toString('base64');
  if (typeof raw === 'object') {
    const bytes = Object.keys(raw)
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map(k => raw[k]);
    if (bytes.length) return Buffer.from(bytes).toString('base64');
  }
  return null;
}

// Devuelve 'stop' | 'resume' | null según la huella coincida con un sticker
// configurado.
export function getStickerAction(fp) {
  if (!fp) return null;
  if (store.stop && fp === store.stop) return 'stop';
  if (store.resume && fp === store.resume) return 'resume';
  return null;
}

// { stop: bool, resume: bool } — para el comando /sticker estado.
export function stickersConfigured() {
  return { stop: Boolean(store.stop), resume: Boolean(store.resume) };
}

// ---- Modo captura ----
// /sticker parar|retomar arma la captura; el próximo sticker fromMe que Mirai
// mande (a cualquier chat privado) se guarda como ese tipo. Expira a los 2 min.
let capture = null; // { kind: 'stop'|'resume', expiresAt }
const CAPTURE_TTL_MS = 2 * 60 * 1000;

export function armCapture(kind) {
  if (kind !== 'stop' && kind !== 'resume') return false;
  capture = { kind, expiresAt: Date.now() + CAPTURE_TTL_MS };
  return true;
}

// Si hay una captura armada y vigente, guarda `fp` como ese tipo, lo persiste y
// devuelve { kind, sameAsOther }. Si no hay captura, devuelve null.
export function consumeCapture(fp) {
  if (!fp || !capture) return null;
  if (capture.expiresAt < Date.now()) { capture = null; return null; }
  const kind = capture.kind;
  const other = kind === 'stop' ? 'resume' : 'stop';
  const sameAsOther = Boolean(store[other] && store[other] === fp);
  store[kind] = fp;
  capture = null;
  persist();
  return { kind, sameAsOther };
}

function persist() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(store, null, 2) + '\n');
  } catch (err) {
    console.error('[mia/sticker] no pude guardar mia-stickers.json:', err.message);
  }
}
