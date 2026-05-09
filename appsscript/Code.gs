// =====================================================================
// KIRA v2 — Apps Script para "SEGUIMIENTO MKT HUB v2.0"
// =====================================================================
//
// CAMBIOS RESPECTO A v1:
//   - Adaptado a la estructura de 11 columnas de la v2
//     (Fecha, Responsable, Área, Cliente/Marca, Tarea, Tipo,
//      Prioridad, Estado, Fecha Compromiso, Días Atraso, Observaciones)
//   - Hoja renombrada de "Hoja 1" a "Registro Diario"
//   - Los datos ahora empiezan en la fila 5 (filas 1-2 = títulos, 3 = vacía, 4 = headers)
//   - Estados con emojis: "✅ Entregado", "❌ No entregado", etc.
//   - Se eliminó la columna "Se hizo el seguimiento" (no aportaba info)
//   - Se agregaron campos: clienteMarca, tipo, fechaCompromiso
//   - reorderAndBorder_ usa columna auxiliar fuera del rango de datos (col 15)
//   - findRow_ usa getDisplayValues() para comparar fechas de forma confiable
//   - readRows devuelve también los campos nuevos (clienteMarca, tipo, fechaCompromiso, diasAtraso)
//   - Nuevo action "summary" que devuelve métricas agregadas por persona
//
// CÓMO INSTALAR (una sola vez):
//   1. Abre la hoja "SEGUIMIENTO MKT HUB v2.0" en Google Sheets.
//   2. Extensiones → Apps Script.
//   3. Borra el código por defecto y pega TODO este archivo.
//   4. Click en el ícono de tuerca (Configuración del proyecto) →
//      Propiedades del script.
//      Crea una propiedad llamada KIRA_SECRET con un valor random largo.
//      (Puedes ejecutar generateSecret() para que te sugiera uno.)
//   5. Click en "Deploy" → "New deployment" → tipo "Web app".
//      - Description: "KIRA v2 webhook"
//      - Execute as: Me (tu usuario de Google)
//      - Who has access: Anyone
//   6. Te dará una URL tipo https://script.google.com/macros/s/AKf.../exec.
//      Cópiala y ponla en el .env de KIRA como SHEETS_WEBHOOK_URL.
//
// =====================================================================

// ─── Configuración ───────────────────────────────────────────────────

// Nombre de la pestaña (mira la pestaña inferior de la hoja).
const SHEET_NAME = 'Registro Diario';

// Fila donde empiezan los datos (fila 1 = título, 2 = subtítulo, 3 = vacía, 4 = headers).
const DATA_START_ROW = 5;

// Mapeo de columnas (1-based). Si alguien reordena columnas, solo hay que tocar esto.
const COL = {
  fecha:           1,
  responsable:     2,
  area:            3,
  clienteMarca:    4,
  tarea:           5,
  tipo:            6,
  prioridad:       7,
  estado:          8,
  fechaCompromiso: 9,
  diasAtraso:     10,  // fórmula automática — no se escribe desde KIRA
  observaciones:  11,
};

// Cantidad total de columnas de datos.
const TOTAL_COLS = 11;

// Columna auxiliar para ordenamiento (fuera del rango de datos para no chocar).
const COL_SORT_TEMP = 15;

// Estados válidos de la v2 (con emojis).
const ESTADOS = {
  POR_REALIZAR:  '⬜ Por realizar',
  EN_PROCESO:    '🔄 En proceso',
  ENTREGADO:     '✅ Entregado',
  NO_ENTREGADO:  '❌ No entregado',
  BLOQUEADO:     '⏸️ Bloqueado',
};

// Estados que significan "terminado" (para ordenamiento y métricas).
const ESTADOS_TERMINADOS = new Set([ESTADOS.ENTREGADO, ESTADOS.NO_ENTREGADO]);

