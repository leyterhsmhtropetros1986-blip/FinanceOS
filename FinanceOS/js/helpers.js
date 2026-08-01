/** Validation & matching helpers */
// GREEK LANGUAGE HELPERS
// ═══════════════════════════════════════════════════════════
export function stripAccents(text) {
  return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
export function normalizeForMatch(text) {
  // \w is ASCII-only in JS regex — even with the /u flag — so it silently
  // stripped every Greek letter from every name (confirmed: a pure-Greek
  // name normalized to an empty string). \p{L}/\p{N} are the Unicode-aware
  // equivalents and correctly keep Greek text intact.
  return stripAccents(text || '').toUpperCase().replace(/[^\p{L}\p{N}_\s]/gu, ' ').replace(/\s+/g, ' ').trim();
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

// DOCUMENT SECTION BOUNDARIES — avoid matching the CUSTOMER's own AFM/name
// as if it were the SUPPLIER's, and avoid matching item/product codes
// inside a line-items table as if they were header-level identifiers
// ═══════════════════════════════════════════════════════════
const CUSTOMER_SECTION_MARKERS = [
  'CUSTOMER DATA', 'ΣΥΝΑΛΛΑΣΣΟΜΕΝΟΥ', 'ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ',
  'BILL TO', 'SHIP TO', 'ΕΠΩΝΥΜΙΑ NAME', 'ΚΩΔΙΚΟΣ CODE',
];

/** Index where a "customer / bill-to" section starts in already
 *  uppercased+accent-stripped text, or text.length if none found. Matches
 *  after this point are almost certainly the CUSTOMER, not the supplier who
 *  issued the invoice — this matters most for business partners who show up
 *  as a supplier on some invoices and a customer on others (a real case:
 *  a manufacturer's own AFM/name printed in the ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ block of an
 *  invoice from one of ITS suppliers must never be read as if it issued
 *  that invoice). */
export function findCustomerSectionStart(upperText) {
  let earliest = upperText.length;
  for (const marker of CUSTOMER_SECTION_MARKERS) {
    const idx = upperText.indexOf(marker);
    if (idx !== -1 && idx < earliest) earliest = idx;
  }
  return earliest;
}

const ITEMS_TABLE_MARKERS = [
  'ΠΕΡΙΓΡΑΦΗ ΕΙΔΟΥΣ', 'ΚΩΔΙΚΟΣ ΕΙΔΟΥΣ', 'ΤΙΜΗ ΜΟΝ', 'ΚΑΘ. ΤΙΜΗ', 'ΚΑΘ. ΑΞΙΑ',
  'DESCRIPTION', 'UNIT PRICE',
];

/** Index where a tabular line-items section starts, or text.length if none
 *  found. Product/item codes inside such a table can coincidentally have
 *  the right digit count to look like an AFM/invoice number and even pass
 *  the MOD-11 checksum by chance — confirmed with a real invoice where a
 *  9-digit item code ("860000097") was picked up as the supplier's AFM. */
export function findItemsTableStart(upperText) {
  let earliest = upperText.length;
  for (const marker of ITEMS_TABLE_MARKERS) {
    const idx = upperText.indexOf(marker);
    if (idx !== -1 && idx < earliest) earliest = idx;
  }
  return earliest;
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

// HANDWRITING OCR CORRECTION — χειρόγραφα ψηφία συχνά διαβάζονται λάθος
// ═══════════════════════════════════════════════════════════
/** Small, deliberately conservative confusable map (block-capital digits
 *  vs. visually similar letters) to avoid corrupting unrelated tokens. */
const DIGIT_CONFUSABLES = { O: '0', o: '0', I: '1', l: '1', i: '1', S: '5', s: '5', B: '8' };

/** Retry a handwritten-looking token with common OCR digit/letter mix-ups
 *  corrected (O/0, I/l/1, S/5, B/8) — Tesseract frequently misreads pen
 *  handwriting this way even when printed text nearby reads cleanly. */
export function normalizeConfusableDigits(token) {
  return String(token || '').replace(/[OoIilSsB]/g, (ch) => DIGIT_CONFUSABLES[ch] || ch);
}

// ═══════════════════════════════════════════════════════════
