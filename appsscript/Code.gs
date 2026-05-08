// =====================================================================
// KIRA — Apps Script para la hoja de productividad de Luisa
// =====================================================================
//
// CÓMO INSTALAR (una sola vez):
// 1. Abre la hoja en Google Sheets.
// 2. Extensiones → Apps Script.
// 3. Borra el código por defecto y pega TODO este archivo.
// 4. Click en el ícono de tuerca (Configuración del proyecto) → Propiedades del script.
//    Crea una propiedad llamada KIRA_SECRET con un valor random largo.
//    (Ej: pega un UUID o 32 caracteres aleatorios — guarda este valor,
//     lo necesitarás en el .env de KIRA.)
// 5. Si tu hoja con los datos NO se llama "Hoja 1", actualiza
//    SHEET_NAME abajo con el nombre real (mira la pestaña inferior).
// 6. Click en "Deploy" → "New deployment" → tipo "Web app".
//    - Description: "KIRA webhook"
//    - Execute as: Me (tu usuario de Google)
//    - Who has access: Anyone
// 7. Te dará una URL tipo https://script.google.com/macros/s/AKf.../exec.
//    Cópiala y pásamela (o ponla en el .env de KIRA como SHEETS_WEBHOOK_URL).
//
// =====================================================================

// Cambia esto si tu pestaña se llama distinto (mira la pestaña inferior de la hoja).
const SHEET_NAME = 'Hoja 1';

// Mapeo de columnas (1-based como las ven los usuarios). Si Luisa cambia el orden
// o renombra columnas, ajusta este objeto.
const COL = {
  date:          1,  // Columna 1 (la fecha)
  name:          2,  // NOMBRE
  area:          3,  // AREA
  pendientes:    4,  // PENDIENTES DEL DIA
  estado:        5,  // ESTADO
  prioridad:     6,  // PRIORIDAD
  seguimiento:   7,  // SE HIZO EL SEGUIMIENTO
  observaciones: 8,  // OBSERVACIONES
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    const expected = PropertiesService.getScriptProperties().getProperty('KIRA_SECRET');
    if (!expected || body.secret !== expected) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    switch (body.action) {
      case 'ping':
        return json({ ok: true, message: 'pong', sheet: SHEET_NAME });

      case 'append':
        return appendRow(body);

      case 'update':
        return updateRow(body);

      case 'read':
        return readRows(body);

      default:
        return json({ ok: false, error: `Unknown action: ${body.action}` }, 400);
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

function appendRow(body) {
  const sheet = getSheet_();
  const row = buildRowArray_(body);
  sheet.appendRow(row);
  const lastRow = sheet.getLastRow();
  reorderAndBorder_(sheet);
  return json({ ok: true, appended_row: lastRow });
}

// Actualiza la fila más reciente que coincida con (date, name).
// Si no la encuentra, la agrega.
function updateRow(body) {
  const sheet = getSheet_();
  const rowIndex = findRow_(sheet, body.date, body.name);
  if (rowIndex < 0) {
    return appendRow(body);
  }
  const row = buildRowArray_(body);
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) {
      sheet.getRange(rowIndex, i + 1).setValue(row[i]);
    }
  }
  reorderAndBorder_(sheet);
  return json({ ok: true, updated_row: rowIndex });
}

