// =====================================================================
// MIA — Apps Script: CRM de leads de la Psicóloga Mirai
// =====================================================================
// Bound a un Sheet nuevo creado por Mirai (ej: "Mia — CRM Leads").
// Pestaña: "Leads" (la crea automáticamente setupSheet()).
//
// CÓMO INSTALAR (una sola vez):
//   1. Crear un Google Sheet nuevo (ej: "Mia — CRM Leads") con tu cuenta personal.
//   2. Extensiones → Apps Script. Borrar el código por defecto.
//   3. Pegar este archivo entero.
//   4. Configuración del proyecto (engranaje izq) → Propiedades del script:
//      - Agregar propiedad: MIA_SECRET
//      - Valor: ejecutar generateSecret() en el editor para que sugiera uno
//        (Ejecutar → seleccionar generateSecret → ver el log → copiar)
//      - Guardar.
//   5. Ejecutar setupSheet() UNA VEZ desde el editor (Run → setupSheet).
//      Esto crea la pestaña "Leads" con headers + formato.
//      Autoriza permisos cuando lo pida.
//   6. Deploy → New deployment → Web app:
//      - Description: "Mia CRM v1"
//      - Execute as: Me (tu cuenta)
//      - Who has access: Anyone
//      - Deploy. Copiar la URL del Web app.
//   7. Pasar la URL a Claude para meterla en EasyPanel como MIA_SHEET_WEBHOOK_URL
//      y el secret como MIA_SHEET_WEBHOOK_SECRET.
//
// SETUP DEL CALENDARIO (Fase 3 — hacer también una vez):
//   8. Ejecutar setupCalendar()    → autoriza permisos de Calendar y te muestra
//      qué calendario usará Mia (tu calendario PRINCIPAL de Google).
//   9. Ejecutar installHoldTrigger() → trigger horario que limpia holds vencidos.
//  10. Re-deployar: Deploy → Manage deployments → (editar el deployment) →
//      Version: New version → Deploy. Así las acciones de calendario quedan
//      publicadas en la MISMA URL (no cambia el MIA_SHEET_WEBHOOK_URL).
//      (Ver el bloque CALENDARIO más abajo para el detalle.)
// =====================================================================

const SHEET_NAME = 'Leads';
const REPORT_SHEET_NAME = 'Reporte';

// Columnas en orden. La primera de cada bloque es la key que usa el código JS.
const COLS = [
  { key: 'fecha_alta',          header: 'Fecha alta',          width: 110 },
  { key: 'ultima_interaccion',  header: 'Última interacción',  width: 110 },
  { key: 'phone',               header: 'Teléfono',            width: 120 },
  { key: 'nombre',              header: 'Nombre',              width: 200 },
  { key: 'estado',              header: 'Estado',              width: 140 },
  { key: 'etiqueta',            header: 'Etiqueta',            width: 110 },
  { key: 'para_quien',          header: 'Para quién',          width: 100 },
  { key: 'edad',                header: 'Edad',                width: 60  },
  { key: 'procedencia',         header: 'Procedencia',         width: 140 },
  { key: 'sede_ok',             header: 'Sede OK',             width: 80  },
  { key: 'motivo',              header: 'Motivo',              width: 280 },
  { key: 'horarios_propuestos', header: 'Horarios propuestos', width: 200 },
  { key: 'nota_interna',        header: 'Nota interna',        width: 280 },
];
const TOTAL_COLS = COLS.length;

// Estados sugeridos (libres — Mia los va seteando desde su JSON datos_lead).
const ESTADOS_SUGERIDOS = [
  'nuevo', 'datos_parciales', 'motivo_dado', 'ubicacion_ok',
  'horarios_dados', 'precio_acordado', 'listo_para_escalar',
  'agendado', 'paciente_activo', 'rechazado', 'no_responde',
];

// ─── Helpers de auth + JSON ──────────────────────────────────────────
function getSecret() {
  return PropertiesService.getScriptProperties().getProperty('MIA_SECRET') || '';
}

