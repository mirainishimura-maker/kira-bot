// NEURA — asistente personal de Mirai (Fase 1 + 2).
// Interpreta instrucciones en lenguaje natural (voz transcrita o texto) que
// Mirai le manda a Mia desde su número personal, y las ejecuta:
//   · registrar un gasto/ingreso   → tabla finances
//   · agregar un recordatorio       → tabla reminders
//   · consultar su agenda           → calendario (sesiones próximas)
//   · bloquear su horario           → evento 🚫 BLOQUEO en Google Calendar (no disponible)
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
import { listUpcomingAppointments, slotLabel, createHold, rescheduleAppointment, cancelAppointment, getUpcoming, isCalendarEnabled, blockRange, listBlocks, unblockRange } from './calendar.js';
import { runGdhRecap } from './gdhRecap.js';
import { handleReflexion } from './reflexion.js';
import { handleReporte } from './reporte.js';
import { enviarReportePdf } from './reportePdf.js';
import { buildResumenFinanzas } from './resumenFinanzas.js';
import {
  resolveAccount, handleConsultarSaldo, handleAjustarSaldo,
  handleRegistrarDeuda, handleAbonarDeuda, handleConsultarDeudaPersonal,
  handleCrearMeta, handleAportarMeta, handleConsultarMetas,
} from './finanzas.js';

