// =====================================================================
// KIRA — Apps Script: Mirai Ops (agenda operativa multi-proyecto)
// =====================================================================
// Hoja: 1oz20T0uk0Oo1hHmqW44O2dNiOMSFXlJ5vMz8fEknfpo  ("KIRA — Mirai Ops")
// Pestaña: "Tareas" (la creamos con setupSheet()).
//
// Estructura — 9 columnas:
//   1. Fecha (dd/mm/yyyy)
//   2. Proyecto
//   3. Tarea
//   4. Tipo
//   5. Prioridad
//   6. Estado
//   7. FechaCompromiso (dd/mm/yyyy)
//   8. DiasAtraso (fórmula)
//   9. Observaciones
//
// Espacio: mirai_ops. Bidireccional (KIRA puede leer y escribir).
//
// CÓMO INSTALAR (una sola vez):
//   1. Abrir la hoja "KIRA — Mirai Ops" → Extensiones → Apps Script.
//   2. Pegar este archivo entero.
//   3. Configuración → Propiedades del script → KIRA_SECRET = <secret>
//      (correr generateSecret() para que sugiera uno).
//   4. Ejecutar setupSheet() UNA VEZ desde el editor — arma la pestaña
//      "Tareas" con headers, validaciones y formato.
//   5. Deploy → New deployment → Web app → Execute as: Me, Anyone.
//   6. Copiar la URL.
// =====================================================================

const SHEET_NAME     = 'Tareas';
const DATA_START_ROW = 2;

const COL = {
  fecha:           1,
  proyecto:        2,
  tarea:           3,
  tipo:            4,
  prioridad:       5,
  estado:          6,
  fechaCompromiso: 7,
  diasAtraso:      8,
  observaciones:   9,
};
const TOTAL_COLS    = 9;
const COL_SORT_TEMP = 12;

const ESTADOS = {
  POR_REALIZAR: '⬜ Por realizar',
  EN_PROCESO:   '🔄 En proceso',
  ENTREGADO:    '✅ Entregado',
  NO_ENTREGADO: '❌ No entregado',
  BLOQUEADO:    '⏸️ Bloqueado',
};
const PRIORIDADES = ['🔴 Urgente', '🟡 Alta', '🔵 Normal', '🟢 Baja'];
const TIPOS       = ['desarrollo', 'reunión', 'revisión', 'decisión', 'admin', 'contenido', 'otro'];
const ESTADOS_TERMINADOS = new Set([ESTADOS.ENTREGADO, ESTADOS.NO_ENTREGADO]);

// ─── Setup (correr UNA vez desde el editor) ──────────────────────────

function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    const first = ss.getSheets()[0];
    first.setName(SHEET_NAME);
    sheet = first;
  }
  sheet.clear();

  const headers = ['Fecha', 'Proyecto', 'Tarea', 'Tipo', 'Prioridad', 'Estado',
                   'Fecha compromiso', 'Días atraso', 'Observaciones'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1F2937').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);

  sheet.setColumnWidth(COL.fecha,           95);
  sheet.setColumnWidth(COL.proyecto,       130);
  sheet.setColumnWidth(COL.tarea,          350);
  sheet.setColumnWidth(COL.tipo,           110);
  sheet.setColumnWidth(COL.prioridad,      110);
  sheet.setColumnWidth(COL.estado,         140);
  sheet.setColumnWidth(COL.fechaCompromiso,110);
  sheet.setColumnWidth(COL.diasAtraso,      80);
  sheet.setColumnWidth(COL.observaciones,  280);

  const N = 1000;
  sheet.getRange(DATA_START_ROW, COL.tipo, N)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(TIPOS, true).build());
  sheet.getRange(DATA_START_ROW, COL.prioridad, N)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(PRIORIDADES, true).build());
  sheet.getRange(DATA_START_ROW, COL.estado, N)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(Object.values(ESTADOS), true).build());

  SpreadsheetApp.flush();
  Logger.log('Setup OK. Hoja "' + SHEET_NAME + '" lista.');
}

