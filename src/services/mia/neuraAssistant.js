// NEURA — asistente personal de Mirai (Fase 1).
// Interpreta instrucciones en lenguaje natural (voz transcrita o texto) que
// Mirai le manda a Mia desde su número personal, y las ejecuta:
//   · registrar un gasto/ingreso   → tabla finances
//   · agregar un recordatorio       → tabla reminders
//   · consultar su agenda           → calendario (sesiones próximas)
// Escribe en el Supabase de Mirai (las MISMAS tablas que muestra el panel Neura).
//
// Se usa SOLO detrás del flag config.mia.assistant.enabled (NEURA_ASSISTANT_
// ENABLED=true). Si no reconoce una instrucción clara, devuelve { handled:false }
// y el webhook cae a su comportamiento de siempre (silencio). Nunca intercepta
// comandos "/..." ni notas de lead: eso lo maneja el flujo existente.

import { miraiOpenai, MIA_MODEL } from '../../lib/miraiOpenai.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { listUpcomingAppointments, slotLabel } from './calendar.js';

const CLASSIFIER_SYSTEM = `Eres el clasificador del asistente personal "Neura" de Mirai (psicóloga).
Mirai te habla en lenguaje natural (a veces por audio transcrito). Entiende qué
quiere y devuelve SOLO un JSON válido, sin ningún texto extra.

Formato exacto:
{
  "intent": "registrar_finanza" | "agregar_recordatorio" | "consultar_agenda" | "ninguno",
  "finanza": { "direction": "gasto" | "ingreso", "amount": number, "category": string, "description": string } | null,
  "recordatorio": { "title": string, "remind_at": string | null, "recurrence": "daily" | "weekly" | null } | null
}

Reglas:
- Gastos: "gasté / compré / pagué / me costó ... soles" → registrar_finanza, direction "gasto".
- Ingresos: "me pagó / cobré / me depositaron / ingresó ..." → registrar_finanza, direction "ingreso".
- category de un gasto: EXACTAMENTE una de [Antojos, Comida, Transporte, Salud, Casa, Servicios, Ocio, Otros].
  (chicle/gaseosa/snack/golosina = Antojos; desayuno/almuerzo/cena/comida = Comida; taxi/pasaje/uber = Transporte;
   medicina/farmacia/consulta médica = Salud). Para un ingreso de una sesión, category = "Consulta".
- amount: solo el número, en soles (PEN). description: muy breve (ej. "chicle", "taxi al consultorio").
- Recordatorios: "recuérdame / acuérdame / anota que tengo que / no me dejes olvidar ..." → agregar_recordatorio.
  title = la acción en pocas palabras (ej. "tomar pastillas", "llamar a la Dra.").
  remind_at = fecha-hora en ISO CON offset de Lima -05:00 (ej. "2026-07-06T16:00:00-05:00"), calculada desde la hora
  actual que te doy. Si no menciona hora, remind_at = null.
  recurrence = "daily" si dice "cada día / todos los días / diario"; "weekly" si "cada semana"; si no, null.
- Agenda: "qué tengo hoy / mi agenda / mis citas / qué sigue / qué me toca" → consultar_agenda.
- Si NO es claramente una de esas instrucciones, intent = "ninguno" y los demás campos en null.`;

async function classify(text) {
  const nowLima = new Date().toLocaleString('sv-SE', { timeZone: 'America/Lima' });
  const resp = await miraiOpenai.chat.completions.create({
    model: MIA_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFIER_SYSTEM },
      { role: 'user', content: `Hora actual en Lima: ${nowLima} (-05:00).\nMirai dice: """${text}"""` },
    ],
  });
  try { return JSON.parse(resp.choices?.[0]?.message?.content ?? '{}'); }
  catch { return { intent: 'ninguno' }; }
}

const money = (n) => `S/ ${Number(Math.abs(n)).toFixed(2)}`;

// Punto de entrada. Devuelve { handled:true, reply } si ejecutó algo, o
// { handled:false } si no era una instrucción reconocida (el webhook sigue).
export async function handleNeuraInstruction(text) {
  if (!miraiOpenai || !miraiSupabase || !text) return { handled: false };

  let parsed;
  try { parsed = await classify(text); }
  catch (err) { console.error('[neura] classify error:', err.message); return { handled: false }; }

  switch (parsed?.intent) {
    case 'registrar_finanza':    return registrarFinanza(parsed.finanza, text);
    case 'agregar_recordatorio': return agregarRecordatorio(parsed.recordatorio, text);
    case 'consultar_agenda':     return consultarAgenda();
    default: return { handled: false };
  }
}

async function registrarFinanza(f, raw) {
  if (!f) return { handled: false };
  const amount = Number(f.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { handled: true, reply: '¿Cuánto fue? Dímelo así: "gasté 8 soles en un café" 🙂' };
  }
  const direction = f.direction === 'ingreso' ? 'ingreso' : 'gasto';
  const category = (f.category || 'Otros').trim();
  const { error } = await miraiSupabase.from('finances').insert({
    direction, amount, currency: 'PEN',
    category, description: f.description?.trim() || null,
    source: 'voz', raw_text: raw,
  });
  if (error) {
    console.error('[neura] finanza insert:', error.message);
    return { handled: true, reply: 'Uy, no pude anotarlo ahora. ¿Me lo repites?' };
  }
  const emoji = direction === 'ingreso' ? '💰' : '💸';
  const verbo = direction === 'ingreso' ? 'Ingreso' : 'Gasto';
  const desc = f.description ? ` (${f.description.trim()})` : '';
  return { handled: true, reply: `${emoji} ${verbo} anotado: ${money(amount)} · ${category}${desc}.\nLo ves en Neura → Finanzas ✦` };
}

async function agregarRecordatorio(r, raw) {
  if (!r || !r.title) return { handled: false };
  const remindAt = r.remind_at || null;
  const recurrence = (r.recurrence === 'daily' || r.recurrence === 'weekly') ? r.recurrence : null;
  const { error } = await miraiSupabase.from('reminders').insert({
    title: r.title.trim(),
    remind_at: remindAt, due_at: remindAt,
    recurrence, status: 'pendiente',
    source: 'voz', raw_text: raw,
  });
  if (error) {
    console.error('[neura] reminder insert:', error.message);
    return { handled: true, reply: 'Uy, no pude guardar el recordatorio. ¿Me lo repites?' };
  }
  const cuando = remindAt ? ` para ${slotLabel(remindAt)}` : '';
  const cada = recurrence === 'daily' ? ', cada día' : recurrence === 'weekly' ? ', cada semana' : '';
  return { handled: true, reply: `✅ Anotado: "${r.title.trim()}"${cuando}${cada}.\nLo ves en Neura → Agenda ✦` };
}

async function consultarAgenda() {
  const r = await listUpcomingAppointments({ hoursAhead: 24 });
  if (!r.ok) return { handled: true, reply: 'No pude leer tu agenda ahora mismo ✦' };
  if (!r.appointments.length) return { handled: true, reply: '🗓️ No tienes sesiones agendadas en las próximas 24h ✦' };
  const lines = r.appointments.map((a) => `• ${a.etiqueta}`).join('\n');
  return { handled: true, reply: `🗓️ Tus próximas sesiones:\n${lines}` };
}