function json(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok(data)   { return json({ ok: true,  data }); }
function err(msg)   { return json({ ok: false, error: msg }); }

// ─── Endpoint principal ──────────────────────────────────────────────
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (ex) { return err('invalid JSON'); }

  const secret = getSecret();
  if (!secret) return err('MIA_SECRET no configurado en Script Properties');
  if (body.secret !== secret) return err('unauthorized');

  try {
    switch (body.action) {
      case 'ping':        return ok({ pong: true, at: new Date().toISOString() });
      case 'upsertLead':  return ok(upsertLead(body.data || {}));
      case 'listLeads':   return ok(listLeads(body.filter || {}));
      case 'writeReport': return ok(writeReport(body.report || {}));
      // ─── Calendario (Fase 3) ───
      case 'checkAvailability':  return ok(checkAvailability(body.data || {}));
      case 'createAppointment':  return ok(createAppointment(body.data || {}));
      case 'confirmAppointment': return ok(confirmAppointment(body.data || {}));
      case 'getUpcoming':        return ok(getUpcoming(body.data || {}));
      case 'expireHolds':        return ok(expireHolds());
      default:            return err('unknown action: ' + body.action);
    }
  } catch (ex) {
    return err('exception: ' + ex.message);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput('Mia CRM — usa POST con action=ping para verificar')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ─── Setup (correr UNA vez desde el editor) ──────────────────────────
function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  // Headers
  const headers = COLS.map(c => c.header);
  sh.getRange(1, 1, 1, TOTAL_COLS).setValues([headers])
    .setFontWeight('bold').setBackground('#f1f3f4').setHorizontalAlignment('left');
  sh.setFrozenRows(1);

  // Anchos
  COLS.forEach((c, i) => sh.setColumnWidth(i + 1, c.width));

  // Validación del estado (dropdown sugerido, pero permite escribir libres)
  const estadoCol = COLS.findIndex(c => c.key === 'estado') + 1;
  if (estadoCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(ESTADOS_SUGERIDOS, true)
      .setAllowInvalid(true)
      .build();
    sh.getRange(2, estadoCol, sh.getMaxRows() - 1, 1).setDataValidation(rule);
  }

  // Formato de fechas
  const fechaAltaCol = COLS.findIndex(c => c.key === 'fecha_alta') + 1;
  const ultimaCol    = COLS.findIndex(c => c.key === 'ultima_interaccion') + 1;
  if (fechaAltaCol > 0) sh.getRange(2, fechaAltaCol, sh.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
  if (ultimaCol    > 0) sh.getRange(2, ultimaCol,    sh.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');

  return 'OK — pestaña Leads configurada.';
}

function generateSecret() {
  const s = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  Logger.log('Secret sugerido (cópialo a Script Properties como MIA_SECRET):');
  Logger.log(s);
  return s;
}

// ─── Upsert: busca por teléfono, si existe UPDATE, si no INSERT ──────
function upsertLead(data) {
  const sh = ensureSheet();
  if (!data.phone) throw new Error('phone es requerido');

  const phoneCol = COLS.findIndex(c => c.key === 'phone') + 1;
  const lastRow = sh.getLastRow();
  let rowIndex = -1;

  if (lastRow >= 2) {
    const phones = sh.getRange(2, phoneCol, lastRow - 1, 1).getValues();
    for (let i = 0; i < phones.length; i++) {
      if (String(phones[i][0]) === String(data.phone)) {
        rowIndex = i + 2;
        break;
      }
    }
  }

  const now = new Date();

  if (rowIndex < 0) {
    // INSERT — nueva fila
    const newRow = COLS.map(c => {
      if (c.key === 'fecha_alta')         return now;
      if (c.key === 'ultima_interaccion') return now;
      return data[c.key] ?? '';
    });
    sh.appendRow(newRow);
    return { mode: 'inserted', row: sh.getLastRow() };
  } else {
    // UPDATE — solo sobreescribe campos que vienen con valor (no pisa con vacío)
    const range = sh.getRange(rowIndex, 1, 1, TOTAL_COLS);
    const existing = range.getValues()[0];
    const updated = COLS.map((c, i) => {
      if (c.key === 'fecha_alta')         return existing[i]; // nunca cambia
      if (c.key === 'ultima_interaccion') return now;
      const incoming = data[c.key];
      if (incoming === undefined || incoming === null || incoming === '') return existing[i];
      return incoming;
    });
    range.setValues([updated]);
    return { mode: 'updated', row: rowIndex };
  }
}

// ─── List (opcional) ────────────────────────────────────────────────
function listLeads(filter) {
  const sh = ensureSheet();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { rows: [], count: 0 };
  const values = sh.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  const rows = values.map(v => {
    const obj = {};
    COLS.forEach((c, i) => obj[c.key] = v[i]);
    return obj;
  });
  let filtered = rows;
  if (filter.estado)  filtered = filtered.filter(r => String(r.estado).toLowerCase().includes(String(filter.estado).toLowerCase()));
  if (filter.phone)   filtered = filtered.filter(r => String(r.phone) === String(filter.phone));
  return { rows: filtered, count: filtered.length };
}

function ensureSheet() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error(`Pestaña "${SHEET_NAME}" no existe. Corre setupSheet() primero.`);
  return sh;
}

// ─── Reporte: reescribe la pestaña "Reporte" con el resumen ya calculado ──
// El cálculo lo hace el bot (Node, desde Supabase) y aquí solo lo pintamos.
// Devuelve la URL de la hoja para que Mia se la mande a Mirai por WhatsApp.
function writeReport(report) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(REPORT_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(REPORT_SHEET_NAME);
  sh.clear();

  const rows = [];
  const sectionRows = [];
  const n = (v) => (v === undefined || v === null ? 0 : v);
  function push(a, b) { rows.push([a, b === undefined ? '' : b]); return rows.length; }

  const titleRow = push('Mía — Reporte de leads', '');
  push('Actualizado:', report.generadoEn || '');
  push('', '');

  const resumen = report.resumen || {};
  sectionRows.push(push('RESUMEN', ''));
  push('Leads esta semana', n(resumen.semana));
  push('Leads este mes',    n(resumen.mes));
  push('Leads en total',    n(resumen.total));
  push('', '');

  sectionRows.push(push('POR ESTADO (todos)', ''));
  (report.porEstado || []).forEach(function (e) { push(e.label, n(e.n)); });
  push('', '');

  sectionRows.push(push('POR FUENTE (este mes)', ''));
  (report.porFuente || []).forEach(function (f) { push(f.label, n(f.n)); });
  push('', '');

  const c = report.conversion || {};
  sectionRows.push(push('CONVERSIÓN (este mes)', ''));
  push('Llegaron a agendar', n(c.num) + ' de ' + n(c.den) + ' (' + n(c.pct) + '%)');

  sh.getRange(1, 1, rows.length, 2).setValues(rows);

  // Formato
  sh.getRange(titleRow, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 1, 1, 2).setFontColor('#666666');
  sectionRows.forEach(function (r) {
    sh.getRange(r, 1, 1, 2).setFontWeight('bold').setBackground('#f1f3f4');
  });
  sh.getRange(1, 2, rows.length, 1).setHorizontalAlignment('left');
  sh.setColumnWidth(1, 230);
  sh.setColumnWidth(2, 170);
  sh.setFrozenRows(0);

  return { url: ss.getUrl(), tab: REPORT_SHEET_NAME };
}

// =====================================================================
// CALENDARIO (Fase 3) — agenda de citas de Mirai vía CalendarApp
// =====================================================================
// Este Apps Script corre "como Mirai" (Execute as: Me), así que CalendarApp
// lee/escribe en SU Google Calendar PRINCIPAL. Mia ve la agenda real de Mirai:
// si el turno de la plantilla está libre en su calendario, lo ofrece; cuando se
// agenda, el evento queda en su calendario. (Se puede apuntar a otro calendario
// con la Script Property MIA_CALENDAR_ID — ver getCal().)
//
// MODELO DE CITA:
//   - HOLD (tentativo): evento naranja, título "⏳ HOLD — <nombre>".
//     Se crea cuando el paciente elige un horario, ANTES de pagar.
//   - CONFIRMADA: evento verde, título "✅ <nombre>".
//     El hold pasa a confirmada cuando el paciente envía el comprobante.
//   - Un solo hold activo por teléfono: crear uno nuevo libera el anterior.
//   - Un hold sin confirmar caduca a las HOLD_TTL_HORAS y deja de bloquear
//     el slot (además expireHolds() los borra; instalar con installHoldTrigger()).
//   - Mia solo toca eventos que ELLA creó (los identifica por el "phone" en la
//     descripción), nunca tus eventos personales. Los de día completo no cuentan.
//
// SETUP CALENDARIO (una vez, desde el editor):
//   1. Ejecutar setupCalendar()  → autoriza permisos de Calendar y te dice qué
//      calendario va a usar (tu principal). Verás su nombre/ID en el log.
//   2. Ejecutar installHoldTrigger() → instala el trigger horario que
//      limpia holds vencidos.
//   3. Re-deployar el Web app (Deploy → Manage deployments → editar → New
//      version) para que las nuevas acciones queden publicadas.
// =====================================================================

const CAL_TZ         = 'America/Lima';   // Perú es UTC-5 todo el año (sin DST)
const CAL_OFFSET     = '-05:00';
const APPT_DURATION_MIN = 45;            // primera consulta: bloque de 45 min
const HOLD_TTL_HORAS = 24;               // hold sin pago deja de bloquear a las 24h
const HOLD_PREFIX    = '⏳ HOLD — ';
const OK_PREFIX      = '✅ ';
const CAL_PROP_KEY   = 'MIA_CALENDAR_ID';

// Plantilla semanal de turnos posibles. Clave = día (ISO: 1=Lun … 7=Dom),
// valor = horas "HH:mm" en hora de Lima. Estas son TODAS las horas en que Mirai
// PODRÍA atender; Mia ofrece solo las que estén LIBRES en su Google Calendar
// (lo que ella bloquee en su calendario, Mia lo saltea). MANTENER EN SYNC con
// la lista de HORARIOS DE ATENCIÓN del prompt de Mia.
const WEEKLY_SLOTS = {
  1: ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00'], // Lunes
  2: ['08:00','09:00','10:00','11:00','12:00','13:00','15:00','16:00','17:00'],                 // Martes
  3: ['08:00','09:00','10:00','11:00','12:00','13:00','17:00'],                                 // Miércoles
  4: ['08:00','09:00','10:00','11:00','12:00','13:00','15:00','16:00','17:00','19:00'],         // Jueves
  5: ['08:00','09:00','10:00','11:00','12:00','13:00'],                                         // Viernes
  6: ['12:00','14:00'],                                                                         // Sábado
};

// ─── Resolución del calendario ───────────────────────────────────────
// Por defecto Mia usa el calendario PRINCIPAL de Mirai (este Apps Script corre
// "como ella"), así ve su agenda REAL: si el turno está libre en SU calendario
// lo ofrece, y cuando se agenda el evento aparece en SU calendario.
// Override opcional: si seteás la Script Property MIA_CALENDAR_ID con el ID de
// otro calendario, usa ése en lugar del principal.
function getCal() {
  const id = PropertiesService.getScriptProperties().getProperty(CAL_PROP_KEY);
  if (id) {
    const c = CalendarApp.getCalendarById(id);
    if (c) return c;
  }
  return CalendarApp.getDefaultCalendar();
}

function setupCalendar() {
  const cal = getCal();
  Logger.log('Mia leerá/escribirá en tu calendario: "' + cal.getName() + '"');
  Logger.log('ID: ' + cal.getId());
  Logger.log('(Si querés que use OTRO calendario, seteá la Script Property MIA_CALENDAR_ID con su ID.)');
  return 'OK — Mia usará el calendario: ' + cal.getName();
}

function installHoldTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'expireHolds') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('expireHolds').timeBased().everyHours(1).create();
  return 'OK — trigger expireHolds (cada 1h) instalado.';
}

