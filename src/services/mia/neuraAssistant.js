// NEURA — asistente personal de Mirai (Fase 1 + 2).
// Interpreta instrucciones en lenguaje natural (voz transcrita o texto) que
// Mirai le manda a Mia desde su número personal, y las ejecuta:
//   · registrar un gasto/ingreso   → hoja de cálculo "Neura - Finanzas" (Sheets)
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
import { config } from '../../config.js';
import { analizarFotoMirai } from './media.js';
import { logFinanceToSheet } from './financeSheet.js';
import { listUpcomingAppointments, slotLabel, createHold, rescheduleAppointment, cancelAppointment, getUpcoming, isCalendarEnabled, blockRange, listBlocks, unblockRange } from './calendar.js';
import { runGdhRecap } from './gdhRecap.js';
import { handleReflexion } from './reflexion.js';
import { handleReporte } from './reporte.js';
import { enviarReportePdf } from './reportePdf.js';
import { buildResumenFinanzas, deudoresPacientes } from './resumenFinanzas.js';
import {
  resolveAccount, handleConsultarSaldo, handleAjustarSaldo,
  handleRegistrarDeuda, handleAbonarDeuda, handleConsultarDeudaPersonal,
  handleCrearMeta, handleAportarMeta, handleConsultarMetas, handleConsultarPlan,
  registrarCostoConsultorio,
} from './finanzas.js';
import { handleRegistrarTrabajo, handleConsultarTrabajo, handleReporteGdh } from './trabajo.js';
import { handleRegistrarPagoFijo, handleConsultarPagosFijos } from './pagosFijos.js';
import { contextoCierre, limpiarContextoCierre } from './buenasNoches.js';
import { addPatient, normalizePhone, listPacientesActivos, listLeads, marcarComoPaciente } from './patients.js';
import { aprobarPR, rehacerCorreccion, listPendientes, formatoListaPendientes, descartarCorreccion } from './itacaCorrecciones.js';
import {
  cmdSilenciar, cmdActivar, cmdNoTocar, cmdRemovePatient, cmdAddNote, cmdAtenderLead,
  cmdReconectar, cmdMetricas, cmdPaquete, cmdAgendar, cmdConfirmar, cmdCancelar, hasPendingEnvio,
  cmdSticker, cmdGrupos, cmdRetomarLead, cmdResponderEnNombreDeLead,
} from './commands.js';