const CLASSIFIER_SYSTEM = `Eres el clasificador del asistente personal "Neura" de Mirai (psicóloga).
Mirai te habla en lenguaje natural (a veces por audio transcrito). Entiende qué
quiere y devuelve SOLO un JSON válido, sin ningún texto extra.

Formato exacto:
{
  "intent": "registrar_finanza" | "agregar_recordatorio" | "completar_recordatorio" | "consultar_agenda" | "nota_sesion" | "registrar_pago" | "consultar_gdh" | "reporte" | "reporte_pdf" | "registrar_cargo" | "consultar_deudas" | "consultar_finanzas" | "consultar_saldo" | "ajustar_saldo" | "registrar_deuda" | "abonar_deuda" | "consultar_deuda_personal" | "crear_meta" | "aportar_meta" | "consultar_metas" | "agendar_cita" | "reprogramar_cita" | "cancelar_cita" | "bloquear_agenda" | "desbloquear_agenda" | "consultar_bloqueos" | "consultar_semana" | "posponer_recordatorio" | "consultar_paciente" | "crear_paquete" | "consultar_paquete" | "guardar_nota" | "consultar_nota" | "registrar_animo" | "registrar_habito" | "agregar_persona" | "contacto_persona" | "espiritual" | "reflexion" | "ayuda" | "buscar" | "ninguno",
  "finanza": { "direction": "gasto" | "ingreso", "amount": number, "category": string, "description": string, "account": string | null } | null,
  "saldo": { "account": string | null, "amount": number | null } | null,
  "deuda": { "counterparty": string, "direction": "debo" | "me_deben" | null, "amount": number | null, "currency": "PEN" | "USD" | null } | null,
  "meta": { "name": string, "target": number | null, "amount": number | null, "currency": "PEN" | "USD" | null } | null,
  "recordatorio": { "title": string, "remind_at": string | null, "recurrence": "daily" | "weekly" | null } | null,
  "sesion": { "patient_name": string, "summary": string, "homework": string | null, "next_focus": string | null } | null,
  "pago": { "patient_name": string, "amount": number, "method": string | null } | null,
  "cargo": { "patient_name": string, "amount": number | null, "sessions": number | null, "concept": string | null } | null,
  "cita": { "patient_name": string, "start_iso": string | null, "new_start_iso": string | null } | null,
  "bloqueo": { "start_iso": string | null, "end_iso": string | null, "motivo": string | null } | null,
  "posponer": { "title": string | null, "remind_at": string | null } | null,
  "consulta_paciente": { "patient_name": string, "aspecto": "sesion" | "saldo" | "cita" | "todo" } | null,
  "paquete": { "patient_name": string, "sessions": number | null } | null,
  "nota": { "content": string, "topic": string | null } | null,
  "busqueda_nota": { "query": string } | null,
  "buscar": { "query": string } | null,
  "animo": { "mood": string, "score": number | null, "note": string | null } | null,
  "habito": { "kind": "agua" | "sueño" | "ejercicio" | "comida" | "descanso" | "disfrute" | "otro", "amount": number | null, "unit": string | null, "note": string | null } | null,
  "persona": { "name": string, "relation": string | null, "phone": string | null, "birthday": string | null } | null,
  "contacto": { "person": string } | null,
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
- AGENDA (HOY / próximo): "qué tengo hoy / mi agenda / mis citas / qué sigue / qué tengo ahora" → consultar_agenda.
- AGENDA DE LA SEMANA: "qué tengo esta semana / cómo viene la semana / mi semana / qué se viene / agenda de la semana / qué tengo estos días" → consultar_semana.
- POSPONER RECORDATORIO (mover un pendiente que ya existe a otra hora): "posponlo / muévelo / cámbialo para / mejor recuérdame eso <cuándo> / pásalo para mañana / recuérdame eso mejor a las ..." → posponer_recordatorio. posponer.title = a qué pendiente se refiere (o null si dice "eso/lo último"); posponer.remind_at = NUEVO ISO con offset Lima -05:00. (Ojo: si es un pendiente NUEVO, es agregar_recordatorio; posponer es mover uno existente.)
- GDH: "resúmeme el GDH / qué pasó en el grupo / recap del trabajo / qué se dijo en GDH / resumen del grupo" → consultar_gdh.
- REPORTE: "hazme un reporte de / ármame un informe sobre / redáctame un reporte / necesito un informe de / prepárame un documento sobre ..." → reporte.
- REPORTE PDF: "mándalo en PDF / pásalo a PDF / hazme el documento / quiero el reporte en PDF / mándame el documento / en PDF ..." (se refiere al reporte que se acaba de armar) → reporte_pdf.
- CARGO / DEUDA DE PACIENTE (lo que un paciente DEBE, NO lo que pagó): "X me debe 105 / cóbrale a X / X quedó debiendo / ponle una sesión pendiente a X / X tiene 2 sesiones sin pagar" → registrar_cargo. cargo.patient_name = nombre. cargo.amount = soles si lo dice, si no null. cargo.sessions = número de sesiones si lo menciona (o null). cargo.concept = breve (o null). (Ojo: "me pagó / me abonó" es registrar_pago, no cargo.)
- CONSULTAR DEUDAS: "quién me debe / quiénes están debiendo / saldos / cuánto me deben / quién tiene pendiente de pago" → consultar_deudas.
- CONSULTAR FINANZAS: "en qué se me fue la plata / resumen de mis finanzas / cuánto gasté esta semana / mis gastos / cómo voy de plata" → consultar_finanzas.
- MOVIMIENTO CON CUENTA: en registrar_finanza, si menciona una cuenta o medio ("con el BBVA / del BCP / en efectivo / con Yape / con la tarjeta Saga / con el crédito Yape"), pon finanza.account = el nombre de la cuenta (BCP, BBVA, Yape, Efectivo, Saga Falabella, Crédito Yape). Si no la menciona, account = null.
- CONSULTAR SALDO: "cuánto tengo en el BBVA / cuánto hay en el BCP / cuánto tengo en total / mis cuentas / cuánta plata tengo" → consultar_saldo. saldo.account = la cuenta, o null si pregunta por el total/todas.
- AJUSTAR SALDO (DECLARA cuánto hay en una cuenta, no es un gasto/ingreso): "tengo 50 en el BBVA / mi saldo del BCP es 6 / pon el efectivo en 20 / en el Yape tengo 100" → ajustar_saldo. saldo.account = cuenta; saldo.amount = el monto.
- REGISTRAR DEUDA/PRÉSTAMO PERSONAL (NO un paciente): "le debo 500 a César / César me prestó 500 / le presté 200 a mi hermano / me prestaron 1000" → registrar_deuda. deuda.counterparty = la persona; deuda.amount = monto; deuda.currency = "USD" si son dólares, si no "PEN".
  deuda.direction — LEE CON CUIDADO quién le prestó a quién:
    · "debo" = MIRAI DEBE (le prestaron a ELLA): "me prestó", "me prestaron", "le debo a X", "quedé debiéndole a X", "X me hizo un préstamo".
    · "me_deben" = a MIRAI le deben (ELLA prestó): "le presté a X", "presté plata a X", "X me debe porque le presté", "me tienen que devolver".
  (Ojo: un PACIENTE que debe por sesiones es registrar_cargo, no registrar_deuda.)
- ABONAR/PAGAR DEUDA: "le aboné 100 a César / le pagué 50 a Julio / me devolvió 30 mi hermano / aboné a la deuda de X" → abonar_deuda. deuda.counterparty; deuda.amount; deuda.direction si se distingue.
- CONSULTAR DEUDA PERSONAL: "cuánto le debo a César / a quién le debo / cuánto debo / cuánto me deben de lo que presté / mis préstamos / mis deudas" → consultar_deuda_personal. deuda.counterparty = persona si la nombra, si no null. (Ojo: "quién me debe" de PACIENTES es consultar_deudas.)
- CREAR META DE AHORRO: "quiero ahorrar 5000 para Georgia / meta para SERUMS / nueva meta viaje a X (necesito 3000)" → crear_meta. meta.name = nombre de la meta; meta.target = monto objetivo si lo da (o null); meta.currency.
- APORTAR A META: "ahorré 100 para Georgia / mete 50 a la meta de SERUMS / guardé 200 para el viaje / aporté 80 al fondo de emergencia" → aportar_meta. meta.name = a qué meta; meta.amount = cuánto aporta.
- CONSULTAR METAS: "cómo van mis metas / cuánto llevo para Georgia / cuánto me falta para X / mis metas de ahorro" → consultar_metas.
- AGENDAR CITA: "agéndame a X el <día/hora> / ponle cita a X / resérvale a X / cítala a X ..." → agendar_cita. cita.patient_name = nombre del paciente; cita.start_iso = ISO con offset Lima -05:00 calculado desde el día/hora que da.
- REPROGRAMAR CITA: "cambia/mueve/reprograma la cita de X al <día/hora>" → reprogramar_cita. cita.patient_name; cita.new_start_iso = ISO -05:00.
- CANCELAR CITA: "cancela/anula la cita de X" → cancelar_cita. cita.patient_name.
- BLOQUEAR AGENDA (Mirai se marca NO DISPONIBLE en SU horario — NO es un paciente, NO es un recordatorio): "bloquéame / bloquea mi agenda / bloquear horario / no estoy disponible / no me pongas citas / no ofrezcas turnos / tápame / ocúpame / márcame ocupada / cierra mi agenda / estaré fuera / de viaje / no atiendo el <día/hora>" → bloquear_agenda.
  bloqueo.start_iso = ISO con offset Lima -05:00 (día + hora de inicio). bloqueo.end_iso = ISO -05:00 del fin SOLO si da un fin explícito o un rango ("de 5 a 6pm", "hasta el viernes", "de las 5 a las 7"); si no da fin, null. bloqueo.motivo = el motivo en breve, o null.
  DIFERENCIA CLAVE: "recuérdame X" es agregar_recordatorio; "agéndame/cítala a X" con un PACIENTE es agendar_cita; bloquear_agenda es cuando Mirai tapa SU propio tiempo para que Mia NO ofrezca esos turnos.
- QUITAR BLOQUEO: "quita/saca el bloqueo de <día/hora> / desbloquea <...> / vuelve a abrir mi agenda el <...> / ya estoy disponible el <...>" → desbloquear_agenda. bloqueo.start_iso / bloqueo.end_iso igual que en bloquear_agenda.
- CONSULTAR BLOQUEOS: "qué tengo bloqueado / muéstrame mis bloqueos / cuándo no estoy disponible / mis bloqueos" → consultar_bloqueos.
- CONSULTAR PACIENTE: "qué trabajé/vi con X / cómo va X / cuánto me debe X / cuándo veo a X / cuándo es la cita de X" → consultar_paciente. consulta_paciente.patient_name; aspecto = "sesion" | "saldo" | "cita" | "todo".
- CREAR PAQUETE DE SESIONES: "X compró un paquete de 6 / véndele un paquete de 4 a X / arma un paquete de 6 sesiones para X / X se llevó el paquete de 4" → crear_paquete. paquete.patient_name = paciente; paquete.sessions = número de sesiones del paquete (4, 6, u otro; si no lo dice, null).
- CONSULTAR PAQUETE: "cuántas sesiones le quedan a X / cómo va el paquete de X / le quedan sesiones a X / el paquete de X" → consultar_paquete. paquete.patient_name = paciente.
- GUARDAR NOTA: "apunta que / anota que / recuerda que <DATO> / guarda que / agrega X a la lista de Y" (un DATO o ítem SIN hora ni acción por hacer; NO es recordatorio) → guardar_nota. nota.content = el dato tal cual; nota.topic = tema en 1-2 palabras (ej "wifi", "lista de compras").
- CONSULTAR NOTA: "qué anoté de X / cuál era el X / qué tengo en la lista de Y / dime el dato de X" → consultar_nota. busqueda_nota.query = a qué se refiere (pocas palabras).
- BUSCAR (global, en todo Neura): "busca X / búscame todo lo de X / encuentra Y / ¿dónde está Z? / qué tengo sobre W" → buscar. buscar.query = qué busca.
- CHECK-IN DE ÁNIMO: "hoy me siento X / estoy X / me siento <emoción> / ando <estado>" (Mirai DECLARA su estado emocional, no pide consejo) → registrar_animo. animo.mood = la emoción en 1-2 palabras; animo.score = 1 (muy mal) a 5 (muy bien) si se infiere, si no null; animo.note = detalle si lo da. (Si PIDE perspectiva o ayuda a decidir → reflexion, no animo.)
- SALUD / HÁBITO / DESCANSO: "tomé X de agua / dormí X horas / hice ejercicio (X min) / comí ... / caminé / hoy descansé / vi una peli / salí a pasear / me di un gusto" → registrar_habito. habito.kind ∈ [agua, sueño, ejercicio, comida, descanso, disfrute, otro]; amount+unit si da cantidad (ej 2 "litros", 6 "horas", 30 "min"); note = detalle.
- AGREGAR PERSONA: "agrega a mi mamá / registra a mi amiga X / anota a mi pareja Y (cumple el <fecha>, su número es ...)" → agregar_persona. persona.name = nombre; persona.relation = vínculo (mamá, pareja, amiga, hermano...); persona.phone si lo da; persona.birthday = ISO YYYY-MM-DD si la da.
- CONTACTO YA HECHO (pasado): "llamé a mi mamá / hablé con X / le escribí a Y / vi a Z / almorcé con W" → contacto_persona. contacto.person = a quién. (Ojo: "recuérdame llamar a X" es recordatorio; "agrega a X" es agregar_persona.)
- ESPIRITUAL (GUARDAR algo espiritual): "hoy agradezco por / doy gracias por / estoy agradecida por" → espiritual, kind "gratitud". "guarda esta oración / quiero orar por" → kind "oracion". "esta lectura / este versículo" → kind "lectura". "una reflexión espiritual / algo que sentí en mi fe" → kind "reflexion".
  espiritual.content = el contenido en breve, tal como lo dice.
- REFLEXIÓN (que Neura RESPONDA pensando con ella): si Mirai reflexiona, plantea una duda o dilema ("¿debería ir o no?"), te pide tu opinión o una perspectiva, se desahoga, piensa en voz alta, o te hace una pregunta personal → reflexion. (Ojo: agradecer/orar es "espiritual", no "reflexion".)
- AYUDA: "¿qué puedes hacer? / ayuda / en qué me ayudas / qué sabes hacer / cómo te uso / opciones" → ayuda.
- Si es solo un "ok / gracias / jaja / 👍" o puro ruido sin intención, intent = "ninguno". CUALQUIER otra cosa que Mirai te diga —una pregunta, un comentario, algo que te cuenta, una duda, pensar en voz alta, o algo que simplemente no calza en las acciones de arriba— usa "reflexion", para que Mia SIEMPRE le responda con calidez. Nunca la dejes sin respuesta.`;

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
    .from('patients').select('id, nombre, phone').ilike('nombre', `%${name.trim()}%`).limit(6);
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
    case 'registrar_cargo':      return registrarCargo(parsed.cargo, text);
    case 'consultar_deudas':     return consultarDeudas();
    case 'consultar_finanzas':   return consultarFinanzas();
    case 'consultar_saldo':      return handleConsultarSaldo(parsed.saldo);
    case 'ajustar_saldo':        return handleAjustarSaldo(parsed.saldo);
    case 'registrar_deuda':      return handleRegistrarDeuda(parsed.deuda, text);
    case 'abonar_deuda':         return handleAbonarDeuda(parsed.deuda, text);
    case 'consultar_deuda_personal': return handleConsultarDeudaPersonal(parsed.deuda);
    case 'crear_meta':           return handleCrearMeta(parsed.meta, text);
    case 'aportar_meta':         return handleAportarMeta(parsed.meta, text);
    case 'consultar_metas':      return handleConsultarMetas();
    case 'agendar_cita':         return agendarCita(parsed.cita);
    case 'reprogramar_cita':     return reprogramarCita(parsed.cita);
    case 'cancelar_cita':        return cancelarCita(parsed.cita);
    case 'bloquear_agenda':      return bloquearAgenda(parsed.bloqueo);
    case 'desbloquear_agenda':   return desbloquearAgenda(parsed.bloqueo);
    case 'consultar_bloqueos':   return consultarBloqueos();
    case 'consultar_semana':     return consultarSemana();
    case 'posponer_recordatorio': return posponerRecordatorio(parsed.posponer);
    case 'consultar_paciente':   return consultarPaciente(parsed.consulta_paciente);
    case 'crear_paquete':        return crearPaquete(parsed.paquete);
    case 'consultar_paquete':    return consultarPaquete(parsed.paquete);
    case 'guardar_nota':         return guardarNota(parsed.nota, text);
    case 'consultar_nota':       return consultarNota(parsed.busqueda_nota);
    case 'buscar':               return buscarGlobal(parsed.buscar);
    case 'registrar_animo':      return registrarAnimo(parsed.animo, text);
    case 'registrar_habito':     return registrarHabito(parsed.habito, text);
    case 'agregar_persona':      return agregarPersona(parsed.persona, text);
    case 'contacto_persona':     return contactoPersona(parsed.contacto);
    case 'consultar_gdh':        return consultarGdh();
    case 'reporte':              return hacerReporte(text);
    case 'reporte_pdf':          return enviarReportePdf();
    case 'espiritual':           return registrarEspiritual(parsed.espiritual, text);
    case 'reflexion':            return reflexionar(text);
    case 'ayuda':                return ayudaMenu();
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
  // Cuenta opcional ("...con el BBVA / en efectivo"): la ligamos si la reconocemos.
  let accountId = null, accountName = null;
  if (f.account && f.account.trim()) {
    const r = await resolveAccount(f.account);
    if (r.account) { accountId = r.account.id; accountName = r.account.name; }
  }
  const { error } = await miraiSupabase.from('finances').insert({
    direction, amount, currency: 'PEN',
    category, description: f.description?.trim() || null,
    account_id: accountId,
    source: 'voz', raw_text: raw,
  });
  if (error) { console.error('[neura] finanza insert:', error.message); return { handled: true, reply: 'Uy, no pude anotarlo ahora. ¿Me lo repites?' }; }
  const emoji = direction === 'ingreso' ? '💰' : '💸';
  const verbo = direction === 'ingreso' ? 'Ingreso' : 'Gasto';
  const desc = f.description ? ` (${f.description.trim()})` : '';
  const cuenta = accountName ? ` · ${accountName}` : '';
  return { handled: true, reply: `${emoji} ${verbo} anotado: ${money(amount)} · ${category}${desc}${cuenta}.\nLo ves en Neura → Finanzas ✦` };
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

