/** Single-pass document render — one PDF open, text layer + canvas per page */
import { throwIfAborted, trackCanvas, yieldToMain } from './ocr-session.js';

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

    const viewportOcr = page.getViewport({ scale: 3.0 });
    const ocrCanvas = document.createElement('canvas');
    ocrCanvas.width = viewportOcr.width;
    ocrCanvas.height = viewportOcr.height;
    await page.render({ canvasContext: ocrCanvas.getContext('2d'), viewport: viewportOcr }).promise;
    trackCanvas(ocrCanvas);
    originalCanvases.push(ocrCanvas);

    const viewportPrev = page.getViewport({ scale: 1.2 });
    const prevCanvas = document.createElement('canvas');
    prevCanvas.width = viewportPrev.width;
    prevCanvas.height = viewportPrev.height;
    prevCanvas.getContext('2d').drawImage(ocrCanvas, 0, 0, prevCanvas.width, prevCanvas.height);
    trackCanvas(prevCanvas);
    previewCanvases.push(prevCanvas);

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

    await yieldToMain();
  }

  const embeddedFullText = embeddedPages.map((pg) => pg.text).join('\n');

  return {
    originalCanvases,
    previewCanvases,
    embeddedPages,
    embeddedFullText,
    pageCount: maxPages,
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
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    trackCanvas(canvas);
    const prev = document.createElement('canvas');
    const scale = Math.min(1, 1200 / canvas.width);
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
      buffer: null,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
