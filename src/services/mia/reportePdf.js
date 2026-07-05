// NEURA · Fase 2 — Reportes en PDF.
// Toma el último reporte que Claude le redactó a Mirai (texto con formato
// WhatsApp: *negritas*, • viñetas) y lo convierte en un PDF prolijo con la
// identidad NEURA. Lo sube al bucket PRIVADO y se lo manda por WhatsApp con una
// URL firmada temporal (los reportes NO quedan públicos). Ella luego lo abre,
// imprime o lo sube a Canva con "Importar archivo".

import PDFDocument from 'pdfkit';
import { config } from '../../config.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { sendDocument } from '../../lib/evolution.js';
import { getLastReport } from './reporte.js';

// paleta NEURA (lila neutralizado)
const INK = '#2b2733';
const MUT = '#8a8494';
const ACC = '#7d6f95';
const LINE = '#e7e2ec';

const M = 60; // margen

// Escribe una línea respetando *negritas* en línea (alterna Helvetica / -Bold).
function writeRich(doc, line, { indent = 0 } = {}) {
  const segs = line.split('*').map((t, i) => ({ text: t, bold: i % 2 === 1 })).filter((s) => s.text.length);
  if (segs.length === 0) return;
  const x = M + indent;
  const width = doc.page.width - M - M - indent;
  doc.fillColor(INK).fontSize(10.5);
  segs.forEach((s, i) => {
    doc.font(s.bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(s.text, i === 0 ? x : undefined, i === 0 ? doc.y : undefined, {
      continued: i < segs.length - 1,
      width,
      lineGap: 3,
      align: 'left',
    });
  });
}

export function renderReportPdf(reportText) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 88, bottom: 60, left: M, right: M } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageW = doc.page.width;
      const dateStr = new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' });

      // ---- cabecera ----
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ACC)
        .text('NEURA', M, 46, { characterSpacing: 4 });
      doc.font('Helvetica').fontSize(8.5).fillColor(MUT)
        .text(dateStr.toUpperCase(), M, 49, { width: pageW - M - M, align: 'right', characterSpacing: 1 });
      doc.moveTo(M, 70).lineTo(pageW - M, 70).lineWidth(1).strokeColor(LINE).stroke();
      doc.y = 92;

      const lines = reportText.replace(/\r/g, '').split('\n');
      let titleDone = false;

      for (const raw of lines) {
        const line = raw.trimEnd();
        const t = line.trim();

        if (!t) { doc.moveDown(0.5); continue; }

        // Título: primera línea con contenido (quita * envolventes).
        if (!titleDone) {
          titleDone = true;
          const title = t.replace(/^\*+|\*+$/g, '').trim();
          doc.font('Helvetica-Bold').fontSize(19).fillColor(INK)
            .text(title, M, doc.y, { width: pageW - M - M, lineGap: 2 });
          doc.moveDown(0.6);
          continue;
        }

        // Encabezado de sección: línea entera entre *...*
        if (/^\*[^*]+\*$/.test(t)) {
          doc.moveDown(0.35);
          doc.font('Helvetica-Bold').fontSize(12.5).fillColor(ACC)
            .text(t.replace(/^\*|\*$/g, '').trim(), M, doc.y, { width: pageW - M - M });
          doc.moveDown(0.15);
          continue;
        }

        // Viñeta: empieza con •, - o *
        if (/^[•\-*]\s+/.test(t)) {
          const content = t.replace(/^[•\-*]\s+/, '');
          const y0 = doc.y;
          doc.circle(M + 3, y0 + 6, 1.7).fillColor(ACC).fill();
          writeRich(doc, content, { indent: 14 });
          doc.moveDown(0.15);
          continue;
        }

        // Párrafo normal
        writeRich(doc, t);
        doc.moveDown(0.3);
      }

      // ---- pie ----
      doc.font('Helvetica').fontSize(8).fillColor(MUT)
        .text('Generado por Neura · tu asistente', M, doc.page.height - 44, {
          width: pageW - M - M, align: 'center',
        });

      doc.end();
    } catch (e) { reject(e); }
  });
}

// Genera y envía por WhatsApp el último reporte como PDF.
export async function enviarReportePdf() {
  const reportText = getLastReport();
  if (!reportText) {
    return { handled: true, reply: 'Primero dictame el reporte 🙂 y después dime "mándalo en PDF".' };
  }
  if (!miraiSupabase) return { handled: true, reply: 'No tengo el almacenamiento conectado ahora mismo.' };

  let buf;
  try {
    buf = await renderReportPdf(reportText);
  } catch (e) {
    console.error('[neura/reportePdf] render:', e.message);
    return { handled: true, reply: 'Uy, no pude armar el PDF. ¿Lo intento de nuevo?' };
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const path = `reportes/reporte-${stamp}.pdf`;
  const { error: upErr } = await miraiSupabase.storage.from(config.neura.stateBucket)
    .upload(path, buf, { contentType: 'application/pdf', upsert: true });
  if (upErr) {
    console.error('[neura/reportePdf] upload:', upErr.message);
    return { handled: true, reply: 'No pude subir el PDF ahora 😕' };
  }

  const { data, error: urlErr } = await miraiSupabase.storage.from(config.neura.stateBucket)
    .createSignedUrl(path, 3600);
  const url = data?.signedUrl;
  if (urlErr || !url) {
    console.error('[neura/reportePdf] signedUrl:', urlErr?.message);
    return { handled: true, reply: 'Armé el PDF pero no pude generar el enlace. ¿Lo reintento?' };
  }

  const fileName = `Reporte Neura ${new Date().toLocaleDateString('es-PE')}.pdf`;
  try {
    await sendDocument(`${config.mia.personalPhone}@s.whatsapp.net`, url, fileName);
  } catch (e) {
    console.error('[neura/reportePdf] send:', e.message);
    return { handled: true, reply: `Aquí está tu reporte: ${url}` };
  }

  return {
    handled: true,
    reply: '📄 Te mandé tu reporte en PDF.\nÁbrelo, imprímelo o súbelo a Canva con *Importar archivo* ✦',
  };
}
