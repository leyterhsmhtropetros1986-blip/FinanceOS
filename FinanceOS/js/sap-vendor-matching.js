/**
 * SAP Vendor Matching Engine (Phases 4-5).
 *
 * Deterministic, evidence-based matching of an extracted invoice against the
 * SAP Vendor Master (state.suppliers, enriched in suppliers.js) plus any
 * human-approved mappings (vendor-mappings.js). This is a NEW, additive
 * computation — it does not read or change the existing archive-filing
 * matchSupplier() in ocr.js, and has no effect on auto-archive behavior.
 *
 * Hard rule throughout: supplier name alone (fuzzy or otherwise) NEVER
 * produces status MATCHED. Only PO/VAT/IBAN exact evidence, a near-VAT
 * corroborated by name, or a previously human-approved mapping can.
 */
import { normalizeVat, normalizeIban, normalizeSupplierName } from './normalize.js';
import { levenshtein, similarity } from './helpers.js';

export const MATCH_STATUS = {
  MATCHED: 'MATCHED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  NO_MATCH: 'NO_MATCH',
  CONFLICT: 'CONFLICT',
};

export const MATCH_METHOD = {
  PO_MAPPING: 'PO_MAPPING',
  VAT_EXACT: 'VAT_EXACT',
  VAT_MAPPING: 'VAT_MAPPING',
  IBAN_EXACT: 'IBAN_EXACT',
  VAT_NAME: 'VAT_NAME',
  NAME_MAPPING: 'NAME_MAPPING',
  NAME_COUNTRY: 'NAME_COUNTRY',
  FUZZY_NAME_SUGGESTION: 'FUZZY_NAME_SUGGESTION',
};

// Priority order — first match in this list wins when multiple clean signals exist.
const PRIORITY = [
  MATCH_METHOD.PO_MAPPING, MATCH_METHOD.VAT_EXACT, MATCH_METHOD.VAT_MAPPING,
  MATCH_METHOD.IBAN_EXACT, MATCH_METHOD.VAT_NAME, MATCH_METHOD.NAME_MAPPING,
  MATCH_METHOD.NAME_COUNTRY,
];

const CONFIDENCE_BY_METHOD = {
  [MATCH_METHOD.PO_MAPPING]: 98,
  [MATCH_METHOD.VAT_EXACT]: 99,
  [MATCH_METHOD.VAT_MAPPING]: 96,
  [MATCH_METHOD.IBAN_EXACT]: 95,
  [MATCH_METHOD.VAT_NAME]: 85,
  [MATCH_METHOD.NAME_MAPPING]: 82,
  [MATCH_METHOD.NAME_COUNTRY]: 75,
};

// Only disagreement AMONG these independent, high-certainty identifiers is a
// genuine CONFLICT (spec example: "VAT points to vendor A but PO points to
// vendor B"). A name-based signal disagreeing with a strong one is expected
// noise — the strong signal simply wins; it is not treated as unresolvable.
const STRONG_METHODS = new Set([
  MATCH_METHOD.PO_MAPPING, MATCH_METHOD.VAT_EXACT, MATCH_METHOD.VAT_MAPPING, MATCH_METHOD.IBAN_EXACT,
]);

function vatDigits(v) { return String(v || '').replace(/\D/g, ''); }

function activeVendors(suppliers) {
  return (suppliers || []).filter((s) => s.active !== false && s.status !== 'inactive');
}

function activeMappings(vendorMappings, keyType) {
  return (vendorMappings || []).filter((m) => m.active !== false && m.keyType === keyType);
}

/** Exact VAT identity — compares digit-only registration number so a
 *  country-prefixed input matches a bare-digit vendor-master record (or
 *  vice versa); that is a formatting difference, not a different vendor. */
function vatMatches(inputNormalized, supplier) {
  if (!inputNormalized) return false;
  const supplierVatFull = normalizeVat(supplier.vat_full).normalizedValue;
  const supplierAfm = normalizeVat(supplier.afm).normalizedValue;
  if (supplierVatFull && supplierVatFull === inputNormalized) return true;
  if (supplierAfm && supplierAfm === inputNormalized) return true;
  const inputDigits = vatDigits(inputNormalized);
  if (inputDigits.length >= 8) {
    if (vatDigits(supplierVatFull) === inputDigits) return true;
    if (vatDigits(supplierAfm) === inputDigits) return true;
  }
  return false;
}

