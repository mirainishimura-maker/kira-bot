// Sube las 11 plantillas TRENDY (estilos de las referencias) al bucket `neura`
// y las agrega a la cola con su copy, intercaladas con lo pendiente. Cron auto-publica.
//   node scripts/queueTrendy.js

import fs from 'fs';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const R = 'C:\\tmp\\ref\\out\\', R2 = 'C:\\tmp\\ref2\\out\\', R3 = 'C:\\tmp\\ref3\\';

const POSTS = [
  { id: 'pt_doodle', file: R + 'A_doodle.png', caption:
`No tienes que atravesarlo solx. 🤍

Hablar con un profesional puede cambiarlo todo — no porque estés “mal”, sino porque mereces sentirte mejor.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #terapiaonline #noestassolo #bienestaremocional #psicologia` },
  { id: 'pt_editorial', file: R + 'B_editorial.png', caption:
`Todos corremos a “estar bien”… pero ¿cuándo fue la última vez que alguien te preguntó cómo estás tú, de verdad? 🤍

Acá nos importa.

📲 Escríbenos — link en la bio.

#saludmental #bienestaremocional #terapiaonline #comoestas #psicologia` },
  { id: 'pt_receipt', file: R + 'C_receipt.png', caption:
`Este es tu recordatorio de hoy 🧾🤍

No tienes que ir al ritmo de nadie. Sanar, descansar, avanzar — todo a tu tiempo. La vida no es una carrera.

📲 ¿Necesitas un espacio para ti? Escríbenos — link en la bio.

#saludmental #autocuidado #atupropioritmo #bienestaremocional #calma` },
  { id: 'pt_silla', file: R + 'D_silla.png', caption:
`Ven, siéntate un rato. 🪑🌿

Date permiso de parar, respirar y simplemente estar. No tienes que hacer nada más por hoy.

📲 Si quieres conversar, escríbenos — link en la bio.

#saludmental #pausa #descanso #bienestaremocional #autocuidado` },
  { id: 'pt_overpensar', file: R2 + '1_overpensar.png', caption:
`Deja de darle vueltas. 🌀

Tu mente puede convertir un “quizás” en una tormenta. Pero la mayoría de lo que tanto temes… nunca pasa. Y si pasa, vas a poder.

📲 ¿La ansiedad no te da tregua? Escríbenos — link en la bio.

#saludmental #overthinking #ansiedad #bienestaremocional #terapiaonline` },
  { id: 'pt_grid', file: R2 + '2_grid.png', caption:
`No eres lo que tu mente te dice en tus peores días. 🤍

Esa voz que te critica no es la verdad — es el cansancio, el miedo, la herida hablando. Tú eres mucho más.

📲 Escríbenos — link en la bio.

#saludmental #autoestima #bienestaremocional #autocompasion #psicologia` },
  { id: 'pt_cajita', file: R2 + '3_cajita.png', caption:
`No tienes que encajar en una cajita. 🟨

Tu proceso, tu ritmo, tu forma de sentir — nada de eso tiene que caber en lo que esperan de ti. Sé tú.

📲 Escríbenos — link en la bio.

#saludmental #autenticidad #bienestaremocional #sequientueres #psicologia` },
  { id: 'pt_moth', file: R2 + '4_moth.png', caption:
`Está bien no estar bien. 🦋

No siempre tienes que poder, sonreír o “echarle ganas”. Permitirte sentir también es parte de sanar.

📲 Si hoy pesa, escríbenos — link en la bio.

#saludmental #estabiennoestarbien #emociones #bienestaremocional #terapiaonline` },
  { id: 'pt_detector', file: R2 + '5_detector.png', caption:
`“Estoy bien” 🙂… la frase que más repetimos y menos sentimos.

Detrás de cada “todo bien” puede haber alguien aguantando en silencio. Si hoy ese eres tú — no estás solx.

📲 Escríbenos — link en la bio.

#saludmental #saludmentalimporta #bienestaremocional #noestassolo #terapiaonline` },
  { id: 'pt_multitud', file: R2 + '6_identidad.png', caption:
`En medio de la multitud, las prisas y las pantallas… tu salud mental importa. 🤍

No eres un número. Eres una persona que también merece cuidarse por dentro.

📲 Escríbenos — link en la bio.

#saludmental #bienestaremocional #saludmentalimporta #autocuidado #psicologia` },
  { id: 'pt_hazlo', file: R3 + 'HAZLO.png', caption:
`Ten miedo… y hazlo igual. 🤍

Dar el primer paso —pedir ayuda, empezar terapia, hablar de lo que sientes— casi siempre da miedo. Hazlo igual. Del otro lado hay alivio.

📲 Escríbenos por WhatsApp — link en la bio.

#saludmental #valentia #primerpaso #terapiaonline #bienestaremocional` },
];

async function main() {
  if (!miraiSupabase) throw new Error('miraiSupabase null — faltan MIRAI_* en .env');
  const bucket = config.neura.bucket || 'neura';
  const state = await loadState();
  if (!Array.isArray(state.queue)) state.queue = [];
  const stamp = Date.now();

  const nuevos = [];
  for (const p of POSTS) {
    if (!fs.existsSync(p.file)) { console.warn('  ⚠ falta', p.file); continue; }
    const buf = fs.readFileSync(p.file);
    const key = `posts/${p.id}_${stamp}.png`;
    const { error } = await miraiSupabase.storage.from(bucket).upload(key, buf, { contentType: 'image/png', upsert: true });
    if (error) throw new Error('upload ' + p.id + ': ' + error.message);
    const { data } = miraiSupabase.storage.from(bucket).getPublicUrl(key);
    nuevos.push({ id: `${p.id}_${stamp}`, tipo: 'single', images: [data.publicUrl], caption: p.caption, posted: false });
    console.log('✓', p.id);
  }

  const posted = state.queue.filter(q => q.posted);
  const oldPend = state.queue.filter(q => !q.posted);
  const mix = []; let i = 0, j = 0;
  while (i < nuevos.length || j < oldPend.length) {
    if (i < nuevos.length) mix.push(nuevos[i++]);
    if (j < oldPend.length) mix.push(oldPend[j++]);
  }
  state.queue = [...posted, ...mix];
  await saveState(state);
  const pend = state.queue.filter(q => !q.posted).length;
  console.log(`\n✅ ${nuevos.length} trendy encoladas con copy | pendientes totales: ${pend}`);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