// ─── Punto de entrada ────────────────────────────────────────────────

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    // Autenticación por secret compartido.
    const expected = PropertiesService.getScriptProperties().getProperty('KIRA_SECRET');
    if (!expected || body.secret !== expected) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }

    switch (body.action) {
      case 'ping':
        return jsonResponse_({ ok: true, message: 'pong', sheet: SHEET_NAME, version: 'v2' });

      case 'append':
        return handleAppend_(body);

      case 'update':
        return handleUpdate_(body);

      case 'read':
        return handleRead_(body);

      case 'summary':
        return handleSummary_(body);

      default:
        return jsonResponse_({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message || err) });
  }
}

// ─── Actions ─────────────────────────────────────────────────────────

/**
 * Agrega una fila nueva al final de los datos.
 */
function handleAppend_(body) {
  const sheet = getSheet_();
  const row = buildRowArray_(body);
  sheet.appendRow(row);
  const lastRow = sheet.getLastRow();
  insertDiasAtrasoFormula_(sheet, lastRow);
  reorderAndBorder_(sheet);
  return jsonResponse_({ ok: true, appended_row: lastRow });
}

/**
 * Actualiza la fila más reciente que coincida con (fecha, responsable).
 * Si no la encuentra, la agrega.
 */
function handleUpdate_(body) {
  const sheet = getSheet_();
  const rowIndex = findRow_(sheet, body.fecha, body.responsable);

  if (rowIndex < 0) {
    return handleAppend_(body);
  }

  const row = buildRowArray_(body);
  for (let i = 0; i < row.length; i++) {
    // No sobreescribir Días Atraso (columna con fórmula).
    if (i === COL.diasAtraso - 1) continue;
    // Solo escribir si el valor no está vacío.
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) {
      sheet.getRange(rowIndex, i + 1).setValue(row[i]);
    }
  }
  reorderAndBorder_(sheet);
  return jsonResponse_({ ok: true, updated_row: rowIndex });
}

/**
 * Lee filas con filtros opcionales.
 *
 * body: {
 *   fecha?:        string — formato DD/MM/YYYY tal como se muestra en la celda
 *   responsable?:  string — substring case-insensitive ("piero" matchea "Piero")
 *   clienteMarca?: string — substring case-insensitive
 *   estado?:       string — substring (ej: "Entregado" matchea "✅ Entregado")
 *   limit?:        number — máximo de filas (default 50, max 200)
 * }
 *
 * Devuelve filas más recientes primero.
 */
function handleRead_(body) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return jsonResponse_({ ok: true, rows: [], count: 0 });

  // getDisplayValues() devuelve lo que se ve en la celda — evita
  // problemas con fechas que internamente son Date objects.
  const numRows = lastRow - DATA_START_ROW + 1;
  const all = sheet.getRange(DATA_START_ROW, 1, numRows, TOTAL_COLS).getDisplayValues();

  const wantFecha    = body.fecha        ? String(body.fecha).trim()                       : null;
  const wantResp     = body.responsable  ? String(body.responsable).trim().toLowerCase()   : null;
  const wantCliente  = body.clienteMarca ? String(body.clienteMarca).trim().toLowerCase()  : null;
  const wantEstado   = body.estado       ? String(body.estado).trim().toLowerCase()        : null;
  const limit        = Math.max(1, Math.min(Number(body.limit) || 50, 200));

  const rows = [];
  for (let i = all.length - 1; i >= 0 && rows.length < limit; i--) {
    const r = all[i];
    const row = {
      row_index:       i + DATA_START_ROW,
      fecha:           val_(r, COL.fecha),
      responsable:     val_(r, COL.responsable),
      area:            val_(r, COL.area),
      clienteMarca:    val_(r, COL.clienteMarca),
      tarea:           val_(r, COL.tarea),
      tipo:            val_(r, COL.tipo),
      prioridad:       val_(r, COL.prioridad),
      estado:          val_(r, COL.estado),
      fechaCompromiso: val_(r, COL.fechaCompromiso),
      diasAtraso:      val_(r, COL.diasAtraso),
      observaciones:   val_(r, COL.observaciones),
    };

    // Saltar filas vacías.
    if (!row.responsable && !row.tarea) continue;

    // Aplicar filtros.
    if (wantFecha   && row.fecha !== wantFecha) continue;
    if (wantResp    && !row.responsable.toLowerCase().includes(wantResp)) continue;
    if (wantCliente && !row.clienteMarca.toLowerCase().includes(wantCliente)) continue;
    if (wantEstado  && !row.estado.toLowerCase().includes(wantEstado)) continue;

    rows.push(row);
  }

  return jsonResponse_({ ok: true, rows, count: rows.length });
}