// ─── Endpoint ────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('KIRA_SECRET');
    if (!expected || body.secret !== expected) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }
    switch (body.action) {
      case 'ping':       return jsonResponse_({ ok: true, sheet: SHEET_NAME, version: 'v1' });
      case 'append':     return handleAppend_(body);
      case 'update':     return handleUpdate_(body);
      case 'read':       return handleRead_(body);
      case 'tasksToday': return handleTasksToday_(body);
      default: return jsonResponse_({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message || err) });
  }
}

function handleAppend_(body) {
  const sheet = getSheet_();
  sheet.appendRow(buildRow_(body));
  const lastRow = sheet.getLastRow();
  insertDiasAtrasoFormula_(sheet, lastRow);
  reorderAndBorder_(sheet);
  return jsonResponse_({ ok: true, appended_row: lastRow });
}

function handleUpdate_(body) {
  const sheet = getSheet_();
  const rowIndex = findRow_(sheet, body.fecha, body.tarea);
  if (rowIndex < 0) return handleAppend_(body);

  const row = buildRow_(body);
  for (let i = 0; i < row.length; i++) {
    if (i === COL.diasAtraso - 1) continue;
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) {
      sheet.getRange(rowIndex, i + 1).setValue(row[i]);
    }
  }
  reorderAndBorder_(sheet);
  return jsonResponse_({ ok: true, updated_row: rowIndex });
}

function handleRead_(body) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return jsonResponse_({ ok: true, rows: [], count: 0 });

  const numRows = lastRow - DATA_START_ROW + 1;
  const all = sheet.getRange(DATA_START_ROW, 1, numRows, TOTAL_COLS).getDisplayValues();

  const wantFecha    = body.fecha    ? String(body.fecha).trim()                       : null;
  const wantProyecto = body.proyecto ? String(body.proyecto).trim().toLowerCase()      : null;
  const wantEstado   = body.estado   ? String(body.estado).trim().toLowerCase()        : null;
  const limit = Math.max(1, Math.min(Number(body.limit) || 50, 200));

  const rows = [];
  for (let i = all.length - 1; i >= 0 && rows.length < limit; i--) {
    const r = all[i];
    const row = {
      row_index:       i + DATA_START_ROW,
      fecha:           val_(r, COL.fecha),
      proyecto:        val_(r, COL.proyecto),
      tarea:           val_(r, COL.tarea),
      tipo:            val_(r, COL.tipo),
      prioridad:       val_(r, COL.prioridad),
      estado:          val_(r, COL.estado),
      fechaCompromiso: val_(r, COL.fechaCompromiso),
      diasAtraso:      val_(r, COL.diasAtraso),
      observaciones:   val_(r, COL.observaciones),
    };
    if (!row.tarea) continue;
    if (wantFecha    && row.fecha !== wantFecha) continue;
    if (wantProyecto && !row.proyecto.toLowerCase().includes(wantProyecto)) continue;
    if (wantEstado   && !row.estado.toLowerCase().includes(wantEstado))    continue;
    rows.push(row);
  }
  return jsonResponse_({ ok: true, rows, count: rows.length });
}

/**
 * Devuelve las tareas pendientes — ideal para el cron matinal de las 8 AM.
 * Excluye las terminadas (Entregado / No entregado).
 */
function handleTasksToday_(body) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return jsonResponse_({ ok: true, count: 0, tasks: [] });

  const today = body.date ? String(body.date).trim() : todayDdMmYyyy_();
  const numRows = lastRow - DATA_START_ROW + 1;
  const all = sheet.getRange(DATA_START_ROW, 1, numRows, TOTAL_COLS).getDisplayValues();

  const tasks = [];
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    const estado = String(r[COL.estado - 1] || '').trim();
    if (ESTADOS_TERMINADOS.has(estado)) continue;
    const tarea = String(r[COL.tarea - 1] || '').trim();
    if (!tarea) continue;
    tasks.push({
      row_index:       i + DATA_START_ROW,
      fecha:           val_(r, COL.fecha),
      proyecto:        val_(r, COL.proyecto),
      tarea,
      tipo:            val_(r, COL.tipo),
      prioridad:       val_(r, COL.prioridad),
      estado,
      fechaCompromiso: val_(r, COL.fechaCompromiso),
      diasAtraso:      val_(r, COL.diasAtraso),
      observaciones:   val_(r, COL.observaciones),
    });
  }
  return jsonResponse_({ ok: true, date: today, count: tasks.length, tasks });
}

