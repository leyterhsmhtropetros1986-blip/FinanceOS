/**
 * Single-pass OCR pipeline
 * Render once → preprocess once → OCR once → extract from text → optional Claude if <65%
 */
import { renderDocumentOnce } from './ocr-render.js';
import { preprocessOnce } from './ocr-preprocess.js';
import { getWorker, extractAllFields } from './ocr.js';
import { refineExtraction } from './ocr-confidence.js';
import * as extractors from './ocr.js';
import { matchSupplier } from './ocr.js';
import { computeFileHash, getCachedOcr, setCachedOcr } from './ocr-cache.js';
import {
  startOcrJob, throwIfAborted, createTimings, yieldToMain, cleanupOcrMemory,
} from './ocr-session.js';
import { runClaudeVisionOCRDirect } from './ai.js';
import { state } from './state.js';

const CONF_AI_THRESHOLD = 65;
const AI_TIMEOUT_MS = 60000;

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
 * Production single-pass pipeline.
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

  let hash = fileHash;
  if (!hash) {
    try {
      hash = await computeFileHash(file);
    } catch (e) {
      console.warn('Hash failed:', e);
    }
  }

  if (hash) {
    const cached = getCachedOcr(hash);
    if (cached) {
      timings.mark('cache_hit');
      timings.finish();
      progress.setStage('done', 'Cache hit — skipped OCR');
      return buildResult(file, cached, timings.marks, [], null);
    }
  }

  throwIfAborted(externalSignal);

  let bundle = renderBundle;
  try {
    progress.setStage('render', 'Rendering (once)…');
    timings.mark('upload');
    if (!bundle) {
      bundle = await renderDocumentOnce(file, {
        onProgress: (m) => progress.report(m),
        signal: externalSignal,
      });
    }
    timings.mark('render');
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    errors.push(`render: ${e.message}`);
    timings.finish();
    return emptyResult(file, errors, timings.marks);
  }

  throwIfAborted(externalSignal);

  const processedCanvases = [];
  try {
    progress.setStage('preprocess', 'Preprocess (once per page)…');
    for (let i = 0; i < bundle.originalCanvases.length; i++) {
      throwIfAborted(externalSignal);
      progress.report(`Preprocess σελ ${i + 1}/${bundle.originalCanvases.length}…`);
      processedCanvases.push(preprocessOnce(bundle.originalCanvases[i]));
      await yieldToMain();
    }
    timings.mark('preprocess');
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('Preprocess failed, using originals:', e);
    processedCanvases.push(...bundle.originalCanvases);
    timings.mark('preprocess');
  }

  throwIfAborted(externalSignal);

  let pages = [];
  let ocrFullText = '';
  try {
    progress.setStage('ocr', 'OCR (single pass)…');
    const worker = await getWorker((m) => progress.report(m));
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
      await yieldToMain();
    }
    ocrFullText = pages.map((p) => p.text).join('\n');
    timings.mark('ocr');
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    errors.push(`ocr: ${e.message}`);
    pages = bundle.embeddedPages || [];
    ocrFullText = '';
    timings.mark('ocr');
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

  const useAI = state.settings.provider === 'anthropic' && state.settings.apiKey;
  let engine = bundle.embeddedFullText ? 'single-pass OCR + PDF text' : 'single-pass OCR';
  let aiUsed = false;

  if (useAI && ocrConfidence < CONF_AI_THRESHOLD) {
    try {
      progress.report(`Claude Vision (confidence ${ocrConfidence}% < ${CONF_AI_THRESHOLD}%)…`);
      throwIfAborted(externalSignal);
      const aiResult = await Promise.race([
        runClaudeVisionOCRDirect(file, (m) => progress.report(`AI: ${m}`)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout (60s)')), AI_TIMEOUT_MS)),
      ]);
      extracted = mergeLowConfidenceWithAi(extracted, aiResult.extracted, fullText);
      engine = `${engine} + Claude (low confidence)`;
      aiUsed = true;
      timings.mark('claude');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('Claude skipped (non-fatal):', e);
      errors.push(`claude: ${e.message}`);
    }
  } else if (useAI) {
    timings.mark('claude_skipped');
  }

  progress.setStage('match', 'Supplier matching…');
  const [{ best, all: supplierCandidates }] = await Promise.all([
    Promise.resolve().then(() => {
      const m = matchSupplier(extracted.afm, extracted.supplier_name_hint, fullText);
      extracted.confidence_supplier = m.best
        ? m.best.confidence
        : (m.all[0]?.confidence || 0);
      return m;
    }),
  ]);
  timings.mark('supplier');

  progress.setStage('validate', 'Έλεγχος…');
  timings.mark('validate');

  const previewDataUrls = bundle.previewCanvases.map((c) => c.toDataURL('image/jpeg', 0.85));

  const payload = {
    fullText,
    pages: allPages,
    extracted,
    extractedList: [extracted],
    ocrConfidence,
    engine,
    pageCount: bundle.pageCount,
    previewCanvases: bundle.previewCanvases,
    previewDataUrls,
    supplierMatch: { best, all: supplierCandidates },
    aiUsed,
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

function mergeLowConfidenceWithAi(ocrExt, aiExt, fullText) {
  const out = { ...ocrExt };
  const fill = (field, confField, minAi = 60) => {
    if ((out[confField] || 0) >= CONF_AI_THRESHOLD && out[field]) return;
    if (aiExt[field] && (aiExt[confField] || 0) >= minAi) {
      out[field] = aiExt[field];
      out[confField] = aiExt[confField];
    }
  };
  fill('afm', 'confidence_afm');
  fill('invoice_number', 'confidence_invoice_no');
  fill('invoice_date', 'confidence_date');
  fill('sap_doc_number', 'confidence_sap_doc');
  if (!out.supplier_name_hint && aiExt.supplier_name_hint) {
    out.supplier_name_hint = aiExt.supplier_name_hint;
    out.confidence_supplier = aiExt.confidence_supplier || 70;
  }
  if (aiExt.sap_doc_candidates?.length) {
    const map = new Map((out.sap_doc_candidates || []).map((c) => [c.value, c]));
    for (const c of aiExt.sap_doc_candidates) {
      const prev = map.get(c.value);
      if (!prev || c.confidence > prev.confidence) map.set(c.value, c);
    }
    out.sap_doc_candidates = [...map.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 15);
  }
  return out;
}

function buildResult(file, payload, timings, errors, previewCanvases) {
  return {
    filename: file.name,
    fileSize: file.size,
    pageCount: payload.pageCount || 0,
    processingMs: timings?.total || 0,
    timings,
    engine: payload.engine || 'single-pass OCR',
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