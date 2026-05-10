// =====================================================================
// KIRA — Apps Script: Cumpleaños ECO Canto
// =====================================================================
// Hoja:     1VHuI-2i02wQIbx1QqyR7sSDWHnE-Kz0hsaLGVILbPQE
// Pestaña:  GID 1279011654 ("abril - julio") — el script la encuentra por GID,
//           NO por nombre, así si renombran la pestaña no se rompe.
//
// Estructura (inscripciones):
//   col  2  Nombre del apoderado
//   col  3  Apellidos del apoderado
//   col  5  Número de WhatsApp
//   col  8  Nombres del participante
//   col  9  Apellidos del participante
//   col 10  Fecha de Nacimiento (dd/mm/yyyy)
//   col 11  Edad
//
// Sede: siempre "Piura". Niños y adultos.
// Filtra fechas absurdas (1/1/0001, 10/10/0010, etc).
//
// CÓMO INSTALAR: igual que el de Piura — pegar en el Apps Script bound a la hoja,
// configurar KIRA_SECRET, deploy.
// =====================================================================

const COL = {
  apoderadoNombre:      2,
  apoderadoApellido:    3,
  participanteNombre:   8,
  participanteApellido: 9,
  fechaNacimiento:     10,
};

const SHEET_GID  = 1279011654;
const SEDE_FIJA  = 'Piura';
const DATA_START_ROW = 2;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('KIRA_SECRET');
    if (!expected || body.secret !== expected) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }
    switch (body.action) {
      case 'ping':            return jsonResponse_({ ok: true, sheet: 'ECO cumples', version: 'v1' });
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
  const rows = sheet.getRange(DATA_START_ROW, 1, numRows, COL.fechaNacimiento).getDisplayValues();
  const result = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const fechaNac = String(r[COL.fechaNacimiento - 1] || '').trim();
    const ddmm = extractDdMm_(fechaNac);
    if (!ddmm || ddmm !== target) continue;

    const yearNac = extractYear_(fechaNac);
    if (yearNac && yearNac < 1900) continue;       // descarta 0001, 0010, etc

    const nombre   = String(r[COL.participanteNombre - 1] || '').trim();
    const apellido = String(r[COL.participanteApellido - 1] || '').trim();
    if (!nombre || nombre === '-') continue;

    const todayYear  = parseInt(Utilities.formatDate(new Date(), 'America/Lima', 'yyyy'), 10);
    const edadCumple = yearNac ? (todayYear - yearNac) : null;

    const apN = String(r[COL.apoderadoNombre - 1] || '').trim();
    const apA = String(r[COL.apoderadoApellido - 1] || '').trim();

    result.push({
      nombre:    (nombre + ' ' + apellido).trim(),
      edad:      edadCumple !== null ? String(edadCumple) : '',
      sede:      SEDE_FIJA,
      grupo:     '',
      apoderado: (apN + ' ' + apA).trim(),
    });
  }

  return jsonResponse_({ ok: true, date: target, count: result.length, birthdays: result });
}

// ─── Helpers ────────────────────────────────────────────────────────

function getSheet_() {
  const sheets = SpreadsheetApp.getActive().getSheets();
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