// ─── Reorder + onEdit ───────────────────────────────────────────────

function reorderAndBorder_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;
  const numRows = lastRow - DATA_START_ROW + 1;
  const dataRange = sheet.getRange(DATA_START_ROW, 1, numRows, TOTAL_COLS);
  const COL_ESTADO_IDX = COL.estado - 1;

  const values = dataRange.getValues();
  const sortKeys = values.map(function(row) {
    return [ESTADOS_TERMINADOS.has(row[COL_ESTADO_IDX]) ? 2 : 1];
  });
  sheet.getRange(DATA_START_ROW, COL_SORT_TEMP, numRows).setValues(sortKeys);
  sheet.getRange(DATA_START_ROW, 1, numRows, COL_SORT_TEMP)
    .sort({ column: COL_SORT_TEMP, ascending: true });
  sheet.getRange(DATA_START_ROW, COL_SORT_TEMP, numRows).clearContent();

  dataRange.setBorder(null, null, true, null, null, null,
    '#E5E7EB', SpreadsheetApp.BorderStyle.SOLID);
}

function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== SHEET_NAME) return;
  if (e.range.getColumn() !== COL.estado) return;
  if (e.range.getRow() < DATA_START_ROW) return;
  reorderAndBorder_(sheet);
  e.range.activate();
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildRow_(body) {
  const arr = new Array(TOTAL_COLS).fill('');
  arr[COL.fecha           - 1] = body.fecha           || '';
  arr[COL.proyecto        - 1] = body.proyecto        || '';
  arr[COL.tarea           - 1] = body.tarea           || '';
  arr[COL.tipo            - 1] = body.tipo            || '';
  arr[COL.prioridad       - 1] = body.prioridad       || '';
  arr[COL.estado          - 1] = body.estado          || ESTADOS.POR_REALIZAR;
  arr[COL.fechaCompromiso - 1] = body.fechaCompromiso || '';
  // diasAtraso: fórmula
  arr[COL.observaciones   - 1] = body.observaciones   || '';
  return arr;
}

function insertDiasAtrasoFormula_(sheet, row) {
  // G = fechaCompromiso, F = estado, ENTREGADO = ✅ Entregado
  const formula = '=IF(AND(G' + row + '<>"",F' + row + '<>"' + ESTADOS.ENTREGADO + '",TODAY()>G' + row + '),TODAY()-G' + row + ',"")';
  sheet.getRange(row, COL.diasAtraso).setFormula(formula);
}

function findRow_(sheet, fecha, tarea) {
  if (!fecha || !tarea) return -1;
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return -1;
  const numRows = lastRow - DATA_START_ROW + 1;
  const data = sheet.getRange(DATA_START_ROW, 1, numRows, COL.tarea).getDisplayValues();
  const targetFecha = String(fecha).trim();
  const targetTarea = String(tarea).trim().toLowerCase();
  for (let i = data.length - 1; i >= 0; i--) {
    const cellFecha = String(data[i][COL.fecha - 1]).trim();
    const cellTarea = String(data[i][COL.tarea - 1]).trim().toLowerCase();
    if (cellFecha === targetFecha && cellTarea === targetTarea) {
      return i + DATA_START_ROW;
    }
  }
  return -1;
}

function val_(row, colNum) { return String(row[colNum - 1] || '').trim(); }

function todayDdMmYyyy_() {
  return Utilities.formatDate(new Date(), 'America/Lima', 'dd/MM/yyyy');
}

function getSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('No existe la pestaña "' + SHEET_NAME + '". Ejecuta setupSheet() primero.');
  return sheet;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Utilidades ─────────────────────────────────────────────────────

function generateSecret() {
  Logger.log('KIRA_SECRET sugerido: ' + Utilities.getUuid() + '-' + Utilities.getUuid());
}

function testTasksToday() {
  const e = { postData: { contents: JSON.stringify({
    secret: PropertiesService.getScriptProperties().getProperty('KIRA_SECRET'),
    action: 'tasksToday',
  })}};
  Logger.log(doPost(e).getContent());
}
