/** Single-pass document render — one PDF open, text layer + canvas per page */
import { throwIfAborted, trackCanvas } from './ocr-session.js';

export const OCR_MAX_WIDTH = 1400;
export const PREVIEW_SCALE = 1.0;
export const MAX_OCR_PAGES = 1;

/** Enough embedded PDF text → skip Tesseract entirely */
export function embeddedTextIsSufficient(pages) {
  const full = (pages || []).map((p) => p.text || '').join('\n').trim();
  if (full.length < 80) return false;
  const digits = (full.match(/\d/g) || []).length;
  return digits >= 6;
}

export async function renderDocumentOnce(file, { onProgress, signal } = {}) {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  if (!isPdf) {
    return renderImageOnce(file, { signal });
  }

  const buffer = await file.arrayBuffer();
  throwIfAborted(signal);
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const maxPages = Math.min(pdf.numPages, 100);
  const originalCanvases = [];
  const previewCanvases = [];
  const embeddedPages = [];

  for (let p = 1; p <= maxPages; p++) {
    throwIfAborted(signal);
    onProgress?.(`Render σελ ${p}/${maxPages}…`, p / maxPages);
    const page = await pdf.getPage(p);

    const viewportText = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items || [];
    const text = items.map((it) => it.str).join(' ');
    const words = items.map((it) => {
      const tx = it.transform || [1, 0, 0, 1, 0, 0];
      return {
        text: it.str,
        confidence: 95,
        x: tx[4],
        y: viewportText.height - tx[5],
        w: it.width || 0,
        h: it.height || 12,
      };
    }).filter((w) => w.text.trim());

    embeddedPages.push({
      page_number: p,
      text,
      words,
      width: viewportText.width,
      height: viewportText.height,
      mean_confidence: text.trim().length > 40 ? 95 : 0,
      source: 'pdf_embedded',
    });

    const viewportPrev = page.getViewport({ scale: PREVIEW_SCALE });
    const prevCanvas = document.createElement('canvas');
    prevCanvas.width = viewportPrev.width;
    prevCanvas.height = viewportPrev.height;
    await page.render({ canvasContext: prevCanvas.getContext('2d'), viewport: viewportPrev }).promise;
    trackCanvas(prevCanvas);
    previewCanvases.push(prevCanvas);
  }

  const skipOcr = embeddedTextIsSufficient(embeddedPages);
  const ocrPageLimit = skipOcr ? 0 : Math.min(maxPages, MAX_OCR_PAGES);

  if (!skipOcr) {
    for (let p = 1; p <= ocrPageLimit; p++) {
      throwIfAborted(signal);
      const page = await pdf.getPage(p);
      const baseVp = page.getViewport({ scale: 1 });
      const ocrScale = Math.min(2.0, OCR_MAX_WIDTH / baseVp.width);
      const viewportOcr = page.getViewport({ scale: ocrScale });
      const ocrCanvas = document.createElement('canvas');
      ocrCanvas.width = viewportOcr.width;
      ocrCanvas.height = viewportOcr.height;
      await page.render({ canvasContext: ocrCanvas.getContext('2d'), viewport: viewportOcr }).promise;
      trackCanvas(ocrCanvas);
      originalCanvases.push(ocrCanvas);
    }
  }

  const embeddedFullText = embeddedPages.map((pg) => pg.text).join('\n');

  return {
    originalCanvases,
    previewCanvases,
    embeddedPages,
    embeddedFullText,
    pageCount: maxPages,
    skipOcr,
    buffer,
  };
}

async function renderImageOnce(file, { signal }) {
  throwIfAborted(signal);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    throwIfAborted(signal);
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const maxDim = OCR_MAX_WIDTH;
    if (Math.max(w, h) > maxDim) {
      const r = maxDim / Math.max(w, h);
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    trackCanvas(canvas);
    const prev = document.createElement('canvas');
    const scale = Math.min(1, 900 / canvas.width);
    prev.width = Math.round(canvas.width * scale);
    prev.height = Math.round(canvas.height * scale);
    prev.getContext('2d').drawImage(canvas, 0, 0, prev.width, prev.height);
    trackCanvas(prev);
    return {
      originalCanvases: [canvas],
      previewCanvases: [prev],
      embeddedPages: [],
      embeddedFullText: '',
      pageCount: 1,
      skipOcr: false,
      buffer: null,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
