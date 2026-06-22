// Sube las 17 plantillas v2 (estilo elevado) al bucket público `neura` y las
// agrega a la COLA de NEURA con su caption, intercaladas con lo que ya hay
// pendiente (1 post nuevo : 1 pendiente). El cron las auto-publica (3/día).
//
// Uso:  node scripts/queueNeuraPosts.js

import fs from 'fs';
import path from 'path';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const DIR = 'C:\\projects\\nowa\\neura_studio\\render17';

// Orden de publicación (ritmo: emocional ↔ educativo) + copy anónimo NEURA.
const POSTS = [
  { file: '02_Recordatorio.png', id: 'p_recordatorio', caption:
`Respira. Ahora mismo, en este momento, estás a salvo. 🤍

A veces la mente corre hacia adelante; volver al presente es volver a casa.

📲 Si necesitas un espacio para hablar, escríbenos — link en la bio.

#saludmental #ansiedad #respira #bienestaremocional #terapiaonline #saludmentalperu` },

  { file: '16_Dato.png', id: 'p_dato', caption:
`1 de cada 3 personas vivirá ansiedad en algún momento de su vida. 🌿

No estás solx, y no estás exagerando. Pedir ayuda es válido y valiente.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #ansiedad #bienestaremocional #terapiaonline #saludmentalperu` },

  { file: '18_Cita.png', id: 'p_cita', caption:
`Sanar no siempre es avanzar rápido. A veces es volver — a tu cuerpo, a tu calma, a quien eras antes de cargar tanto. 🤍

En NEURA te acompañamos en ese camino, a tu ritmo y en un espacio seguro.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #sanar #bienestaremocional #terapiaonline #psicologia` },

  { file: '09_Pausa_wellness.png', id: 'p_pausa', caption:
`Esta es tu señal para parar 2 minutos. 🌿

Respira hondo. Una pausa no te atrasa — también es avanzar.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #pausa #autocuidado #bienestaremocional #mindfulness` },

  { file: '07_Lista_recursos.png', id: 'p_limites', caption:
`Poner límites no te hace egoísta. Te cuida. 🤍

Decir “no” sin culpa, respetar tu descanso, alejarte de lo que te agota, pedir ayuda a tiempo. Empieza por uno.

📲 Escríbenos — link en la bio.

#saludmental #limites #autocuidado #bienestaremocional #terapiaonline` },

  { file: '05_Silueta.png', id: 'p_calma', caption:
`Vivimos celebrando la productividad… pero tu calma también es un logro. 🌸

Descansar, poner límites, soltar lo que pesa — eso también es avanzar.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #autocuidado #calma #bienestaremocional #terapiaonline` },

  { file: '12_Mitos_vs_Realidad.png', id: 'p_mitos', caption:
`Mito: la terapia es solo para cuando estás en crisis. 🚫

Realidad: es para conocerte, cuidarte y crecer — no necesitas tocar fondo para empezar. 🤍

📲 Escríbenos — link en la bio.

#saludmental #terapia #mitos #psicologia #bienestaremocional` },

  { file: '21_CTA_final.png', id: 'p_cta', caption:
`Dar el primer paso es lo más difícil — y lo más valiente. 🤍

Psicoterapia online, a tu ritmo y en un espacio seguro. Estamos para escucharte.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #terapiaonline #primerpaso #bienestaremocional #psicologia` },

  { file: '11_Frase_texturizada.png', id: 'p_sentir', caption:
`No tienes que “estar bien” todo el tiempo. Sentir —incluso lo difícil— también es parte de sanar. 🌿

Darte permiso de sentir es un acto de cuidado.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #emociones #bienestaremocional #terapiaonline #autocuidado` },

  { file: '14_Pregunta.png', id: 'p_pregunta', caption:
`Pregunta honesta: ¿cómo está tu descanso últimamente? 🌙

Reparador, interrumpido, o casi inexistente… Leerte es el primer paso — cuéntanos en los comentarios.

📲 ¿Necesitas apoyo? Escríbenos — link en la bio.

#saludmental #descanso #sueño #bienestaremocional #autocuidado` },

  { file: '06_Sillas_-_espacio.png', id: 'p_espacio', caption:
`No tienes que cargar con todo solx. Aquí hay un espacio seguro para ti — sin juicios, a tu ritmo. 🤍

Pedir ayuda también es valentía.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #terapiaonline #espacioseguro #psicologia #bienestaremocional` },

  { file: '19_Checklist.png', id: 'p_autocuidado', caption:
`El autocuidado no es un spa de vez en cuando — son pequeñas cosas cada día. 🌿

Dormir, moverte, hablar lo que sientes, poner límites, pedir ayuda. ¿Cuál te falta hoy?

📲 Escríbenos — link en la bio.

#saludmental #autocuidado #rutina #bienestaremocional #habitos` },

  { file: '04_Frase_iOS.png', id: 'p_resuelto', caption:
`Spoiler: nadie lo tiene todo resuelto. 🤍 Y está bien.

Darte permiso de no saber, de equivocarte, de ir despacio — eso también es salud mental.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #autocompasion #bienestaremocional #terapiaonline #psicologia` },

  { file: '10_Testimonios.png', id: 'p_testimonios', caption:
`A veces el primer paso da miedo… pero del otro lado hay alivio. 🤍

Cosas que suelen contarnos quienes empiezan: “por fin me siento escuchada”, “aprendí a poner límites”, “volví a dormir tranquilo”. Tú también puedes empezar.

📲 Escríbenos — link en la bio.

#saludmental #terapiaonline #bienestaremocional #psicologia` },

  { file: '03_Portada_carrusel.png', id: 'p_agotamiento', caption:
`El agotamiento emocional no siempre se ve como cansancio. 🌙

A veces es irritabilidad, desconexión, o sentir que “funcionas” pero por dentro estás vacíx. Si te identificas, no estás solx.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #burnout #agotamiento #bienestaremocional #terapiaonline` },

  { file: '20_Slide_carrusel.png', id: 'p_ansiedad', caption:
`¿Qué es realmente la ansiedad? 🌿

Es una respuesta natural de tu sistema nervioso para protegerte. No estás exagerando — tu cuerpo solo intenta cuidarte.

📲 ¿Quieres aprender a manejarla? Escríbenos — link en la bio.

#saludmental #ansiedad #psicoeducacion #bienestaremocional #terapiaonline` },

  { file: '13_Moodboard.png', id: 'p_recursos', caption:
`Guarda este post para ti 🤍 Recursos por tema para cuidar tu salud mental: ansiedad, límites, duelo, autoestima.

¿Sobre cuál te gustaría que hablemos primero?

📲 Escríbenos — link en la bio.

#saludmental #recursos #bienestaremocional #autocuidado #psicologia` },
];

