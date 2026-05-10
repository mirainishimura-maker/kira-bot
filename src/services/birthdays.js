// Formateo del mensaje de cumpleaños y orquestación del envío al owner del espacio.

import { callSpaceEndpoint, getSpaceOwner, listSpacesByKind } from './spaces.js';
import { sendPrivate } from '../lib/evolution.js';

// Reglas de formato:
//   - Si edad está vacía, no se imprime "(N años)".
//   - Si grupo está vacío, no se imprime el "· grupo".
//   - Si apoderado coincide con el nombre del participante (caso adulto que
//     se inscribió a sí mismo), se omite la mención al apoderado.
// 1 cumple → bloque destacado de 2-3 líneas.
// >1 cumples → header con conteo + lista compacta de una línea por persona.

function formatBirthdayBlock(b) {
  const nombre = (b.nombre || '').trim();
  const edad   = (b.edad   || '').trim();
  const sede   = (b.sede   || '').trim();
  const grupo  = (b.grupo  || '').trim();
  const apoderado = (b.apoderado || '').trim();

  const lines = [];
  lines.push(edad ? `🎂 Hoy cumple ${nombre} (${edad} años)` : `🎂 Hoy cumple ${nombre}`);
  if (sede) lines.push(grupo ? `📍 ${sede} · ${grupo}` : `📍 ${sede}`);
  if (apoderado && apoderado.toLowerCase() !== nombre.toLowerCase()) {
    lines.push(`👤 Apoderado: ${apoderado}`);
  }
  return lines.join('\n');
}

function formatBirthdayLine(b) {
  const nombre = (b.nombre || '').trim();
  const edad   = (b.edad   || '').trim();
  const sede   = (b.sede   || '').trim();
  const grupo  = (b.grupo  || '').trim();
  const apoderado = (b.apoderado || '').trim();

  let head = nombre;
  if (edad) head += ` (${edad} años)`;

  const sedeBlock = grupo ? `${sede} · ${grupo}` : sede;
  const parts = [head];
  if (sedeBlock) parts.push(sedeBlock);
  if (apoderado && apoderado.toLowerCase() !== nombre.toLowerCase()) {
    parts.push(apoderado);
  }
  return parts.join(' — ');
}

export function formatBirthdayMessage(birthdays) {
  if (!birthdays?.length) return null;
  if (birthdays.length === 1) {
    return formatBirthdayBlock(birthdays[0]) + '\n\nAcuérdate del flyer 🎨';
  }
  const lines = [`🎂 Hoy cumplen ${birthdays.length} personas:`, ''];
  for (const b of birthdays) lines.push('• ' + formatBirthdayLine(b));
  lines.push('', 'Acuérdate del flyer 🎨');
  return lines.join('\n');
}

// Procesa un espacio de cumples: consulta el endpoint, formatea, envía DM al owner.
// Si dry=true, formatea y loguea pero no envía. Devuelve { slug, sent, count, ... }.
async function processBirthdaySpace(space, { dry = false } = {}) {
  const result = { slug: space.slug, sent: false, count: 0 };
  try {
    const owner = await getSpaceOwner(space.id);
    if (!owner?.phone) {
      result.reason = 'sin_owner';
      return result;
    }

    const data = await callSpaceEndpoint(space, 'birthdaysToday');
    const birthdays = data.birthdays ?? [];
    result.count = birthdays.length;

    if (!birthdays.length) {
      result.reason = 'sin_cumples';
      return result;
    }

    const text = formatBirthdayMessage(birthdays);
    result.preview = text;
    result.to      = owner.phone;
    if (dry) {
      console.log(`[birthdays][DRY] ${space.slug} → ${owner.name} (${owner.phone}):\n${text}`);
      return result;
    }
    await sendPrivate(owner.phone, text);
    result.sent = true;
    return result;
  } catch (err) {
    result.reason = 'error';
    result.error  = err.message;
    console.error(`[birthdays] fallo en ${space.slug}:`, err.message);
    return result;
  }
}

// Corre los crons de cumples de todos los espacios birthday_reminders activos.
// Cada espacio se procesa de forma aislada — un fallo no detiene a los otros.
export async function runBirthdayCron({ dry = false } = {}) {
  const spaces = await listSpacesByKind('birthday_reminders');
  console.log(`[birthdays] cron disparado | espacios=${spaces.length}${dry ? ' (DRY)' : ''}`);
  const results = [];
  for (const space of spaces) {
    const r = await processBirthdaySpace(space, { dry });
    results.push(r);
    console.log(`[birthdays] ${r.slug} | sent=${r.sent} count=${r.count}${r.reason ? ' ('+r.reason+')' : ''}`);
  }
  return results;
}