const CLASSIFIER_SYSTEM = `Eres el clasificador del asistente personal "Neura" de Mirai (psicóloga).
Mirai te habla en lenguaje natural (a veces por audio transcrito). Entiende qué
quiere y devuelve SOLO un JSON válido, sin ningún texto extra.

Formato exacto:
{
  "intent": "aprobar_pr" | "rehacer_correccion" | "listar_correcciones" | "descartar_correccion" | "listar_pacientes" | "marcar_paciente" | "registrar_paciente" | "silenciar_paciente" | "activar_paciente" | "no_tocar" | "dar_de_baja" | "agregar_nota_paciente" | "atender_lead" | "retomar_lead_saludado" | "responder_como_si" | "reconectar_lead" | "consultar_metricas" | "coordinar_paquete" | "coordinar_cita" | "configurar_sticker" | "listar_grupos" | "registrar_finanza" | "agregar_recordatorio" | "completar_recordatorio" | "consultar_agenda" | "nota_sesion" | "registrar_pago" | "consultar_gdh" | "registrar_trabajo" | "consultar_trabajo" | "reporte_gdh" | "reporte" | "reporte_pdf" | "registrar_cargo" | "consultar_deudas" | "consultar_finanzas" | "consultar_saldo" | "ajustar_saldo" | "registrar_deuda" | "abonar_deuda" | "consultar_deuda_personal" | "crear_meta" | "aportar_meta" | "consultar_metas" | "consultar_plan" | "registrar_pago_fijo" | "consultar_pagos_fijos" | "agendar_cita" | "reprogramar_cita" | "cancelar_cita" | "bloquear_agenda" | "desbloquear_agenda" | "consultar_bloqueos" | "consultar_semana" | "posponer_recordatorio" | "consultar_paciente" | "crear_paquete" | "consultar_paquete" | "guardar_nota" | "consultar_nota" | "registrar_animo" | "consultar_animo" | "escribir_diario" | "consultar_diario" | "registrar_habito" | "agregar_persona" | "contacto_persona" | "espiritual" | "reflexion" | "ayuda" | "buscar" | "ninguno",
  "finanza": [{ "direction": "gasto" | "ingreso", "amount": number, "category": string, "description": string, "account": string | null }] | null,
  "saldo": { "account": string | null, "amount": number | null } | null,
  "deuda": { "counterparty": string, "direction": "debo" | "me_deben" | null, "amount": number | null, "currency": "PEN" | "USD" | null } | null,
  "meta": { "name": string, "target": number | null, "amount": number | null, "currency": "PEN" | "USD" | null, "target_date": string | null } | null,
  "pagofijo": { "concept": string, "amount": number | null, "day": number | null, "category": "Suscripción" | "Tarjeta" | "Crédito" | "Servicio" | "Otro" | null } | null,
  "recordatorio": { "title": string, "remind_at": string | null, "recurrence": "daily" | "weekly" | null } | null,
  "sesion": { "patient_name": string, "summary": string, "homework": string | null, "next_focus": string | null } | null,
  "pago": { "patient_name": string, "amount": number, "method": string | null } | null,
  "cargo": { "patient_name": string, "amount": number | null, "sessions": number | null, "concept": string | null } | null,
  "cita": { "patient_name": string, "start_iso": string | null, "new_start_iso": string | null } | null,
  "bloqueo": { "start_iso": string | null, "end_iso": string | null, "motivo": string | null } | null,
  "posponer": { "title": string | null, "remind_at": string | null } | null,
  "consulta_paciente": { "patient_name": string, "aspecto": "sesion" | "saldo" | "cita" | "todo" } | null,
  "paquete": { "patient_name": string, "sessions": number | null } | null,
  "trabajo": { "kind": "logro" | "pendiente" | "tarea" | "ahorro" | "venta" | "nota", "content": string, "impact": number | null } | null,
  "nota": { "content": string, "topic": string | null } | null,
  "busqueda_nota": { "query": string } | null,
  "buscar": { "query": string } | null,
  "animo": { "mood": string, "score": number | null, "note": string | null } | null,
  "diario": { "content": string } | null,
  "habito": { "kind": "agua" | "sueño" | "ejercicio" | "comida" | "descanso" | "disfrute" | "otro", "amount": number | null, "unit": string | null, "note": string | null } | null,
  "persona": { "name": string, "relation": string | null, "phone": string | null, "birthday": string | null } | null,
  "paciente_nuevo": { "name": string | null, "phone": string | null } | null,
  "listado": { "tipo": "pacientes" | "leads", "origen": "campaña" | "montsinai" | "organico" | null } | null,
  "marcar": { "name": string, "es_paciente": boolean } | null,
  "pr": { "id": number | null } | null,
  "control_paciente": { "patient_name": string | null, "phone": string | null, "nota": string | null } | null,
  "sticker": { "accion": "parar" | "retomar" | "estado" } | null,
  "coordinacion": { "patient_name": string, "sessions": number | null, "objetivo": string | null } | null,
  "contacto": { "person": string } | null,
  "espiritual": { "kind": "gratitud" | "reflexion" | "oracion" | "lectura", "content": string } | null,
  "completar": { "title": string } | null
}

Reglas:
- GASTO: "gasté / compré / pagué / me costó ... soles" → registrar_finanza, direction "gasto".
  category de gasto: EXACTAMENTE una de [Antojos, Comida, Transporte, Salud, Casa, Servicios, Ocio, Otros].
- INGRESO general (SIN nombre de persona): "cobré / me depositaron / ingresó / me prestaron / me depositó <persona> ..." → registrar_finanza, direction "ingreso", category "Otros" o "Consulta".
- VARIOS MOVIMIENTOS EN UN SOLO MENSAJE: "finanza" es SIEMPRE una LISTA — si el mensaje menciona varios gastos y/o ingresos (ej. un listado de compras, varios cargos de tarjeta, un gasto y luego un depósito), incluye TODOS como elementos separados de la lista. NO te quedes solo con el primero.
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
- GDH GRUPO (recap del CHAT del grupo de trabajo): "resúmeme el GDH / qué pasó en el grupo / qué se dijo en GDH / resumen del grupo / recap del grupo" → consultar_gdh.
- REGISTRAR TRABAJO/GDH (Mirai anota algo de SU trabajo en GDH/Ítaca — REQUIERE contexto de trabajo: "de GDH / del trabajo / en GDH / en Ítaca / para gerencia"): "apunta un logro de GDH: … / logro del trabajo … / conseguí/logré … / bajé/reduje X de A a B / ahorré N en GDH / cerré una venta de N / pendiente de GDH … / tarea del trabajo …" → registrar_trabajo.
  trabajo.kind: "logro" (algo que logró), "ahorro" (bajó un costo o ahorró plata), "venta" (una venta/ingreso conseguido), "pendiente" (algo por hacer), "tarea" (tarea concreta), "nota" (un dato). trabajo.content = qué, en breve, INCLUYENDO los números tal como los dice. trabajo.impact = el monto en soles del ahorro/venta si hay uno claro (o null). (Ojo: sin contexto de trabajo, "ahorré N" es una meta/finanza; "recuérdame X" es recordatorio.)
- CONSULTAR TRABAJO: "qué logros tengo este mes / cómo va mi trabajo / mis pendientes de GDH / qué he hecho en GDH este mes" → consultar_trabajo.
- REPORTE GDH (informe MENSUAL a gerencia, se arma desde la bitácora): "hazme el reporte de GDH / arma mi reporte mensual / reporte para gerencia / informe para Brian / el reporte del mes de GDH" → reporte_gdh. (Ojo: "hazme un reporte de <otro tema que te dicto>" sin ser GDH/gerencia es reporte normal.)
- REPORTE: "hazme un reporte de / ármame un informe sobre / redáctame un reporte / necesito un informe de / prepárame un documento sobre ..." → reporte.
- REPORTE PDF: "mándalo en PDF / pásalo a PDF / hazme el documento / quiero el reporte en PDF / mándame el documento / en PDF ..." (se refiere al reporte que se acaba de armar) → reporte_pdf.
- CARGO / DEUDA DE PACIENTE (lo que un paciente DEBE, NO lo que pagó): "X me debe 105 / cóbrale a X / X quedó debiendo / ponle una sesión pendiente a X / X tiene 2 sesiones sin pagar" → registrar_cargo. cargo.patient_name = nombre. cargo.amount = soles si lo dice, si no null. cargo.sessions = número de sesiones si lo menciona (o null). cargo.concept = breve (o null). (Ojo: "me pagó / me abonó" es registrar_pago, no cargo.)
- CONSULTAR DEUDAS: "quién me debe / quiénes están debiendo / saldos / cuánto me deben / quién tiene pendiente de pago" → consultar_deudas.
- CONSULTAR FINANZAS: "en qué se me fue la plata / resumen de mis finanzas / cuánto gasté esta semana / mis gastos / cómo voy de plata" → consultar_finanzas.
- MOVIMIENTO CON CUENTA: en registrar_finanza, si menciona una cuenta o medio ("con el BBVA / del BCP / en efectivo / con Yape / con la tarjeta Saga / con el crédito Yape"), pon account = el nombre EXACTO de la cuenta (BCP, BBVA, Yape, Efectivo, Saga Falabella, Crédito Yape) en ESE elemento de la lista. Si dice solo "mi tarjeta de crédito" sin decir cuál (y tiene más de una), deja account = null — no adivines. Si una frase aclara que VARIOS gastos anteriores son de una cuenta específica ("esos cinco son de mi tarjeta Saga"), aplica esa cuenta a CADA uno de esos elementos. Si no menciona cuenta, account = null.
- CONSULTAR SALDO: "cuánto tengo en el BBVA / cuánto hay en el BCP / cuánto tengo en total / mis cuentas / cuánta plata tengo" → consultar_saldo. saldo.account = la cuenta, o null si pregunta por el total/todas.
- AJUSTAR SALDO (DECLARA cuánto hay en una cuenta, no es un gasto/ingreso): "tengo 50 en el BBVA / mi saldo del BCP es 6 / pon el efectivo en 20 / en el Yape tengo 100" → ajustar_saldo. saldo.account = cuenta; saldo.amount = el monto.
- REGISTRAR DEUDA/PRÉSTAMO PERSONAL (NO un paciente): "le debo 500 a César / César me prestó 500 / le presté 200 a mi hermano / me prestaron 1000" → registrar_deuda. deuda.counterparty = la persona; deuda.amount = monto; deuda.currency = "USD" si son dólares, si no "PEN".
  deuda.direction — LEE CON CUIDADO quién le prestó a quién:
    · "debo" = MIRAI DEBE (le prestaron a ELLA): "me prestó", "me prestaron", "le debo a X", "quedé debiéndole a X", "X me hizo un préstamo".
    · "me_deben" = a MIRAI le deben (ELLA prestó): "le presté a X", "presté plata a X", "X me debe porque le presté", "me tienen que devolver".
  (Ojo: un PACIENTE que debe por sesiones es registrar_cargo, no registrar_deuda.)
- ABONAR/PAGAR DEUDA: "le aboné 100 a César / le pagué 50 a Julio / me devolvió 30 mi hermano / aboné a la deuda de X" → abonar_deuda. deuda.counterparty; deuda.amount; deuda.direction si se distingue.
- CONSULTAR DEUDA PERSONAL: "cuánto le debo a César / a quién le debo / cuánto debo / cuánto me deben de lo que presté / mis préstamos / mis deudas" → consultar_deuda_personal. deuda.counterparty = persona si la nombra, si no null. (Ojo: "quién me debe" de PACIENTES es consultar_deudas.)
- CREAR META DE AHORRO: "quiero ahorrar 5000 para Georgia / meta para SERUMS / quiero ir a Italia y necesito 12000 / nueva meta viaje a X para el 2028" → crear_meta. meta.name = nombre de la meta (ej. "Viaje a Italia"); meta.target = monto objetivo (costo) si lo da (o null); meta.currency; meta.target_date = fecha objetivo en ISO YYYY-MM-DD si da una fecha CONCRETA o un año ("para diciembre 2028" → 2028-12-01; "en 2028" → 2028-12-31). Si la fecha depende de un dato que no tienes (ej. "en mi cumpleaños 27") deja target_date en null.
- APORTAR A META: "ahorré 100 para Georgia / mete 50 a la meta de SERUMS / guardé 200 para el viaje / aporté 80 al fondo de emergencia" → aportar_meta. meta.name = a qué meta; meta.amount = cuánto aporta.
- CONSULTAR METAS: "cómo van mis metas / cuánto llevo para Georgia / mis metas de ahorro" → consultar_metas.
- CONSULTAR PLAN DE META (cuánto ahorrar al mes para llegar): "cuál es mi plan para Georgia / cuánto necesito ahorrar al mes para Italia / cuánto debo guardar por mes para <meta> / arma mi plan de ahorro para X" → consultar_plan. meta.name = la meta; meta.target = costo si lo menciona ahora; meta.target_date = fecha ISO si la menciona ahora.
- REGISTRAR SUSCRIPCIÓN / PAGO FIJO: "agrega una suscripción: Netflix 30 el día 15 / pago Claude 73 el 9 de cada mes / tengo Spotify 20 mensual / anota el pago de mi tarjeta Visa el día 5 / mi crédito BCP se paga el 20" → registrar_pago_fijo. pagofijo.concept = nombre (Netflix, Claude, Tarjeta Visa, Crédito BCP…); pagofijo.amount = monto mensual si lo dice (o null); pagofijo.day = día del mes 1-31 si lo dice (o null); pagofijo.category = "Suscripción" (apps/servicios), "Tarjeta" (tarjeta de crédito), "Crédito" (préstamo/crédito), "Servicio" (luz/agua/internet), o "Otro".
- CONSULTAR PAGOS FIJOS: "qué suscripciones tengo / qué pagos fijos tengo / qué me toca pagar / cuánto pago al mes en suscripciones / qué pagos vienen / mis pagos del mes" → consultar_pagos_fijos.
- AGENDAR CITA (con día/hora YA decidida): "agéndame a X el <día/hora> / ponle cita a X / resérvale a X / cítala a X ..." → agendar_cita. cita.patient_name = nombre del paciente; cita.start_iso = ISO con offset Lima -05:00 calculado desde el día/hora que da.
- COORDINAR CITA (SIN día/hora decidida — le manda un mensaje a X por WhatsApp preguntando cuándo puede): "escríbele a X para coordinar su próxima cita / pregúntale a X qué día le queda / contáctala para agendar / avísale a X que le toca sesión y ve cuándo puede" → coordinar_cita. coordinacion.patient_name = paciente. (Ojo: si SÍ da un día/hora concreto es agendar_cita, no coordinar_cita.)
- REPROGRAMAR CITA: "cambia/mueve/reprograma la cita de X al <día/hora>" → reprogramar_cita. cita.patient_name; cita.new_start_iso = ISO -05:00.
- CANCELAR CITA: "cancela/anula la cita de X" → cancelar_cita. cita.patient_name.
- BLOQUEAR AGENDA (Mirai se marca NO DISPONIBLE en SU horario — NO es un paciente, NO es un recordatorio): "bloquéame / bloquea mi agenda / bloquear horario / no estoy disponible / no me pongas citas / no ofrezcas turnos / tápame / ocúpame / márcame ocupada / cierra mi agenda / estaré fuera / de viaje / no atiendo el <día/hora>" → bloquear_agenda.
  bloqueo.start_iso = ISO con offset Lima -05:00 (día + hora de inicio). bloqueo.end_iso = ISO -05:00 del fin SOLO si da un fin explícito o un rango ("de 5 a 6pm", "hasta el viernes", "de las 5 a las 7"); si no da fin, null. bloqueo.motivo = el motivo en breve, o null.
  DIFERENCIA CLAVE: "recuérdame X" es agregar_recordatorio; "agéndame/cítala a X" con un PACIENTE es agendar_cita; bloquear_agenda es cuando Mirai tapa SU propio tiempo para que Mia NO ofrezca esos turnos.
  ⚠️ REGLA DURA — bloquear_agenda SOLO si MIRAI habla de SU PROPIA indisponibilidad, en primera persona ("no atiendo", "estaré fuera", "bloquéame"). Si el mensaje cuenta que OTRA PERSONA confirmó, pidió o quiere una cita —"la señora Monica confirmó para el martes 18 a las 9", "el Dr. X quiere cita el jueves", "me confirmaron para mañana 10am", o un mensaje reenviado de la clínica— eso es agendar_cita, NUNCA bloquear_agenda. Confundirlos le tapa un día entero de trabajo. Ante la duda entre las dos, elige agendar_cita.
- QUITAR BLOQUEO: "quita/saca el bloqueo de <día/hora> / desbloquea <...> / vuelve a abrir mi agenda el <...> / ya estoy disponible el <...>" → desbloquear_agenda. bloqueo.start_iso / bloqueo.end_iso igual que en bloquear_agenda.
- CONSULTAR BLOQUEOS: "qué tengo bloqueado / muéstrame mis bloqueos / cuándo no estoy disponible / mis bloqueos" → consultar_bloqueos.
- CONSULTAR PACIENTE: "qué trabajé/vi con X / cómo va X / cuánto me debe X / cuánto ha invertido X / en qué sesión va X / cuántas sesiones lleva X / cuándo veo a X / cuándo es la cita de X" → consultar_paciente. consulta_paciente.patient_name; aspecto = "sesion" | "saldo" | "cita" | "todo". La respuesta ya trae número de sesión e invertido, así que NUNCA le pidas esos datos a Mirai: están en el sistema.
- CREAR PAQUETE DE SESIONES: "X compró un paquete de 6 / véndele un paquete de 4 a X / arma un paquete de 6 sesiones para X / X se llevó el paquete de 4" → crear_paquete. paquete.patient_name = paciente; paquete.sessions = número de sesiones del paquete (4, 6, u otro; si no lo dice, null).
- CONSULTAR PAQUETE: "cuántas sesiones le quedan a X / cómo va el paquete de X / le quedan sesiones a X / el paquete de X" → consultar_paquete. paquete.patient_name = paciente.
- COORDINAR/OFRECER PAQUETE (Mia le ARMA y ENVÍA por WhatsApp la propuesta con tarjeta, AÚN NO comprado — distinto de crear_paquete que registra uno YA comprado): "ofrécele a X un paquete de 6 / propónle a X un paquete de 4 para <objetivo> / mándale a X la propuesta del paquete / hazle la oferta del paquete a X" → coordinar_paquete. coordinacion.patient_name = paciente; coordinacion.sessions = 4 o 6 (o el número que dé); coordinacion.objetivo = para qué (breve) si lo dice, si no null. Antes de enviar, Mia SIEMPRE te muestra la vista previa — le respondes "sí" o "no" para confirmar o cancelar.
- GUARDAR NOTA: "apunta que / anota que / recuerda que <DATO> / guarda que / agrega X a la lista de Y" (un DATO o ítem SIN hora ni acción por hacer; NO es recordatorio) → guardar_nota. nota.content = el dato tal cual; nota.topic = tema en 1-2 palabras (ej "wifi", "lista de compras").
- CONSULTAR NOTA: "qué anoté de X / cuál era el X / qué tengo en la lista de Y / dime el dato de X" → consultar_nota. busqueda_nota.query = a qué se refiere (pocas palabras).
- BUSCAR (global, en todo Neura): "busca X / búscame todo lo de X / encuentra Y / ¿dónde está Z? / qué tengo sobre W" → buscar. buscar.query = qué busca.
- CHECK-IN DE ÁNIMO: "hoy me siento X / estoy X / me siento <emoción> / ando <estado>" (Mirai DECLARA su estado emocional, no pide consejo) → registrar_animo. animo.mood = la emoción en 1-2 palabras; animo.score = 1 (muy mal) a 5 (muy bien) si se infiere, si no null; animo.note = detalle si lo da. (Si PIDE perspectiva o ayuda a decidir → reflexion, no animo.)
- CONSULTAR ÁNIMO (pregunta por su TENDENCIA, no declara): "cómo ha estado mi ánimo / cómo va mi ánimo / cómo he estado de ánimo esta semana / mi ánimo del mes / cómo vengo emocionalmente" → consultar_animo.
- ESCRIBIR DIARIO: "escribe en mi diario … / querido diario … / anota en mi diario … / en mi diario … / hoy en mi diario …" (una entrada personal, reflexiva, del día) → escribir_diario. diario.content = lo que quiere guardar, tal cual lo dice.
- CONSULTAR DIARIO: "léeme mi diario / qué escribí en mi diario / mis entradas del diario / mi diario" → consultar_diario.
- SALUD / HÁBITO / DESCANSO: "tomé X de agua / dormí X horas / hice ejercicio (X min) / comí ... / caminé / hoy descansé / vi una peli / salí a pasear / me di un gusto" → registrar_habito. habito.kind ∈ [agua, sueño, ejercicio, comida, descanso, disfrute, otro]; amount+unit si da cantidad (ej 2 "litros", 6 "horas", 30 "min"); note = detalle.
- APROBAR EL PR DE UNA CORRECCIÓN DE ITACA (Mirai responde al aviso de que hay código listo): "apruebo / aprobado / apruébalo / dale merge / merge / hazle merge / ya está, súbelo / mándalo a producción / dale / ok apruebo la #3" → aprobar_pr. pr.id = el número de corrección si lo menciona ("la #3"), si no null.
  OJO: esto es SOLO para el flujo de correcciones de ITACA. Un "ok" o "dale" suelto que no venga a cuento de un PR NO es aprobar_pr.
- REHACER UNA CORRECCIÓN (su PR quedó obsoleto y choca con el código actual): "rehaz la #1 / rehazla / vuélvela a hacer / hazla de nuevo / que la implemente otra vez" → rehacer_correccion. pr.id = el número de corrección si lo dice, si no null.
- LISTAR CORRECCIONES DE ITACA PENDIENTES: "qué correcciones tengo pendientes / dame la lista de correcciones / qué hay de ITACA por revisar / muéstrame las correcciones" → listar_correcciones.
- DESCARTAR UNA CORRECCIÓN: "descarta la #5 / descártala / esa corrección no va / bórrala, no la necesito" → descartar_correccion. pr.id = el número si lo dice, si no null.
- LISTAR PACIENTES (los que ve EN CONSULTA, para darles seguimiento): "dime mis pacientes / qué pacientes tengo / lista de pacientes / mis pacientes activos / a quiénes estoy viendo / cuántos pacientes tengo" → listar_pacientes con listado.tipo = "pacientes".
  TAMBIÉN es listar_pacientes cuando pide el CUADRO de todos: "hazme el cuadro de mis pacientes / dime en qué sesión va cada uno / cuánto ha invertido cada paciente / el resumen de todos mis pacientes / cuántas sesiones lleva cada uno". La lista ya trae número de sesión y lo invertido — NUNCA le preguntes quiénes son sus pacientes, eso ya está en el sistema.
  LISTAR LEADS (gente que le escribió pero NO es paciente): "cuántos leads tengo / mis leads / los de la campaña / los que llegaron por la pauta / los que me derivó Mont Sinai / los orgánicos" → listar_pacientes con listado.tipo = "leads" y listado.origen = "campaña" (pauta/publicidad/anuncio), "montsinai" (derivados de la clínica), "organico" (escribieron por su cuenta), o null si pide todos.
  OJO: paciente ≠ lead ≠ silenciada. Si pregunta por PACIENTES nunca devuelvas leads.
- MARCAR COMO PACIENTE (un lead que ya empezó consulta): "X ya es mi paciente / marca a X como paciente / X pasó a consulta / ya estoy viendo a X" → marcar_paciente. marcar.name = el nombre; marcar.es_paciente = true. Si dice lo contrario ("X ya no es mi paciente / sácala de pacientes / dale de baja de mi lista"), es_paciente = false.
- REGISTRAR PACIENTE NUEVA (alguien a quien ATIENDE en consulta, todavía no está en Neura): "registra a Maximina / agrégala como paciente / es nueva, regístrala / da de alta a X / anota a X que es paciente nueva (su número es 999...)" → registrar_paciente. paciente_nuevo.name = el nombre (o null si solo dice "es nueva, regístrala" refiriéndose a alguien que acabas de nombrar); paciente_nuevo.phone = el número si lo da (o null).
  TAMBIÉN aquí: si el mensaje es SOLO un número de teléfono peruano (9 dígitos, con o sin +51) sin nada más, es el número de la paciente que quedó pendiente de registrar → registrar_paciente con name null y phone = ese número.
  DIFERENCIA CLAVE con agregar_persona: paciente = alguien que atiende en consulta; persona = un vínculo personal suyo (mamá, pareja, amiga) para que Neura la ayude a cuidarlo.
- SILENCIAR A UN PACIENTE (PAUSA reversible — Mia deja de responderle mientras Mirai lo atiende manual, por AHORA): "silencia a X / que Mia no le responda a X por ahora / pon a X en pausa / deja de responderle a X" → silenciar_paciente. control_paciente.patient_name = paciente.
- ACTIVAR A UN PACIENTE (quita la pausa/silencio, Mia vuelve a responderle): "reactiva a X / que Mia le vuelva a responder a X / quítale la pausa a X / activa a X de nuevo" → activar_paciente. control_paciente.patient_name = paciente.
- NO TOCAR (contacto personal/de trabajo — Mia NUNCA debe engancharlo, ni como lead nuevo aunque escriba con palabras clave; DISTINTO de silenciar, que sí es para pacientes): "X es mi [amiga/hermana/colega], que Mia nunca le responda / agrega el número 999... a no tocar / ese número no es paciente, no lo toques nunca" → no_tocar. control_paciente.patient_name = el nombre si lo da (o null); control_paciente.phone = el número si lo da (o null). Necesitas AL MENOS uno de los dos.
- DAR DE BAJA A UN PACIENTE (DEFINITIVO — Mia deja de responderle PARA SIEMPRE, no es una pausa; úsalo solo si Mirai lo pide claro): "dale de baja a X / termina el seguimiento de X / ya no sigas con X, ciérralo / X ya no vuelve, bórrala de mi lista para siempre" → dar_de_baja. control_paciente.patient_name = paciente. (Ojo: si solo dice "X ya no es mi paciente" sin más énfasis, eso es marcar_paciente con es_paciente false — vuelve a leads pero Mia AÚN puede hablarle. dar_de_baja es más fuerte: silencio total.)
- AGREGAR NOTA A UN PACIENTE (un dato o detalle sobre SU FICHA, no una nota general): "anota en la ficha de X que… / agrégale una nota a X: … / apunta sobre X que…" → agregar_nota_paciente. control_paciente.patient_name = paciente; control_paciente.nota = el contenido tal cual. (Ojo: "apunta que <dato suelto, sin nombrar paciente>" es guardar_nota, no esto.)
- ATENDER UN LEAD NUEVO (alguien que te escribió directo, fuera del flujo normal, y quieres que Mia lo tome como lead + le mande el saludo de bienvenida): "atiende a X, su número es 999... / activa el saludo para X / que Mia salude a X, escribió directo" → atender_lead. control_paciente.patient_name = nombre; control_paciente.phone = el número (requerido).
- RETOMAR UN LEAD YA SALUDADO POR TI (Mirai YA lo saludó manualmente fuera de Mia y quiere que Mia siga la conversación SIN volver a presentarse — distinto de atender_lead, que sí manda el saludo): "ya saludé a X yo misma, que Mia siga sin repetir el saludo, su número es 999... / retómalo, ya le escribí / continúa con X, ya la contacté yo" → retomar_lead_saludado. control_paciente.patient_name = nombre; control_paciente.phone = el número (requerido).
- RESPONDER "COMO SI" (Mirai copia/pega algo que el lead YA le escribió fuera de Mia, y quiere que Mia lo procese YA MISMO y responda de una — acción real e inmediata, úsala solo con una frase MUY explícita de este tipo): "que Mia responda como si X hubiera dicho: <texto> / procesa esto como si lo hubiera mandado X: <texto> / hazle como que X escribió <texto> y respóndele" → responder_como_si. control_paciente.patient_name = paciente; control_paciente.nota = el texto exacto que "escribió" el lead.
- RECONECTAR CON UN LEAD/PACIENTE (Mia REDACTA un mensaje cálido retomando el hilo de la conversación guardada — para cuando quedó pendiente o Mirai no llegó a responder): "redáctale un mensaje a X para retomar el contacto / escríbele a X para reconectar / retoma la conversación con X (menciónale la beca de S/45)" → reconectar_lead. control_paciente.patient_name = paciente; control_paciente.nota = alguna indicación extra que dé para orientar el mensaje (o null). Antes de enviar, Mia te muestra la vista previa — le respondes "sí" o "no".
- CONSULTAR MÉTRICAS DEL EMBUDO (Instagram + leads + conversión, NO es lo mismo que consultar_trabajo de GDH): "cómo van mis métricas / cómo va el embudo / cuántos leads entraron esta semana por la pauta / dame las métricas" → consultar_metricas.
- CONFIGURAR LOS STICKERS DE CONTROL (elegir qué sticker pausa/reactiva a Mia con un paciente — Mia te pide que le mandes el sticker DESPUÉS, esto solo arma la captura): "quiero elegir el sticker para parar a Mia / configura el sticker que la silencia / pon el sticker de retomar / cómo están mis stickers / ya configuré los stickers?" → configurar_sticker. sticker.accion = "parar" (elegir el de pausar), "retomar" (elegir el de reactivar), o "estado" (solo consultar cómo están, incluye "cómo van" sin decir cuál).
- LISTAR GRUPOS QUE MIA VIO (utilidad técnica, para configurar el grupo de ITACA): "qué grupos ha visto Mia / dame los JIDs de los grupos / lista de grupos" → listar_grupos.
- AGREGAR PERSONA: "agrega a mi mamá / registra a mi amiga X / anota a mi pareja Y (cumple el <fecha>, su número es ...)" → agregar_persona. persona.name = nombre; persona.relation = vínculo (mamá, pareja, amiga, hermano...); persona.phone si lo da; persona.birthday = ISO YYYY-MM-DD si la da.
- CONTACTO YA HECHO (pasado): "llamé a mi mamá / hablé con X / le escribí a Y / vi a Z / almorcé con W" → contacto_persona. contacto.person = a quién. (Ojo: "recuérdame llamar a X" es recordatorio; "agrega a X" es agregar_persona.)
- ESPIRITUAL (GUARDAR algo espiritual): "hoy agradezco por / doy gracias por / estoy agradecida por" → espiritual, kind "gratitud". "guarda esta oración / quiero orar por" → kind "oracion". "esta lectura / este versículo" → kind "lectura". "una reflexión espiritual / algo que sentí en mi fe" → kind "reflexion".
  espiritual.content = el contenido en breve, tal como lo dice.
- REFLEXIÓN (que Neura RESPONDA pensando con ella): si Mirai reflexiona, plantea una duda o dilema ("¿debería ir o no?"), te pide tu opinión o una perspectiva, se desahoga, piensa en voz alta, o te hace una pregunta personal → reflexion. (Ojo: agradecer/orar es "espiritual", no "reflexion".)
- AYUDA: "¿qué puedes hacer? / ayuda / en qué me ayudas / qué sabes hacer / cómo te uso / opciones" → ayuda.
- Si es solo un "ok / gracias / jaja / 👍" o puro ruido sin intención, intent = "ninguno". CUALQUIER otra cosa que Mirai te diga —una pregunta, un comentario, algo que te cuenta, una duda, pensar en voz alta, o algo que simplemente no calza en las acciones de arriba— usa "reflexion", para que Mia SIEMPRE le responda con calidez. Nunca la dejes sin respuesta.`;

