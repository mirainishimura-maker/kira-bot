// NEURA — asistente personal de Mirai (Fase 1 + 2).
// Interpreta instrucciones en lenguaje natural (voz transcrita o texto) que
// Mirai le manda a Mia desde su número personal, y las ejecuta:
//   · registrar un gasto/ingreso   → tabla finances
//   · agregar un recordatorio       → tabla reminders
//   · consultar su agenda           → calendario (sesiones próximas)
//   · nota de sesión de un paciente → tabla sessions (continuidad clínica)
//   · pago de un paciente           → tabla payments (saldos)
//   · recap del grupo GDH           → Claude resume el grupo de trabajo (Fase 2)
//   · reflexión / coaching          → Claude piensa CON ella (Fase 2)
//   · reporte / informe             → Claude le redacta un reporte (Fase 2)
//   · espiritual                    → gratitud / reflexión / oración / lectura (Fase 2)
// Escribe en el Supabase de Mirai (las MISMAS tablas que muestra el panel Neura).
//
// Se usa SOLO detrás del flag config.mia.assistant.enabled (NEURA_ASSISTANT_
// ENABLED=true). Si no reconoce una instrucción clara, devuelve { handled:false }
// y el webhook cae a su comportamiento de siempre (silencio). Nunca intercepta
// comandos "/..." ni notas de lead: eso lo maneja el flujo existente.

import { miraiOpenai, MIA_MODEL } from '../../lib/miraiOpenai.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { listUpcomingAppointments, slotLabel } from './calendar.js';
import { runGdhRecap } from './gdhRecap.js';
import { handleReflexion } from './reflexion.js';
import { handleReporte } from './reporte.js';

const CLASSIFIER_SYSTEM = `Eres el clasificador del asistente personal "Neura" de Mirai (psicóloga).
Mirai te habla en lenguaje natural (a veces por audio transcrito). Entiende qué
quiere y devuelve SOLO un JSON válido, sin ningún texto extra.

Formato exacto:
{
  "intent": "registrar_finanza" | "agregar_recordatorio" | "completar_recordatorio" | "consultar_agenda" | "nota_sesion" | "registrar_pago" | "consultar_gdh" | "reporte" | "espiritual" | "reflexion" | "ninguno",
  "finanza": { "direction": "gasto" | "ingreso", "amount": number, "category": string, "description": string } | null,
  "recordatorio": { "title": string, "remind_at": string | null, "recurrence": "daily" | "weekly" | null } | null,
  "sesion": { "patient_name": string, "summary": string, "homework": string | null, "next_focus": string | null } | null,
  "pago": { "patient_name": string, "amount": number, "method": string | null } | null,
  "espiritual": { "kind": "gratitud" | "reflexion" | "oracion" | "lectura", "content": string } | null,
  "completar": { "title": string } | null
}

Reglas:
- GASTO: "gasté / compré / pagué / me costó ... soles" → registrar_finanza, direction "gasto".
  category de gasto: EXACTAMENTE una de [Antojos, Comida, Transporte, Salud, Casa, Servicios, Ocio, Otros].
- INGRESO general (SIN nombre de persona): "cobré / me depositaron / ingresó ..." → registrar_finanza, direction "ingreso", category "Otros" o "Consulta".
- PAGO DE PACIENTE (menciona un NOMBRE de persona que paga): "me pagó Ana ... / Ana me pagó / Rosa abonó ... soles" → registrar_pago.
  pago.patient_name = el nombre. pago.amount = número en soles. pago.method = "yape"|"plin"|"efectivo"|"transferencia"|null.
- amount: solo el número, en soles (PEN). description: muy breve.
- RECORDATORIO: "recuérdame / acuérdame / anota que tengo que / no me dejes olvidar ..." → agregar_recordatorio.
  title = acción en pocas palabras. remind_at = ISO con offset Lima -05:00 calculado desde la hora que te doy, o null.
  recurrence = "daily" si "cada día/todos los días"; "weekly" si "cada semana"; si no, null.
- COMPLETAR RECORDATORIO: "ya hice / ya tomé / ya está / marca como hecho / completé / ya terminé lo de ..." → completar_recordatorio. completar.title = a qué pendiente se refiere (pocas palabras).
- NOTA DE SESIÓN: "terminé con X / la sesión con X estuvo / trabajé con X / con X vimos ..." → nota_sesion.
  sesion.patient_name = el nombre del paciente. sesion.summary = lo que trabajaron. sesion.homework = tarea que le dejó (o null).
  sesion.next_focus = qué ver la próxima (o null).
- AGENDA: "qué tengo hoy / mi agenda / mis citas / qué sigue" → consultar_agenda.
- GDH: "resúmeme el GDH / qué pasó en el grupo / recap del trabajo / qué se dijo en GDH / resumen del grupo" → consultar_gdh.
- REPORTE: "hazme un reporte de / ármame un informe sobre / redáctame un reporte / necesito un informe de / prepárame un documento sobre ..." → reporte.
- ESPIRITUAL (GUARDAR algo espiritual): "hoy agradezco por / doy gracias por / estoy agradecida por" → espiritual, kind "gratitud". "guarda esta oración / quiero orar por" → kind "oracion". "esta lectura / este versículo" → kind "lectura". "una reflexión espiritual / algo que sentí en mi fe" → kind "reflexion".
  espiritual.content = el contenido en breve, tal como lo dice.
- REFLEXIÓN (que Neura RESPONDA pensando con ella): si Mirai reflexiona, plantea una duda o dilema ("¿debería ir o no?"), te pide tu opinión o una perspectiva, se desahoga, piensa en voz alta, o te hace una pregunta personal → reflexion. (Ojo: agradecer/orar es "espiritual", no "reflexion".)
- Si es solo un "ok / gracias / jaja" o ruido sin intención, intent = "ninguno". Para lo demás que no calce en una acción concreta pero SÍ sea una reflexión o desahogo, usa "reflexion".`;

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

