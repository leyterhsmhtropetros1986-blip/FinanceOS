/** Validation & matching helpers */
// GREEK LANGUAGE HELPERS
// ═══════════════════════════════════════════════════════════
export function stripAccents(text) {
  return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
export function normalizeForMatch(text) {
  return stripAccents(text || '').toUpperCase().replace(/[^\w\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════

// AFM MOD-11 VALIDATION
// ═══════════════════════════════════════════════════════════
export function validateAfmChecksum(afm) {
  if (!afm || !/^\d{9}$/.test(afm) || afm === '000000000') return false;
  let total = 0;
  for (let i = 0; i < 8; i++) {
    total += parseInt(afm[i]) * Math.pow(2, 8 - i);
  }
  return (total % 11) % 10 === parseInt(afm[8]);
}

// ═══════════════════════════════════════════════════════════

// FUZZY MATCHING (Levenshtein-based similarity)
// ═══════════════════════════════════════════════════════════
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      cur.push(Math.min(
        prev[j + 1] + 1,
        cur[j] + 1,
        prev[j] + (a[i] === b[j] ? 0 : 1)
      ));
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length];
}
export function similarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return Math.round((1 - levenshtein(a, b) / maxLen) * 100);
}

// ═══════════════════════════════════════════════════════════

// SAP DOC NUMBER — χειρόγραφος αριθμός με στυλό, πάντα ένα από τα prefixes
// ═══════════════════════════════════════════════════════════
/** Επιτρεπόμενα prefixes (σειρά: μεγαλύτερο πρώτο για matching) */
export const SAP_HANDWRITTEN_PREFIXES = ['1900', '1700', '510'];
export const SAP_PREFIXES = SAP_HANDWRITTEN_PREFIXES;

export function hasAllowedSapPrefix(num) {
  const n = String(num || '').replace(/\D/g, '');
  return SAP_HANDWRITTEN_PREFIXES.some((p) => n.startsWith(p));
}

export function isValidSapDocNumber(num, { requirePrefix = true } = {}) {
  const clean = String(num || '').replace(/\D/g, '');
  if (clean.length < 6 || clean.length > 12) return false;
  if (requirePrefix && !hasAllowedSapPrefix(clean)) return false;
  return true;
}

export function sapPrefixBoost(number) {
  const n = String(number || '').replace(/\D/g, '');
  if (!isValidSapDocNumber(n)) return 0;
  for (const p of SAP_HANDWRITTEN_PREFIXES) {
    if (n.startsWith(p)) return 30 + p.length * 2;
  }
  return 0;
}

export function sapPrefixLabel(number) {
  const n = String(number || '').replace(/\D/g, '');
  for (const p of SAP_HANDWRITTEN_PREFIXES) {
    if (n.startsWith(p)) return p;
  }
  return 'invalid';
}
export function sapLengthBoost(number) {
  const L = number.length;
  if (L === 10) return 15;
  if (L === 8 || L === 9) return 10;
  if (L === 12) return 8;
  return 0;
}

// ═══════════════════════════════════════════════════════════