// `cierre` = 'gratitud' | 'animo' | null. Cuando el mensaje de las 10pm hizo la
// pregunta de cierre, Mirai suele responder suelto ("que pude descansar",
// "cansada pero tranquila") sin las palabras que dispararían la intención. El
// contexto se lo decimos al clasificador para que lo entienda — sin forzarlo:
// si en vez de responder dicta un gasto, sigue siendo un gasto.
async function classify(text, cierre = null) {
  const nowLima = new Date().toLocaleString('sv-SE', { timeZone: 'America/Lima' });
  const pista = cierre === 'gratitud'
    ? '\nContexto: hace un rato le preguntaste por qué da gracias hoy. Si su mensaje responde a eso, es intent "espiritual" con kind "gratitud".'
    : cierre === 'animo'
      ? '\nContexto: hace un rato le preguntaste cómo estuvo su ánimo hoy. Si su mensaje responde a eso, es intent "registrar_animo".'
      : '';
  const resp = await miraiOpenai.chat.completions.create({
    model: MIA_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFIER_SYSTEM },
      { role: 'user', content: `Hora actual en Lima: ${nowLima} (-05:00).${pista}\nMirai dice: """${text}"""` },
    ],
  });
  try { return JSON.parse(resp.choices?.[0]?.message?.content ?? '{}'); }
  catch { return { intent: 'ninguno' }; }
}

