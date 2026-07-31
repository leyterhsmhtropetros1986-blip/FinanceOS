/** Normalization utilities — VAT, IBAN, supplier name, invoice/PO number.
 *  Every function returns { originalValue, normalizedValue } and never
 *  destroys the original extracted value. Pure, reusable, no state. */
import { stripAccents } from './helpers.js';

// ═══════════════════════════════════════════════════════════
// VAT / TAX ID
// ═══════════════════════════════════════════════════════════

/** Uppercase, strip spaces/punctuation, preserve country prefix if present. */
export function normalizeVat(raw) {
  const originalValue = raw == null ? '' : String(raw);
  if (!originalValue.trim()) return { originalValue, normalizedValue: null };
  const cleaned = originalValue.toUpperCase().replace(/[\s\-.]/g, '');
  const normalizedValue = cleaned || null;
  return { originalValue, normalizedValue };
}

/** True if the normalized VAT has a 2-letter country prefix (e.g. EL, IT). */
export function vatHasCountryPrefix(normalizedVat) {
  return /^[A-Z]{2}/.test(String(normalizedVat || ''));
}

/** Basic structural check — 2-letter prefix (optional) + 5-15 alphanumerics. */
export function isPlausibleVatFormat(normalizedVat) {
  const v = String(normalizedVat || '');
  if (!v) return false;
  return /^[A-Z]{0,2}[A-Z0-9]{5,15}$/.test(v);
}

/** EU VIES-style VAT country prefix → ISO-3166 country code. EL (Greek VAT
 *  prefix) maps to GR (ISO country code) — a well-established, fixed quirk. */
const VAT_COUNTRY_PREFIXES = {
  AT: 'AT', BE: 'BE', BG: 'BG', CY: 'CY', CZ: 'CZ', DE: 'DE', DK: 'DK', EE: 'EE',
  EL: 'GR', ES: 'ES', FI: 'FI', FR: 'FR', HR: 'HR', HU: 'HU', IE: 'IE', IT: 'IT',
  LT: 'LT', LU: 'LU', LV: 'LV', MT: 'MT', NL: 'NL', PL: 'PL', PT: 'PT', RO: 'RO',
  SE: 'SE', SI: 'SI', SK: 'SK', GB: 'GB', XI: 'GB', CH: 'CH', NO: 'NO', US: 'US',
};

/** Derive supplier country from a normalized VAT — never guesses beyond the
 *  VAT string itself: a 2-letter prefix decodes directly, a bare 9-digit
 *  number is the Greek AFM scheme (no prefix used domestically). Anything
 *  else returns null rather than inventing a country. */
export function inferCountryFromVat(normalizedVat) {
  const v = String(normalizedVat || '');
  if (!v) return null;
  const prefix = v.slice(0, 2);
  if (VAT_COUNTRY_PREFIXES[prefix]) return VAT_COUNTRY_PREFIXES[prefix];
  if (/^\d{9}$/.test(v)) return 'GR';
  return null;
}

// ═══════════════════════════════════════════════════════════
// IBAN
// ═══════════════════════════════════════════════════════════

/** Uppercase, strip spaces/dashes. Does not attempt to reformat in groups of 4. */
export function normalizeIban(raw) {
  const originalValue = raw == null ? '' : String(raw);
  if (!originalValue.trim()) return { originalValue, normalizedValue: null };
  const cleaned = originalValue.toUpperCase().replace(/[\s\-]/g, '');
  const normalizedValue = cleaned || null;
  return { originalValue, normalizedValue };
}

/** Structural check: 2-letter country + 2 check digits + up to 30 alphanumerics. */
export function isPlausibleIbanFormat(normalizedIbanValue) {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(String(normalizedIbanValue || ''));
}

/** ISO 7064 MOD-97-10 checksum. Returns null if the format is not plausible. */
export function validateIbanChecksum(normalizedIbanValue) {
  const iban = String(normalizedIbanValue || '');
  if (!isPlausibleIbanFormat(iban)) return null;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(String(remainder) + numeric.slice(i, i + 7)) % 97;
  }
  return remainder === 1;
}

// ═══════════════════════════════════════════════════════════
// SUPPLIER NAME
// ═══════════════════════════════════════════════════════════

/** Legal-form suffixes we treat as equivalent noise for comparison only
 *  (never stripped from the value shown to the user). */
const LEGAL_SUFFIXES = [
  'A.E.', 'AE', 'Α.Ε.', 'ΑΕ',
  'Ε.Π.Ε.', 'ΕΠΕ', 'E.P.E.', 'EPE',
  'Ο.Ε.', 'ΟΕ', 'O.E.', 'OE',
  'Ι.Κ.Ε.', 'ΙΚΕ', 'I.K.E.', 'IKE',
  'Μ.Ε.Π.Ε.', 'ΜΕΠΕ',
  'S.A.', 'SA', 'S.R.L.', 'SRL', 'LTD', 'LIMITED', 'GMBH', 'INC', 'CORP', 'CO',
  'ΜΟΝΟΠΡΟΣΩΠΗ', 'MONOPROSOPI',
];

/** Uppercase, accent-stripped, punctuation-normalized comparison key.
 *  Legal suffixes are removed only from the *comparison* key, never from
 *  normalizedValue's display form. Supports Greek/Latin by stripping
 *  accents from Greek first (safe — does not transliterate). */
export function normalizeSupplierName(raw) {
  const originalValue = raw == null ? '' : String(raw);
  if (!originalValue.trim()) return { originalValue, normalizedValue: null, comparisonKey: null };

  const upper = stripAccents(originalValue).toUpperCase();
  const normalizedValue = upper.replace(/[^\p{L}\p{N}\s.&-]/gu, ' ').replace(/\s+/g, ' ').trim();

  let comparisonKey = normalizedValue;
  for (const suffix of LEGAL_SUFFIXES) {
    const suffixNorm = stripAccents(suffix).toUpperCase();
    comparisonKey = comparisonKey
      .replace(new RegExp(`(^|\\s)${suffixNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'g'), ' ');
  }
  comparisonKey = comparisonKey.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

  return { originalValue, normalizedValue: normalizedValue || null, comparisonKey: comparisonKey || normalizedValue || null };
}

// ═══════════════════════════════════════════════════════════
// INVOICE NUMBER
// ═══════════════════════════════════════════════════════════

/** Trim whitespace, collapse internal whitespace. Separators (- / .) are
 *  preserved in normalizedValue since invoice numbering schemes vary — only
 *  whitespace noise is removed. originalValue is always preserved untouched. */
export function normalizeInvoiceNumber(raw) {
  const originalValue = raw == null ? '' : String(raw);
  if (!originalValue.trim()) return { originalValue, normalizedValue: null };
  const normalizedValue = originalValue.trim().replace(/\s+/g, '') || null;
  return { originalValue, normalizedValue };
}

// ═══════════════════════════════════════════════════════════
// PO NUMBER
// ═══════════════════════════════════════════════════════════

/** Trim/collapse whitespace. Optional structural validation against a
 *  configured pattern (e.g. /^45\d{8}$/ for SAP standard POs) — only
 *  applied if a pattern is supplied; absence of config never invalidates. */
export function normalizePoNumber(raw, { pattern } = {}) {
  const originalValue = raw == null ? '' : String(raw);
  if (!originalValue.trim()) return { originalValue, normalizedValue: null, matchesExpectedFormat: null };
  const normalizedValue = originalValue.trim().replace(/\s+/g, '') || null;
  const matchesExpectedFormat = pattern ? pattern.test(normalizedValue) : null;
  return { originalValue, normalizedValue, matchesExpectedFormat };
}