// ─── Helpers de fecha/evento ─────────────────────────────────────────
function toLimaISO(d) {
  // "2026-06-22T16:00:00-05:00"
  return Utilities.formatDate(d, CAL_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function slotDate(yyyy, mm, dd, hhmm) {
  // Construye un Date a partir de ISO con offset fijo de Lima — inmune al TZ
  // del proyecto Apps Script.
  return new Date(Utilities.formatString('%04d-%02d-%02dT%s:00%s', yyyy, mm, dd, hhmm, CAL_OFFSET));
}

function isHold(ev)  { return ev.getTitle().indexOf(HOLD_PREFIX) === 0; }

function isExpiredHold(ev) {
  if (!isHold(ev)) return false;
  const created = ev.getDateCreated();
  return (new Date().getTime() - created.getTime()) > HOLD_TTL_HORAS * 3600000;
}

function setColor(ev, tentative) {
  try {
    ev.setColor(tentative ? CalendarApp.EventColor.ORANGE : CalendarApp.EventColor.GREEN);
  } catch (e) { /* algunas cuentas no permiten setColor — no es crítico */ }
}

function buildDesc(o) {
  return 'phone: ' + (o.phone || '') +
       '\nmotivo: ' + (o.motivo || '') +
       '\nestado: ' + (o.estado || '') +
       '\nvia: Mia';
}

function descPhone(ev) {
  const m = String(ev.getDescription() || '').match(/phone:\s*([0-9]+)/);
  return m ? m[1] : '';
}

function setEstadoInDesc(desc, estado) {
  if (/estado:\s*\S+/.test(desc)) return desc.replace(/estado:\s*\S+/, 'estado: ' + estado);
  return (desc || '') + '\nestado: ' + estado;
}

// ¿El slot start coincide EXACTAMENTE con un turno de la plantilla?
function isTemplateSlot(start) {
  const dow  = Number(Utilities.formatDate(start, CAL_TZ, 'u'));   // 1=Lun … 7=Dom
  const hhmm = Utilities.formatDate(start, CAL_TZ, 'HH:mm');
  const times = WEEKLY_SLOTS[dow] || [];
  return times.indexOf(hhmm) >= 0;
}

// ¿El rango [start,end) está libre en el calendario de Mirai?
// - Los eventos de DÍA COMPLETO (cumpleaños, recordatorios) NO bloquean —
//   suelen ser informativos y bloquearían turnos sin sentido.
// - Los holds vencidos NO bloquean (se liberan solos).
// - Cualquier otro evento con hora (cita real, compromiso de Mirai) SÍ bloquea.
function isFree(cal, start, end) {
  const events = cal.getEvents(start, end);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.isAllDayEvent()) continue;
    if (isExpiredHold(ev)) continue;
    return false;
  }
  return true;
}

