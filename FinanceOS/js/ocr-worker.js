/**
 * Tesseract OCR Web Worker — runs recognition off main thread.
 * Loaded via importScripts (classic worker).
 */
importScripts('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');

let tessWorker = null;

async function ensureTesseract() {
  if (tessWorker) return tessWorker;
  tessWorker = await Tesseract.createWorker(['ell', 'eng'], 1, { logger: () => {} });
  await tessWorker.setParameters({
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1',
  });
  return tessWorker;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id, type } = msg;
  try {
    if (type === 'init') {
      await ensureTesseract();
      self.postMessage({ id, type, ok: true });
      return;
    }
    if (type === 'recognize') {
      const w = await ensureTesseract();
      const { width, height, buffer } = msg;
      const rgba = new Uint8ClampedArray(buffer);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
      const { data } = await w.recognize(canvas);
      self.postMessage({
        id,
        type,
        ok: true,
        data: {
          text: data.text || '',
          confidence: data.confidence || 0,
          words: (data.words || []).map((word) => ({
            text: word.text,
            confidence: word.confidence,
            bbox: word.bbox,
          })),
        },
      });
      return;
    }
    if (type === 'terminate') {
      if (tessWorker) {
        try { await tessWorker.terminate(); } catch (err) { /* ignore */ }
        tessWorker = null;
      }
      self.postMessage({ id, type, ok: true });
      return;
    }
    self.postMessage({ id, type, ok: false, error: `Unknown type: ${type}` });
  } catch (err) {
    self.postMessage({ id, type, ok: false, error: String(err?.message || err) });
  }
};
