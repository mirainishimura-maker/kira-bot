// =====================================================================
// KIRA — Apps Script: Cumpleaños Ítaca Kids Lima
// =====================================================================
// Hoja:    1M4TbRUHT9ddbwKzJWa3SuwRkI2FpIWctHXxG7eJwWr0
// Pestaña: GID 843706539 (la principal de inscripciones).
//
// Estructura:
//   col  2  NOMBRE COMPLETO (apoderado)
//   col  4  NÚMERO DE TELÉFONO (apoderado)
//   col  7  NOMBRE COMPLETO (participante — niño/a)
//   col  8  FECHA DE NACIMIENTO (dd/mm/yyyy)
//   col  9  EDAD
//   col 15  SEDE (MIRAFLORES | LOS OLIVOS)
//   col 16  HORARIOS MIRAFLORES
//   col 17  HORARIOS OLIVOS
//
// Niños y adultos. Filtra fechas absurdas.
//
// CÓMO INSTALAR: proyecto Apps Script STANDALONE (no bound). Razón: esta hoja
// ya tiene un Apps Script bound (la web app de asistencia Ítaca Kids Lima).
//   1. https://script.google.com/home → New project.
//   2. Pegar TODO este archivo en Code.gs.
//   3. Propiedades del script → KIRA_SECRET = <secret> (correr generateSecret()).
//   4. Deploy → New deployment → Web app → Execute as Me, Anyone access.
//   5. Copiar la URL → guardarla en spaces.sheet_url.
// =====================================================================

const COL = {
  apoderado:           2,
  participante:        7,
  fechaNacimiento:     8,
  sede:               15,
  horariosMiraflores: 16,
  horariosOlivos:     17,
};

// Standalone Apps Script (no bound). Leemos la hoja por ID para no chocar con
// el Apps Script de la asistencia Ítaca Kids Lima, que ya está bound a esta hoja.
const SHEET_ID  = '1M4TbRUHT9ddbwKzJWa3SuwRkI2FpIWctHXxG7eJwWr0';
const SHEET_GID = 843706539;
const DATA_START_ROW = 2;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('KIRA_SECRET');
    if (!expected || body.secret !== expected) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }
    switch (body.action) {
      case 'ping':            return jsonResponse_({ ok: true, sheet: 'Lima cumples', version: 'v1' });
      case 'birthdaysToday':  return handleBirthdaysToday_(body);
      default: return jsonResponse_({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message || err) });
  }
}

function handleBirthdaysToday_(body) {
  const target = body.date ? String(body.date).trim() : todayDdMm_();
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return jsonResponse_({ ok: true, date: target, count: 0, birthdays: [] });

  const numRows = lastRow - DATA_START_ROW + 1;
  const rows = sheet.getRange(DATA_START_ROW, 1, numRows, COL.horariosOlivos).getDisplayValues();
  const result = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const fechaNac = String(r[COL.fechaNacimiento - 1] || '').trim();
    const ddmm = extractDdMm_(fechaNac);
    if (!ddmm || ddmm !== target) continue;

    const yearNac = extractYear_(fechaNac);
    if (yearNac && yearNac < 1900) continue;

    const nombre = String(r[COL.participante - 1] || '').trim();
    if (!nombre || nombre === '-') continue;

    const todayYear  = parseInt(Utilities.formatDate(new Date(), 'America/Lima', 'yyyy'), 10);
    const edadCumple = yearNac ? (todayYear - yearNac) : null;

    const sedeRaw = String(r[COL.sede - 1] || '').trim().toUpperCase();
    const sede    = formatSede_(sedeRaw);

    let grupo = '';
    if (sedeRaw === 'MIRAFLORES') {
      grupo = String(r[COL.horariosMiraflores - 1] || '').trim();
    } else if (sedeRaw === 'LOS OLIVOS' || sedeRaw === 'OLIVOS') {
      grupo = String(r[COL.horariosOlivos - 1] || '').trim();
    }

    result.push({
      nombre,
      edad:      edadCumple !== null ? String(edadCumple) : '',
      sede,
      grupo,
      apoderado: String(r[COL.apoderado - 1] || '').trim(),
    });
  }

  return jsonResponse_({ ok: true, date: target, count: result.length, birthdays: result });
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatSede_(raw) {
  if (raw === 'MIRAFLORES')                         return 'Miraflores';
  if (raw === 'LOS OLIVOS' || raw === 'OLIVOS')     return 'Los Olivos';
  return raw || 'verificar sede';
}

function getSheet_() {
  const sheets = SpreadsheetApp.openById(SHEET_ID).getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === SHEET_GID) return sheets[i];
  }
  throw new Error('No se encontró la pestaña con GID ' + SHEET_GID);
}

function todayDdMm_() {
  return Utilities.formatDate(new Date(), 'America/Lima', 'dd/MM');
}

function extractDdMm_(fecha) {
  const m = String(fecha).match(/^(\d{1,2})\/(\d{1,2})\/\d{1,4}$/);
  if (!m) return null;
  return pad2_(m[1]) + '/' + pad2_(m[2]);
}

function extractYear_(fecha) {
  const m = String(fecha).match(/^\d{1,2}\/\d{1,2}\/(\d{1,4})$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function pad2_(s) { return ('0' + String(s).trim()).slice(-2); }

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function generateSecret() {
  Logger.log('KIRA_SECRET sugerido: ' + Utilities.getUuid() + '-' + Utilities.getUuid());
}

function testToday() {
  const e = { postData: { contents: JSON.stringify({
    secret: PropertiesService.getScriptProperties().getProperty('KIRA_SECRET'),
    action: 'birthdaysToday',
  })}};
  Logger.log(doPost(e).getContent());
}

// Corré esta función desde el editor (no necesita redeploy) para ver qué
// está leyendo realmente el script: cuántas filas, y muestra de las primeras 5.
function debugSheet() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  Logger.log('Pestaña: ' + sheet.getName() + ' | GID: ' + sheet.getSheetId());
  Logger.log('Total filas (incluida header): ' + lastRow);
  if (lastRow < DATA_START_ROW) { Logger.log('Sin datos'); return; }
  const numRows = Math.min(5, lastRow - DATA_START_ROW + 1);
  const rows = sheet.getRange(DATA_START_ROW, 1, numRows, COL.horariosOlivos).getDisplayValues();
  rows.forEach((r, i) => {
    Logger.log('Fila ' + (DATA_START_ROW + i) + ' → apoderado=[' + r[COL.apoderado - 1] +
               '] participante=[' + r[COL.participante - 1] +
               '] fechaNac=[' + r[COL.fechaNacimiento - 1] +
               '] sede=[' + r[COL.sede - 1] + ']');
  });
}
