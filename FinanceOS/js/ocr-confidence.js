/** Confidence engine — retry low-confidence fields on full OCR text */
import { stripAccents, validateAfmChecksum, similarity, normalizeForMatch } from './helpers.js';

const CONF_RETRY = 70;

export function valueInText(value, fullText) {
  if (value == null || value === '') return false;
  const v = String(value).trim();
  const compact = fullText.replace(/\s+/g, '');
  if (compact.includes(v.replace(/\s+/g, ''))) return true;
  const digits = v.replace(/\D/g, '');
  if (digits.length >= 4 && fullText.replace(/\D/g, '').includes(digits)) return true;
  return fullText.toUpperCase().includes(v.toUpperCase());
}

/** Re-scan full text when field confidence is low */
export function refineExtraction(extracted, fullText, pages, extractors) {
  const out = { ...extracted };
  const text = fullText || '';

  if ((out.confidence_afm || 0) < CONF_RETRY || !out.afm) {
    const r = extractors.extractAfm(text);
    if (r.value && r.confidence >= (out.confidence_afm || 0)) {
      out.afm = r.value;
      out.confidence_afm = r.confidence;
    }
  }

  if ((out.confidence_invoice_no || 0) < CONF_RETRY || !out.invoice_number) {
    const r = extractors.extractInvoiceNumber(text);
    if (r.value && r.confidence >= (out.confidence_invoice_no || 0)) {
      out.invoice_number = r.value;
      out.confidence_invoice_no = r.confidence;
    }
  }

  if ((out.confidence_date || 0) < CONF_RETRY || !out.invoice_date) {
    const r = extractors.extractDate(text);
    if (r.value && r.confidence >= (out.confidence_date || 0)) {
      out.invoice_date = r.value;
      out.confidence_date = r.confidence;
    }
  }

  if ((out.confidence_sap_doc || 0) < CONF_RETRY || !out.sap_doc_number) {
    const cands = extractors.extractSapDocCandidates(pages, text);
    if (cands[0] && cands[0].confidence >= (out.confidence_sap_doc || 0)) {
      out.sap_doc_number = cands[0].value;
      out.confidence_sap_doc = cands[0].confidence;
      out.sap_doc_candidates = cands;
    }
  }

  if (!out.supplier_name_hint || (out.confidence_supplier || 0) < CONF_RETRY) {
    const r = extractors.extractSupplierNameHint(pages);
    if (r.value) {
      out.supplier_name_hint = r.value;
      out.confidence_supplier = Math.max(out.confidence_supplier || 0, r.confidence);
    }
  }

  return out;
}

/** Strip AI-hallucinated values not present in OCR text */
export function sanitizeAgainstOcrText(extracted, fullText) {
  if (!fullText) return extracted;
  const out = { ...extracted };
  const check = (field, confField) => {
    if (out[field] && !valueInText(out[field], fullText)) {
      console.warn(`Rejected ${field}="${out[field]}" — not found in OCR text`);
      out[field] = null;
      out[confField] = 0;
    }
  };
  check('afm', 'confidence_afm');
  check('invoice_number', 'confidence_invoice_no');
  check('sap_doc_number', 'confidence_sap_doc');
  if (out.afm && !validateAfmChecksum(String(out.afm).replace(/\D/g, '').slice(0, 9))) {
    if ((out.confidence_afm || 0) < 85) {
      out.afm = null;
      out.confidence_afm = 0;
    }
  }
  return out;
}

export function fuzzyFindSupplierInText(fullText, suppliers) {
  const upper = stripAccents(fullText.toUpperCase());
  let best = null;
  let bestScore = 0;
  for (const s of suppliers) {
    if (s.status !== 'active') continue;
    const tokens = normalizeForMatch(s.name).split(' ').filter((t) => t.length >= 4);
    if (!tokens.length) continue;
    const hits = tokens.filter((t) => upper.includes(t)).length;
    const score = Math.round((hits / tokens.length) * 100);
    if (score > bestScore && score >= 50) {
      bestScore = score;
      best = { supplier: s, score };
    }
    if (s.afm && upper.includes(s.afm)) {
      return { supplier: s, score: 99, method: 'afm_in_text' };
    }
    if (s.vat_full && upper.includes(s.vat_full.replace(/\s/g, ''))) {
      return { supplier: s, score: 98, method: 'vat_in_text' };
    }
  }
  if (best) return { supplier: best.supplier, score: best.score, method: 'fuzzy_name_in_text' };
  return null;
}
