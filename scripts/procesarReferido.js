// Procesa el referido de Mont Sinai 51951650942 (confirmado por la usuaria):
// lo registra (o reactiva si estaba silenciado) y le manda el saludo de Mia.
import { findPatientByPhone, addPatient, setPatientEstado } from '../src/services/mia/patients.js';
import { sendText } from '../src/lib/evolution.js';
import { rememberMiaSentId } from '../src/services/mia/echoTracker.js';
import { logMessage } from '../src/services/mia/conversations.js';

const SALUDO = [
  'Hola! Te habla Mia, la asistente de la Psic. Mirai Nishimura 🌸',
  'Recibí tu contacto para información de sesión psicológica 🤍',
  '¿La consulta es para ti o para alguien más?',
];
const PHONE = '51951650942';

let patient = await findPatientByPhone(PHONE);
if (patient) {
  await setPatientEstado(PHONE, 'datos_parciales');
  patient = await findPatientByPhone(PHONE);
  console.log(`↻ reactivado: ${patient.nombre} (${PHONE})`);
} else {
  const r = await addPatient({ phone: PHONE, nombre: 'Lead Mont Sinai', etiqueta: 'lead_montsinai' });
  patient = r.patient;
  console.log(`＋ creado: ${PHONE}`);
}
const jid = `${PHONE}@s.whatsapp.net`;
for (const b of SALUDO) {
  const sent = await sendText(jid, b);
  if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  await logMessage({ patientId: patient.id, author: 'mia', content: b, whatsappMessageId: sent?.key?.id ?? null, metadata: { kind: 'auto_intake_saludo' } });
}
console.log(`✓ saludo enviado a ${PHONE}. Cuando responda, Mia hace el triage.`);
