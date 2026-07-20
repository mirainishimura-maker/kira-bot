// Botón de Piero — el Atajo del iPhone de Piero hace POST /piero/boton y:
//   1) a Mirai le llega un WhatsApp "está pensando en ti" (ruleta de frases,
//      con contador de toques del mes y total histórico),
//   2) el Atajo le muestra a Piero la confirmación que devuelve este endpoint
//      (otra ruleta, para que nunca sepa qué le va a salir).
//
// Contadores persistidos en el bucket privado de NEURA (neura-state), mismo
// patrón que el publicador: sobreviven redeploys sin crear tablas en el
// Supabase compartido.
//
// Anti-spam: cada toque SIEMPRE se cuenta, pero a Mirai le llega máximo un
// WhatsApp por minuto — si Piero se emociona y presiona 10 veces seguidas,
// el Atajo se lo dice con cariño.

import { config } from '../config.js';
import { miraiSupabase } from '../lib/miraiSupabase.js';
import { sendPrivate } from '../lib/evolution.js';

const STATE_FILE = 'piero_boton.json';
const COOLDOWN_MS = 60_000;

let lastSentAt = 0; // en memoria: si el proceso se reinicia solo se pierde el cooldown

const FRASES_MIRAI = [
  '💙 Piero presionó el botón: está pensando en ti ahora mismo.',
  '💙 Señal de Piero — te está pensando.',
  '💙 Piero te mandó un toque de cariño desde su celular.',
  '💙 Aviso importante: Piero está pensando en ti. Fin del comunicado.',
  '💙 Piero apretó su botón favorito: tú.',
  '💙 Interrumpimos tu día para informarte que Piero te piensa.',
];

const FRASES_PIERO = [
  'Entregado 💌 Mirai ya sabe que la estás pensando.',
  'Señal enviada 💙 Le llegó directito a su WhatsApp.',
  'Boom 💥 Dopamina en camino.',
  'Listo ✨ Acabas de mejorarle el día.',
  'Enviado 🚀 Cariño viajando a la velocidad de la luz.',
  'Hecho 💙 Un pensamiento tuyo acaba de aterrizar en su celular.',
];

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

export async function presionarBoton() {
  const state = await loadState();
  const mes = mesKey();
  state.total += 1;
  state.meses[mes] = (state.meses[mes] || 0) + 1;
  state.lastAt = new Date().toISOString();
  await saveState(state);

  const delMes = state.meses[mes];
  const hito = state.total % 100 === 0; // cada 100 toques históricos, fiesta

  const now = Date.now();
  const enCooldown = now - lastSentAt < COOLDOWN_MS;

  let enviado = false;
  if (!enCooldown) {
    const texto = hito
      ? `🏆💙 ¡Toque #${state.total} en la historia del botón! Piero está pensando en ti (van ${delMes} este mes).`
      : `${pick(FRASES_MIRAI)}\n\n_Toque #${delMes} del mes (${state.total} en total)._`;
    await sendPrivate(config.mia.personalPhone, texto);
    lastSentAt = now;
    enviado = true;
  }

  const mensaje = !enviado
    ? `Tranquilo, galán 😄 le avisé hace un ratito. Igual conté tu toque: #${delMes} del mes.`
    : hito
      ? `🏆 ¡Toque #${state.total} de la historia! Nivel leyenda. Mirai ya lo sabe.`
      : `${pick(FRASES_PIERO)}\nToque #${delMes} del mes.`;

  return { ok: true, enviado, mensaje, toques: { mes: delMes, total: state.total } };
}