/**
 * Devuelve métricas agregadas por persona (o globales si no se filtra).
 *
 * body: { responsable? }
 *
 * Respuesta:
 * {
 *   ok: true,
 *   global: { total, entregadas, noEntregadas, enProceso, porRealizar, bloqueadas, tasaCumplimiento },
 *   porPersona: { "Analu": { total, entregadas, ... }, ... },
 *   tareasAtrasadas: [ { responsable, tarea, diasAtraso }, ... ]
 * }
 */
function handleSummary_(body) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) {
    return jsonResponse_({ ok: true, global: emptyStats_(), porPersona: {}, tareasAtrasadas: [] });
  }

  const numRows = lastRow - DATA_START_ROW + 1;
  const all = sheet.getRange(DATA_START_ROW, 1, numRows, TOTAL_COLS).getDisplayValues();

  const wantResp = body.responsable ? String(body.responsable).trim().toLowerCase() : null;

  const porPersona = {};
  const tareasAtrasadas = [];

  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    const responsable = val_(r, COL.responsable);
    const tarea       = val_(r, COL.tarea);
    const estado      = val_(r, COL.estado);
    const diasAtraso  = val_(r, COL.diasAtraso);

    if (!responsable && !tarea) continue;
    if (wantResp && !responsable.toLowerCase().includes(wantResp)) continue;

    if (!porPersona[responsable]) {
      porPersona[responsable] = emptyStats_();
    }
    const stats = porPersona[responsable];
    stats.total++;

    if (estado.includes('Entregado') && !estado.includes('No entregado')) {
      stats.entregadas++;
    } else if (estado.includes('No entregado')) {
      stats.noEntregadas++;
    } else if (estado.includes('En proceso')) {
      stats.enProceso++;
    } else if (estado.includes('Por realizar')) {
      stats.porRealizar++;
    } else if (estado.includes('Bloqueado')) {
      stats.bloqueadas++;
    }

    // Recolectar tareas con atraso.
    const atraso = parseInt(diasAtraso, 10);
    if (!isNaN(atraso) && atraso > 0) {
      tareasAtrasadas.push({ responsable, tarea, diasAtraso: atraso });
    }
  }

  // Calcular tasas de cumplimiento.
  const global = emptyStats_();
  for (const name in porPersona) {
    const s = porPersona[name];
    s.tasaCumplimiento = s.total > 0 ? Math.round((s.entregadas / s.total) * 100) : 0;
    global.total        += s.total;
    global.entregadas   += s.entregadas;
    global.noEntregadas += s.noEntregadas;
    global.enProceso    += s.enProceso;
    global.porRealizar  += s.porRealizar;
    global.bloqueadas   += s.bloqueadas;
  }
  global.tasaCumplimiento = global.total > 0 ? Math.round((global.entregadas / global.total) * 100) : 0;

  // Ordenar tareas atrasadas de mayor a menor atraso.
  tareasAtrasadas.sort((a, b) => b.diasAtraso - a.diasAtraso);

  return jsonResponse_({ ok: true, global, porPersona, tareasAtrasadas });
}

// ─── Reordenamiento y bordes ─────────────────────────────────────────

/**
 * Reordena filas: pendientes arriba, entregados/no entregados abajo.
 * Pinta un borde grueso como separador visual.
 *
 * Usa una columna temporal fuera del rango de datos (col 15) para
 * evitar chocar con las 11 columnas de la v2.
 */
