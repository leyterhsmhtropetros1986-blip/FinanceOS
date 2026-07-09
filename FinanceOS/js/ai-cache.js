/** AI extraction cache keyed by file hash */
const _mem = new Map();

export function getCachedAi(hash) {
  return _mem.get(hash) || null;
}

export function setCachedAi(hash, payload) {
  if (!hash) return;
  _mem.set(hash, {
    extracted: payload.extracted,
    engine: payload.engine,
    at: Date.now(),
  });
  if (_mem.size > 24) {
    const oldest = [..._mem.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) _mem.delete(oldest);
  }
}