// ─── Acción: disponibilidad real ─────────────────────────────────────
function checkAvailability(data) {
  const cal = getCal();
  const daysAhead = Math.min(Math.max(Number(data.daysAhead) || 14, 1), 30);
  const now = new Date();
  const minStart = now.getTime() + 60 * 60000; // no ofrecer slots a menos de 1h
  const slots = [];

  for (let i = 0; i <= daysAhead; i++) {
    const day = new Date(now.getTime() + i * 86400000);
    const y   = Number(Utilities.formatDate(day, CAL_TZ, 'yyyy'));
    const mo  = Number(Utilities.formatDate(day, CAL_TZ, 'MM'));
    const d   = Number(Utilities.formatDate(day, CAL_TZ, 'dd'));
    const dow = Number(Utilities.formatDate(day, CAL_TZ, 'u'));
    const times = WEEKLY_SLOTS[dow];
    if (!times) continue;

    for (let t = 0; t < times.length; t++) {
      const start = slotDate(y, mo, d, times[t]);
      if (start.getTime() < minStart) continue;
      const end = new Date(start.getTime() + APPT_DURATION_MIN * 60000);
      if (isFree(cal, start, end)) {
        slots.push({ startISO: toLimaISO(start), endISO: toLimaISO(end) });
      }
    }
  }
  return { slots: slots, count: slots.length };
}