function reorderAndBorder_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const numRows = lastRow - DATA_START_ROW + 1;
  const dataRange = sheet.getRange(DATA_START_ROW, 1, numRows, TOTAL_COLS);
  const COL_ESTADO_IDX = COL.estado - 1; // índice 0-based

  // 1. Generar columna temporal de prioridad de orden.
  const values = dataRange.getValues();
  const sortKeys = values.map(function(row) {
    return [ESTADOS_TERMINADOS.has(row[COL_ESTADO_IDX]) ? 2 : 1];
  });

  sheet.getRange(DATA_START_ROW, COL_SORT_TEMP, numRows).setValues(sortKeys);

  // 2. Ordenar por la columna temporal y limpiarla.
  var sortRange = sheet.getRange(DATA_START_ROW, 1, numRows, COL_SORT_TEMP);
  sortRange.sort({ column: COL_SORT_TEMP, ascending: true });
  sheet.getRange(DATA_START_ROW, COL_SORT_TEMP, numRows).clearContent();

  // 3. Borde fino en todas las filas de datos.
  dataRange.setBorder(
    null, null, true, null, null, null,
    '#E5E7EB', SpreadsheetApp.BorderStyle.SOLID
  );

  // 4. Borde grueso entre última pendiente y primera terminada.
  var freshValues = dataRange.getValues();
  for (var i = 0; i < freshValues.length - 1; i++) {
    var estadoActual    = freshValues[i][COL_ESTADO_IDX];
    var estadoSiguiente = freshValues[i + 1][COL_ESTADO_IDX];
    var pendienteAhora  = !ESTADOS_TERMINADOS.has(estadoActual);
    var terminadoDesp   = ESTADOS_TERMINADOS.has(estadoSiguiente);

    if (pendienteAhora && terminadoDesp) {
      sheet.getRange(i + DATA_START_ROW, 1, 1, TOTAL_COLS)
        .setBorder(null, null, true, null, null, null,
          '#1F2937', SpreadsheetApp.BorderStyle.SOLID_THICK);
      break;
    }
  }
}

/**
 * Trigger nativo: se dispara cuando alguien edita la hoja manualmente.
 * Solo reordena si se editó la columna ESTADO en una fila de datos.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.source.getActiveSheet();
  if (sheet.getName() !== SHEET_NAME) return;
  if (e.range.getColumn() !== COL.estado) return;
  if (e.range.getRow() < DATA_START_ROW) return;

  reorderAndBorder_(sheet);
  e.range.activate();
}

// ─── Helpers internos ────────────────────────────────────────────────

/**
 * Construye un array de 11 elementos para appendRow.
 * NO escribe en la columna Días Atraso (es fórmula).
 */
function buildRowArray_(body) {
  var arr = new Array(TOTAL_COLS).fill('');
  arr[COL.fecha           - 1] = body.fecha           || '';
  arr[COL.responsable     - 1] = body.responsable     || '';
  arr[COL.area            - 1] = body.area            || '';
  arr[COL.clienteMarca    - 1] = body.clienteMarca    || '';
  arr[COL.tarea           - 1] = body.tarea           || '';
  arr[COL.tipo            - 1] = body.tipo            || '';
  arr[COL.prioridad       - 1] = body.prioridad       || '';
  arr[COL.estado          - 1] = body.estado          || ESTADOS.POR_REALIZAR;
  arr[COL.fechaCompromiso - 1] = body.fechaCompromiso || '';
  // COL.diasAtraso se deja vacío — la fórmula se insertará después.
  arr[COL.observaciones   - 1] = body.observaciones   || '';
  return arr;
}

/**
 * Después de appendRow, inserta la fórmula de Días Atraso en la nueva fila.
 * appendRow no puede escribir fórmulas, así que lo hacemos aparte.
 */
