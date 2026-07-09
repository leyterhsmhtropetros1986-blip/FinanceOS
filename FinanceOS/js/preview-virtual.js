/** Lazy virtual PDF preview — only renders visible pages */
import { trackCanvas } from './ocr-session.js';

const RENDER_AHEAD = 2;
const DEFAULT_SLOT_H = 520;

let _pdfDocCache = new WeakMap();

async function getPdfDoc(buffer) {
  if (_pdfDocCache.has(buffer)) return _pdfDocCache.get(buffer);
  const doc = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  _pdfDocCache.set(buffer, doc);
  return doc;
}

/**
 * Mount virtual scroll preview for large PDFs.
 * @param {HTMLElement} container
 * @param {{ pdfBuffer, pageCount, previewScale? }} bundle
 * @param {number} zoomPct
 */
export async function mountVirtualPreview(container, bundle, zoomPct = 100) {
  if (!container || !bundle?.pdfBuffer) return;
  container.innerHTML = '';
  container.classList.add('virtual-preview-root');

  const pageCount = bundle.pageCount || 1;
  const scale = bundle.previewScale || 1.0;
  const rendered = new Map();
  const slots = [];

  for (let p = 1; p <= pageCount; p++) {
    const slot = document.createElement('div');
    slot.className = 'virtual-page-slot skeleton';
    slot.dataset.page = String(p);
    slot.style.minHeight = `${DEFAULT_SLOT_H}px`;
    slot.innerHTML = `<div class="virtual-page-label">Σελίδα ${p}</div>`;
    container.appendChild(slot);
    slots.push(slot);
  }

  $('#preview-page-info').textContent = `${pageCount} σελίδες (virtual)`;

  async function renderPage(pageNum, slot) {
    if (rendered.has(pageNum)) return;
    rendered.set(pageNum, true);
    try {
      const pdf = await getPdfDoc(bundle.pdfBuffer);
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = 'preview-page';
      canvas.style.width = `${zoomPct}%`;
      canvas.dataset.pageIndex = String(pageNum - 1);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      trackCanvas(canvas);
      slot.classList.remove('skeleton');
      slot.innerHTML = '';
      slot.appendChild(canvas);
      slot.style.minHeight = '';
    } catch (e) {
      console.warn(`Virtual render page ${pageNum}:`, e);
      slot.classList.remove('skeleton');
      slot.innerHTML = `<div class="virtual-page-error">Σελίδα ${pageNum} — preview unavailable</div>`;
    }
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pageNum = parseInt(entry.target.dataset.page, 10);
      renderPage(pageNum, entry.target);
      for (let d = 1; d <= RENDER_AHEAD; d++) {
        const next = slots[pageNum - 1 + d];
        if (next) renderPage(pageNum + d, next);
      }
    }
  }, { root: container.closest('.preview-panel') || container, rootMargin: '200px 0px' });

  slots.forEach((s) => observer.observe(s));

  if (slots[0]) await renderPage(1, slots[0]);

  return {
    destroy() {
      observer.disconnect();
      rendered.clear();
    },
    updateZoom(pct) {
      container.querySelectorAll('.preview-page').forEach((c) => {
        c.style.width = `${pct}%`;
      });
    },
  };
}

export function isVirtualBundle(bundle) {
  return !!(bundle?.virtual && bundle?.pdfBuffer);
}

export function releasePdfDoc(buffer) {
  _pdfDocCache.delete(buffer);
}