/** One-digit-off VAT (typical OCR misread) — never a signal on its own,
 *  only usable when corroborated by a compatible supplier name. */
function isNearVat(inputNormalized, supplier) {
  const inputD = vatDigits(inputNormalized);
  const supplierD = vatDigits(supplier.vat_full) || vatDigits(supplier.afm);
  if (!inputD || !supplierD || inputD.length !== supplierD.length || inputD === supplierD) return false;
  return levenshtein(inputD, supplierD) === 1;
}

function ibanMatches(inputNormalized, supplier) {
  if (!inputNormalized || !supplier.iban) return false;
  return normalizeIban(supplier.iban).normalizedValue === inputNormalized;
}

function nameCompatible(inputName, supplierName) {
  const a = normalizeSupplierName(inputName).comparisonKey;
  const b = normalizeSupplierName(supplierName).comparisonKey;
  if (!a || !b) return false;
  return a === b || similarity(a, b) >= 80;
}

function nameCountryMatches(input, supplier) {
  if (!input.supplierName || !input.supplierCountry || !supplier.country) return false;
  const a = normalizeSupplierName(input.supplierName).comparisonKey;
  const b = normalizeSupplierName(supplier.name).comparisonKey;
  return !!a && a === b && supplier.country.toUpperCase() === input.supplierCountry.toUpperCase();
}

/** Suggestion-only name candidates (includes exact-name matches that have no
 *  VAT/country corroboration — spec: "only supplier name matches" → REVIEW,
 *  never MATCHED). Deliberately never promoted to a deterministic signal. */
