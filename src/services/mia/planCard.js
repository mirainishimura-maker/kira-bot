// Genera la tarjeta "Plan de tu proceso" personalizada (PNG) y la sube al bucket
// público para que Mia la pueda enviar por WhatsApp. Reproduce el diseño de
// Mirai (verde + crema, Playfair + Montserrat) con SVG → PNG vía resvg-js.
//
// Fuentes embebidas en assets/fonts (instancias estáticas Regular/Bold/Italic),
// para que renderice igual en el server (sin fuentes de sistema).

import { fileURLToPath } from 'url';
import path from 'path';
import { miraiSupabase } from '../../lib/miraiSupabase.js';

// resvg es un módulo NATIVO: lo cargamos de forma diferida para que, si fallara
// en el server, solo se rompa /paquete y no el arranque de todo el bot.

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
const FONT_FILES = [
  'Montserrat-Regular.ttf', 'Montserrat-Bold.ttf',
  'PlayfairDisplay-Bold.ttf', 'PlayfairDisplay-Regular.ttf', 'PlayfairDisplay-Italic.ttf',
].map(f => path.join(FONT_DIR, f));

const BUCKET = process.env.MIA_PUBLIC_BUCKET || 'neura'; // público, mismo Supabase de Mirai

const C = {
  cream:'#F7F1E5', headDark:'#2E5D4E', headLight:'#6E9384', gold:'#C9A23C',
  coral:'#C4623F', coralPill:'#F3DDD3', headingDark:'#213D33', green:'#3C7A5F',
  greenDeep:'#2E6A4F', gray:'#6B7B73', cardBorder:'#E7E0CF', taupe:'#B2A892',
  taupeLight:'#C9BFA8', mint:'#E3EFE8', mintBorder:'#BFD6C9', barGreen:'#214A3B',
  firstBg:'#F8E7DE', white:'#FFFFFF',
};
const SERIF = 'Playfair Display, Georgia, serif';
const SANS  = 'Montserrat, Segoe UI, Arial, sans-serif';

const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const money = (n) => 'S/ ' + (Number.isInteger(n) ? n : n.toFixed(2));