// Vista de los próximos 7 días: citas + bloqueos, ordenados por fecha/hora.
async function consultarSemana() {
  const r = await listUpcomingAppointments({ hoursAhead: 168 });
  if (!r.ok) return { handled: true, reply: 'No pude leer tu agenda ahora mismo ✦' };
  const limite = Date.now() + 7 * 86400000;
  const items = r.appointments.map((a) => ({ iso: a.inicio_iso, texto: `🌿 ${a.etiqueta}` }));
  if (isCalendarEnabled()) {
    try {
      const b = await listBlocks();
      if (b.ok) for (const x of b.blocks) {
        if (new Date(x.inicio_iso).getTime() <= limite) {
          items.push({ iso: x.inicio_iso, texto: `🚫 ${x.inicio_label} — ${x.motivo || 'No disponible'}` });
        }
      }
    } catch (e) { console.error('[neura] semana bloqueos:', e.message); }
  }
  if (!items.length) return { handled: true, reply: '🗓️ Tu semana está libre — sin citas ni bloqueos en los próximos 7 días ✦' };
  items.sort((a, b) => new Date(a.iso) - new Date(b.iso));
  const lines = items.slice(0, 20).map((i) => `• ${i.texto}`).join('\n');
  return { handled: true, reply: `🗓️ *Tu semana:*\n${lines}` };
}

