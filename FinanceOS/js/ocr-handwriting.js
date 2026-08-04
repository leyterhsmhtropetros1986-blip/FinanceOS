/**
 * Targeted fallback OCR pass for handwritten annotations (SAP doc numbers,
 * PO/routing notes) — stays entirely inside the free Tesseract pipeline, no
 * API credits. Only meant to run when the main pass didn't already find a
 * confident handwritten SAP doc candidate, so the common case stays fast.
 *
 * Handwritten notes on real invoices cluster in two zones: the top header
 * (stamped/written SAP doc numbers) and the bottom margin (routing notes
 * like "PO: 4500471482", "Inv: 30407"). Each zone gets cropped, upscaled and
 * contrast-enhanced on its own — handwriting reads far better isolated and
 * magnified than as part of a full, downscaled page — then OCR'd twice:
 * once unrestricted with a sparse-text page-segmentation mode (catches
 * labels like "Po:", "Inv:"), and once restricted to a digits-only
 * character whitelist. Whitelisting removes almost every confusable glyph
 * Tesseract could otherwise pick between — the single biggest accuracy
 * lever available for handwritten reference numbers, which are what this
 * pass actually needs to get right.
 */
import { cropStrip, upscaleCanvas, enhanceCanvas, binarizeCanvas } from './ocr-preprocess.js';
import { recognizeInWorker } from './ocr-worker-bridge.js';

const HANDWRITING_ZONES = [
  { from: 0, to: 0.3 },   // top header — where SAP doc stamps usually sit
  { from: 0.7, to: 1 },   // bottom margin — where routing notes usually sit
];
const UPSCALE_FACTOR = 1.6;
const PASS_VARIANTS = [
  { tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' },
  { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789./ ' },
];

async function ocrZoneVariant(pageCanvas, zone, params) {
  const { canvas: strip, offsetY } = cropStrip(pageCanvas, zone);
  const prepped = binarizeCanvas(enhanceCanvas(upscaleCanvas(strip, UPSCALE_FACTOR)));
  const data = await recognizeInWorker(prepped, params);
  const words = (data.words || [])
    .filter((w) => w.text && w.text.trim())
    .map((w) => ({
      text: w.text,
      confidence: Math.round(w.confidence || 0),
      x: Math.round((w.bbox?.x0 || 0) / UPSCALE_FACTOR),
      y: Math.round((w.bbox?.y0 || 0) / UPSCALE_FACTOR) + offsetY,
      w: w.bbox ? Math.round((w.bbox.x1 - w.bbox.x0) / UPSCALE_FACTOR) : 0,
      h: w.bbox ? Math.round((w.bbox.y1 - w.bbox.y0) / UPSCALE_FACTOR) : 0,
    }));
  return { text: data.text || '', words };
}

async function runZone(pageCanvas, zone) {
  const textParts = [];
  const words = [];
  for (const params of PASS_VARIANTS) {
    try {
      const r = await ocrZoneVariant(pageCanvas, zone, params);
      if (r.text) textParts.push(r.text);
      words.push(...r.words);
    } catch (e) {
      console.warn('Handwriting fallback pass failed (non-fatal):', e);
    }
  }
  return { textParts, words };
}

/**
 * @param {HTMLCanvasElement} pageCanvas - full page at OCR resolution
 * @returns {Promise<{ text: string, words: Array }>} text/words already
 *   mapped back into the full page's coordinate space.
 */
export async function runHandwritingFallback(pageCanvas) {
  if (!pageCanvas) return { text: '', words: [] };
  // The two zones don't overlap and the worker pool holds 2 concurrent
  // Tesseract instances — run them in parallel instead of doubling wall time.
  const results = await Promise.all(HANDWRITING_ZONES.map((zone) => runZone(pageCanvas, zone)));
  const textParts = [];
  const words = [];
  for (const r of results) {
    textParts.push(...r.textParts);
    words.push(...r.words);
  }
  return { text: textParts.join('\n'), words };
}