function insertDiasAtrasoFormula_(sheet, row) {
  var formula = '=IF(AND(I' + row + '<>"",H' + row + '<>"' + ESTADOS.ENTREGADO + '",TODAY()>I' + row + '),TODAY()-I' + row + ',"")';
  sheet.getRange(row, COL.diasAtraso).setFormula(formula);
}

/**
 * Busca la fila más reciente que coincida con (fecha, responsable).
 * Usa getDisplayValues() para comparar fechas como strings visibles,
 * evitando problemas con Date objects internos.
 */
function findRow_(sheet, fecha, responsable) {
  if (!fecha || !responsable) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return -1;

  var numRows = lastRow - DATA_START_ROW + 1;
  // Leer solo las columnas de fecha y responsable (1 y 2).
  var data = sheet.getRange(DATA_START_ROW, 1, numRows, 2).getDisplayValues();
  var targetFecha = String(fecha).trim();
  var targetResp  = String(responsable).trim().toLowerCase();

  for (var i = data.length - 1; i >= 0; i--) {
    var cellFecha = String(data[i][0]).trim();
    var cellResp  = String(data[i][1]).trim().toLowerCase();
    if (cellFecha === targetFecha && cellResp === targetResp) {
      return i + DATA_START_ROW;
    }
  }
  return -1;
}

/**
 * Extrae un valor limpio de un array de fila por número de columna (1-based).
 */
function val_(row, colNum) {
  return String(row[colNum - 1] || '').trim();
}

/**
 * Retorna un objeto de stats vacío para inicializar contadores.
 */
function emptyStats_() {
  return {
    total: 0,
    entregadas: 0,
    noEntregadas: 0,
    enProceso: 0,
    porRealizar: 0,
    bloqueadas: 0,
    tasaCumplimiento: 0,
  };
}

/**
 * Obtiene la hoja configurada. Lanza error si no existe.
 */
function getSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('No existe la pestaña "' + SHEET_NAME + '". Revisa SHEET_NAME al inicio del código.');
  }
  return sheet;
}

/**
 * Devuelve una respuesta JSON.
 * Nota: ContentService siempre devuelve HTTP 200 — el parámetro status
 * de la v1 fue eliminado porque no tenía efecto real.
 */
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Utilidades para ejecutar desde el editor ────────────────────────

/**
 * Genera un secret random y lo muestra en el log.
 */
function generateSecret() {
  var secret = Utilities.getUuid() + '-' + Utilities.getUuid();
  Logger.log('KIRA_SECRET sugerido: ' + secret);
  Logger.log('Cópialo a Configuración del proyecto → Propiedades del script.');
}

/** Test rápido de append sin pasar por el deployment. */
function testAppendLocal() {
  var e = {
    postData: { contents: JSON.stringify({
      secret: PropertiesService.getScriptProperties().getProperty('KIRA_SECRET'),
      action: 'append',
      fecha: '08/05/2026',
      responsable: 'Test',
      area: 'Creación de Contenido',
      clienteMarca: 'ArtaMax',
      tarea: 'Fila de prueba desde Apps Script',
      tipo: 'Entregable',
      prioridad: '🔵 Normal',
      estado: '🔄 En proceso',
      fechaCompromiso: '10/05/2026',
      observaciones: 'Borrar después',
    })}
  };
  var out = doPost(e);
  Logger.log(out.getContent());
}

/** Test rápido de read sin pasar por el deployment. */
function testReadLocal() {
  var e = {
    postData: { contents: JSON.stringify({
      secret: PropertiesService.getScriptProperties().getProperty('KIRA_SECRET'),
      action: 'read',
      responsable: 'Piero',
    })}
  };
  var out = doPost(e);
  Logger.log(out.getContent());
}

/** Test rápido de summary sin pasar por el deployment. */
function testSummaryLocal() {
  var e = {
    postData: { contents: JSON.stringify({
      secret: PropertiesService.getScriptProperties().getProperty('KIRA_SECRET'),
      action: 'summary',
    })}
  };
  var out = doPost(e);
  Logger.log(out.getContent());
}