// Busca un pendiente pendiente por título tolerando relleno ("lo de las …").
// Sin título → el más reciente. Con título → limpia stopwords y, si no calza,
// reintenta con la palabra más larga (la clave, ej. "pastillas").
const STOP_TITULO = new Set(['lo', 'de', 'la', 'las', 'el', 'los', 'mi', 'mis', 'eso', 'esa', 'ese', 'cosa', 'del', 'un', 'una', 'que', 'a']);
async function buscarPendiente(rawTitle) {
  const base = () => miraiSupabase.from('reminders').select('id, title').eq('status', 'pendiente').order('created_at', { ascending: false });
  if (!rawTitle) { const { data } = await base().limit(5); return data ?? []; }
  const words = rawTitle.toLowerCase().split(/\s+/).filter((w) => w && !STOP_TITULO.has(w));
  const clean = words.join(' ') || rawTitle;
  let { data } = await base().ilike('title', `%${clean}%`).limit(5);
  if ((!data || !data.length) && words.length) {
    const longest = words.slice().sort((a, b) => b.length - a.length)[0];
    ({ data } = await base().ilike('title', `%${longest}%`).limit(5));
  }
  return data ?? [];
}

// Mueve un pendiente EXISTENTE a otra fecha/hora (posponer).
async function posponerRecordatorio(p) {
  const nuevo = p?.remind_at || null;
  if (!nuevo) return { handled: true, reply: '¿Para cuándo lo muevo? Dime el nuevo día y hora 🙂' };
  const rows = await buscarPendiente((p?.title || '').trim());
  if (!rows.length) {
    return { handled: true, reply: p?.title ? `No encontré un pendiente que diga "${p.title.trim()}" 🤔` : 'No tienes pendientes para posponer 🙂' };
  }
  const target = rows[0];
  const { error } = await miraiSupabase.from('reminders').update({ remind_at: nuevo, due_at: nuevo }).eq('id', target.id);
  if (error) { console.error('[neura] posponer:', error.message); return { handled: true, reply: 'Uy, no pude moverlo. ¿Me lo repites?' }; }
  return { handled: true, reply: `🔁 Listo, moví "${target.title}" para ${slotLabel(nuevo)}.\nLo ves en Neura → Agenda ✦` };
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
  const paqLinea = await descontarPaquete(patient.id); // si tiene paquete activo, descuenta 1
  return { handled: true, reply: `📝 Nota de sesión guardada para ${patient.nombre}.${tarea}${prox}${paqLinea}\nLa ves en Neura → Pacientes ✦` };
}

// ---- Paquetes de sesiones (4/6 a S/105 c/u) ----
const PRECIO_SESION = 105;

async function paqueteActivo(patientId) {
  const { data } = await miraiSupabase
    .from('packages').select('*').eq('patient_id', patientId).eq('status', 'activo')
    .order('purchased_at', { ascending: false }).limit(1);
  return data?.[0] || null;
}

// Descuenta una sesión del paquete activo (si hay). Devuelve una línea para el
// mensaje ("🎟️ Le quedan X del paquete") o '' si no tiene paquete.
async function descontarPaquete(patientId) {
  const paq = await paqueteActivo(patientId);
  if (!paq) return '';
  const used = Number(paq.used_sessions || 0) + 1;
  const total = Number(paq.total_sessions || 0);
  const patch = { used_sessions: used };
  if (used >= total) patch.status = 'completado';
  await miraiSupabase.from('packages').update(patch).eq('id', paq.id);
  const quedan = Math.max(0, total - used);
  return quedan > 0
    ? `\n🎟️ Le quedan ${quedan} de ${total} del paquete.`
    : `\n🎟️ Con esta se completó el paquete de ${total} sesiones.`;
}

async function crearPaquete(p) {
  if (!p || !p.patient_name) return { handled: false };
  const { patient, error } = await resolvePatient(p.patient_name);
  if (error) return { handled: true, reply: error };
  let total = Number(p.sessions);
  if (!Number.isFinite(total) || total <= 0) total = 4;
  const price = total * PRECIO_SESION;
  const { error: e } = await miraiSupabase.from('packages').insert({
    patient_id: patient.id, total_sessions: total, used_sessions: 0, price, status: 'activo',
  });
  if (e) { console.error('[neura] paquete insert:', e.message); return { handled: true, reply: 'Uy, no pude crear el paquete. ¿Me lo repites?' }; }
  // El paquete implica un cargo por su precio (se paga en una o varias cuotas).
  await miraiSupabase.from('charges').insert({
    patient_id: patient.id, amount: price, currency: 'PEN', concept: `paquete ${total} sesiones`, source: 'voz', raw_text: `paquete ${total}`,
  });
  return { handled: true, reply: `🎟️ Paquete de *${total} sesiones* para ${patient.nombre} · ${money(price)}.\nLe registré el cargo (págalo en cuotas si quiere). Cada sesión que anotes va descontando ✦` };
}

