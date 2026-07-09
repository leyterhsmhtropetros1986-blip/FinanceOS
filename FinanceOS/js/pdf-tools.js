/** PDF merge, split, invoice boundary detection */
import { stripAccents } from './helpers.js';

export async function mergePdfFiles(files) {
  if (!window.PDFLib) throw new Error('PDFLib not loaded');
  const merged = await PDFLib.PDFDocument.create();
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }
  const out = await merged.save();
  const name = `merged_${files.length}docs_${Date.now()}.pdf`;
  return new File([out], name, { type: 'application/pdf' });
}

/**
 * Detect invoice page boundaries from OCR text per page.
 * New invoice when supplier, invoice number, or layout signature changes.
 */
export function detectInvoiceBoundaries(pages) {
  if (!pages?.length) return [{ start: 1, end: 1 }];
  const boundaries = [];
  let start = 1;
  let prevSig = '';

  for (let i = 0; i < pages.length; i++) {
    const text = pages[i].text || '';
    const sig = pageSignature(text);
    if (i > 0 && prevSig && sig && sig !== prevSig && looksLikeNewInvoice(text, pages[i - 1]?.text)) {
      boundaries.push({ start, end: i });
      start = i + 1;
    }
    prevSig = sig || prevSig;
  }
  boundaries.push({ start, end: pages.length });
  return boundaries;
}

function pageSignature(text) {
  const u = stripAccents((text || '').toUpperCase());
  const inv = u.match(/(?:ΤΙΜΟΛΟΓΙΟ|INVOICE|ΑΡΙΘΜΟΣ)[^\d]{0,30}(\S{4,20})/);
  const afm = u.match(/(?<!\d)(\d{9})(?!\d)/);
  return `${inv?.[1] || ''}|${afm?.[1] || ''}|${u.slice(0, 80)}`;
}

function looksLikeNewInvoice(currentText, prevText) {
  const cur = stripAccents((currentText || '').toUpperCase());
  const prev = stripAccents((prevText || '').toUpperCase());
  if (/ΤΙΜΟΛΟΓΙΟ|INVOICE|ΠΑΡΑΣΤΑΤΙΚΟ/.test(cur) && cur.slice(0, 200) !== prev.slice(0, 200)) return true;
  const curAfm = cur.match(/(?<!\d)(\d{9})(?!\d)/)?.[1];
  const prevAfm = prev.match(/(?<!\d)(\d{9})(?!\d)/)?.[1];
  if (curAfm && prevAfm && curAfm !== prevAfm) return true;
  return false;
}

export async function splitPdfByBoundaries(file, boundaries) {
  if (!window.PDFLib) throw new Error('PDFLib not loaded');
  const bytes = await file.arrayBuffer();
  const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  const outputs = [];
  for (let i = 0; i < boundaries.length; i++) {
    const { start, end } = boundaries[i];
    const doc = await PDFLib.PDFDocument.create();
    const indices = [];
    for (let p = start; p <= end; p++) indices.push(p - 1);
    const pages = await doc.copyPages(src, indices);
    pages.forEach((pg) => doc.addPage(pg));
    const out = await doc.save();
    outputs.push(new File([out], `${file.name.replace(/\.pdf$/i, '')}_part${i + 1}.pdf`, { type: 'application/pdf' }));
  }
  return outputs;
}
