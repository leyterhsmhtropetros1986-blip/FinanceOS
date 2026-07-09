/**
 * Fast single-pass OCR pipeline
 * PDF text layer → skip Tesseract | else one light OCR pass → extract from text
 */
import { renderDocumentOnce } from './ocr-render.js';
import { preprocessFast } from './ocr-preprocess.js';
import { borrowWorker, releaseWorker, extractAllFields } from './ocr.js';
import { refineExtraction } from './ocr-confidence.js';
import * as extractors from './ocr.js';
import { matchSupplier } from './ocr.js';
import { computeFileHash, getCachedOcr, setCachedOcr } from './ocr-cache.js';
import {
  startOcrJob, throwIfAborted, createTimings, cleanupOcrMemory,
} from './ocr-session.js';
import { state } from './state.js';

const STAGES = ['upload', 'render', 'preprocess', 'ocr', 'extract', 'match', 'validate', 'done'];

export function createProgressReporter(onProgress) {
  let stage = 0;
  const setStage = (name, msg) => {
    const idx = STAGES.indexOf(name);
    if (idx >= 0) stage = idx;
    onProgress?.(msg || name, stage / (STAGES.length - 1));
  };
  return { setStage, report: (msg, pct) => onProgress?.(msg, pct) };
}

/** Cancel any in-flight OCR and start a fresh job */
export function beginOcrExtraction() {
  return startOcrJob();
}

/**
 * Production fast pipeline — target ≤5s per invoice.
 * @param {File} file
 * @param {{ onProgress?, signal?, renderBundle?, fileHash? }} opts
 */
export async function runOcrPipeline(file, {
  onProgress,
  signal: externalSignal,
  renderBundle = null,
  fileHash = null,
} = {}) {
  const timings = createTimings();
  const progress = createProgressReporter(onProgress);
  const errors = [];

  const hashPromise = fileHash
    ? Promise.resolve(fileHash)
    : computeFileHash(file).catch((e) => { console.warn('Hash failed:', e); return null; });

  let hash = fileHash;
  if (!renderBundle) {
    const cachedHash = await hashPromise;
    if (cachedHash) {
      hash = cachedHash;
      const cached = getCachedOcr(hash);
      if (cached) {
        timings.mark('cache_hit');
        timings.finish();
        progress.setStage('done', 'Cache hit — skipped OCR');
        return buildResult(file, cached, timings.marks, [], null);
      }
    }
  }

  throwIfAborted(externalSignal);

  let bundle = renderBundle;
  try {
    progress.setStage('render', 'Rendering…');
    timings.mark('upload');
    if (!bundle) {
      const [h, b] = await Promise.all([
        hashPromise,
        renderDocumentOnce(file, {
          onProgress: (m) => progress.report(m),
          signal: externalSignal,
        }),
      ]);
      hash = h || hash;
      bundle = b;
      if (hash) {
        const cached = getCachedOcr(hash);
        if (cached) {
          timings.mark('cache_hit');
          timings.finish();
          progress.setStage('done', 'Cache hit');
          return buildResult(file, cached, timings.marks, [], null);
        }
      }
    }
    timings.mark('render');
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    errors.push(`render: ${e.message}`);
    timings.finish();
    return emptyResult(file, errors, timings.marks);
  }

  throwIfAborted(externalSignal);

  const skipOcr = bundle.skipOcr || !bundle.originalCanvases?.length;
  let pages = [];
  let ocrFullText = '';

  if (skipOcr) {
    progress.report('PDF text layer — OCR skipped');
    timings.mark('preprocess');
    timings.mark('ocr');
  } else {
    const processedCanvases = [];
    try {
      progress.setStage('preprocess', 'Preprocess…');
      for (let i = 0; i < bundle.originalCanvases.length; i++) {
        throwIfAborted(externalSignal);
        processedCanvases.push(preprocessFast(bundle.originalCanvases[i]));
      }
      timings.mark('preprocess');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('Preprocess failed, using originals:', e);
      processedCanvases.push(...bundle.originalCanvases);
      timings.mark('preprocess');
    }

    throwIfAborted(externalSignal);

    try {
      progress.setStage('ocr', 'OCR…');
      const worker = await borrowWorker((m) => progress.report(m));
      try {
        for (let i = 0; i < processedCanvases.length; i++) {
          throwIfAborted(externalSignal);
          progress.report(`OCR σελ ${i + 1}/${processedCanvases.length}…`, i / processedCanvases.length);
          const { data } = await worker.recognize(processedCanvases[i]);
          pages.push({
            page_number: i + 1,
            text: data.text || '',
            words: (data.words || []).map((w) => ({
              text: w.text,
              confidence: Math.round(w.confidence || 0),
              x: w.bbox?.x0 || 0,
              y: w.bbox?.y0 || 0,
              w: w.bbox ? w.bbox.x1 - w.bbox.x0 : 0,
              h: w.bbox ? w.bbox.y1 - w.bbox.y0 : 0,
            })),
            width: processedCanvases[i].width,
            height: processedCanvases[i].height,
            mean_confidence: Math.round(data.confidence || 0),
          });
        }
        ocrFullText = pages.map((p) => p.text).join('\n');
      } finally {
        releaseWorker(worker);
      }
      timings.mark('ocr');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      errors.push(`ocr: ${e.message}`);
      pages = bundle.embeddedPages || [];
      ocrFullText = '';
      timings.mark('ocr');
    }
  }

  const fullText = [bundle.embeddedFullText, ocrFullText].filter(Boolean).join('\n');
  const allPages = mergePageText(bundle.embeddedPages, pages);

  throwIfAborted(externalSignal);

  progress.setStage('extract', 'Εξαγωγή πεδίων…');
  timings.mark('regex_start');

  let extracted = extractAllFields(allPages, fullText);
  extracted = refineExtraction(extracted, fullText, allPages, {
    extractAfm: extractors.extractAfm,
    extractInvoiceNumber: extractors.extractInvoiceNumber,
    extractDate: extractors.extractDate,
    extractSapDocCandidates: extractors.extractSapDocCandidates,
    extractSupplierNameHint: extractors.extractSupplierNameHint,
  });

  const ocrConfidence = computeMeanConfidence(allPages, bundle.embeddedPages);
  extracted._meanOcrConfidence = ocrConfidence;
  timings.mark('regex');

  const engine = skipOcr
    ? 'PDF text (fast)'
    : (bundle.embeddedFullText ? 'fast OCR + PDF text' : 'fast OCR');

  progress.setStage('match', 'Supplier matching…');
  const { best, all: supplierCandidates } = matchSupplier(extracted.afm, extracted.supplier_name_hint, fullText);
  extracted.confidence_supplier = best
    ? best.confidence
    : (supplierCandidates[0]?.confidence || 0);
  timings.mark('supplier');

  progress.setStage('validate', 'Έλεγχος…');
  timings.mark('validate');

  const payload = {
    fullText,
    pages: allPages,
    extracted,
    extractedList: [extracted],
    ocrConfidence,
    engine,
    pageCount: bundle.pageCount,
    previewCanvases: bundle.previewCanvases,
    previewDataUrls: null,
    supplierMatch: { best, all: supplierCandidates },
    aiUsed: false,
  };

  if (hash) setCachedOcr(hash, payload);

  timings.finish();
  progress.setStage('done', 'Ολοκληρώθηκε');

  return buildResult(file, payload, timings.marks, errors, bundle.previewCanvases);
}

