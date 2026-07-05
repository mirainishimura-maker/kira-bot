// PROTOTIPO — Fábrica de reels de NEURA con IA + Pexels.
// OpenAI escribe el guion (reframe validador) → Pexels da el clip real →
// resvg pone el texto en marca → ffmpeg ensambla el reel 1080x1920.
//
// Uso: node scripts/neuraReelFactory.mjs ["tema opcional"]

import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { Resvg } from '@resvg/resvg-js';
import { miraiOpenai, MIA_MODEL } from '../src/lib/miraiOpenai.js';

const FF = process.env.FFMPEG_PATH || 'C:\\Users\\mirai\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe';
const PEXELS = process.env.PEXELS_API_KEY;
const OUT = 'C:\\tmp\\neura_reels';
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts');
const FONTS = ['Montserrat-Regular','Montserrat-Bold','PlayfairDisplay-Bold','PlayfairDisplay-Regular','PlayfairDisplay-Italic'].map(f=>path.join(FONT_DIR, f+'.ttf'));
const tema = process.argv[2] || '';

// 1) GUION con OpenAI ----------------------------------------------------
async function guion() {
  const sys = `Eres guionista de reels para @neurapsi2026, cuenta de salud mental en Perú (español).
FÓRMULA GANADORA: un REFRAME VALIDADOR corto — nombra una lucha común y la resignifica con cariño.
Ejemplos: "Sentir no te hace débil. Te hace humano." · "No tienes que poder con todo, todo el tiempo." · "A veces no es flojera. Es cansancio emocional."
Devuelve SOLO JSON: {
 "linea1": "gancho corto (2-5 palabras)",
 "linea2": "el reframe (3-7 palabras)",
 "pexels_query": "en INGLÉS, una escena calmada y estética (ej: 'calm rain window','hands holding tea','soft morning light','woman walking nature')",
 "caption": "2-4 líneas cálidas + CTA 'Sígueme para acompañarte 🌿' + 4-5 hashtags Perú de salud mental"
}`;
  const u = tema ? `Tema: ${tema}` : 'Elige un tema de salud mental (ansiedad, descanso, autoexigencia, límites, autocompasión…).';
  const r = await miraiOpenai.chat.completions.create({ model: MIA_MODEL, temperature: 0.8, response_format:{type:'json_object'}, messages:[{role:'system',content:sys},{role:'user',content:u}] });
  return JSON.parse(r.choices[0].message.content);
}

// 2) CLIP de Pexels ------------------------------------------------------
async function clip(query) {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=12&size=medium`;
  const j = await (await fetch(url, { headers:{ Authorization: PEXELS } })).json();
  const vids = (j.videos||[]).filter(v => v.duration >= 8);
  if (!vids.length) throw new Error('Pexels sin resultados para: '+query);
  const v = vids[0];
  const file = (v.video_files||[]).filter(f => f.width < f.height && f.height >= 1200)
    .sort((a,b)=>Math.abs(1080-a.width)-Math.abs(1080-b.width))[0] || v.video_files[0];
  const dest = path.join(OUT, 'clip.mp4');
  const buf = Buffer.from(await (await fetch(file.link)).arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { dest, credit: v.user?.name, id: v.id };
}

// 3) OVERLAY (texto en marca) -------------------------------------------
function overlaySvg({ linea1, linea2 }) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const fit = t => { const n = [...String(t)].length; return n<=14?86 : n<=20?74 : n<=26?62 : 54; };
  // Texto con CONTORNO oscuro (paint-order stroke) → legible sobre cualquier footage.
  const T = (t,y,fill) => `<text x="540" y="${y}" font-family="Playfair Display,serif" font-size="${fit(t)}" font-weight="700" fill="${fill}" stroke="#141210" stroke-width="10" stroke-opacity="0.6" stroke-linejoin="round" paint-order="stroke" text-anchor="middle">${esc(t)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
   <defs>
    <linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0.42"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient>
    <linearGradient id="bot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.62"/></linearGradient>
   </defs>
   <rect x="0" y="0" width="1080" height="1920" fill="#000000" fill-opacity="0.18"/>
   <rect x="0" y="0" width="1080" height="440" fill="url(#top)"/>
   <rect x="0" y="1340" width="1080" height="580" fill="url(#bot)"/>
   <text x="540" y="120" font-family="Montserrat,sans-serif" font-size="30" font-weight="700" fill="#FFFFFF" fill-opacity="0.92" text-anchor="middle" letter-spacing="3">@neurapsi2026</text>
   ${T(linea1, 930, '#FFFFFF')}
   ${T(linea2, 1045, '#EBD9B8')}
   <text x="540" y="1660" font-family="Montserrat,sans-serif" font-size="30" font-weight="700" fill="#FFFFFF" stroke="#141210" stroke-width="5" stroke-opacity="0.5" paint-order="stroke" text-anchor="middle" letter-spacing="1">Síguenos para acompañarte</text>
  </svg>`;
}
function renderOverlay(spec) {
  const png = path.join(OUT, 'overlay.png');
  const r = new Resvg(overlaySvg(spec), { fitTo:{mode:'width',value:1080}, font:{loadSystemFonts:false, fontFiles:FONTS, defaultFontFamily:'Montserrat'} });
  fs.writeFileSync(png, r.render().asPng());
  return png;
}

// 4) ENSAMBLE con ffmpeg -------------------------------------------------
function ensamblar(clipPath, overlayPath, outPath) {
  const vf = "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,trim=0:9,setpts=PTS-STARTPTS,fps=30[bg];" +
             "[1:v]format=rgba,fade=t=in:st=0.2:d=0.7:alpha=1[ov];" +
             "[bg][ov]overlay=0:0,fade=t=in:st=0:d=0.4,fade=t=out:st=8.5:d=0.5,format=yuv420p[v]";
  execFileSync(FF, ['-y','-loglevel','error',
    '-i', clipPath, '-loop','1','-i', overlayPath,
    '-f','lavfi','-t','9','-i','anullsrc=r=44100:cl=stereo',
    '-filter_complex', vf, '-map','[v]','-map','2:a','-t','9',
    '-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','128k',
    outPath], { stdio:'inherit' });
}

async function main() {
  fs.mkdirSync(OUT, { recursive:true });
  if (!PEXELS) throw new Error('falta PEXELS_API_KEY');
  if (!miraiOpenai) throw new Error('falta OpenAI de Mirai');

  console.log('🧠 Guion…');
  const g = await guion();
  console.log('   linea1:', g.linea1, '| linea2:', g.linea2);
  console.log('   pexels:', g.pexels_query);

  console.log('🎬 Clip de Pexels…');
  const c = await clip(g.pexels_query);
  console.log('   clip id', c.id, 'by', c.credit);

  console.log('✍️  Overlay en marca…');
  const ov = renderOverlay(g);

  console.log('🎞️  Ensamblando reel…');
  const out = path.join(OUT, 'muestra_reel.mp4');
  ensamblar(c.dest, ov, out);

  // Frame de preview
  execFileSync(FF, ['-y','-loglevel','error','-ss','2.5','-i',out,'-frames:v','1', path.join(OUT,'muestra_frame.png')]);

  console.log('\n✅ Reel:', out);
  console.log('   Frame:', path.join(OUT,'muestra_frame.png'));
  console.log('\n📝 CAPTION:\n' + g.caption);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