const money = (n) => `S/ ${Number(Math.abs(n)).toFixed(2)}`;

// Paciente que Mirai nombró y todavía no existe en Neura. Lo recordamos para
// que pueda cerrar el círculo con solo pasar el número ("999888777") o decir
// "sí, regístrala", en vez de dejarla en un callejón sin salida.
let pacientePendiente = null;                 // { nombre, expiraMs }
const PACIENTE_TTL_MS = 30 * 60 * 1000;

function recordarPacienteNuevo(nombre) {
  pacientePendiente = { nombre, expiraMs: Date.now() + PACIENTE_TTL_MS };
}
function pacienteNuevoPendiente() {
  if (!pacientePendiente) return null;
  if (pacientePendiente.expiraMs < Date.now()) { pacientePendiente = null; return null; }
  return pacientePendiente.nombre;
}

// Resuelve un paciente por nombre (coincidencia parcial). Devuelve { patient }
// o { error } con un mensaje listo para responderle a Mirai.
async function resolvePatient(name) {
  if (!name || !name.trim()) return { error: '¿De qué paciente? Dime el nombre 🙂' };
  const limpio = name.trim();
  const { data } = await miraiSupabase
    .from('patients').select('id, nombre, phone').ilike('nombre', `%${limpio}%`).limit(6);
  const rows = data ?? [];
  if (rows.length === 0) {
    // No es un error del que Mirai tenga que salir sola: casi siempre es una
    // paciente NUEVA. Le ofrecemos registrarla y recordamos el nombre.
    recordarPacienteNuevo(limpio);
    return { error: `Todavía no tengo a *${limpio}* en tus pacientes — ¿es nueva? 🌸\n\nPásame su número y la registro al toque (o dime "es nueva" y la creo con lo que tengas).` };
  }
  if (rows.length > 1) return { error: `Tengo varias que coinciden con "${limpio}": ${rows.map((r) => r.nombre).join(', ')}. ¿Cuál? (dime el nombre completo)` };
  return { patient: rows[0] };
}