async function consultarPaquete(p) {
  if (!p || !p.patient_name) return { handled: false };
  const { patient, error } = await resolvePatient(p.patient_name);
  if (error) return { handled: true, reply: error };
  const paq = await paqueteActivo(patient.id);
  if (!paq) return { handled: true, reply: `${patient.nombre} no tiene un paquete activo ahora mismo. Puedes crearle uno: "${patient.nombre} compró un paquete de 6" 🙂` };
  const total = Number(paq.total_sessions || 0);
  const used = Number(paq.used_sessions || 0);
  const quedan = Math.max(0, total - used);
  return { handled: true, reply: `🎟️ *${patient.nombre}* — paquete de ${total} sesiones.\nUsadas: ${used} · *Quedan: ${quedan}* ✦` };
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
  const saldo = await balancePaciente(patient.id);
  const saldoLine = saldo > 0.5 ? `\nAún debe: *${money(saldo)}*.` : saldo < -0.5 ? '\n(quedó a favor)' : '\n¡Al día! ✅';
  return { handled: true, reply: `💰 Pago registrado: ${money(amount)} de ${patient.nombre}${met}.${saldoLine}\nLo ves en Neura → Pacientes ✦` };
}

// Saldo de un paciente = SUMA(cargos) − SUMA(pagos).
async function balancePaciente(patientId) {
  const [ch, pa] = await Promise.all([
    miraiSupabase.from('charges').select('amount').eq('patient_id', patientId),
    miraiSupabase.from('payments').select('amount').eq('patient_id', patientId),
  ]);
  const sum = (r) => (r.data ?? []).reduce((a, x) => a + Number(x.amount || 0), 0);
  return sum(ch) - sum(pa);
}

async function registrarCargo(c, raw) {
  if (!c || !c.patient_name) return { handled: false };
  const { patient, error } = await resolvePatient(c.patient_name);
  if (error) return { handled: true, reply: error };
  const DEFAULT_RATE = 105;
  let amount = Number(c.amount);
  const sessions = Number(c.sessions);
  let note = '';
  if (!Number.isFinite(amount) || amount <= 0) {
    if (Number.isFinite(sessions) && sessions > 0) { amount = sessions * DEFAULT_RATE; note = ` (${sessions} × ${money(DEFAULT_RATE)})`; }
    else return { handled: true, reply: `¿Cuánto le cargo a ${patient.nombre}? Dime por ejemplo "${patient.nombre} me debe 105" 🙂` };
  }
  const { error: e } = await miraiSupabase.from('charges').insert({
    patient_id: patient.id, amount, currency: 'PEN',
    concept: c.concept?.trim() || 'sesión', source: 'voz', raw_text: raw,
  });
  if (e) { console.error('[neura] cargo insert:', e.message); return { handled: true, reply: 'Uy, no pude registrar el cargo. ¿Me lo repites?' }; }
  const saldo = await balancePaciente(patient.id);
  return { handled: true, reply: `🧾 Anotado: ${patient.nombre} debe ${money(amount)}${note}.\nSaldo actual: *${money(saldo)}*.\nLo ves en Neura → Pacientes ✦` };
}

async function consultarDeudas() {
  const [pRes, cRes, payRes] = await Promise.all([
    miraiSupabase.from('patients').select('id, nombre').neq('phone', '51904301391'),
    miraiSupabase.from('charges').select('patient_id, amount'),
    miraiSupabase.from('payments').select('patient_id, amount'),
  ]);
  const bal = new Map();
  for (const c of cRes.data ?? []) bal.set(c.patient_id, (bal.get(c.patient_id) || 0) + Number(c.amount || 0));
  for (const p of payRes.data ?? []) bal.set(p.patient_id, (bal.get(p.patient_id) || 0) - Number(p.amount || 0));
  const nameOf = new Map((pRes.data ?? []).map((p) => [p.id, p.nombre]));
  const deudores = [...bal.entries()].filter(([id, v]) => v > 0.5 && nameOf.has(id)).sort((a, b) => b[1] - a[1]);
  if (!deudores.length) return { handled: true, reply: '✅ ¡Nadie te debe! Todos tus pacientes están al día 🎉' };
  const lines = deudores.map(([id, v]) => `• ${nameOf.get(id)}: *${money(v)}*`).join('\n');
  const total = deudores.reduce((a, [, v]) => a + v, 0);
  return { handled: true, reply: `🧾 *Quién te debe:*\n${lines}\n\nTotal por cobrar: *${money(total)}* ✦` };
}

async function consultarFinanzas() {
  try {
    const texto = await buildResumenFinanzas({ period: 'semana' });
    return { handled: true, reply: texto, speak: isCalculo(texto) };
  } catch (e) {
    console.error('[neura] finanzas:', e.message);
    return { handled: true, reply: 'No pude armar tu resumen de finanzas ahora ✦' };
  }
}

// ---- Citas: agendar / reprogramar / cancelar (Google Calendar vía Apps Script) ----
async function agendarCita(c) {
  if (!c || !c.patient_name) return { handled: false };
  if (!isCalendarEnabled()) return { handled: true, reply: 'No tengo tu calendario conectado ahora mismo ✦' };
  if (!c.start_iso) return { handled: true, reply: '¿Para cuándo? Dime el día y la hora 🙂' };
  const { patient, error } = await resolvePatient(c.patient_name);
  if (error) return { handled: true, reply: error };
  if (!patient.phone) return { handled: true, reply: `No tengo el número de ${patient.nombre} para agendar. Agrégalo en su ficha y lo hacemos ✦` };
  const r = await createHold({ phone: patient.phone, startISO: c.start_iso, nombre: patient.nombre, tentative: false });
  if (!r.ok) return { handled: true, reply: `No pude agendar (${r.error || 'error'}). ¿Probamos otra hora?` };
  return { handled: true, reply: `🗓️ Listo, agendé a ${patient.nombre} para ${r.etiqueta}.\nLo ves en Neura → Agenda ✦` };
}

