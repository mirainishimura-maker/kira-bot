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
// =====================================================================

const SHEET_NAME = 'Leads';

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
      case 'ping':       return ok({ pong: true, at: new Date().toISOString() });
      case 'upsertLead': return ok(upsertLead(body.data || {}));
      case 'listLeads':  return ok(listLeads(body.filter || {}));
      default:           return err('unknown action: ' + body.action);
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