// Resuelve un paciente por nombre (coincidencia parcial). Devuelve { patient }
// o { error } con un mensaje listo para responderle a Mirai.
async function resolvePatient(name) {
  if (!name || !name.trim()) return { error: '¿De qué paciente? Dime el nombre 🙂' };
  const { data } = await miraiSupabase
    .from('patients').select('id, nombre').ilike('nombre', `%${name.trim()}%`).limit(6);
  const rows = data ?? [];
  if (rows.length === 0) return { error: `No encontré a "${name.trim()}" en tus pacientes. ¿Está escrito igual que en Neura?` };
  if (rows.length > 1) return { error: `Tengo varias que coinciden con "${name.trim()}": ${rows.map((r) => r.nombre).join(', ')}. ¿Cuál? (dime el nombre completo)` };
  return { patient: rows[0] };
}

// Punto de entrada. { handled:true, reply } si ejecutó algo; { handled:false } si no.
export async function handleNeuraInstruction(text) {
  if (!miraiOpenai || !miraiSupabase || !text) return { handled: false };

  let parsed;
  try { parsed = await classify(text); }
  catch (err) { console.error('[neura] classify error:', err.message); return { handled: false }; }

  switch (parsed?.intent) {
    case 'registrar_finanza':    return registrarFinanza(parsed.finanza, text);
    case 'agregar_recordatorio': return agregarRecordatorio(parsed.recordatorio, text);
    case 'completar_recordatorio': return completarRecordatorio(parsed.completar);
    case 'consultar_agenda':     return consultarAgenda();
    case 'nota_sesion':          return notaSesion(parsed.sesion, text);
    case 'registrar_pago':       return registrarPago(parsed.pago, text);
    case 'consultar_gdh':        return consultarGdh();
    case 'reporte':              return hacerReporte(text);
    case 'espiritual':           return registrarEspiritual(parsed.espiritual, text);
    case 'reflexion':            return reflexionar(text);
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
  if (error) { console.error('[neura] finanza insert:', error.message); return { handled: true, reply: 'Uy, no pude anotarlo ahora. ¿Me lo repites?' }; }
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
  if (error) { console.error('[neura] reminder insert:', error.message); return { handled: true, reply: 'Uy, no pude guardar el recordatorio. ¿Me lo repites?' }; }
  const cuando = remindAt ? ` para ${slotLabel(remindAt)}` : '';
  const cada = recurrence === 'daily' ? ', cada día' : recurrence === 'weekly' ? ', cada semana' : '';
  return { handled: true, reply: `✅ Anotado: "${r.title.trim()}"${cuando}${cada}.\nLo ves en Neura → Agenda ✦` };
}

async function completarRecordatorio(c) {
  if (!c || !c.title || !c.title.trim()) return { handled: false };
  const { data } = await miraiSupabase
    .from('reminders').select('id, title, recurrence')
    .eq('status', 'pendiente').ilike('title', `%${c.title.trim()}%`).limit(5);
  const rows = data ?? [];
  if (rows.length === 0) return { handled: true, reply: `No encontré un pendiente que diga "${c.title.trim()}" 🤔` };
  const target = rows[0];
  if (target.recurrence) {
    return { handled: true, reply: `👍 Listo, "${target.title}" hecho por hoy. Como es de cada día, sigue en tu lista para mañana 🙂` };
  }
  const { error } = await miraiSupabase.from('reminders')
    .update({ status: 'hecho', done_at: new Date().toISOString() }).eq('id', target.id);
  if (error) { console.error('[neura] completar:', error.message); return { handled: true, reply: 'Uy, no pude marcarlo. ¿Me lo repites?' }; }
  return { handled: true, reply: `✅ Marqué "${target.title}" como hecho. ¡Bien ahí! 💪` };
}

async function consultarAgenda() {
  const r = await listUpcomingAppointments({ hoursAhead: 24 });
  if (!r.ok) return { handled: true, reply: 'No pude leer tu agenda ahora mismo ✦' };
  if (!r.appointments.length) return { handled: true, reply: '🗓️ No tienes sesiones agendadas en las próximas 24h ✦' };
  const lines = r.appointments.map((a) => `• ${a.etiqueta}`).join('\n');
  return { handled: true, reply: `🗓️ Tus próximas sesiones:\n${lines}` };
}

async function notaSesion(s, raw) {
  if (!s || !s.patient_name || !s.summary) return { handled: false };
  const { patient, error } = await resolvePatient(s.patient_name);
  if (error) return { handled: true, reply: error };
  const { error: e } = await miraiSupabase.from('sessions').insert({
    patient_id: patient.id,
    summary: s.summary.trim(),
    homework: s.homework?.trim() || null,
    next_focus: s.next_focus?.trim() || null,
    source: 'voz', raw_text: raw,
  });
  if (e) { console.error('[neura] sesion insert:', e.message); return { handled: true, reply: 'Uy, no pude guardar la nota. ¿Me la repites?' }; }
  const tarea = s.homework ? `\nTarea: ${s.homework.trim()}` : '';
  const prox = s.next_focus ? `\nPróxima: ${s.next_focus.trim()}` : '';
  return { handled: true, reply: `📝 Nota de sesión guardada para ${patient.nombre}.${tarea}${prox}\nLa ves en Neura → Pacientes ✦` };
}

async function registrarPago(p, raw) {
  if (!p || !p.patient_name) return { handled: false };
  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { handled: true, reply: '¿Cuánto te pagó? Dímelo así: "Ana me pagó 105 soles" 🙂' };
  const { patient, error } = await resolvePatient(p.patient_name);
  if (error) return { handled: true, reply: error };
  const { error: e } = await miraiSupabase.from('payments').insert({
    patient_id: patient.id, amount, currency: 'PEN',
    method: p.method?.trim() || null, concept: 'sesión',
    source: 'voz', raw_text: raw,
  });
  if (e) { console.error('[neura] pago insert:', e.message); return { handled: true, reply: 'Uy, no pude registrar el pago. ¿Me lo repites?' }; }
  const met = p.method ? ` (${p.method.trim()})` : '';
  return { handled: true, reply: `💰 Pago registrado: ${money(amount)} de ${patient.nombre}${met}.\nLo ves en Neura → Pacientes ✦` };
}

async function consultarGdh() {
  try {
    const r = await runGdhRecap({ dry: true });
    if (!r.ok) return { handled: true, reply: 'No pude leer el grupo GDH ahora mismo ✦' };
    return { handled: true, reply: r.texto };
  } catch (e) {
    console.error('[neura] gdh:', e.message);
    return { handled: true, reply: 'No pude armar el recap del GDH ahora ✦' };
  }
}

async function hacerReporte(text) {
  const reply = await handleReporte(text);
  if (!reply) return { handled: false };
  return { handled: true, reply };
}

async function registrarEspiritual(e, raw) {
  if (!e || !e.content || !e.content.trim()) return { handled: false };
  const kind = ['gratitud', 'reflexion', 'oracion', 'lectura'].includes(e.kind) ? e.kind : 'gratitud';
  const { error } = await miraiSupabase.from('spiritual').insert({
    kind, content: e.content.trim(), source: 'voz', raw_text: raw,
  });
  if (error) { console.error('[neura] espiritual insert:', error.message); return { handled: true, reply: 'Uy, no pude guardarlo ahora. ¿Me lo repites?' }; }
  const emo = kind === 'gratitud' ? '🙏' : kind === 'oracion' ? '✝️' : kind === 'lectura' ? '📖' : '🌱';
  const label = kind === 'gratitud' ? 'Gratitud' : kind === 'oracion' ? 'Oración' : kind === 'lectura' ? 'Lectura' : 'Reflexión';
  return { handled: true, reply: `${emo} ${label} guardada.\nLa ves en Neura → Espíritu ✦` };
}

async function reflexionar(text) {
  const reply = await handleReflexion(text);
  if (!reply) return { handled: false };
  return { handled: true, reply };
}
