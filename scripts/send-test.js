// Envía un mensaje de prueba desde la instancia "kira" a un número.
// Uso: node scripts/send-test.js 51904301391 [mensaje opcional]

import { sendPrivate } from '../src/lib/evolution.js';

const phone = process.argv[2];
const text  = process.argv.slice(3).join(' ') || 'Hola, soy KIRA. Test de envío 👋';

if (!phone || !/^\d{10,15}$/.test(phone)) {
  console.error('Uso: node scripts/send-test.js <numero E.164 sin +> [mensaje]');
  console.error('Ejemplo: node scripts/send-test.js 51999999999 "hola"');
  process.exit(1);
}

console.log(`Enviando a ${phone}: "${text}"`);

try {
  const result = await sendPrivate(phone, text);
  console.log('OK. Respuesta de Evolution:');
  console.dir(result, { depth: 5 });
} catch (err) {
  console.error('FALLÓ:', err.message);
  process.exit(1);
}