// Lista por NOMBRE — el teléfono no le sirve para dar seguimiento.
async function listarPacientes(l) {
  const tipo = l?.tipo === 'leads' ? 'leads' : 'pacientes';

  if (tipo === 'pacientes') {
    const rows = await listPacientesActivos();
    if (!rows.length) {
      return { handled: true, reply: 'Todavía no tienes a nadie marcado como paciente 🌸\n\nDime "X ya es mi paciente" y la agrego a tu lista de seguimiento.' };
    }
    // El cuadro que pide Mirai: en qué sesión va cada una y cuánto lleva
    // invertido en su proceso. Todo en una burbuja, para leerlo de un vistazo.
    const lines = rows.map((p) => {
      const ses = p.sesiones ? `sesión ${p.sesiones}` : 'sin sesiones aún';
      const inv = p.invertido ? ` · ${money(p.invertido)} invertido` : '';
      const debe = p.debe > 0.5 ? ` · ⚠️ debe ${money(p.debe)}` : '';
      return `• *${p.nombre}* — ${ses}${inv}${debe}${p.en_pausa ? ' · _en pausa_' : ''}`;
    });
    const totalInv = rows.reduce((a, p) => a + p.invertido, 0);
    const pie = totalInv ? `\n\nTotal invertido por tus pacientes: *${money(totalInv)}*` : '';
    return { handled: true, reply: `🩺 *Tus pacientes* (${rows.length}):\n${lines.join('\n')}${pie}` };
  }

  const origen = ['campaña', 'montsinai', 'organico'].includes(l?.origen) ? l.origen : null;
  const rows = await listLeads(origen);
  if (!rows.length) return { handled: true, reply: `No tengo leads${origen ? ` de ${origen}` : ''} por ahora 🙂` };

  const TITULO = { 'campaña': '📣 De campaña', montsinai: '🏥 De Mont Sinai', organico: '🌱 Orgánicos' };
  if (origen) {
    const lines = rows.slice(0, 20).map((x) => `• ${x.nombre}`);
    const mas = rows.length > 20 ? `\n…y ${rows.length - 20} más` : '';
    return { handled: true, reply: `${TITULO[origen]} (${rows.length}):\n${lines.join('\n')}${mas}\n\n_Son leads, no pacientes_ ✦` };
  }
  const porOrigen = new Map();
  for (const x of rows) porOrigen.set(x.origen, (porOrigen.get(x.origen) || 0) + 1);
  const resumen = [...porOrigen.entries()].map(([o, n]) => `${TITULO[o] ?? o}: *${n}*`).join('\n');
  return { handled: true, reply: `📇 *Tus leads* (${rows.length}):\n${resumen}\n\n_Pídeme "los de campaña" o "los de Mont Sinai" para verlos_ ✦` };
}

async function marcarPaciente(m) {
  if (!m?.name) return { handled: false };
  const { patient, error } = await resolvePatient(m.name);
  if (error) return { handled: true, reply: error };
  const esPaciente = m.es_paciente !== false;
  const updated = await marcarComoPaciente(patient.phone, esPaciente);
  if (!updated) return { handled: true, reply: 'Uy, no pude actualizarla. ¿Me lo repites?' };
  return esPaciente
    ? { handled: true, reply: `✅ *${updated.nombre}* ya está en tu lista de pacientes 🩺\n\nPídeme "mis pacientes" cuando quieras verlos.` }
    : { handled: true, reply: `Listo, saqué a *${updated.nombre}* de tus pacientes (vuelve a leads).` };
}

// Registra una paciente nueva. `phone` puede faltar: en ese caso pedimos el
// número y dejamos el nombre pendiente para el siguiente mensaje.
async function registrarPaciente(p, raw) {
  const nombre = (p?.name || '').trim() || pacienteNuevoPendiente();
  if (!nombre) return { handled: true, reply: '¿Cómo se llama la paciente que quieres registrar? 🙂' };

  const phone = normalizePhone(p?.phone);
  if (!phone) {
    recordarPacienteNuevo(nombre);
    return { handled: true, reply: `Va, registro a *${nombre}* 😊 Pásame su número de WhatsApp y la dejo lista.` };
  }

  try {
    const { duplicated, patient } = await addPatient({ phone, nombre, etiqueta: 'paciente' });
    pacientePendiente = null;
    if (duplicated) {
      return { handled: true, reply: `Ese número ya estaba en tu lista como *${patient?.nombre || nombre}* — no la dupliqué 🙂` };
    }
    return { handled: true, reply: `✅ Registré a *${patient.nombre}* (${patient.phone}).\n\nYa puedes dictarme su nota de sesión, su pago o agendarle cita 🌸` };
  } catch (e) {
    console.error('[neura] registrar paciente:', e.message);
    return { handled: true, reply: `Uy, no pude registrarla: ${e.message}. ¿Me pasas el número de nuevo?` };
  }
}

// ─── Gestión de pacientes en lenguaje natural (antes solo con /comandos) ──
// Reusan los handlers de commands.js (misma lógica que /silenciar, /paquete,
// etc. — cero duplicación) resolviendo el nombre a teléfono con resolvePatient.
function fromCmd(r) {
  return { handled: true, reply: r?.messages?.[0]?.text || '✓ Hecho.' };
}

// Resuelve control_paciente a un teléfono: usa el número directo si lo dan
// (ej. pegó un número de un aviso), si no busca por nombre.
async function resolverTelefono(cp) {
  const directo = normalizePhone(cp?.phone);
  if (directo) return { phone: directo };
  if (cp?.patient_name) {
    const { patient, error } = await resolvePatient(cp.patient_name);
    if (error) return { error };
    return { phone: patient.phone };
  }
  return { error: '¿A quién? Dime el nombre o el número 🙂' };
}

