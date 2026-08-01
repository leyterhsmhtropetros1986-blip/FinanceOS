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
 * magnified than as part of a full, downscaled page — then OCR'd with a
 * sparse-text page-segmentation mode suited to scattered annotations rather
 * than the dense uniform-block mode used for the main printed body.
 */
import { cropStrip, upscaleCanvas, enhanceCanvas, binarizeCanvas } from './ocr-preprocess.js';
import { recognizeInWorker } from './ocr-worker-bridge.js';

const HANDWRITING_ZONES = [
  { from: 0, to: 0.3 },   // top header — where SAP doc stamps usually sit
  { from: 0.7, to: 1 },   // bottom margin — where routing notes usually sit
];
const UPSCALE_FACTOR = 1.6;
const SPARSE_PSM_PARAMS = { tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' };

/**
 * @param {HTMLCanvasElement} pageCanvas - full page at OCR resolution
 * @returns {Promise<{ text: string, words: Array }>} text/words already
 *   mapped back into the full page's coordinate space.
 */
export async function runHandwritingFallback(pageCanvas) {
  if (!pageCanvas) return { text: '', words: [] };
  const textParts = [];
  const words = [];

  for (const zone of HANDWRITING_ZONES) {
    let strip, offsetY;
    try {
      ({ canvas: strip, offsetY } = cropStrip(pageCanvas, zone));
      const prepped = binarizeCanvas(enhanceCanvas(upscaleCanvas(strip, UPSCALE_FACTOR)));
      const data = await recognizeInWorker(prepped, SPARSE_PSM_PARAMS);
      if (data.text) textParts.push(data.text);
      for (const w of data.words || []) {
        if (!w.text || !w.text.trim()) continue;
        words.push({
          text: w.text,
          confidence: Math.round(w.confidence || 0),
          x: Math.round((w.bbox?.x0 || 0) / UPSCALE_FACTOR),
          y: Math.round((w.bbox?.y0 || 0) / UPSCALE_FACTOR) + offsetY,
          w: w.bbox ? Math.round((w.bbox.x1 - w.bbox.x0) / UPSCALE_FACTOR) : 0,
          h: w.bbox ? Math.round((w.bbox.y1 - w.bbox.y0) / UPSCALE_FACTOR) : 0,
        });
      }
    } catch (e) {
      console.warn('Handwriting fallback zone failed (non-fatal):', e);
    }
  }

  return { text: textParts.join('\n'), words };
}
