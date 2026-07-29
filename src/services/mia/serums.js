// SERUMS · recordatorio diario de calma para Mirai (9:30am Lima).
// Nace de lo conversado el 28 jul 2026: examen dom 9 ago, adjudicación
// ago-sep, inicio de actividades ~1 oct. Mensajes cortos que recuerdan
// las fechas Y la calma (entender > memorizar, sobran plazas, su porqué).
// 29 jul: Mirai eligió la hora (9:30, mañana sin apuro) y estilo mixto —
// motivación + calma + fe ("todo obra para bien") rotando.
// Se apaga solo después del 1 oct. Off con SERUMS_REMINDER_ENABLED=false.

import cron from 'node-cron';
import { config } from '../../config.js';
import { sendPrivate } from '../../lib/evolution.js';

const EXAMEN = '2026-08-09';
const INICIO = '2026-10-01';

const limaHoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const dias = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// Fase 1 — hasta el examen. Rota uno por día.
const PRE = [
  'Entender > memorizar. Una idea que puedes explicar con tus palabras vale más que diez listas repetidas. Hoy elige UNA y desármala 🌸',
  'Dato real: el proceso pasado sobraron 659 plazas remuneradas de psicología (de 1,237). No peleas un cupo imposible — solo tienes que llegar en paz 💛',
  'No necesitas top 10. Necesitas pasar tranquila y elegir tu plaza. Estudiar desde la calma rinde más que estudiar desde la culpa 🌿',
  'Ratito para Investigación y Gestión hoy: un solo tema, con un ejemplo vívido. Pequeño y bien entendido, gana 🌸',
  'Descansar también es estudiar: el cerebro consolida cuando paras. Si hoy toca pausa, la pausa es parte del plan 💛',
  'Acuérdate de tu porqué: tus primos, las misiones, el mundo que quieres ver. Este examen es un puente, no una prueba de tu valor 🌸',
  'Viviste sola en Denver, a miles de kilómetros. Una plaza lejos de casa no te queda grande — ya lo demostraste 💪',
  'Después del examen vienen 7 semanas para tus pacientes, y en octubre tu nueva etapa. Todo está ordenado; hoy solo toca un paso chiquito 🌿',
  'Si la mente se acelera: inhala 4 segundos, exhala 6, tres veces. Lo que les enseñas a tus pacientes también es tuyo 🤍',
  'La culpa por "no estudiar suficiente" mide horas, no comprensión — y miente. Tú entiendes profundo. Confía en tu forma de aprender 💛',
  '«Todo obra para bien» (Romanos 8:28) — tu propia frase. También este examen, también los días en que solo descansas 🙏',
  '«No se preocupen por el día de mañana» (Mateo 6:34). Hoy solo existe hoy: un tema, una caminata, una siesta. Mañana se cuida solo 🤍',
  '«No temas, porque yo estoy contigo» (Isaías 41:10). No vas sola a esto — ni al examen ni a la plaza que venga después 💛',
];

// Fase 2 — del examen al inicio. Acompaña la espera sin ansiedad.
const POST = [
  'Ya diste el examen 🎉 Lo que sigue no depende de repasar: resultados a fines de agosto y adjudicación entre agosto y septiembre. Estas semanas son para tus pacientes 🌸',
  'Recordatorio de fechas: resultados ~fines de agosto, adjudicación ago-sep, inicio de actividades ~1 de octubre. Nada que hacer hoy más que vivir tu agenda 💛',
  'Estas semanas cierran una etapa linda: tus pacientes de agosto-septiembre merecen finales bien cuidados. Eso también es prepararte para el SERUMS 🌿',
  'La espera de resultados no se apura con preocupación. Si aparece la ansiedad, trátala como tratarías a un paciente: con curiosidad y cariño 🤍',
  '«El que comenzó en ustedes la buena obra la irá perfeccionando» (Filipenses 1:6). La espera también es parte de la obra 🙏',
];

export async function runSerumsReminder({ dry = false } = {}) {
  const hoy = limaHoy();
  const alExamen = dias(hoy, EXAMEN);
  const alInicio = dias(hoy, INICIO);

  let texto;
  if (alExamen > 1) {
    texto = `🎓 *SERUMS · faltan ${alExamen} días* (examen: dom 9 de agosto)\n\n${PRE[alExamen % PRE.length]}`;
  } else if (alExamen === 1) {
    texto = '🎓 *SERUMS · mañana es el día*\n\nHoy NO se estudia nada nuevo: repaso suave, buena cena, dormir temprano. Llegas lista — mañana solo vas a mostrar lo que ya entiendes 🌸💛';
  } else if (alExamen === 0) {
    texto = '🎓 *HOY es tu examen* 🌸\n\nRespira: inhala 4, exhala 6. Ya hiciste el trabajo. Entra tranquila, lee con calma y confía en tu forma de entender. Aquí te espero con la razón de tu porqué 💛 ¡Tú puedes!';
  } else if (alInicio > 0) {
    texto = `🌿 *SERUMS · etapa de espera* (inicio ~1 de octubre, faltan ${alInicio} días)\n\n${POST[alInicio % POST.length]}`;
  } else if (alInicio === 0) {
    texto = '🎉 *Hoy empieza tu SERUMS* 🌸\n\nUn año que te acerca a tus primos, a las misiones y al mundo que quieres ver. Este recordatorio se despide aquí — ahora te toca vivirlo. Estoy orgullosa de ti 💛';
  } else {
    return { ok: true, texto: null }; // ya empezó: el cron queda mudo
  }

  if (!dry) {
    try { await sendPrivate(config.mia.personalPhone, texto); }
    catch (e) { console.error('[mia/serums] envío:', e.message); return { ok: false, error: e.message, texto }; }
  }
  return { ok: true, texto };
}

export function startSerumsCron() {
  if (!config.mia.enabled) return;
  if (process.env.SERUMS_REMINDER_ENABLED === 'false') {
    console.log('[mia/serums] recordatorio diario APAGADO por env');
    return;
  }
  cron.schedule('30 9 * * *', () => {
    runSerumsReminder({ dry: false }).catch((e) => console.error('[mia/serums] cron:', e.message));
  }, { timezone: 'America/Lima' });
  console.log('[mia/serums] cron activo (9:30 Lima · recordatorio SERUMS)');
}
