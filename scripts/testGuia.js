// Agrega/quita el número personal de Mirai como paciente de prueba, para poder
// probar el flujo de la guía desde su propio celular.
//   node scripts/testGuia.js add     → la agrega como paciente (Mia le responde)
//   node scripts/testGuia.js remove  → la da de alta (Mia deja de responderle)
import { config } from '../src/config.js';
import { addPatient, findPatientByPhone, removePatient } from '../src/services/mia/patients.js';

const action = process.argv[2] || 'add';
const phone = config.mia.personalPhone;
if (!phone) { console.error('No hay MIRAI_PERSONAL_PHONE en .env'); process.exit(1); }

if (action === 'remove') {
  await removePatient(phone);
  console.log('✅ quitada (estado=alta) — Mia ya no le responde a', phone);
  process.exit(0);
}

const existing = await findPatientByPhone(phone);
if (existing && existing.estado !== 'alta') {
  console.log('Ya estaba como paciente:', existing.nombre, '| estado:', existing.estado);
} else {
  const r = await addPatient({ phone, nombre: 'Mirai (prueba guía)', etiqueta: 'test' });
  console.log('✅ agregada como paciente de prueba:', r.patient?.phone, '| estado:', r.patient?.estado);
}
console.log('\nAhora escribí "GUÍA" al WhatsApp de NEURA desde tu celu. Esperá ~30-60s (Mia agrupa mensajes).');