/** @deprecated use runOcrPipeline — kept for imports */
export async function runSinglePassOcr(file, opts) {
  return runOcrPipeline(file, opts);
}

function mergePageText(embedded, ocrPages) {
  if (!embedded?.length) return ocrPages;
  if (!ocrPages.length) return embedded;
  return ocrPages.map((p, i) => {
    const emb = embedded[i];
    if (!emb?.text?.trim()) return p;
    const combined = `${emb.text}\n${p.text}`.trim();
    return {
      ...p,
      text: combined,
      words: [...(emb.words || []), ...(p.words || [])],
      mean_confidence: Math.max(p.mean_confidence || 0, emb.mean_confidence || 0),
    };
  });
}

function computeMeanConfidence(ocrPages, embeddedPages) {
  const scores = [];
  for (const p of ocrPages || []) scores.push(p.mean_confidence || 0);
  for (const p of embeddedPages || []) {
    if (p.text?.trim().length > 40) scores.push(95);
  }
  return scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;
}

function buildResult(file, payload, timings, errors, previewCanvases) {
  return {
    filename: file.name,
    fileSize: file.size,
    pageCount: payload.pageCount || 0,
    processingMs: timings?.total || 0,
    timings,
    engine: payload.engine || 'fast OCR',
    fullText: payload.fullText || '',
    extracted: payload.extracted,
    extractedList: payload.extractedList || [payload.extracted],
    canvases: previewCanvases || payload.previewCanvases || [],
    previewDataUrls: payload.previewDataUrls,
    supplierHint: payload.extracted?.supplier_name_hint,
    supplierMatch: payload.supplierMatch,
    ocrConfidence: payload.ocrConfidence || 0,
    errors: errors || [],
    success: true,
    cached: !!timings?.cache_hit,
  };
}

function emptyResult(file, errors, timings) {
  return {
    filename: file.name,
    fileSize: file.size,
    pageCount: 0,
    processingMs: timings?.total || 0,
    timings,
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

export { cleanupOcrMemory, cancelOcrJob } from './ocr-session.js';