// ─── Acción: crear cita (hold tentativo por defecto) ─────────────────
function createAppointment(data) {
  const cal = getCal();
  const phone = String(data.phone || '');
  if (!phone)        throw new Error('phone requerido');
  if (!data.startISO) throw new Error('startISO requerido');

  const start = new Date(data.startISO);
  if (isNaN(start.getTime())) return { ok: false, error: 'startISO inválido' };
  if (!isTemplateSlot(start))  return { ok: false, error: 'ese horario no es un turno disponible' };

  const end = new Date(start.getTime() + APPT_DURATION_MIN * 60000);
  const tentative = data.tentative !== false; // default: hold

  // Un solo hold activo por teléfono: liberar holds previos de este paciente.
  releaseHoldsForPhone(cal, phone);

  if (!isFree(cal, start, end)) return { ok: false, error: 'ese horario ya está ocupado' };

  const nombre = data.nombre || 'Paciente';
  const title  = (tentative ? HOLD_PREFIX : OK_PREFIX) + nombre;
  const ev = cal.createEvent(title, start, end, {
    description: buildDesc({ phone: phone, motivo: data.motivo, estado: tentative ? 'hold' : 'confirmada' }),
  });
  setColor(ev, tentative);

  return {
    ok: true,
    eventId: ev.getId(),
    startISO: toLimaISO(start),
    estado: tentative ? 'hold' : 'confirmada',
  };
}

