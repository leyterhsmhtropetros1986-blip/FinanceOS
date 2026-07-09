/** Unified OCR pipeline — every stage wrapped in try/catch, never throws to caller */
import { renderToCanvases, getWorker, extractAllFields } from './ocr.js';
import { extractPdfText } from './pdf-text.js';
import { getOcrPassVariants, autoOrientCanvas } from './ocr-preprocess.js';
import { mergeExtractionResults, mergeOcrPages } from './field-extractors.js';
import { refineExtraction, sanitizeAgainstOcrText } from './ocr-confidence.js';
import * as extractors from './ocr.js';

const STAGES = ['upload', 'render', 'preprocess', 'ocr', 'extract', 'match', 'validate', 'done'];

export function createProgressReporter(onProgress) {
  let stage = 0;
  const setStage = (name, msg) => {
    const idx = STAGES.indexOf(name);
    if (idx >= 0) stage = idx;
    onProgress?.(msg || name, stage / (STAGES.length - 1));
  };
  const report = (msg, pct) => onProgress?.(msg, pct);
  return { setStage, report };
}

async function recognizePage(worker, canvas, label, params = {}) {
  try {
    if (params.whitelist) {
      await worker.setParameters({ tessedit_char_whitelist: params.whitelist });
    }
    if (params.psm) {
      await worker.setParameters({ tessedit_pageseg_mode: params.psm });
    }
    const { data } = await worker.recognize(canvas);
    await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
    return {
      text: data.text || '',
      words: (data.words || []).map((w) => ({
        text: w.text,
        confidence: Math.round(w.confidence || 0),
        x: w.bbox?.x0 || 0,
        y: w.bbox?.y0 || 0,
        w: w.bbox ? w.bbox.x1 - w.bbox.x0 : 0,
        h: w.bbox ? w.bbox.y1 - w.bbox.y0 : 0,
      })),
      mean_confidence: Math.round(data.confidence || 0),
      pass: label,
    };
  } catch (e) {
    console.warn(`OCR pass ${label} failed:`, e);
    return null;
  }
}

/**
 * Production OCR pipeline — Tesseract multi-pass + PDF text layer.
 * Never throws; returns partial results on failure.
 */
export async function runOcrPipeline(file, { onProgress, existingCanvases = null } = {}) {
  const t0 = performance.now();
  const progress = createProgressReporter(onProgress);
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  let canvases = existingCanvases;
  let pdfTextData = null;
  let pages = [];
  let fullText = '';
  let errors = [];

  try {
    progress.setStage('render', 'Rendering σελίδες…');
    if (!canvases) {
      canvases = await Promise.race([
        renderToCanvases(file, (m) => progress.report(m)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Render timeout (90s)')), 90000)),
      ]);
    }
  } catch (e) {
    errors.push(`render: ${e.message}`);
    return emptyResult(file, errors, t0);
  }

  try {
    progress.setStage('preprocess', 'Προεπεξεργασία εικόνας…');
    canvases = canvases.map((c) => autoOrientCanvas(c));
  } catch (e) {
    console.warn('Preprocess failed:', e);
  }

  if (isPdf) {
    try {
      progress.report('PDF text extraction…');
      pdfTextData = await extractPdfText(file, progress.report);
    } catch (e) {
      errors.push(`pdf-text: ${e.message}`);
    }
  }

  try {
    progress.setStage('ocr', 'OCR (multi-pass)…');
    const worker = await Promise.race([
      getWorker(progress.report),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Tesseract load timeout')), 120000)),
    ]);

    const allPageSets = [];
    for (let i = 0; i < canvases.length; i++) {
      progress.report(`OCR σελίδα ${i + 1}/${canvases.length}…`, i / canvases.length);
      const passes = getOcrPassVariants(canvases[i]);
      const passResults = [];
      for (const pass of passes) {
        const r = await recognizePage(worker, pass.canvas, pass.label, pass.params || {});
        if (r) {
          passResults.push({
            page_number: i + 1,
            text: r.text,
            words: r.words,
            width: pass.canvas.width,
            height: pass.canvas.height,
            mean_confidence: r.mean_confidence,
            pass: r.pass,
          });
        }
      }
      if (passResults.length) {
        allPageSets.push(mergeOcrPages([passResults]));
      }
    }
    pages = mergeOcrPages(allPageSets);
    fullText = [
      pdfTextData?.fullText || '',
      ...pages.map((p) => p.text),
    ].filter(Boolean).join('\n');
  } catch (e) {
    errors.push(`ocr: ${e.message}`);
    fullText = pdfTextData?.fullText || '';
    pages = pdfTextData?.pages || [];
  }

  try {
    progress.setStage('extract', 'Εξαγωγή πεδίων…');
    let ocrExtracted = extractAllFields(pages, fullText);
    ocrExtracted._meanOcrConfidence = pages.length
      ? Math.round(pages.reduce((s, p) => s + (p.mean_confidence || 0), 0) / pages.length)
      : 0;

    let pdfExtracted = null;
    if (pdfTextData?.fullText) {
      pdfExtracted = extractAllFields(pdfTextData.pages, pdfTextData.fullText);
      pdfExtracted._meanOcrConfidence = 95;
    }

    const meanOcr = ocrExtracted._meanOcrConfidence || 0;
    let extracted = pdfExtracted && meanOcr < 65
      ? mergeExtractionResults(pdfExtracted, ocrExtracted)
      : mergeExtractionResults(ocrExtracted, pdfExtracted);

    extracted = refineExtraction(extracted, fullText, pages, {
      extractAfm: extractors.extractAfm,
      extractInvoiceNumber: extractors.extractInvoiceNumber,
      extractDate: extractors.extractDate,
      extractSapDocCandidates: extractors.extractSapDocCandidates,
      extractSupplierNameHint: extractors.extractSupplierNameHint,
    });

    progress.setStage('validate', 'Έλεγχος αποτελεσμάτων…');
    extracted = sanitizeAgainstOcrText(extracted, fullText);

    const processingMs = Math.round(performance.now() - t0);
    progress.setStage('done', 'Ολοκληρώθηκε');

    return {
      filename: file.name,
      fileSize: file.size,
      pageCount: canvases.length,
      processingMs,
      engine: pdfTextData ? 'multi-pass OCR + PDF text' : 'multi-pass OCR',
      fullText,
      pdfText: pdfTextData?.fullText || null,
      extracted,
      extractedList: [extracted],
      canvases,
      supplierHint: extracted.supplier_name_hint,
      ocrConfidence: meanOcr,
      errors,
      success: true,
    };
  } catch (e) {
    errors.push(`extract: ${e.message}`);
    return {
      ...emptyResult(file, errors, t0),
      canvases,
      fullText,
      pages,
    };
  }
}

function emptyResult(file, errors, t0) {
  return {
    filename: file.name,
    fileSize: file.size,
    pageCount: 0,
    processingMs: Math.round(performance.now() - t0),
    engine: 'failed',
    fullText: '',
    extracted: blankExtraction(),
    extractedList: [blankExtraction()],
    canvases: [],
    errors,
    success: false,
  };
}

function blankExtraction() {
  return {
    afm: null, invoice_number: null, invoice_date: null, sap_doc_number: null,
    supplier_name_hint: null, confidence_afm: 0, confidence_invoice_no: 0,
    confidence_date: 0, confidence_sap_doc: 0, confidence_supplier: 0,
    sap_doc_candidates: [],
  };
}
