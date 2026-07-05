// Sube el teaser de la guía y lo pone AL FRENTE de la cola (el cron lo publica
// en el próximo slot). No publica directo — respeta el modo auto.
import fs from 'fs';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';
import { loadState, saveState } from '../src/services/neura/publisher.js';

const FILE = 'C:\\tmp\\teaser_guia.png';
const CAPTION = `🌿 GUÍA GRATIS para calmar tu ansiedad

5 ejercicios simples para hacer hoy — cuando la mente no para y el cuerpo se acelera. 🤍

¿La quieres? Escríbenos «GUÍA» por WhatsApp (link en la bio) y te la enviamos al instante. Gratis, es para ti. 💛

Pequeños pasos también cuentan.

#ansiedad #saludmental #guiagratis #bienestaremocional #calma #terapiaonline #saludmentalperu`;

const buf = fs.readFileSync(FILE);
const bucket = config.neura.bucket || 'neura';
const key = `posts/teaser_guia_${Date.now()}.png`;
const up = await miraiSupabase.storage.from(bucket).upload(key, buf, { contentType: 'image/png', upsert: true });
if (up.error) throw new Error('upload: ' + up.error.message);
const { data } = miraiSupabase.storage.from(bucket).getPublicUrl(key);

const state = await loadState();
const item = { id: `teaser_guia_${Date.now()}`, tipo: 'single', images: [data.publicUrl], caption: CAPTION, posted: false };
const posted = state.queue.filter(q => q.posted);
const pend = state.queue.filter(q => !q.posted);
state.queue = [...posted, item, ...pend]; // al frente de los pendientes
await saveState(state);
console.log('✅ teaser AL FRENTE de la cola | pendientes:', state.queue.filter(q => !q.posted).length);