async function reprogramarCita(c) {
  if (!c || !c.patient_name) return { handled: false };
  if (!isCalendarEnabled()) return { handled: true, reply: 'No tengo tu calendario conectado ahora mismo ✦' };
  if (!c.new_start_iso) return { handled: true, reply: '¿Para cuándo la muevo? Dime el nuevo día y hora 🙂' };
  const { patient, error } = await resolvePatient(c.patient_name);
  if (error) return { handled: true, reply: error };
  if (!patient.phone) return { handled: true, reply: `No tengo el número de ${patient.nombre} para mover su cita.` };
  const r = await rescheduleAppointment({ phone: patient.phone, newStartISO: c.new_start_iso });
  if (!r.ok) return { handled: true, reply: `No pude reprogramar (${r.error || 'no encontré su cita'}).` };
  return { handled: true, reply: `🔁 Moví la cita de ${patient.nombre} a ${r.etiqueta} ✦` };
}

async function cancelarCita(c) {
  if (!c || !c.patient_name) return { handled: false };
  if (!isCalendarEnabled()) return { handled: true, reply: 'No tengo tu calendario conectado ahora mismo ✦' };
  const { patient, error } = await resolvePatient(c.patient_name);
  if (error) return { handled: true, reply: error };
  if (!patient.phone) return { handled: true, reply: `No tengo el número de ${patient.nombre}.` };
  const r = await cancelAppointment({ phone: patient.phone });
  if (!r.ok) return { handled: true, reply: `No pude cancelar (${r.error || 'no encontré su cita'}).` };
  return { handled: true, reply: `🚫 Cancelé la cita de ${patient.nombre}${r.etiqueta ? ` (${r.etiqueta})` : ''} ✦` };
}

// ---- Bloqueos de agenda: Mirai se marca NO DISPONIBLE (Google Calendar vía Apps Script) ----
// Igual que el comando /bloquear, pero por voz/texto natural. Sin fin explícito,
// el bloqueo va de esa hora al fin del día (misma convención que /bloquear).
function finDelDiaLima(startISO) {
  const m = String(startISO || '').match(/^(\d{4}-\d{2}-\d{2})T/);
  return m ? `${m[1]}T23:59:00-05:00` : null;
}

// Normaliza el rango: fin explícito válido, o fin del día del inicio. → { startISO, endISO } o null.
function rangoBloqueo(b) {
  const startISO = b?.start_iso;
  if (!startISO) return null;
  let endISO = b?.end_iso || null;
  if (!endISO || new Date(endISO).getTime() <= new Date(startISO).getTime()) endISO = finDelDiaLima(startISO);
  return endISO ? { startISO, endISO } : null;
}

async function bloquearAgenda(b) {
  if (!isCalendarEnabled()) return { handled: true, reply: 'No tengo tu calendario conectado ahora mismo, así que no puedo bloquear el horario ✦' };
  if (!b || !b.start_iso) return { handled: true, reply: '¿Qué horario te bloqueo? Dime el día y la hora, ej: "bloquéame el lunes 13 de 5 a 6pm" 🙂' };
  const rango = rangoBloqueo(b);
  if (!rango) return { handled: true, reply: '¿Hasta qué hora te bloqueo? Dime, por ejemplo "de 5 a 6pm" 🙂' };
  const motivo = (b.motivo && b.motivo.trim()) || 'No disponible';
  const r = await blockRange({ startISO: rango.startISO, endISO: rango.endISO, motivo });
  if (!r.ok) return { handled: true, reply: `No pude bloquear tu agenda (${r.error || 'error'}). ¿Lo intentamos de nuevo?` };
  return { handled: true, reply: `🚫 Bloqueé tu agenda:\n${r.inicio_label}\n   → ${r.fin_label}\nMotivo: ${r.motivo}.\nNo ofreceré esos turnos y ya quedó en tu Google Calendar ✦` };
}

async function desbloquearAgenda(b) {
  if (!isCalendarEnabled()) return { handled: true, reply: 'No tengo tu calendario conectado ahora mismo ✦' };
  if (!b || !b.start_iso) return { handled: true, reply: '¿Qué bloqueo quito? Dime el día/hora, ej: "quita el bloqueo del lunes 13 a las 5pm" 🙂' };
  const rango = rangoBloqueo(b);
  if (!rango) return { handled: true, reply: '¿De qué rango quito el bloqueo? 🙂' };
  const r = await unblockRange({ startISO: rango.startISO, endISO: rango.endISO });
  if (!r.ok) return { handled: true, reply: `No pude quitar el bloqueo (${r.error || 'error'}).` };
  if (!r.deleted) return { handled: true, reply: 'No encontré un bloqueo en ese rango 🤔 (pídeme "muéstrame mis bloqueos" para verlos).' };
  return { handled: true, reply: `✓ Quité ${r.deleted} bloqueo${r.deleted === 1 ? '' : 's'} de ese rango. Vuelvo a ofrecer esos turnos ✦` };
}

async function consultarBloqueos() {
  if (!isCalendarEnabled()) return { handled: true, reply: 'No tengo tu calendario conectado ahora mismo ✦' };
  const r = await listBlocks();
  if (!r.ok) return { handled: true, reply: 'No pude leer tus bloqueos ahora mismo ✦' };
  if (!r.blocks.length) return { handled: true, reply: '🗓️ No tienes bloqueos activos. Tu agenda está abierta según tu plantilla ✦' };
  const lines = r.blocks.map((x) => `🚫 ${x.inicio_label} → ${x.fin_label}${x.motivo ? ` — ${x.motivo}` : ''}`).join('\n');
  return { handled: true, reply: `Tus bloqueos activos (${r.blocks.length}):\n${lines}` };
}

async function consultarPaciente(cp) {
  if (!cp || !cp.patient_name) return { handled: false };
  const { patient, error } = await resolvePatient(cp.patient_name);
  if (error) return { handled: true, reply: error };
  const [sesRes, saldo, upc] = await Promise.all([
    miraiSupabase.from('sessions').select('summary, homework, next_focus').eq('patient_id', patient.id).order('created_at', { ascending: false }).limit(1),
    balancePaciente(patient.id),
    patient.phone && isCalendarEnabled() ? getUpcoming({ phone: patient.phone }) : Promise.resolve({ hasAppointment: false }),
  ]);
  const partes = [`👤 *${patient.nombre}*`];
  const s = sesRes.data?.[0];
  if (s?.summary) {
    partes.push(`*Última sesión:* ${s.summary}`);
    if (s.homework) partes.push(`*Tarea:* ${s.homework}`);
    if (s.next_focus) partes.push(`*Próximo foco:* ${s.next_focus}`);
  } else {
    partes.push('Aún sin notas de sesión.');
  }
  partes.push(`*Saldo:* ${saldo > 0.5 ? `debe ${money(saldo)}` : 'al día ✅'}`);
  if (upc?.hasAppointment) partes.push(`*Próxima cita:* ${upc.etiqueta}`);
  return { handled: true, reply: partes.join('\n') };
}

