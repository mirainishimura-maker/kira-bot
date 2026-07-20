// Botón de cariño BIDIRECCIONAL — dos atajos, uno en cada celular:
//   · Piero presiona (POST /piero/boton)  → a Mirai le llega "está pensando en ti",
//   · Mirai presiona (POST /mirai/boton)  → a Piero le llega lo mismo, de vuelta.
// En ambos casos el Atajo le muestra al que presionó una confirmación (ruleta).
//
// Cada dirección tiene su token (PIERO_BOTON_TOKEN / MIRAI_BOTON_TOKEN) y su
// contador (toques del mes + total histórico, con hito cada 100). El mensaje a
// Piero necesita PIERO_PHONE (mismo formato E.164 sin "+" que MIRAI_PERSONAL_PHONE).
//
// Contadores persistidos en el bucket privado de NEURA (neura-state), mismo
// patrón que el publicador: sobreviven redeploys sin crear tablas en el
// Supabase compartido. Los toques de Piero viven en la raíz del JSON (legado
// de la v1) y los de Mirai bajo la key `mirai`.
//
// Anti-spam: cada toque SIEMPRE se cuenta, pero al destinatario le llega
// máximo un WhatsApp por minuto por dirección.

import { config } from '../config.js';
import { miraiSupabase } from '../lib/miraiSupabase.js';
import { sendPrivate } from '../lib/evolution.js';

const STATE_FILE = 'piero_boton.json';
const COOLDOWN_MS = 60_000;

// key = quién presionó; en memoria: un reinicio solo resetea el cooldown
const lastSentAt = { piero: 0, mirai: 0 };

function frasesPensandoEnTi(nombre) {
  return [
    `💙 ${nombre} presionó el botón: está pensando en ti ahora mismo.`,
    `💙 Señal de ${nombre} — te está pensando.`,
    `💙 ${nombre} te mandó un toque de cariño desde su celular.`,
    `💙 Aviso importante: ${nombre} está pensando en ti. Fin del comunicado.`,
    `💙 ${nombre} apretó su botón favorito: tú.`,
    `💙 Interrumpimos tu día para informarte que ${nombre} te piensa.`,
  ];
}

// Confirmación que ve el que presionó. `leLo` = pronombre según el destinatario.
function frasesConfirmacion(nombre, leLo) {
  return [
    `Entregado 💌 ${nombre} ya sabe que ${leLo} estás pensando.`,
    `Señal enviada 💙 Le llegó directito a su WhatsApp.`,
    `Boom 💥 Dopamina en camino.`,
    `Listo ✨ Acabas de mejorarle el día a ${nombre}.`,
    `Enviado 🚀 Cariño viajando a la velocidad de la luz.`,
    `Hecho 💙 Un pensamiento tuyo acaba de aterrizar en su celular.`,
  ];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 'YYYY-MM' en hora Lima — la key del contador mensual.
function mesKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.tz }).slice(0, 7);
}

async function loadState() {
  const def = { total: 0, meses: {} };
  if (!miraiSupabase) return def;
  try {
    const { data, error } = await miraiSupabase.storage.from(config.neura.stateBucket).download(STATE_FILE);
    if (error || !data) return def;
    const s = JSON.parse(await data.text());
    if (!Number.isFinite(s.total)) s.total = 0;
    if (!s.meses || typeof s.meses !== 'object') s.meses = {};
    return s;
  } catch (err) {
    console.error('[piero] loadState error:', err.message);
    return def;
  }
}

async function saveState(state) {
  if (!miraiSupabase) return;
  const buf = Buffer.from(JSON.stringify(state, null, 2));
  const { error } = await miraiSupabase.storage.from(config.neura.stateBucket)
    .upload(STATE_FILE, buf, { contentType: 'application/json', upsert: true });
  if (error) console.error('[piero] saveState error:', error.message);
}

async function toque({ quien, nombre, leLo, destinoPhone }) {
  const state = await loadState();
  // Los toques de Piero viven en la raíz (compat con la v1); los de Mirai en `mirai`.
  let slot = state;
  if (quien === 'mirai') {
    if (!state.mirai || typeof state.mirai !== 'object') state.mirai = { total: 0, meses: {} };
    if (!Number.isFinite(state.mirai.total)) state.mirai.total = 0;
    if (!state.mirai.meses || typeof state.mirai.meses !== 'object') state.mirai.meses = {};
    slot = state.mirai;
  }

  const mes = mesKey();
  slot.total += 1;
  slot.meses[mes] = (slot.meses[mes] || 0) + 1;
  slot.lastAt = new Date().toISOString();
  await saveState(state);

  const delMes = slot.meses[mes];
  const hito = slot.total % 100 === 0; // cada 100 toques históricos, fiesta

  const now = Date.now();
  const enCooldown = now - lastSentAt[quien] < COOLDOWN_MS;

  let enviado = false;
  if (!enCooldown) {
    const quienPresiona = quien === 'piero' ? 'Piero' : 'Mirai';
    const texto = hito
      ? `🏆💙 ¡Toque #${slot.total} en la historia del botón! ${quienPresiona} está pensando en ti (van ${delMes} este mes).`
      : `${pick(frasesPensandoEnTi(quienPresiona))}\n\n_Toque #${delMes} del mes (${slot.total} en total)._`;
    await sendPrivate(destinoPhone, texto);
    lastSentAt[quien] = now;
    enviado = true;
  }

  const mensaje = !enviado
    ? `Con calma 😄 le avisé hace un ratito. Igual conté tu toque: #${delMes} del mes.`
    : hito
      ? `🏆 ¡Toque #${slot.total} de la historia! Nivel leyenda. ${nombre} ya lo sabe.`
      : `${pick(frasesConfirmacion(nombre, leLo))}\nToque #${delMes} del mes.`;

  return { ok: true, enviado, mensaje, toques: { mes: delMes, total: slot.total } };
}

// Piero presionó su botón → WhatsApp a Mirai.
export function presionarBoton() {
  return toque({ quien: 'piero', nombre: 'Mirai', leLo: 'la', destinoPhone: config.mia.personalPhone });
}

// Mirai presionó el suyo → WhatsApp a Piero.
export function presionarBotonMirai() {
  return toque({ quien: 'mirai', nombre: 'Piero', leLo: 'lo', destinoPhone: config.piero.phone });
}