// Reordena las filas de datos: pendientes arriba, ENTREGADO/COMPLETO abajo.
// Pinta un borde grueso entre la última fila pendiente y la primera entregada.
// Se llama desde appendRow, updateRow y desde onEdit (cuando alguien edita
// manualmente la columna ESTADO).
function reorderAndBorder_(sheet) {
  const FILA_INICIO = 3;       // Los datos empiezan en la fila 3 (1=encabezado, 2=título?)
  const ULTIMA_COL = 8;        // Hasta H (Observaciones)
  const COL_ESTADO_IDX = 4;    // Índice 0-based de la columna ESTADO dentro del array de fila

  const ultimaFila = sheet.getLastRow();
  if (ultimaFila < FILA_INICIO) return;

  const rangoTabla = sheet.getRange(FILA_INICIO, 1, ultimaFila - FILA_INICIO + 1, ULTIMA_COL);

  // 1. Columna temporal de prioridad: 2 = ENTREGADO/COMPLETO, 1 = pendiente
  const valores = rangoTabla.getValues();
  const prioridades = valores.map((fila) => {
    const estado = fila[COL_ESTADO_IDX];
    return [(estado === 'ENTREGADO' || estado === 'COMPLETO') ? 2 : 1];
  });

  const COL_TEMP = 10;
  sheet.getRange(FILA_INICIO, COL_TEMP, prioridades.length).setValues(prioridades);

  // 2. Ordena por la columna temporal y la limpia
  rangoTabla.offset(0, 0, prioridades.length, COL_TEMP)
            .sort({ column: COL_TEMP, ascending: true });
  sheet.getRange(FILA_INICIO, COL_TEMP, prioridades.length).clearContent();

  // 3. Borde fino divisorio en todas las filas
  rangoTabla.setBorder(null, null, true, null, null, null, '#b7b7b7', SpreadsheetApp.BorderStyle.SOLID);

  // 4. Borde grueso entre la última pendiente y la primera entregada
  const nuevos = rangoTabla.getValues();
  let filaParaBorde = -1;
  for (let i = 0; i < nuevos.length - 1; i++) {
    const actual    = nuevos[i][COL_ESTADO_IDX];
    const siguiente = nuevos[i + 1][COL_ESTADO_IDX];
    const esPendiente    = !(actual    === 'ENTREGADO' || actual    === 'COMPLETO');
    const esEntregadoSig =  (siguiente === 'ENTREGADO' || siguiente === 'COMPLETO');
    if (esPendiente && esEntregadoSig) {
      filaParaBorde = i + FILA_INICIO;
      break;
    }
  }
  if (filaParaBorde !== -1) {
    sheet.getRange(filaParaBorde, 1, 1, ULTIMA_COL)
         .setBorder(null, null, true, null, null, null, 'black', SpreadsheetApp.BorderStyle.SOLID_THICK);
  }
}

// Trigger nativo de Google Sheets: se dispara cuando un humano edita la hoja.
// Reusa la misma función de reorden que llaman appendRow/updateRow.
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  // Solo reordenar si se editó la columna ESTADO en una fila de datos.
  const COL_ESTADO_1BASED = 5;
  const FILA_INICIO = 3;
  if (e.range.getColumn() !== COL_ESTADO_1BASED) return;
  if (e.range.getRow() < FILA_INICIO) return;

  reorderAndBorder_(sheet);
  e.range.activate();
}

