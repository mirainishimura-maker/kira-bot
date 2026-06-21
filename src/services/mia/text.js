// Helpers de texto compartidos por los módulos automáticos de Mia
// (recontacto, recordatorios): nombre limpio y elección estable de variante.

// Muchos leads tienen el campo "nombre" sucio (capturado de su 1er mensaje:
// "hola 🙋", "Lead pendiente", "paciente", "Mi nombre es Keren"...).
const NOMBRE_BASURA = new Set([
  'hola', 'lead', 'paciente', 'buenas', 'buenos', 'si', 'no', 'mi', 'soy',
  'me', 'la', 'el', 'buen', 'dia', 'tarde', 'noche', 'hello', 'holi',
]);

// Devuelve un primer nombre LIMPIO si parece real; si no, null.
export function nombreValido(nombre) {
  const first = String(nombre || '').trim().split(/\s+/)[0] || '';
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}$/.test(first)) return null; // emojis, números, 1 letra → no
  if (NOMBRE_BASURA.has(first.toLowerCase())) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// Aplica {nombre} si hay nombre válido; si no, quita el placeholder y limpia.
export function aplicarNombre(texto, nombre) {
  const n = nombreValido(nombre);
  if (n) return texto.replaceAll('{nombre}', n);
  return texto
    .replaceAll('Hola {nombre}', 'Hola')
    .replaceAll('{nombre}, ', '')
    .replaceAll(', {nombre}', '')
    .replaceAll('{nombre}', '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([?!.,])/g, '$1')
    .trim();
}

// Elige una variante de forma estable (mismo seed → misma variante), sin
// Math.random (que rompería resúmenes/tests). seed: cualquier string/número.
export function pickVariante(arr, ...seeds) {
  if (arr.length <= 1) return arr[0] || '';
  let h = 7;
  for (const s of seeds) for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 1000000;
  return arr[h % arr.length];
}