async function silenciarPaciente(cp) {
  const { phone, error } = await resolverTelefono(cp);
  if (error) return { handled: true, reply: error };
  return fromCmd(await cmdSilenciar(phone));
}

async function activarPaciente(cp) {
  const { phone, error } = await resolverTelefono(cp);
  if (error) return { handled: true, reply: error };
  return fromCmd(await cmdActivar(phone));
}

// Contacto personal/de trabajo: acepta nombre (si ya está en el sistema) o
// teléfono directo (lo usual, ya que a menudo nunca escribió).
async function noTocar(cp) {
  let phone = normalizePhone(cp?.phone);
  if (!phone && cp?.patient_name) {
    const { patient } = await resolvePatient(cp.patient_name);
    if (patient) phone = patient.phone;
  }
  if (!phone) return { handled: true, reply: '¿A quién agrego a no tocar? Dame el nombre o el número 🙂' };
  return fromCmd(await cmdNoTocar(phone));
}

async function darDeBaja(cp) {
  const { phone, error } = await resolverTelefono(cp);
  if (error) return { handled: true, reply: error };
  return fromCmd(await cmdRemovePatient(phone));
}

async function agregarNotaPaciente(cp) {
  if (!cp?.patient_name || !cp?.nota?.trim()) return { handled: true, reply: '¿A quién y qué anoto? Dime "anota en la ficha de X que…" 🙂' };
  const { patient, error } = await resolvePatient(cp.patient_name);
  if (error) return { handled: true, reply: error };
  return fromCmd(await cmdAddNote(`${patient.phone} ${cp.nota.trim()}`));
}

async function atenderLead(cp) {
  const phone = normalizePhone(cp?.phone);
  if (!phone || !cp?.patient_name?.trim()) return { handled: true, reply: 'Dame el nombre Y el número para atenderlo 🙂' };
  return fromCmd(await cmdAtenderLead(`${phone} ${cp.patient_name.trim()}`));
}

async function retomarLeadSaludado(cp) {
  const phone = normalizePhone(cp?.phone);
  if (!phone || !cp?.patient_name?.trim()) return { handled: true, reply: 'Dame el nombre Y el número — ya lo saludaste tú y quieres que Mia siga sin repetirlo 🙂' };
  return fromCmd(await cmdRetomarLead(`${phone} ${cp.patient_name.trim()}`));
}

// Inyecta un texto como si el paciente lo hubiera mandado AHORA — Mia lo
// procesa y responde de una. Acción real e inmediata, por eso exige nombre +
// texto explícitos (ver rule RESPONDER "COMO SI").
async function responderComoSi(cp) {
  if (!cp?.patient_name || !cp?.nota?.trim()) {
    return { handled: true, reply: 'Dime el nombre y el texto exacto, así: "que Mia responda como si Fran hubiera dicho: sí, para mí" 🙂' };
  }
  const { patient, error } = await resolvePatient(cp.patient_name);
  if (error) return { handled: true, reply: error };
  return fromCmd(await cmdResponderEnNombreDeLead(`${patient.phone} ${cp.nota.trim()}`));
}

function configurarSticker(s) {
  const accion = s?.accion === 'parar' ? 'parar' : s?.accion === 'retomar' ? 'retomar' : 'estado';
  return fromCmd(cmdSticker(accion));
}

function listarGrupos() {
  return fromCmd(cmdGrupos());
}

async function reconectarLead(cp) {
  if (!cp?.patient_name) return { handled: true, reply: '¿Con quién reconecto? Dime el nombre 🙂' };
  const { patient, error } = await resolvePatient(cp.patient_name);
  if (error) return { handled: true, reply: error };
  return fromCmd(await cmdReconectar(`${patient.phone} ${cp.nota || ''}`.trim()));
}

async function consultarMetricas() {
  return fromCmd(await cmdMetricas());
}

// Ofrece un paquete AÚN NO comprado (tarjeta + preview, distinto de
// crear_paquete que registra uno ya vendido). Requiere confirmación aparte.
async function coordinarPaquete(c) {
  if (!c?.patient_name) return { handled: true, reply: '¿Para quién es el paquete? Dime el nombre 🙂' };
  const n = Number(c.sessions);
  if (!Number.isFinite(n) || n <= 0) return { handled: true, reply: '¿De cuántas sesiones? (normalmente 4 o 6) 🙂' };
  const { patient, error } = await resolvePatient(c.patient_name);
  if (error) return { handled: true, reply: error };
  const objetivo = (c.objetivo || '').trim() || 'continuar su proceso';
  return fromCmd(await cmdPaquete(`${patient.phone} ${patient.nombre} ${n} ${objetivo}`));
}

// Manda un mensaje ABRIENDO la coordinación (sin hora fija todavía). Requiere
// confirmación aparte. Distinto de agendar_cita, que reserva un horario ya.
async function coordinarCita(c) {
  if (!c?.patient_name) return { handled: true, reply: '¿Con quién coordino? Dime el nombre 🙂' };
  const { patient, error } = await resolvePatient(c.patient_name);
  if (error) return { handled: true, reply: error };
  return fromCmd(await cmdAgendar(`${patient.phone} ${patient.nombre}`));
}

// Punto de entrada. { handled:true, reply } si ejecutó algo; { handled:false } si no.
export async function handleNeuraInstruction(text) {
  if (!miraiOpenai || !miraiSupabase || !text) return { handled: false };

  // Atajo: quedó una paciente pendiente de registrar y Mirai manda SOLO el
  // número. No hace falta molestar al clasificador para eso.
  if (/^(?:\+?51)?\s*9\d{2}\s*\d{3}\s*\d{3}$/.test(text.trim()) && pacienteNuevoPendiente()) {
    return registrarPaciente({ name: null, phone: text }, text);
  }

  // Atajo de SEGURIDAD para confirmar/cancelar un envío pendiente (coordinar
  // paquete/cita, reconectar): un "sí"/"no" corto y sin ambigüedad se resuelve
  // por regex, NUNCA por el LLM — así nunca se dispara un envío real a un
  // paciente por una mala interpretación del clasificador. Solo aplica si hay
  // algo pendiente; si no, sigue el flujo normal (un "sí" suelto es "ninguno").
  if (hasPendingEnvio()) {
    const t = text.trim().toLowerCase();
    if (/^(s[ií]|dale|confirmo|confirmar|env[ií]alo|m[aá]ndalo|hazlo)[.!¡]*$/.test(t)) return fromCmd(await cmdConfirmar());
    if (/^(no|cancela|cancelar|mejor no|olv[ií]dalo|no lo mandes)[.!¡]*$/.test(t)) return fromCmd(cmdCancelar());
  }

  const cierre = contextoCierre();

  let parsed;
  try { parsed = await classify(text, cierre); }
  catch (err) { console.error('[neura] classify error:', err.message); return { handled: false }; }

  // Si contestó la pregunta de cierre, la damos por respondida (no se la
  // volvemos a interpretar con lo siguiente que diga esta noche).
  if (cierre && (parsed?.intent === 'espiritual' || parsed?.intent === 'registrar_animo')) {
    limpiarContextoCierre();
  }

  switch (parsed?.intent) {
    case 'aprobar_pr':           return { handled: true, reply: await aprobarPR(parsed.pr?.id ?? null) };
    case 'rehacer_correccion':   return parsed.pr?.id
      ? { handled: true, reply: await rehacerCorreccion(parsed.pr.id) }
      : { handled: true, reply: '¿Cuál corrección rehago? Dime por ejemplo "rehaz la #1" (mira los números con "qué correcciones tengo pendientes").' };
    case 'listar_correcciones':  return { handled: true, reply: formatoListaPendientes(await listPendientes()) };
    case 'descartar_correccion': return parsed.pr?.id
      ? { handled: true, reply: await descartarCorreccion(parsed.pr.id) }
      : { handled: true, reply: '¿Cuál corrección descarto? Dime el número, por ejemplo "descarta la #5".' };
    case 'listar_pacientes':     return listarPacientes(parsed.listado);
    case 'marcar_paciente':      return marcarPaciente(parsed.marcar);
    case 'registrar_paciente':   return registrarPaciente(parsed.paciente_nuevo, text);
    case 'silenciar_paciente':   return silenciarPaciente(parsed.control_paciente);
    case 'activar_paciente':     return activarPaciente(parsed.control_paciente);
    case 'no_tocar':             return noTocar(parsed.control_paciente);
    case 'dar_de_baja':          return darDeBaja(parsed.control_paciente);
    case 'agregar_nota_paciente': return agregarNotaPaciente(parsed.control_paciente);
    case 'atender_lead':         return atenderLead(parsed.control_paciente);
    case 'retomar_lead_saludado': return retomarLeadSaludado(parsed.control_paciente);
    case 'responder_como_si':    return responderComoSi(parsed.control_paciente);
    case 'reconectar_lead':      return reconectarLead(parsed.control_paciente);
    case 'consultar_metricas':   return consultarMetricas();
    case 'coordinar_paquete':    return coordinarPaquete(parsed.coordinacion);
    case 'coordinar_cita':       return coordinarCita(parsed.coordinacion);
    case 'configurar_sticker':   return configurarSticker(parsed.sticker);
    case 'listar_grupos':        return listarGrupos();
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
    case 'consultar_plan':       return handleConsultarPlan(parsed.meta);
    case 'registrar_pago_fijo':  return handleRegistrarPagoFijo(parsed.pagofijo, text);
    case 'consultar_pagos_fijos': return handleConsultarPagosFijos();
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
    case 'consultar_animo':      return consultarAnimo();
    case 'escribir_diario':      return escribirDiario(parsed.diario, text);
    case 'consultar_diario':     return consultarDiario();
    case 'registrar_habito':     return registrarHabito(parsed.habito, text);
    case 'agregar_persona':      return agregarPersona(parsed.persona, text);
    case 'contacto_persona':     return contactoPersona(parsed.contacto);
    case 'consultar_gdh':        return consultarGdh();
    case 'registrar_trabajo':    return handleRegistrarTrabajo(parsed.trabajo, text);
    case 'consultar_trabajo':    return handleConsultarTrabajo();
    case 'reporte_gdh':          return handleReporteGdh();
    case 'reporte':              return hacerReporte(text);
    case 'reporte_pdf':          return enviarReportePdf();
    case 'espiritual':           return registrarEspiritual(parsed.espiritual, text);
    case 'reflexion':            return reflexionar(text);
    case 'ayuda':                return ayudaMenu();
    default: return { handled: false };
  }
}

