/** PDF embedded text extraction via PDF.js */

export async function extractPdfText(file, onProgress) {
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  const maxPages = Math.min(pdf.numPages, 100);
  for (let p = 1; p <= maxPages; p++) {
    onProgress?.(`PDF text σελ ${p}/${maxPages}…`, p / maxPages);
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items || [];
    const text = items.map((it) => it.str).join(' ');
    const words = items.map((it) => {
      const tx = it.transform || [1, 0, 0, 1, 0, 0];
      const x = tx[4];
      const y = viewport.height - tx[5];
      const w = it.width || 0;
      const h = it.height || 12;
      return {
        text: it.str,
        confidence: 95,
        x, y, w, h,
      };
    }).filter((w) => w.text.trim());
    pages.push({
      page_number: p,
      text,
      words,
      width: viewport.width,
      height: viewport.height,
      mean_confidence: 95,
      source: 'pdf_embedded',
    });
  }
  const fullText = pages.map((p) => p.text).join('\n');
  return { pages, fullText, engine: 'pdf.js text layer' };
}
