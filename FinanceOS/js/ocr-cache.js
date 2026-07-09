/** In-memory OCR result cache keyed by file hash */

const _cache = new Map();
const MAX_ENTRIES = 24;

export async function computeFileHash(file) {
  const size = file.size;
  const head = await file.slice(0, Math.min(size, 65536)).arrayBuffer();
  const tailBuf = size > 65536
    ? await file.slice(Math.max(0, size - 65536)).arrayBuffer()
    : null;
  const meta = new TextEncoder().encode(`${file.name}|${size}|${file.lastModified}`);
  const total = head.byteLength + (tailBuf?.byteLength || 0) + meta.length;
  const combined = new Uint8Array(total);
  combined.set(new Uint8Array(head), 0);
  let off = head.byteLength;
  if (tailBuf) {
    combined.set(new Uint8Array(tailBuf), off);
    off += tailBuf.byteLength;
  }
  combined.set(meta, off);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getCachedOcr(hash) {
  const entry = _cache.get(hash);
  if (!entry) return null;
  entry.lastAccess = Date.now();
  return entry.payload;
}

export function setCachedOcr(hash, payload) {
  if (_cache.size >= MAX_ENTRIES) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of _cache) {
      if (v.lastAccess < oldest) { oldest = v.lastAccess; oldestKey = k; }
    }
    if (oldestKey) _cache.delete(oldestKey);
  }
  _cache.set(hash, { payload: structuredClonePayload(payload), lastAccess: Date.now() });
}

function structuredClonePayload(p) {
  return {
    fullText: p.fullText,
    pages: p.pages,
    extracted: p.extracted,
    extractedList: p.extractedList,
    ocrConfidence: p.ocrConfidence,
    engine: p.engine,
    pageCount: p.pageCount,
    previewDataUrls: p.previewDataUrls ? [...p.previewDataUrls] : null,
    timings: p.timings,
  };
}

export function clearOcrCache() {
  _cache.clear();
}