function releaseHoldsForPhone(cal, phone) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 90 * 86400000);
  const events = cal.getEvents(now, horizon);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (isHold(ev) && descPhone(ev) === phone) ev.deleteEvent();
  }
}

// ─── Acción: confirmar el hold del paciente (tras el pago) ───────────
function confirmAppointment(data) {
  const cal = getCal();
  const phone = String(data.phone || '');
  if (!phone) throw new Error('phone requerido');

  const now = new Date();
  const horizon = new Date(now.getTime() + 90 * 86400000);
  const events = cal.getEvents(now, horizon);
  let target = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!isHold(ev) || descPhone(ev) !== phone || isExpiredHold(ev)) continue;
    if (!target || ev.getStartTime() < target.getStartTime()) target = ev;
  }
  if (!target) return { ok: false, error: 'no hay hold activo para este paciente' };

  const nombre = target.getTitle().replace(HOLD_PREFIX, '');
  target.setTitle(OK_PREFIX + nombre);
  target.setDescription(setEstadoInDesc(target.getDescription(), 'confirmada'));
  setColor(target, false);

  return { ok: true, startISO: toLimaISO(target.getStartTime()), nombre: nombre };
}

// ─── Acción: próxima cita del paciente ───────────────────────────────
function getUpcoming(data) {
  const cal = getCal();
  const phone = String(data.phone || '');
  if (!phone) throw new Error('phone requerido');

  const now = new Date();
  const horizon = new Date(now.getTime() + 90 * 86400000);
  const events = cal.getEvents(now, horizon);
  let next = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (descPhone(ev) !== phone || isExpiredHold(ev)) continue;
    if (!next || ev.getStartTime() < next.getStartTime()) next = ev;
  }
  if (!next) return { hasAppointment: false };

  return {
    hasAppointment: true,
    startISO: toLimaISO(next.getStartTime()),
    estado: isHold(next) ? 'hold' : 'confirmada',
  };
}

// ─── Limpieza de holds vencidos (trigger horario) ────────────────────
function expireHolds() {
  const cal = getCal();
  const now = new Date();
  const past    = new Date(now.getTime() - 30 * 86400000);
  const horizon = new Date(now.getTime() + 90 * 86400000);
  const events = cal.getEvents(past, horizon);
  let deleted = 0;
  for (let i = 0; i < events.length; i++) {
    if (isExpiredHold(events[i])) { events[i].deleteEvent(); deleted++; }
  }
  return { deleted: deleted };
}
