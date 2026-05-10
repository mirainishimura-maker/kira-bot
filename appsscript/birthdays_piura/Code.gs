// =====================================================================
// KIRA — Apps Script: Cumpleaños Ítaca Kids Piura
// =====================================================================
// Hoja: 1Z2Izlk19hKVcpDPXFB7t_ggGJZLEacaZwFXnTzZyXAY
// Pestaña: la primera de la hoja.
// Estructura: 6 columnas (#, Fecha dd/mm, Nombre, Edad, Grupo, Apoderado).
// Hay filas separadoras de mes (🎂 ABRIL, 🎂 MAYO, ...) que se ignoran.
// Espacio: itaca_kids_piura_birthdays
//
// CÓMO INSTALAR:
//   1. Abrir la hoja → Extensiones → Apps Script.
//   2. Borrar el código por defecto y pegar TODO este archivo.
//   3. Configuración del proyecto → Propiedades del script → KIRA_SECRET = <secret>
//      (puedes correr generateSecret() en el editor para que te sugiera uno).
//   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
//   5. Copiar la URL — la usaremos para guardarla en spaces.sheet_url.
// =====================================================================

const COL = {
  numero:    1,
  fecha:     2,  // dd/mm
  nombre:    3,
  edad:      4,
  grupo:     5,
  apoderado: 6,
};

const SAMA_SUFFIX  = '(Sama)';
const SEDE_DEFAULT = 'verificar sede';
const SEDE_SAMA    = 'Sama';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('KIRA_SECRET');
    if (!expected || body.secret !== expected) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }
    switch (body.action) {
      case 'ping':            return jsonResponse_({ ok: true, sheet: 'Piura cumples', version: 'v1' });
      case 'birthdaysToday':  return handleBirthdaysToday_(body);
      default: return jsonResponse_({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * body: { date?: 'dd/mm' }  // por defecto hoy en TZ Lima
 * Respuesta: { ok, date, count, birthdays: [{nombre, edad, sede, grupo, apoderado}] }
 */
function handleBirthdaysToday_(body) {
  const target = body.date ? String(body.date).trim() : todayDdMm_();
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse_({ ok: true, date: target, count: 0, birthdays: [] });

  const rows = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues();
  const result = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const fechaCelda = String(r[COL.fecha - 1] || '').trim();
    if (!isDdMm_(fechaCelda)) continue;          // ignora separadores de mes
    if (fechaCelda !== target) continue;
    const nombre = String(r[COL.nombre - 1] || '').trim();
    if (!nombre) continue;

    const grupo  = String(r[COL.grupo - 1] || '').trim();
    const isSama = grupo.includes(SAMA_SUFFIX);
    const sede   = isSama ? SEDE_SAMA : SEDE_DEFAULT;
    const grupoLimpio = grupo.replace(SAMA_SUFFIX, '').trim();

    result.push({
      nombre,
      edad:      String(r[COL.edad - 1] || '').trim(),
      sede,
      grupo:     grupoLimpio,
      apoderado: String(r[COL.apoderado - 1] || '').trim(),
    });
  }

  return jsonResponse_({ ok: true, date: target, count: result.length, birthdays: result });
}

// ─── Helpers ────────────────────────────────────────────────────────

function getSheet_() {
  return SpreadsheetApp.getActive().getSheets()[0];
}

function todayDdMm_() {
  return Utilities.formatDate(new Date(), 'America/Lima', 'dd/MM');
}

function isDdMm_(s) {
  return /^\d{2}\/\d{2}$/.test(s);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Utilidades ─────────────────────────────────────────────────────

function generateSecret() {
  const secret = Utilities.getUuid() + '-' + Utilities.getUuid();
  Logger.log('KIRA_SECRET sugerido: ' + secret);
  Logger.log('Cópialo a Configuración del proyecto → Propiedades del script.');
}

function testToday() {
  const e = { postData: { contents: JSON.stringify({
    secret: PropertiesService.getScriptProperties().getProperty('KIRA_SECRET'),
    action: 'birthdaysToday',
  })}};
  Logger.log(doPost(e).getContent());
}

function testSpecificDate() {
  const e = { postData: { contents: JSON.stringify({
    secret: PropertiesService.getScriptProperties().getProperty('KIRA_SECRET'),
    action: 'birthdaysToday',
    date: '10/05',
  })}};
  Logger.log(doPost(e).getContent());
}