async function main() {
  if (!miraiSupabase) throw new Error('miraiSupabase null — faltan MIRAI_* en .env');
  const bucket = config.neura.bucket || 'neura';
  const state = await loadState();
  if (!Array.isArray(state.queue)) state.queue = [];
  const stamp = Date.now();

  const nuevos = [];
  for (const p of POSTS) {
    const fp = path.join(DIR, p.file);
    if (!fs.existsSync(fp)) { console.warn('  ⚠ no existe', p.file); continue; }
    const buf = fs.readFileSync(fp);
    const key = `posts/${p.id}_${stamp}.png`;
    const { error } = await miraiSupabase.storage.from(bucket)
      .upload(key, buf, { contentType: 'image/png', upsert: true });
    if (error) throw new Error('upload ' + p.id + ': ' + error.message);
    const { data } = miraiSupabase.storage.from(bucket).getPublicUrl(key);
    nuevos.push({ id: `${p.id}_${stamp}`, tipo: 'single', images: [data.publicUrl], caption: p.caption, posted: false });
    console.log('✓ subido', p.file);
  }

  // Intercalar 1 nuevo : 1 pendiente, liderando con los nuevos.
  const posted = state.queue.filter(q => q.posted);
  const oldPend = state.queue.filter(q => !q.posted);
  const mix = []; let i = 0, j = 0;
  while (i < nuevos.length || j < oldPend.length) {
    if (i < nuevos.length) mix.push(nuevos[i++]);
    if (j < oldPend.length) mix.push(oldPend[j++]);
  }
  state.queue = [...posted, ...mix];
  await saveState(state);

  const pend = state.queue.filter(q => !q.posted);
  console.log(`\n✅ ${nuevos.length} posts nuevos encolados | pendientes totales: ${pend.length}`);
  console.log('Próximos 8:', pend.slice(0, 8).map(q => q.id).join('  →  '));
}

main().catch(err => { console.error('\n❌ ERROR:', err.message); process.exit(1); });