// ---- Notas (segundo cerebro) ----
async function guardarNota(n, raw) {
  if (!n || !n.content || !n.content.trim()) return { handled: false };
  const { error } = await miraiSupabase.from('notes').insert({
    content: n.content.trim(), topic: n.topic?.trim() || null, source: 'voz', raw_text: raw,
  });
  if (error) { console.error('[neura] nota insert:', error.message); return { handled: true, reply: 'Uy, no pude guardar la nota. ¿Me la repites?' }; }
  return { handled: true, reply: `📝 Anotado${n.topic ? ` (${n.topic.trim()})` : ''}. Cuando quieras me lo pides de vuelta ✦` };
}

async function consultarNota(b) {
  if (!b || !b.query) return { handled: false };
  const q = b.query.replace(/[,()%]/g, ' ').trim();
  if (!q) return { handled: false };
  const { data } = await miraiSupabase.from('notes')
    .select('content, topic').or(`content.ilike.%${q}%,topic.ilike.%${q}%`)
    .order('created_at', { ascending: false }).limit(6);
  const rows = data ?? [];
  if (!rows.length) return { handled: true, reply: `No encontré nada anotado sobre "${q}" 🤔` };
  const lines = rows.map((r) => `• ${r.content}`).join('\n');
  return { handled: true, reply: `📒 Sobre "${q}":\n${lines}` };
}

// Búsqueda global: revisa todas tus áreas de una (idea de Notion: buen buscador).
async function buscarGlobal(b) {
  if (!b || !b.query) return { handled: false };
  const q = b.query.replace(/[,()%]/g, ' ').trim();
  if (q.length < 2) return { handled: false };
  const like = `%${q}%`;
  const [notes, ppl, pats, ses, spir, fin] = await Promise.all([
    miraiSupabase.from('notes').select('content').or(`content.ilike.${like},topic.ilike.${like}`).limit(5),
    miraiSupabase.from('people').select('name, relation').or(`name.ilike.${like},relation.ilike.${like}`).limit(5),
    miraiSupabase.from('patients').select('nombre').ilike('nombre', like).neq('phone', '51904301391').limit(5),
    miraiSupabase.from('sessions').select('summary').ilike('summary', like).limit(3),
    miraiSupabase.from('spiritual').select('content').ilike('content', like).limit(3),
    miraiSupabase.from('finances').select('description, category, amount').or(`description.ilike.${like},category.ilike.${like}`).limit(4),
  ]);
  const lines = [];
  (notes.data || []).forEach((r) => lines.push(`📝 ${r.content}`));
  (ppl.data || []).forEach((r) => lines.push(`🫂 ${r.name}${r.relation ? ` (${r.relation})` : ''}`));
  (pats.data || []).forEach((r) => lines.push(`🩺 ${r.nombre}`));
  (ses.data || []).forEach((r) => lines.push(`📋 ${r.summary}`));
  (spir.data || []).forEach((r) => lines.push(`🙏 ${r.content}`));
  (fin.data || []).forEach((r) => lines.push(`💰 ${r.description || r.category} — ${money(r.amount)}`));
  if (!lines.length) return { handled: true, reply: `No encontré nada sobre "${q}" en tu Neura 🤔` };
  return { handled: true, reply: `🔎 Encontré esto sobre "${q}":\n${lines.slice(0, 10).join('\n')}` };
}

// ---- Ánimo (check-in de bienestar) ----
async function registrarAnimo(a, raw) {
  if (!a || !a.mood || !a.mood.trim()) return { handled: false };
  const score = Number.isFinite(Number(a.score)) ? Number(a.score) : null;
  const { error } = await miraiSupabase.from('moods').insert({
    mood: a.mood.trim(), score, note: a.note?.trim() || null, source: 'voz', raw_text: raw,
  });
  if (error) { console.error('[neura] animo insert:', error.message); return { handled: true, reply: 'Estoy contigo 💗 (no pude guardarlo, pero te leo).' }; }
  const bajo = score != null && score <= 2;
  const cierre = bajo
    ? 'Gracias por contármelo. Si quieres, respira conmigo un momento… estoy aquí 💗'
    : 'Anotado 💗 Qué lindo que te tomes el pulso a ti misma.';
  return { handled: true, reply: `Registré cómo te sientes: *${a.mood.trim()}*.\n${cierre}` };
}

// ---- Salud / hábitos / descanso (tabla life_log) ----
async function registrarHabito(h, raw) {
  if (!h || !h.kind) return { handled: false };
  const kinds = ['agua', 'sueño', 'ejercicio', 'comida', 'descanso', 'disfrute', 'otro'];
  const kind = kinds.includes(h.kind) ? h.kind : 'otro';
  const amount = Number.isFinite(Number(h.amount)) ? Number(h.amount) : null;
  const { error } = await miraiSupabase.from('life_log').insert({
    kind, amount, unit: h.unit?.trim() || null, note: h.note?.trim() || null, source: 'voz', raw_text: raw,
  });
  if (error) { console.error('[neura] habito insert:', error.message); return { handled: true, reply: 'Uy, no pude anotarlo. ¿Me lo repites?' }; }
  const emo = { agua: '💧', 'sueño': '😴', ejercicio: '🏃‍♀️', comida: '🍽️', descanso: '🌿', disfrute: '🎈', otro: '✦' }[kind];
  const cant = amount != null ? ` (${amount}${h.unit ? ' ' + h.unit.trim() : ''})` : '';
  return { handled: true, reply: `${emo} Anotado: ${kind}${cant}.\nLo ves en Neura → Vida ✦` };
}

// ---- Tu gente (relaciones) ----
async function agregarPersona(p, raw) {
  if (!p || !p.name || !p.name.trim()) return { handled: false };
  const { error } = await miraiSupabase.from('people').insert({
    name: p.name.trim(), relation: p.relation?.trim() || null,
    phone: p.phone?.trim() || null, birthday: p.birthday || null,
    last_contact: new Date().toISOString(), source: 'voz',
  });
  if (error) { console.error('[neura] persona insert:', error.message); return { handled: true, reply: 'Uy, no pude guardarla. ¿Me repites el nombre?' }; }
  return { handled: true, reply: `🫂 Guardé a ${p.name.trim()}${p.relation ? ` (${p.relation.trim()})` : ''} en tu gente.\nTe avisaré si pasa mucho sin que la busques 💛` };
}

