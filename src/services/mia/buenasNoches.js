// Buenas noches · mensaje diario de cierre para Mirai (10:00pm Lima).
// Pedido el 29 jul 2026: un empujoncito para irse a dormir, estilo mixto
// (calma + fe + sueño como autocuidado). A diferencia del recordatorio
// SERUMS (serums.js), este NO expira: acompaña también durante el servicio.
// Off con BUENAS_NOCHES_ENABLED=false.

import cron from 'node-cron';
import { config } from '../../config.js';
import { sendPrivate } from '../../lib/evolution.js';

const limaHoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

const NOCHE = [
  'Hora de ir cerrando el día, Mirai. Lo que quedó pendiente sabe esperar hasta mañana — tú también mereces descanso 💤',
  '«En paz me acuesto y me duermo, porque solo tú, Señor, me haces vivir confiada» (Salmo 4:8) 🤍',
  'Dato de psicóloga para psicóloga: dormir es cuando el cerebro guarda lo que entendiste hoy. Irte a la cama ES estudiar 💛',
  'Suelta el celular, apaga la luz y respira lento: inhala 4, exhala 6. El día ya dio lo que tenía que dar 🌿',
  'Antes de dormir, una gratitud chiquita: ¿qué cosa buena tuvo hoy? Con eso en la mente se duerme mejor 🤍',
  '«Todo obra para bien» — también mientras duermes. Nada de lo tuyo se cae por descansar 🙏',
  'Mañana a las 9:30 te espero con tu recordatorio. Ahora te toca la mejor parte del plan: dormir rico 💤',
  'Tu cuerpo te cuidó todo el día; ahora cuídalo tú: cama temprano, pantalla lejos. Buenas noches 💛',
  '«Él da a su amada el sueño» (Salmo 127:2). No tienes que resolver nada esta noche. Descansa 🤍',
  'Cerrar el día en paz también es un logro. Hoy hiciste suficiente — aunque "suficiente" haya sido descansar 🌿',
];

// ─── Cierre que SÍ guarda (10 ago 2026) ──────────────────────────────
// Antes el mensaje a veces preguntaba "¿qué cosa buena tuvo hoy?" pero la
// respuesta no quedaba en ningún lado. Ahora la pregunta alterna día por medio
// entre GRATITUD (tabla espiritual) y ÁNIMO (tabla de check-in), y dejamos un
// contexto para que neuraAssistant interprete la siguiente respuesta de Mirai
// como la respuesta a esa pregunta (aunque no diga "agradezco" ni "me siento").
const PREGUNTAS = {
  gratitud: '🙏 Y antes de dormir: *¿por qué das gracias hoy?*\n\nDime una, aunque sea chiquita, y la guardo 🤍',
  animo:    '💛 Y para cerrar: *¿cómo estuviste de ánimo hoy?*\n\nCuéntamelo en una frase y lo anoto — a ti también hay que medirte 🤍',
};

let cierrePendiente = null;             // { tipo, expiraMs }
const CIERRE_TTL_MS = 10 * 60 * 60 * 1000;   // vale hasta la mañana siguiente

// Lo consulta neuraAssistant para entender una respuesta suelta ("que pude
// descansar", "cansada pero tranquila") como lo que es.
export function contextoCierre() {
  if (!cierrePendiente) return null;
  if (cierrePendiente.expiraMs < Date.now()) { cierrePendiente = null; return null; }
  return cierrePendiente.tipo;
}
export function limpiarContextoCierre() { cierrePendiente = null; }

export async function runBuenasNoches({ dry = false } = {}) {
  const dia = Math.floor(Date.parse(limaHoy()) / 864e5);
  const idx = dia % NOCHE.length;
  const tipo = dia % 2 === 0 ? 'gratitud' : 'animo';
  const texto = `🌙 *Buenas noches, Mirai*\n\n${NOCHE[idx]}\n\n${PREGUNTAS[tipo]}`;

  if (!dry) {
    try {
      await sendPrivate(config.mia.personalPhone, texto);
      cierrePendiente = { tipo, expiraMs: Date.now() + CIERRE_TTL_MS };
    }
    catch (e) { console.error('[mia/noches] envío:', e.message); return { ok: false, error: e.message, texto }; }
  }
  return { ok: true, texto, tipo };
}

export function startBuenasNochesCron() {
  if (!config.mia.enabled) return;
  if (process.env.BUENAS_NOCHES_ENABLED === 'false') {
    console.log('[mia/noches] buenas noches APAGADO por env');
    return;
  }
  cron.schedule('0 22 * * *', () => {
    runBuenasNoches({ dry: false }).catch((e) => console.error('[mia/noches] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[mia/noches] cron activo (22:00 Lima · buenas noches)');
}
