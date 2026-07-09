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

// SAP DOC NUMBER SCORING
// ═══════════════════════════════════════════════════════════
export const SAP_PREFIXES = ['1900', '1700', '20', '60'];

export function sapPrefixBoost(number) {
  for (const p of SAP_PREFIXES) {
    if (number.startsWith(p)) return 25 + (p.length * 2);  // 1900→33, 20→29
  }
  return 0;
}
export function sapLengthBoost(number) {
  const L = number.length;
  if (L === 10) return 15;
  if (L === 8 || L === 9) return 10;
  if (L === 12) return 8;
  return 0;
}

// ═══════════════════════════════════════════════════════════
