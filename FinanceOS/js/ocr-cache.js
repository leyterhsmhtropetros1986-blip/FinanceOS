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

export async function getCachedOcr(hash) {
  const entry = _cache.get(hash);
  if (entry) {
    entry.lastAccess = Date.now();
    return entry.payload;
  }
  const idb = await getIdbCache(hash);
  if (idb) {
    _cache.set(hash, { payload: idb, lastAccess: Date.now() });
    return idb;
  }
  return null;
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
  const cloned = structuredClonePayload(payload);
  _cache.set(hash, { payload: cloned, lastAccess: Date.now() });
  setIdbCache(hash, cloned).catch(() => {});
}

async function getIdbCache(hash) {
  try {
    const { idbOpen } = await import('./storage.js');
    const db = await idbOpen();
    return new Promise((res) => {
      const tx = db.transaction('ocrCache', 'readonly');
      const req = tx.objectStore('ocrCache').get(hash);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => res(null);
    });
  } catch { return null; }
}

async function setIdbCache(hash, payload) {
  try {
    const { idbOpen } = await import('./storage.js');
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction('ocrCache', 'readwrite');
      tx.objectStore('ocrCache').put(payload, hash);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* ignore */ }
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
