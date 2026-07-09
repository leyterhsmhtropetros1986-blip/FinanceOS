/** Learn from user corrections — supplier, SAP, invoice patterns */
import { stripAccents, similarity } from './helpers.js';

const STORAGE_KEY = 'parastatika-ocr-learning';

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function save(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function recordCorrection({ field, original, corrected, supplierId, afm }) {
  const db = load();
  if (!db.corrections) db.corrections = [];
  db.corrections.unshift({
    field, original, corrected, supplierId, afm,
    at: new Date().toISOString(),
  });
  db.corrections = db.corrections.slice(0, 500);

  if (field === 'supplier' && supplierId && corrected) {
    if (!db.suppliers) db.suppliers = {};
    const key = stripAccents(corrected.toUpperCase().slice(0, 40));
    db.suppliers[key] = { supplierId, name: corrected, count: (db.suppliers[key]?.count || 0) + 1 };
  }
  save(db);
}

export function boostSupplierFromLearning(nameHint, afm) {
  const db = load();
  if (!nameHint || !db.suppliers) return null;
  const key = stripAccents(nameHint.toUpperCase().slice(0, 40));
  let best = null;
  let bestScore = 0;
  for (const [k, v] of Object.entries(db.suppliers)) {
    const score = similarity(key, k) * 0.7 + Math.min(v.count, 20) * 1.5;
    if (score > bestScore && score > 60) {
      bestScore = score;
      best = { supplierId: v.supplierId, name: v.name, confidence: Math.min(99, 70 + v.count * 3) };
    }
  }
  return best;
}

export function getLearningStats() {
  const db = load();
  return {
    corrections: db.corrections?.length || 0,
    learnedSuppliers: Object.keys(db.suppliers || {}).length,
  };
}