function fuzzyNameCandidates(inputName, vendors) {
  const inputKey = normalizeSupplierName(inputName).comparisonKey;
  if (!inputKey) return [];
  const out = [];
  for (const v of vendors) {
    const key = normalizeSupplierName(v.name).comparisonKey;
    if (!key) continue;
    const score = similarity(inputKey, key);
    if (score >= 60) out.push({ vendor: v, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

function buildAlternatives(ambiguousSignals, fuzzy) {
  const seen = new Map();
  for (const sig of ambiguousSignals) {
    for (const v of sig.vendors) {
      if (!seen.has(v.sap_vendor_code)) {
        seen.set(v.sap_vendor_code, { sapVendorCode: v.sap_vendor_code, sapVendorName: v.name, matchMethod: sig.method });
      }
    }
  }
  for (const f of fuzzy) {
    if (!seen.has(f.vendor.sap_vendor_code)) {
      seen.set(f.vendor.sap_vendor_code, {
        sapVendorCode: f.vendor.sap_vendor_code, sapVendorName: f.vendor.name,
        matchMethod: MATCH_METHOD.FUZZY_NAME_SUGGESTION, confidence: f.score,
      });
    }
  }
  return [...seen.values()];
}

/**
 * @param {object} input - { vat, iban, poNumber, supplierName, supplierCountry }
 * @param {object} ctx - { suppliers: array, vendorMappings: array }
 * @returns {{ sapVendorCode, sapVendorName, matchMethod, confidence, matchEvidence,
 *             alternativeMatches, requiresReview, status, usedMappingId }}
 */
export function matchSapVendor(input, { suppliers = [], vendorMappings = [] } = {}) {
  const vendors = activeVendors(suppliers);
  const vatNorm = input.vat ? normalizeVat(input.vat).normalizedValue : null;
  const ibanNorm = input.iban ? normalizeIban(input.iban).normalizedValue : null;
  const poNorm = input.poNumber ? String(input.poNumber).trim().replace(/\s+/g, '') : null;
  const nameKey = input.supplierName ? normalizeSupplierName(input.supplierName).comparisonKey : null;

  const signals = []; // { method, vendors: [supplier...], note, mappingId? }

  if (poNorm) {
    const maps = activeMappings(vendorMappings, 'PO').filter((m) => m.normalizedKey === poNorm);
    if (maps.length) {
      const codes = [...new Set(maps.map((m) => m.sapVendorCode))];
      const found = codes.map((c) => vendors.find((v) => v.sap_vendor_code === c)).filter(Boolean);
      if (found.length) signals.push({ method: MATCH_METHOD.PO_MAPPING, vendors: found, note: `PO ${poNorm} → εγκεκριμένη αντιστοίχιση`, mappingId: maps[0].id });
    }
  }

  if (vatNorm) {
    const found = vendors.filter((v) => vatMatches(vatNorm, v));
    if (found.length) signals.push({ method: MATCH_METHOD.VAT_EXACT, vendors: found, note: `VAT ${vatNorm} — ακριβής αντιστοίχιση` });

    if (!found.length) {
      const maps = activeMappings(vendorMappings, 'VAT').filter((m) => m.normalizedKey === vatNorm || vatDigits(m.normalizedKey) === vatDigits(vatNorm));
      if (maps.length) {
        const codes = [...new Set(maps.map((m) => m.sapVendorCode))];
        const mapped = codes.map((c) => vendors.find((v) => v.sap_vendor_code === c)).filter(Boolean);
        if (mapped.length) signals.push({ method: MATCH_METHOD.VAT_MAPPING, vendors: mapped, note: `VAT ${vatNorm} → εγκεκριμένη αντιστοίχιση`, mappingId: maps[0].id });
      }
    }
  }

  if (ibanNorm) {
    const found = vendors.filter((v) => ibanMatches(ibanNorm, v));
    if (found.length) signals.push({ method: MATCH_METHOD.IBAN_EXACT, vendors: found, note: 'IBAN — ακριβής αντιστοίχιση' });
  }

  if (vatNorm && input.supplierName) {
    const found = vendors.filter((v) => isNearVat(vatNorm, v) && nameCompatible(input.supplierName, v.name));
    if (found.length) signals.push({ method: MATCH_METHOD.VAT_NAME, vendors: found, note: 'Σχεδόν-ταιριαστό VAT (1 ψηφίο) + συμβατή επωνυμία' });
  }

  if (nameKey) {
    const maps = activeMappings(vendorMappings, 'NAME').filter((m) => m.normalizedKey === nameKey);
    if (maps.length) {
      const codes = [...new Set(maps.map((m) => m.sapVendorCode))];
      const mapped = codes.map((c) => vendors.find((v) => v.sap_vendor_code === c)).filter(Boolean);
      if (mapped.length) signals.push({ method: MATCH_METHOD.NAME_MAPPING, vendors: mapped, note: 'Επωνυμία → εγκεκριμένη αντιστοίχιση (χειροκίνητα επιβεβαιωμένη)', mappingId: maps[0].id });
    }
  }

  if (input.supplierName && input.supplierCountry) {
    const found = vendors.filter((v) => nameCountryMatches(input, v));
    if (found.length) signals.push({ method: MATCH_METHOD.NAME_COUNTRY, vendors: found, note: 'Επωνυμία + χώρα — ακριβής αντιστοίχιση' });
  }

  const fuzzy = input.supplierName ? fuzzyNameCandidates(input.supplierName, vendors) : [];

  return resolveSignals(signals, fuzzy);
}

function resolveSignals(signals, fuzzy) {
  const evidence = [];
  const clean = [];
  const ambiguous = [];

  for (const sig of signals) {
    const distinctCodes = [...new Set(sig.vendors.map((v) => v.sap_vendor_code))];
    if (distinctCodes.length === 1) clean.push({ ...sig, vendor: sig.vendors[0] });
    else if (distinctCodes.length > 1) ambiguous.push(sig);
  }

  const strongClean = clean.filter((c) => STRONG_METHODS.has(c.method));
  const weakClean = clean.filter((c) => !STRONG_METHODS.has(c.method));
  const distinctStrongCodes = [...new Set(strongClean.map((c) => c.vendor.sap_vendor_code))];

  // Genuine conflict: two independent strong identifiers (e.g. VAT vs PO) disagree.
  if (distinctStrongCodes.length > 1) {
    for (const c of clean) evidence.push(`${c.method}: ${c.note} → ${c.vendor.sap_vendor_code}`);
    return {
      sapVendorCode: null, sapVendorName: null, matchMethod: null, confidence: 0,
      matchEvidence: evidence,
      alternativeMatches: clean.map((c) => ({ sapVendorCode: c.vendor.sap_vendor_code, sapVendorName: c.vendor.name, matchMethod: c.method })),
      requiresReview: true, status: MATCH_STATUS.CONFLICT, usedMappingId: null,
    };
  }

  for (const a of ambiguous) evidence.push(`${a.method}: ${a.note} — ασαφές (${a.vendors.map((v) => v.sap_vendor_code).join(', ')})`);

  // A strong signal (if present) always wins over disagreeing weak (name-based)
  // signals — those are noted for transparency but never escalate to CONFLICT.
  let winnerPool = null;
  if (distinctStrongCodes.length === 1) {
    winnerPool = strongClean;
    for (const c of weakClean) {
      if (c.vendor.sap_vendor_code !== strongClean[0].vendor.sap_vendor_code) {
        evidence.push(`${c.method}: ${c.note} → ${c.vendor.sap_vendor_code} (αγνοήθηκε — υπερισχύει ισχυρότερο στοιχείο)`);
      }
    }
  } else {
    const distinctWeakCodes = [...new Set(weakClean.map((c) => c.vendor.sap_vendor_code))];
    if (distinctWeakCodes.length > 1) {
      // Only weak (name-based) evidence, and it disagrees with itself — ambiguous, not a hard conflict.
      for (const c of weakClean) evidence.push(`${c.method}: ${c.note} → ${c.vendor.sap_vendor_code}`);
      return {
        sapVendorCode: null, sapVendorName: null, matchMethod: null, confidence: 0,
        matchEvidence: evidence,
        alternativeMatches: buildAlternatives([...ambiguous, ...weakClean.map((c) => ({ method: c.method, vendors: [c.vendor] }))], fuzzy),
        requiresReview: true, status: MATCH_STATUS.REVIEW_REQUIRED, usedMappingId: null,
      };
    }
    winnerPool = weakClean;
  }

  if (winnerPool.length) {
    winnerPool.sort((a, b) => PRIORITY.indexOf(a.method) - PRIORITY.indexOf(b.method));
    const winner = winnerPool[0];
    for (const c of winnerPool) evidence.push(`${c.method}: ${c.note}`);
    const hasHigherAmbiguous = ambiguous.some((a) => PRIORITY.indexOf(a.method) < PRIORITY.indexOf(winner.method));
    const status = hasHigherAmbiguous ? MATCH_STATUS.REVIEW_REQUIRED : MATCH_STATUS.MATCHED;
    return {
      sapVendorCode: winner.vendor.sap_vendor_code,
      sapVendorName: winner.vendor.name,
      matchMethod: winner.method,
      confidence: CONFIDENCE_BY_METHOD[winner.method],
      matchEvidence: evidence,
      alternativeMatches: buildAlternatives(ambiguous, fuzzy),
      requiresReview: status !== MATCH_STATUS.MATCHED,
      status,
      usedMappingId: winner.mappingId || null,
    };
  }

  if (ambiguous.length) {
    return {
      sapVendorCode: null, sapVendorName: null, matchMethod: null, confidence: 0,
      matchEvidence: evidence, alternativeMatches: buildAlternatives(ambiguous, fuzzy),
      requiresReview: true, status: MATCH_STATUS.REVIEW_REQUIRED, usedMappingId: null,
    };
  }

  if (fuzzy.length) {
    return {
      sapVendorCode: null, sapVendorName: null, matchMethod: MATCH_METHOD.FUZZY_NAME_SUGGESTION, confidence: 0,
      matchEvidence: [`Ασαφής αντιστοίχιση επωνυμίας — ${fuzzy.length} υποψήφιος/οι, απαιτεί χειροκίνητη επιβεβαίωση`],
      alternativeMatches: fuzzy.map((f) => ({
        sapVendorCode: f.vendor.sap_vendor_code, sapVendorName: f.vendor.name,
        matchMethod: MATCH_METHOD.FUZZY_NAME_SUGGESTION, confidence: f.score,
      })),
      requiresReview: true, status: MATCH_STATUS.REVIEW_REQUIRED, usedMappingId: null,
    };
  }

  return {
    sapVendorCode: null, sapVendorName: null, matchMethod: null, confidence: 0,
    matchEvidence: ['Δεν βρέθηκαν στοιχεία αντιστοίχισης (VAT/IBAN/PO/επωνυμία)'],
    alternativeMatches: [], requiresReview: true, status: MATCH_STATUS.NO_MATCH, usedMappingId: null,
  };
}

/** Adapter — maps this app's extraction field names onto the engine's input shape. */
export function buildMatchInputFromExtraction(extracted) {
  return {
    vat: extracted?.afm ?? null,
    iban: extracted?.iban ?? null,
    poNumber: extracted?.purchase_order ?? null,
    supplierName: extracted?.supplier_name_hint ?? null,
    supplierCountry: extracted?.supplier_country ?? null,
  };
}