// ---- Fotos que Mirai le manda a Mia (visión): Yape → pago; escrito → diario ----
export async function handleNeuraImage(media) {
  if (!miraiOpenai || !miraiSupabase || !media?.base64) return { handled: false };
  const info = await analizarFotoMirai(media);
  if (!info) return { handled: true, reply: 'Uy, no pude leer bien la imagen. ¿Me la reenvías más nítida? 🙂' };
  if (info.tipo === 'pago' && info.pago) return pagoDesdeFoto(info.pago);
  if (info.tipo === 'escrito' && info.texto) return escritoDesdeFoto(info, media);
  return {
    handled: true,
    reply: info.descripcion
      ? `Vi tu imagen (${info.descripcion}). ¿Qué hago con ella? Puedo leer un Yape para registrar el pago, o transcribir algo escrito ✦`
      : '¿Qué hago con esta imagen? Puedo registrar un Yape o transcribir una nota escrita 🙂',
  };
}

async function pagoDesdeFoto(pago) {
  const monto = Number(pago.monto_pen);
  if (!Number.isFinite(monto) || monto <= 0) return { handled: true, reply: 'Vi un comprobante pero no pude leer bien el monto. ¿De cuánto fue? 🙂' };
  const metodo = ['yape', 'plin', 'transferencia', 'efectivo'].includes(pago.metodo) ? pago.metodo : null;
  const nombre = (pago.pagador || '').trim();
  if (nombre) {
    const { patient } = await resolvePatient(nombre);
    if (patient) {
      const { error } = await miraiSupabase.from('payments').insert({
        patient_id: patient.id, amount: monto, currency: 'PEN', method: metodo,
        concept: 'sesión', verified: true, source: 'auto-comprobante',
      });
      if (!error) {
        const saldo = await balancePaciente(patient.id);
        const saldoLine = saldo > 0.5 ? `\nAún debe: *${money(saldo)}*.` : '\n¡Al día! ✅';
        return { handled: true, reply: `💰 Leí el Yape: *${money(monto)}* de ${patient.nombre}${metodo ? ` (${metodo})` : ''}.${saldoLine}\nLo ves en Neura → Pacientes ✦` };
      }
    }
  }
  // No identifiqué a la paciente por la foto → lo anoto como ingreso y le doy el camino.
  await logFinanceToSheet({
    direction: 'ingreso', amount: monto, category: 'Consulta',
    description: nombre ? `Pago de ${nombre} (foto)` : 'Pago recibido (foto)', source: 'auto',
  });
  return { handled: true, reply: `💰 Leí un pago de *${money(monto)}*${nombre ? ` de ${nombre}` : ''} y lo anoté como ingreso en tu hoja de Finanzas.\nSi es de una paciente y quieres enlazarlo a su ficha, dime "${nombre || 'Ana'} me pagó ${monto}" 🙂` };
}

async function escritoDesdeFoto(info, media) {
  const texto = info.texto.trim();
  // Guarda la foto (best-effort) en el bucket privado + la transcripción al diario.
  let fotoPath = null;
  try {
    const buf = Buffer.from(media.base64, 'base64');
    const ext = (media.mimetype || '').includes('png') ? 'png' : 'jpg';
    fotoPath = `diario/${Date.now()}.${ext}`;
    const { error: upErr } = await miraiSupabase.storage.from(config.neura.stateBucket)
      .upload(fotoPath, buf, { contentType: media.mimetype || 'image/jpeg', upsert: true });
    if (upErr) { fotoPath = null; console.error('[neura] foto upload:', upErr.message); }
  } catch (e) { console.error('[neura] foto buffer:', e.message); fotoPath = null; }
  const { error } = await miraiSupabase.from('journal').insert({
    content: texto, source: 'foto', raw_text: fotoPath ? `foto:${fotoPath}` : null,
  });
  if (error) {
    console.error('[neura] escrito insert:', error.message);
    return { handled: true, reply: `📔 Lo transcribí:\n\n"${texto.slice(0, 400)}"\n\n(pero no pude guardarlo, ¿lo reintento?)` };
  }
  const preview = texto.length > 300 ? texto.slice(0, 300) + '…' : texto;
  return { handled: true, reply: `📔 Transcribí y guardé en tu diario${fotoPath ? ' (con la foto)' : ''}:\n\n"${preview}"\n\nLo ves en Neura → Bienestar → Diario ✦` };
}