// Lee filas de la hoja con filtros opcionales (date, name, status).
// Útil para que KIRA consulte el estado actual antes de responder al usuario.
//
// body: { date?, name?, status?, limit? }
//   - date:   string exacto en formato dd/mm (mismo que escribimos)
//   - name:   substring case-insensitive del nombre (ej: "piero" matchea "Piero")
//   - status: string exacto (ENTREGADO | EN PROCESO | BLOQUEADO | POR REALIZAR)
//   - limit:  máximo de filas a devolver (default 50, max 200)
//
// Devuelve las filas más recientes primero.
function readRows(body) {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return json({ ok: true, rows: [] });

  // Usamos getDisplayValues() (lo que se ve en la celda) en vez de getValues()
  // (el dato crudo) — algunas filas tienen fechas como objeto Date y otras como
  // string. El display siempre es lo que el usuario ve ("08/05").
  const all = sheet.getRange(2, 1, last - 1, 8).getDisplayValues();
  const wantDate   = body.date ? String(body.date).trim() : null;
  const wantName   = body.name ? String(body.name).trim().toLowerCase() : null;
  const wantStatus = body.status ? String(body.status).trim() : null;
  const limit = Math.max(1, Math.min(Number(body.limit) || 50, 200));

  const rows = [];
  for (let i = all.length - 1; i >= 0 && rows.length < limit; i--) {
    const r = all[i];
    const row = {
      row_index:     i + 2, // 1-based como en la hoja
      date:          String(r[COL.date          - 1] ?? '').trim(),
      name:          String(r[COL.name          - 1] ?? '').trim(),
      area:          String(r[COL.area          - 1] ?? '').trim(),
      pendientes:    String(r[COL.pendientes    - 1] ?? '').trim(),
      estado:        String(r[COL.estado        - 1] ?? '').trim(),
      prioridad:     String(r[COL.prioridad     - 1] ?? '').trim(),
      seguimiento:   String(r[COL.seguimiento   - 1] ?? '').trim(),
      observaciones: String(r[COL.observaciones - 1] ?? '').trim(),
    };
    if (!row.name && !row.pendientes) continue; // fila vacía
    if (wantDate   && row.date !== wantDate) continue;
    if (wantName   && !row.name.toLowerCase().includes(wantName)) continue;
    if (wantStatus && row.estado !== wantStatus) continue;
    rows.push(row);
  }
  return json({ ok: true, rows, count: rows.length });
}

function buildRowArray_(body) {
  const arr = new Array(8).fill('');
  arr[COL.date          - 1] = body.date          ?? '';
  arr[COL.name          - 1] = body.name          ?? '';
  arr[COL.area          - 1] = body.area          ?? '';
  arr[COL.pendientes    - 1] = body.pendientes    ?? '';
  arr[COL.estado        - 1] = body.estado        ?? '';
  arr[COL.prioridad     - 1] = body.prioridad     ?? '';
  arr[COL.seguimiento   - 1] = body.seguimiento   ?? 'SI';
  arr[COL.observaciones - 1] = body.observaciones ?? '';
  return arr;
}

function findRow_(sheet, date, name) {
  if (!date || !name) return -1;
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const data = sheet.getRange(2, 1, last - 1, 2).getValues(); // cols date + name
  for (let i = data.length - 1; i >= 0; i--) {
    const [d, n] = data[i];
    if (String(d) === String(date) && String(n).trim() === String(name).trim()) {
      return i + 2; // +2 porque empezamos en fila 2 y i es 0-based
    }
  }
  return -1;
}

function getSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error(`No existe la pestaña "${SHEET_NAME}". Revisa SHEET_NAME al inicio del código.`);
  }
  return sheet;
}

function json(obj, status) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================
// Helpers para correr UNA VEZ desde el editor de Apps Script
// =====================================================================

// Genera un secret random y lo deja en el portapapeles del log.
// Ejecútalo, copia el valor del log, ponlo en Script Properties con
// el nombre KIRA_SECRET, y también en el .env de KIRA como SHEETS_WEBHOOK_SECRET.
function generateSecret() {
  const secret = Utilities.getUuid() + '-' + Utilities.getUuid();
  Logger.log('KIRA_SECRET sugerido: ' + secret);
  Logger.log('Cópialo a Configuración del proyecto → Propiedades del script.');
}

// Test rápido sin pasar por el deployment (para verificar que el código corre).
function testAppendLocal() {
  const e = {
    postData: { contents: JSON.stringify({
      secret: PropertiesService.getScriptProperties().getProperty('KIRA_SECRET'),
      action: 'append',
      date: '07/05',
      name: 'Test',
      area: 'TEST',
      pendientes: 'fila de prueba desde Apps Script',
      estado: 'EN PROCESO',
      prioridad: 'NORMAL',
      seguimiento: 'SI',
      observaciones: 'borrar después',
    })}
  };
  const out = doPost(e);
  Logger.log(out.getContent());
}
