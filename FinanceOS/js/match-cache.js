/** Supplier match cache — avoid repeat queries per session */
import { matchSupplier } from './ocr.js';

const _cache = new Map();
const MAX = 200;

export function matchSupplierCached(afm, hint, fullText) {
  const key = `${afm || ''}|${hint || ''}|${(fullText || '').length}`;
  if (_cache.has(key)) return _cache.get(key);
  const result = matchSupplier(afm, hint, fullText);
  if (_cache.size >= MAX) {
    const first = _cache.keys().next().value;
    _cache.delete(first);
  }
  _cache.set(key, result);
  return result;
}

export function clearMatchCache() {
  _cache.clear();
}