// `items` puede traer VARIOS movimientos en un solo mensaje (ej: un listado de
// cargos de tarjeta). Aceptamos también un objeto suelto por compatibilidad,
// por si el modelo no envuelve en lista.
async function registrarFinanza(items, raw) {
  const lista = Array.isArray(items) ? items : (items ? [items] : []);
  if (!lista.length) return { handled: false };

  const anotados = [];
  let fallaron = 0;
  for (const f of lista) {
    const amount = Number(f?.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const direction = f.direction === 'ingreso' ? 'ingreso' : 'gasto';
    const category = (f.category || 'Otros').trim();
    // Cuenta opcional ("...con el BBVA / en efectivo"): solo va como ETIQUETA
    // en la hoja — a diferencia de Finanzas v2 (ajustar_saldo), esto ya NO
    // actualiza el saldo de la cuenta en Neura (decisión de Mirai: ingresos/
    // gastos sueltos viven solo en la hoja de cálculo, no en Supabase).
    let accountName = null;
    if (f.account && f.account.trim()) {
      const r = await resolveAccount(f.account);
      if (r.account) accountName = r.account.name;
    }
    const r = await logFinanceToSheet({
      direction, amount, category,
      description: f.description?.trim() || null,
      account: accountName, source: 'voz',
    });
    if (!r.ok) { console.error('[neura] finanza sheet:', r.error); fallaron++; continue; }
    const emoji = direction === 'ingreso' ? '💰' : '💸';
    const desc = f.description ? ` (${f.description.trim()})` : '';
    const cuenta = accountName ? ` · ${accountName}` : '';
    anotados.push(`${emoji} ${money(amount)} · ${category}${desc}${cuenta}`);
  }

  if (!anotados.length) {
    return { handled: true, reply: fallaron ? 'Uy, no pude anotarlo en tu hoja ahora. ¿Me lo repites en un momento?' : '¿Cuánto fue? Dímelo así: "gasté 8 soles en un café" 🙂' };
  }
  const aviso = fallaron ? `\n(${fallaron} no se pudo anotar, reinténtalo)` : '';
  const cuerpo = anotados.length === 1 ? anotados[0] : anotados.map((a) => `• ${a}`).join('\n');
  const titulo = anotados.length === 1 ? '' : `Anotados ${anotados.length} movimientos:\n`;
  return { handled: true, reply: `${titulo}${cuerpo}${aviso}\nLo ves en tu hoja de Finanzas ✦` };
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
  // Cada sesión atendida cuesta el alquiler del consultorio: se registra solo
  // para que el resumen de finanzas muestre lo que de verdad le queda.
  const costo = await registrarCostoConsultorio({ phone: patient.phone, nombre: patient.nombre });
  const costoLinea = costo ? `\n_Anoté ${money(costo)} de consultorio_` : '';
  return { handled: true, reply: `📝 Nota de sesión guardada para ${patient.nombre}.${tarea}${prox}${paqLinea}${costoLinea}\nLa ves en Neura → Pacientes ✦` };
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
  const { deudores, total } = await deudoresPacientes();
  if (!deudores.length) return { handled: true, reply: '✅ ¡Nadie te debe! Todos tus pacientes están al día 🎉' };
  const lines = deudores.map((d) => `• ${d.nombre}: *${money(d.saldo)}*`).join('\n');
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
// Una hora después del inicio, conservando la hora de pared de Lima.
function masUnaHora(startISO) {
  const t = new Date(startISO).getTime();
  if (!Number.isFinite(t)) return null;
  const s = new Date(t + 60 * 60 * 1000).toLocaleString('sv-SE', { timeZone: 'America/Lima' });
  return `${s.slice(0, 10)}T${s.slice(11, 19)}-05:00`;
}

function rangoBloqueo(b) {
  const startISO = b?.start_iso;
  if (!startISO) return null;
  let endISO = b?.end_iso || null;
  if (!endISO || new Date(endISO).getTime() <= new Date(startISO).getTime()) {
    // Sin fin explícito: si dio una HORA concreta, bloqueamos SOLO esa hora.
    // Antes se tapaba hasta medianoche, así que una clasificación errónea le
    // borraba el día entero (caso real del 13 ago: "…la señora Monica
    // confirmó para el día martes 18 9:00am" se leyó como bloqueo y dejó el
    // martes tapado de 9am a 11:59pm). Solo se bloquea el día completo cuando
    // no mencionó hora (el ISO viene a las 00:00).
    const horaPared = Number(String(startISO).slice(11, 13));
    endISO = horaPared === 0 ? finDelDiaLima(startISO) : masUnaHora(startISO);
  }
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
  const [sesRes, todasRes, pagRes, saldo, upc] = await Promise.all([
    miraiSupabase.from('sessions').select('summary, homework, next_focus').eq('patient_id', patient.id).order('created_at', { ascending: false }).limit(1),
    miraiSupabase.from('sessions').select('id', { count: 'exact', head: true }).eq('patient_id', patient.id),
    miraiSupabase.from('payments').select('amount').eq('patient_id', patient.id),
    balancePaciente(patient.id),
    patient.phone && isCalendarEnabled() ? getUpcoming({ phone: patient.phone }) : Promise.resolve({ hasAppointment: false }),
  ]);
  const nSesiones = todasRes.count ?? 0;
  const invertido = (pagRes.data ?? []).reduce((a, x) => a + Number(x.amount || 0), 0);

  const partes = [`👤 *${patient.nombre}*`];
  partes.push(`*Va en la sesión:* ${nSesiones || '—'}${invertido ? ` · *invertido:* ${money(invertido)}` : ''}`);
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

// Tendencia de ánimo de los últimos 30 días (promedio + recientes).
async function consultarAnimo() {
  const desde = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data } = await miraiSupabase.from('moods')
    .select('mood, score, created_at').gte('created_at', desde).order('created_at', { ascending: false }).limit(60);
  const rows = data ?? [];
  if (!rows.length) return { handled: true, reply: 'Aún no tengo check-ins de ánimo tuyos este mes. Cuéntame cómo te sientes cuando quieras 💗' };
  const conScore = rows.filter((r) => Number.isFinite(Number(r.score)));
  let linea;
  if (conScore.length) {
    const avg = conScore.reduce((a, r) => a + Number(r.score), 0) / conScore.length;
    const cara = avg >= 4 ? '🙂' : avg >= 3 ? '😌' : avg >= 2 ? '😔' : '💗';
    linea = `Tu promedio es *${avg.toFixed(1)}/5* ${cara} (${conScore.length} check-ins).`;
  } else {
    linea = `Van ${rows.length} check-ins este mes.`;
  }
  const ultimos = rows.slice(0, 5).map((r) => r.mood).filter(Boolean);
  const recientes = ultimos.length ? `\nÚltimos: ${ultimos.join(', ')}.` : '';
  return { handled: true, reply: `💗 *Tu ánimo (últimos 30 días):*\n${linea}${recientes}\nEstoy aquí para lo que necesites 🤍` };
}

const fechaCortaLima = (d) => {
  try { return new Date(`${d}T12:00:00-05:00`).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' }); }
  catch { return d; }
};

async function escribirDiario(d, raw) {
  if (!d || !d.content || !d.content.trim()) return { handled: false };
  const { error } = await miraiSupabase.from('journal').insert({ content: d.content.trim(), source: 'voz', raw_text: raw });
  if (error) { console.error('[neura] diario insert:', error.message); return { handled: true, reply: 'Uy, no pude guardar tu diario. ¿Me lo repites?' }; }
  return { handled: true, reply: `📔 Guardé tu entrada de diario.\nCuando quieras te la leo: "léeme mi diario" ✦` };
}

async function consultarDiario() {
  const { data } = await miraiSupabase.from('journal')
    .select('content, entry_date').order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(4);
  const rows = data ?? [];
  if (!rows.length) return { handled: true, reply: 'Tu diario está en blanco por ahora. Dime "escribe en mi diario: ..." cuando quieras 🙂' };
  const bloques = rows.map((r) => `📔 *${fechaCortaLima(r.entry_date)}*\n${r.content}`).join('\n\n');
  return { handled: true, reply: `Tus últimas entradas:\n\n${bloques} ✦` };
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
{"pagos":[{"patient_name":string,"amount":number}],"cargos":[{"patient_name":string,"amount":number}],"gastos":[{"amount":number,"category":string,"description":string}],"ingresos":[{"amount":number,"category":string,"description":string}]}
- pago = un paciente le PAGÓ/abonó N soles.
- cargo = un paciente le DEBE / quedó debiendo N soles.
- gasto = Mirai gastó/compró/pagó N soles (gasto personal).
- ingreso = a Mirai le entró/depositaron/cobró/prestaron N soles (que NO sea de un paciente — eso es "pago").
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
    const r = await logFinanceToSheet({ direction: 'gasto', amount, category: g.category || 'Otros', description: g.description || null, source: 'voz' });
    if (r.ok) saved.push(`💸 gasto ${money(amount)}`);
  }
  for (const i of parsed.ingresos ?? []) {
    const amount = Number(i.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const r = await logFinanceToSheet({ direction: 'ingreso', amount, category: i.category || 'Otros', description: i.description || null, source: 'voz' });
    if (r.ok) saved.push(`💰 ingreso ${money(amount)}`);
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

💰 *Plata* — "gasté 20 con el BBVA" · "¿cuánto tengo en el BCP?" · "le aboné 100 a César" · "¿a quién le debo?" · "mete 50 a mi meta de Georgia" · "¿cuál es mi plan para Italia?" · "agrega Netflix 30 el día 15" · "¿qué pagos me tocan?" · "¿en qué se me fue la plata?"
🩺 *Consultorio* — "terminé con Ana, trabajamos…" · "Ana me pagó 105" · "Ana compró un paquete de 6" · "¿cuántas sesiones le quedan a Ana?" · "¿quién me debe?" · "¿qué trabajé con Ana?" · "agéndame a Ana el martes 4pm"
🗓️ *Tu día* — "¿qué tengo hoy?" · "¿qué tengo esta semana?" · "recuérdame las pastillas a las 9" · "posponlo a mañana" · "ya tomé las pastillas" · "bloquéame el lunes de 5 a 6pm"
🫂 *Tu gente* — "agrega a mi mamá" · "llamé a mi mamá"
🫀 *Tú* — "tomé 2 litros de agua" · "dormí 6 horas" · "hoy me siento cansada" · "¿cómo va mi ánimo?" · "escribe en mi diario: hoy…" · "hoy agradezco por…"
💼 *Trabajo (GDH)* — "apunta un logro: bajé AgendaPro de 540 a 100" · "¿cómo va mi trabajo?" · "hazme el reporte de GDH"
📝 *Recordar y pensar* — "apunta que el wifi es…" · "hazme un reporte de…" · "ayúdame a pensar si…"

Y si solo quieres conversar o pensar algo conmigo, también estoy aquí 💛`;
  return { handled: true, reply: txt };
}