async function contactoPersona(c) {
  if (!c || !c.person || !c.person.trim()) return { handled: false };
  const term = c.person.trim().replace(/[,()%]/g, ' ').trim();
  if (!term) return { handled: false };
  const { data } = await miraiSupabase.from('people')
    .select('id, name').or(`name.ilike.%${term}%,relation.ilike.%${term}%`).limit(3);
  const rows = data ?? [];
  if (!rows.length) {
    await miraiSupabase.from('people').insert({ name: c.person.trim(), last_contact: new Date().toISOString(), source: 'voz' });
    return { handled: true, reply: `💛 Anotado que hablaste con ${c.person.trim()}. La agregué a tu gente.` };
  }
  await miraiSupabase.from('people').update({ last_contact: new Date().toISOString() }).eq('id', rows[0].id);
  return { handled: true, reply: `💛 Listo, anoté que hablaste con ${rows[0].name}. Qué lindo cuidar tus vínculos.` };
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
  return { handled: true, reply: `${reply}\n\n— _¿te lo mando en PDF? dime "en PDF"_ ✦` };
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

// ¿La respuesta es un CÁLCULO matemático (cuentas/plata)? Solo esas van por audio.
function isCalculo(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const numTokens = (t.match(/\d+/g) || []).length;
  const señal = /(soles|s\/|total|suma|sumar|falta|faltan|debe|deben|saldo|cuenta|bloque|cuota|paga|pag[oó]|=|×)/.test(t);
  return numTokens >= 2 && señal;
}

// Extrae del mensaje (aunque sea largo/desordenado) las transacciones EXPLÍCITAS
// y las registra sola: pagos, cargos (saldos) y gastos. Devuelve qué guardó.
async function extraerYRegistrarFinanzas(text) {
  if (!/\d/.test(text)) return [];
  let parsed;
  try {
    const resp = await miraiOpenai.chat.completions.create({
      model: MIA_MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Extrae SOLO transacciones financieras EXPLÍCITAS y YA OCURRIDAS del mensaje de Mirai (psicóloga). Devuelve JSON:
{"pagos":[{"patient_name":string,"amount":number}],"cargos":[{"patient_name":string,"amount":number}],"gastos":[{"amount":number,"category":string,"description":string}]}
- pago = un paciente le PAGÓ/abonó N soles.
- cargo = un paciente le DEBE / quedó debiendo N soles.
- gasto = Mirai gastó/compró/pagó N soles (gasto personal).
- patient_name = el nombre de la PACIENTE. Si dice "papá/mamá de X", la paciente es X.
NO incluyas preguntas, hipótesis, precios que solo consulta, ni totales que solo comenta. Si no hay transacciones claras y ocurridas, deja todo vacío. Devuelve SOLO el JSON.` },
        { role: 'user', content: text },
      ],
    });
    parsed = JSON.parse(resp.choices?.[0]?.message?.content ?? '{}');
  } catch { return []; }

  const saved = [];
  for (const p of parsed.pagos ?? []) {
    const amount = Number(p.amount);
    if (!p?.patient_name || !Number.isFinite(amount) || amount <= 0) continue;
    const { patient } = await resolvePatient(p.patient_name);
    if (!patient) continue;
    const { error } = await miraiSupabase.from('payments').insert({ patient_id: patient.id, amount, currency: 'PEN', concept: 'sesión', source: 'voz', raw_text: text });
    if (!error) saved.push(`💰 pago ${money(amount)} de ${patient.nombre}`);
  }
  for (const c of parsed.cargos ?? []) {
    const amount = Number(c.amount);
    if (!c?.patient_name || !Number.isFinite(amount) || amount <= 0) continue;
    const { patient } = await resolvePatient(c.patient_name);
    if (!patient) continue;
    const { error } = await miraiSupabase.from('charges').insert({ patient_id: patient.id, amount, currency: 'PEN', concept: 'sesión', source: 'voz', raw_text: text });
    if (!error) saved.push(`🧾 ${patient.nombre} debe ${money(amount)}`);
  }
  for (const g of parsed.gastos ?? []) {
    const amount = Number(g.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const { error } = await miraiSupabase.from('finances').insert({ direction: 'gasto', amount, currency: 'PEN', category: g.category || 'Otros', description: g.description || null, source: 'voz', raw_text: text });
    if (!error) saved.push(`💸 gasto ${money(amount)}`);
  }
  return saved;
}

async function reflexionar(text) {
  const [reply, saved] = await Promise.all([handleReflexion(text), extraerYRegistrarFinanzas(text)]);
  if (!reply) return { handled: false };
  let full = reply;
  if (saved.length) full += `\n\n💾 Guardé: ${saved.join(' · ')}.\nSi algo no va, lo editas en Pacientes ✦`;
  return { handled: true, reply: full, speak: isCalculo(full) };
}

function ayudaMenu() {
  const txt = `🌿 *Soy Mia, tu asistente.* Háblame normal (texto o audio) y yo me encargo:

💰 *Plata* — "gasté 20 con el BBVA" · "¿cuánto tengo en el BCP?" · "le aboné 100 a César" · "¿a quién le debo?" · "mete 50 a mi meta de Georgia" · "¿cómo van mis metas?" · "¿en qué se me fue la plata?"
🩺 *Consultorio* — "terminé con Ana, trabajamos…" · "Ana me pagó 105" · "Ana compró un paquete de 6" · "¿cuántas sesiones le quedan a Ana?" · "¿quién me debe?" · "¿qué trabajé con Ana?" · "agéndame a Ana el martes 4pm"
🗓️ *Tu día* — "¿qué tengo hoy?" · "¿qué tengo esta semana?" · "recuérdame las pastillas a las 9" · "posponlo a mañana" · "ya tomé las pastillas" · "bloquéame el lunes de 5 a 6pm"
🫂 *Tu gente* — "agrega a mi mamá" · "llamé a mi mamá"
🫀 *Tú* — "tomé 2 litros de agua" · "dormí 6 horas" · "hoy me siento cansada" · "hoy agradezco por…"
📝 *Recordar y pensar* — "apunta que el wifi es…" · "hazme un reporte de…" · "ayúdame a pensar si…"

Y si solo quieres conversar o pensar algo conmigo, también estoy aquí 💛`;
  return { handled: true, reply: txt };
}