function wrap(text, max) {
  const words = String(text).split(' '); const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { lines.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

// Parte el objetivo en 2 líneas: primera mitad (oscura) / resto (verde).
export function splitObjetivo(objetivo) {
  const w = String(objetivo).trim().split(/\s+/).filter(Boolean);
  if (w.length <= 1) return { titulo1: w.join(' '), titulo2: '' };
  const k = Math.ceil(w.length / 2);
  return { titulo1: w.slice(0, k).join(' '), titulo2: w.slice(k).join(' ') };
}

export function buildCardSVG(o) {
  const W = 1080, H = 1560;
  const sesion = o.precioPaquete, suelta = o.precioSuelta, n = o.nSesiones;
  const total = sesion * n, ahorro = (suelta - sesion) * n;
  const cuotas = [1,2,3,4].map(k => ({ k, val: total / k }));
  const subLines = wrap(`Un acompañamiento estructurado en ${n} sesiones, con una tarifa preferente por iniciar tu paquete y la opción de pagarlo en cómodas cuotas.`, 64);

  const barTitulo = `${o.titulo1} ${o.titulo2}`.trim();
  const barTituloFit = barTitulo.length > 30 ? barTitulo.slice(0, 29).trim() + '…' : barTitulo;
  const eyebrow = `PLAN PARA ${String(o.nombre).toUpperCase()}`;
  const eyebrowW = 56 + eyebrow.length * 15.5;

  const cuotaCards = cuotas.map((c, i) => {
    const cw = 218, gap = 20, x = 70 + i * (cw + gap), y = 1215, h = 180;
    const first = i === 0;
    return `
      <rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="18" fill="${first ? C.firstBg : C.white}" stroke="${first ? C.coral : C.cardBorder}" stroke-width="${first ? 2.5 : 1.5}"/>
      <circle cx="${x + cw/2}" cy="${y + 44}" r="24" fill="none" stroke="${C.gold}" stroke-width="2.5"/>
      <text x="${x + cw/2}" y="${y + 53}" font-family="${SANS}" font-size="26" font-weight="700" fill="${C.headingDark}" text-anchor="middle">${c.k}</text>
      <text x="${x + cw/2}" y="${y + 96}" font-family="${SANS}" font-size="20" fill="${C.gray}" text-anchor="middle">En ${c.k} ${c.k===1?'cuota':'cuotas'}</text>
      <text x="${x + cw/2}" y="${y + 132}" font-family="${SERIF}" font-size="34" font-weight="700" fill="${C.greenDeep}" text-anchor="middle">${money(c.val)}</text>
      <text x="${x + cw/2}" y="${y + 160}" font-family="${SANS}" font-size="15" font-weight="700" fill="${C.coral}" text-anchor="middle" letter-spacing="0.5">${first ? '' : 'cada cuota'}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.headDark}"/><stop offset="1" stop-color="${C.headLight}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="${C.cream}"/>
  <rect x="0" y="0" width="${W}" height="208" fill="url(#hg)"/>
  <rect x="0" y="208" width="${W}" height="7" fill="${C.gold}"/>
  <rect x="0" y="208" width="150" height="7" fill="${C.coral}"/>
  <circle cx="112" cy="104" r="56" fill="none" stroke="#CFE0D6" stroke-width="3"/>
  <text x="112" y="124" font-family="${SERIF}" font-size="56" font-weight="700" fill="${C.cream}" text-anchor="middle">M</text>
  <text x="200" y="74" font-family="${SANS}" font-size="18" font-weight="700" fill="#CFE0D6" letter-spacing="4">PLAN DE TU PROCESO</text>
  <text x="198" y="120" font-family="${SERIF}" font-size="40" font-weight="700" fill="#FFFFFF">Lic. Mirai Nishimura Coronado</text>
  <text x="200" y="156" font-family="${SANS}" font-size="19" fill="#D7E4DC">Psicóloga Colegiada</text>
  <rect x="70" y="256" width="${eyebrowW}" height="50" rx="25" fill="${C.coralPill}"/>
  <text x="98" y="288" font-family="${SANS}" font-size="20" font-weight="700" fill="${C.coral}" letter-spacing="1.5">${esc(eyebrow)}</text>
  <text x="68" y="400" font-family="${SERIF}" font-size="68" font-weight="700" fill="${C.headingDark}">${esc(o.titulo1)}</text>
  <text x="68" y="474" font-family="${SERIF}" font-size="68" font-weight="700" fill="${C.green}">${esc(o.titulo2)}</text>
  ${subLines.map((l,i)=>`<text x="70" y="${528 + i*33}" font-family="${SANS}" font-size="22" fill="${C.gray}">${esc(l)}</text>`).join('')}
  <rect x="70" y="648" width="445" height="285" rx="22" fill="${C.white}" stroke="${C.cardBorder}" stroke-width="1.5"/>
  <text x="110" y="714" font-family="${SANS}" font-size="20" font-weight="700" fill="${C.headingDark}" letter-spacing="1">SESIÓN INDIVIDUAL</text>
  <text x="110" y="816" font-family="${SERIF}" font-size="90" font-weight="700"><tspan fill="${C.taupeLight}" font-size="42">S/</tspan><tspan fill="${C.taupe}">${suelta}</tspan></text>
  <text x="112" y="862" font-family="${SANS}" font-size="20" fill="${C.gray}">Tarifa por sesión suelta</text>
  <rect x="565" y="648" width="445" height="285" rx="22" fill="${C.mint}" stroke="${C.mintBorder}" stroke-width="2"/>
  <rect x="838" y="626" width="140" height="46" rx="23" fill="${C.coral}"/>
  <text x="908" y="656" font-family="${SANS}" font-size="18" font-weight="700" fill="#FFFFFF" text-anchor="middle">Tu tarifa</text>
  <text x="605" y="714" font-family="${SANS}" font-size="20" font-weight="700" fill="${C.greenDeep}" letter-spacing="1">SESIÓN EN TU PAQUETE</text>
  <text x="605" y="816" font-family="${SERIF}" font-size="90" font-weight="700"><tspan fill="${C.greenDeep}" font-size="42">S/</tspan><tspan fill="${C.greenDeep}">${sesion}</tspan><tspan fill="${C.gray}" font-size="26" font-family="${SANS}"> / sesión</tspan></text>
  <rect x="605" y="856" width="335" height="50" rx="12" fill="${C.gold}"/>
  <text x="625" y="889" font-family="${SANS}" font-size="20" font-weight="700" fill="#FFFFFF">Ahorras ${money(ahorro)} en tu proceso</text>
  <rect x="70" y="958" width="940" height="168" rx="22" fill="${C.barGreen}"/>
  <text x="108" y="1022" font-family="${SANS}" font-size="20" font-weight="700" fill="#A9C4B6" letter-spacing="1">PAQUETE DE ${n} SESIONES</text>
  <text x="106" y="1078" font-family="${SERIF}" font-size="33" font-weight="700" fill="#FFFFFF">${esc(barTituloFit)}</text>
  <text x="972" y="1006" font-family="${SANS}" font-size="20" fill="#A9C4B6" text-anchor="end">${n} sesiones × ${money(sesion)}</text>
  <text x="972" y="1082" font-family="${SERIF}" font-size="62" font-weight="700" fill="#FFFFFF" text-anchor="end">${money(total)}</text>
  <text x="70" y="1178" font-family="${SANS}" font-size="30" font-weight="700" fill="${C.headingDark}">Paga a tu ritmo</text>
  <text x="1010" y="1178" font-family="${SANS}" font-size="19" fill="${C.gray}" text-anchor="end">Elige de 1 hasta 4 cuotas</text>
  <line x1="390" y1="1170" x2="740" y2="1170" stroke="${C.cardBorder}" stroke-width="1.5"/>
  ${cuotaCards}
  <line x1="70" y1="1448" x2="1010" y2="1448" stroke="${C.cardBorder}" stroke-width="1.5"/>
  <text x="540" y="1496" font-family="${SERIF}" font-size="26" font-style="italic" fill="${C.green}" text-anchor="middle">"Estoy comprometida con tu proceso y con ofrecerte</text>
  <text x="540" y="1530" font-family="${SERIF}" font-size="26" font-style="italic" fill="${C.green}" text-anchor="middle">un espacio seguro, honesto y transformador."</text>
</svg>`;
}

// Renderiza el SVG a PNG (Buffer) con las fuentes embebidas. Carga resvg al vuelo.
export async function renderCardPng(svg) {
  const { Resvg } = await import('@resvg/resvg-js');
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1080 },
    font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: 'Montserrat' },
  });
  return r.render().asPng();
}

// Genera la tarjeta para un paciente y la sube al bucket público.
// → { ok, url } | { ok:false, error }
export async function generarYSubirPlan({ phone, nombre, nSesiones, objetivo, precioPaquete = 105, precioSuelta = 120 }) {
  if (!miraiSupabase) return { ok: false, error: 'Supabase de Mirai no configurado' };
  try {
    const { titulo1, titulo2 } = splitObjetivo(objetivo);
    const svg = buildCardSVG({ nombre, titulo1, titulo2, nSesiones, precioPaquete, precioSuelta });
    const png = await renderCardPng(svg);
    const key = `mia/planes/${String(phone)}_${nSesiones}s_${Date.now()}.png`;
    const { error } = await miraiSupabase.storage.from(BUCKET).upload(key, png, { contentType: 'image/png', upsert: true });
    if (error) return { ok: false, error: 'upload: ' + error.message };
    const { data } = miraiSupabase.storage.from(BUCKET).getPublicUrl(key);
    return { ok: true, url: data.publicUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
