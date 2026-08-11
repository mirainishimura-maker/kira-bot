// Rutina fija de Mirai (iglesia + discipulado) — alimenta el brief de las 7am.
//
// Decisión del 10 ago 2026: los cultos semanales NO se avisan uno por uno
// (serían ~4 pings por semana de cosas que ya hace siempre). Se LISTAN en el
// brief matutino, junto a sus sesiones y pendientes, para ver el día completo.
//
// El motor de `reminders` solo sabe de 'daily' y 'weekly', así que lo mensual
// (día 25, 2º domingo, último viernes) se resuelve aquí por calendario.

// ─── Rutina SEMANAL ───────────────────────────────────────────────────
// dow: 0=domingo … 6=sábado. `orden` solo ordena la lista del día.
const SEMANAL = [
  { dow: 5, orden: 1900, icono: '⛪', texto: '7:00 pm — culto de oración' },
  { dow: 6, orden: 1900, icono: '⛪', texto: '7:00 pm — culto de jóvenes' },
  // El culto dominical NO va los domingos de ayuno (ese día el ayuno lo reemplaza).
  { dow: 0, orden: 1030, icono: '⛪', texto: '10:30 am — culto dominical', omitirSiAyuno: true },
  { dow: 0, orden: 1800, icono: '📖', texto: '6:00 pm — escuela de formación cristiana' },
];

// ─── Eventos ÚNICOS con fecha exacta (YYYY-MM-DD) ─────────────────────
const EVENTOS = {
  '2026-08-14': [{ orden: 900,  icono: '📊', texto: 'Publican el puntaje del SERUMS' }],
  '2026-08-16': [{ orden: 800,  icono: '🙏', texto: '8:00 am — ayuno de jóvenes (estás en ofrendas)' }],
  '2026-08-17': [{ orden: 1200, icono: '📖', texto: 'Taller de discipulado' }],
  '2026-08-24': [{ orden: 1200, icono: '📖', texto: 'Taller de discipulado' }],
};

// Rangos de varios días: { desde, hasta, ... } inclusive.
// suprimeRutina: esos días está fuera de la ciudad → no listar los cultos de
// su iglesia local (aparecerían como pendientes que no puede cumplir).
const RANGOS = [
  { desde: '2026-08-27', hasta: '2026-08-30', orden: 700, icono: '🚌', texto: 'Viaje a Huancabamba', suprimeRutina: true },
];

// ¿Esta fecha cae dentro de un rango que suprime la rutina semanal?
function fueraDeCiudad(ymd) {
  return RANGOS.some((r) => r.suprimeRutina && ymd >= r.desde && ymd <= r.hasta);
}

// ─── Helpers de calendario (fecha "pura", sin husos) ──────────────────
function partes(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return { y, m, d, dow: new Date(y, m - 1, d).getDay() };
}
function diasDelMes(y, m) { return new Date(y, m, 0).getDate(); }

// ¿Es la n-ésima vez que cae ese día de la semana en el mes? (2º domingo, etc.)
function ordinalEnMes(d) { return Math.floor((d - 1) / 7) + 1; }

// ¿Es el último <dow> del mes? (para la vigilia del último viernes)
function esUltimoDelMes({ y, m, d }) { return d + 7 > diasDelMes(y, m); }

export function esDomingoDeAyuno(ymd) {
  const p = partes(ymd);
  return p.dow === 0 && ordinalEnMes(p.d) === 2;   // 2º domingo del mes
}

// ─── Actividades de una fecha ─────────────────────────────────────────
// Devuelve [{ icono, texto }] ya ordenado por hora.
export function rutinaDeFecha(ymd) {
  const p = partes(ymd);
  const items = [];

  const deViaje = fueraDeCiudad(ymd);

  // Mensuales. El informe al líder se manda desde donde sea; el ayuno y la
  // vigilia son presenciales en su iglesia → no se listan si está de viaje.
  if (p.d === 25) {
    items.push({ orden: 900, icono: '📋', texto: 'Avisarle a tu líder el informe de discipulado' });
  }
  if (!deViaje && esDomingoDeAyuno(ymd)) {
    items.push({ orden: 900, icono: '🙏', texto: 'Ayuno en la iglesia (2º domingo)' });
  }
  if (!deViaje && p.dow === 5 && esUltimoDelMes(p)) {
    items.push({ orden: 2200, icono: '🕯️', texto: 'Vigilia (último viernes del mes)' });
  }

  // Semanales (salvo si está de viaje esos días)
  const hayAyuno = esDomingoDeAyuno(ymd);
  if (!deViaje) {
    for (const s of SEMANAL) {
      if (s.dow !== p.dow) continue;
      if (s.omitirSiAyuno && hayAyuno) continue;
      items.push({ orden: s.orden, icono: s.icono, texto: s.texto });
    }
  }

  // Únicos y rangos
  for (const e of (EVENTOS[ymd] ?? [])) items.push(e);
  for (const r of RANGOS) {
    if (ymd >= r.desde && ymd <= r.hasta) {
      const dia = r.desde === ymd ? ' (empieza hoy)' : r.hasta === ymd ? ' (último día)' : '';
      items.push({ orden: r.orden, icono: r.icono, texto: `${r.texto}${dia}` });
    }
  }

  return items.sort((a, b) => a.orden - b.orden);
}

// Solo lo que conviene anticipar la víspera: eventos únicos y mensuales.
// Los cultos semanales no se adelantan (ya son parte de su rutina).
export function anticiposDeFecha(ymd) {
  const p = partes(ymd);
  const deViaje = fueraDeCiudad(ymd);
  const items = [];
  if (p.d === 25) items.push({ icono: '📋', texto: 'informe de discipulado a tu líder' });
  if (!deViaje && esDomingoDeAyuno(ymd)) items.push({ icono: '🙏', texto: 'ayuno en la iglesia' });
  if (!deViaje && p.dow === 5 && esUltimoDelMes(p)) items.push({ icono: '🕯️', texto: 'vigilia' });
  for (const e of (EVENTOS[ymd] ?? [])) items.push({ icono: e.icono, texto: e.texto });
  for (const r of RANGOS) {
    if (r.desde === ymd) items.push({ icono: r.icono, texto: `empieza ${r.texto.toLowerCase()}` });
  }
  return items;
}

// Fecha Lima de hoy / mañana en formato YYYY-MM-DD.
export function ymdLima(offsetDias = 0) {
  const base = new Date(Date.now() + offsetDias * 86400000);
  return base.toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}
