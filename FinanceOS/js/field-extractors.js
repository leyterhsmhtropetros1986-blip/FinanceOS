/** Extended field extraction & multi-source merge */
import { stripAccents } from './helpers.js';

const AMOUNT_KEYWORDS = {
  total: ['ΣΥΝΟΛΟ', 'TOTAL', 'GROSS', 'ΠΛΗΡΩΤΕΟ', 'AMOUNT DUE', 'ΤΕΛΙΚΗ ΑΞΙΑ'],
  net: ['ΚΑΘΑΡΗ', 'NET', 'ΥΠΟΚΑΤΑΣΤΑΤΟ', 'SUBTOTAL', 'ΑΞΙΑ'],
  vat: ['ΦΠΑ', 'VAT', 'Φ.Π.Α', 'TAX'],
};
const CURRENCY_RE = /\b(EUR|USD|GBP|CHF|€|\$|£)\b/i;
const PO_KEYWORDS = ['PO', 'P.O.', 'PURCHASE ORDER', 'ΕΝΤΟΛΗ ΑΓΟΡΑΣ', 'ΠΑΡΑΓΓΕΛΙΑ'];
const REF_KEYWORDS = ['REFERENCE', 'REF', 'ΑΝΑΦΟΡΑ', 'YOUR REF'];
const CONTAINER_KEYWORDS = ['CONTAINER', 'CNTR', 'ΕΜΚ'];
const BL_KEYWORDS = ['B/L', 'BILL OF LADING', 'BL NO', 'ΦΟΡΤΩΤΙΚΗ', 'BOL'];
const BOOKING_KEYWORDS = ['BOOKING', 'BOOKING NO', 'BOOKING NUMBER', 'ΚΡΑΤΗΣΗ'];
const SHIPMENT_KEYWORDS = ['SHIPMENT', 'SHIPMENT NO', 'SHPMT', 'ΑΠΟΣΤΟΛΗ'];

function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function findNearKeyword(text, keywords, valueRe, windowSize = 50) {
  const upper = stripAccents(text.toUpperCase());
  let best = null;
  let bestConf = 0;
  for (const kw of keywords) {
    let idx = 0;
    while ((idx = upper.indexOf(kw, idx)) !== -1) {
      const win = text.slice(idx, idx + kw.length + windowSize);
      const m = win.match(valueRe);
      if (m) {
        const val = parseAmount(m[1] || m[0]);
        if (val != null && val > 0) {
          const conf = 88;
          if (conf > bestConf) { best = val; bestConf = conf; }
        }
      }
      idx += kw.length;
    }
  }
  return { value: best, confidence: bestConf };
}

function findLabeledValue(text, keywords, pattern) {
  const upper = stripAccents(text.toUpperCase());
  for (const kw of keywords) {
    let idx = 0;
    while ((idx = upper.indexOf(kw, idx)) !== -1) {
      const win = text.slice(idx + kw.length, idx + kw.length + 80).replace(/^[\s:.\-#]+/, '');
      const m = win.match(pattern);
      if (m) return { value: m[1].trim(), confidence: 85 };
      idx += kw.length;
    }
  }
  return { value: null, confidence: 0 };
}

export function extractAmounts(fullText) {
  const amountRe = /([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{2})|[0-9]+[.,][0-9]{2})/;
  const total = findNearKeyword(fullText, AMOUNT_KEYWORDS.total, amountRe);
  const net = findNearKeyword(fullText, AMOUNT_KEYWORDS.net, amountRe);
  const vat = findNearKeyword(fullText, AMOUNT_KEYWORDS.vat, amountRe);
  let vatRate = null;
  const rateM = stripAccents(fullText.toUpperCase()).match(/(?:ΦΠΑ|VAT)\s*[:\s]*(\d{1,2})\s*%/);
  if (rateM) vatRate = parseInt(rateM[1], 10);
  return {
    total_amount: total.value,
    net_amount: net.value,
    vat_amount: vat.value,
    vat_rate: vatRate,
    confidence_total: total.confidence,
    confidence_net: net.confidence,
    confidence_vat: vat.confidence,
  };
}

export function extractCurrency(fullText) {
  const m = fullText.match(CURRENCY_RE);
  if (!m) return { value: 'EUR', confidence: 40 };
  const sym = m[1].toUpperCase();
  const map = { '€': 'EUR', '$': 'USD', '£': 'GBP' };
  return { value: map[sym] || sym, confidence: 90 };
}

export function extractPurchaseOrder(fullText) {
  return findLabeledValue(fullText, PO_KEYWORDS, /([A-Z0-9][A-Z0-9\-/]{3,20})/i);
}

export function extractReference(fullText) {
  return findLabeledValue(fullText, REF_KEYWORDS, /([A-Z0-9][A-Z0-9\-/]{3,24})/i);
}

export function extractContainer(fullText) {
  const m = fullText.match(/\b([A-Z]{4}\d{7})\b/);
  if (m) return { value: m[1], confidence: 92 };
  return findLabeledValue(fullText, CONTAINER_KEYWORDS, /([A-Z0-9]{4,12})/i);
}

export function extractBillOfLading(fullText) {
  const iso = fullText.match(/\b([A-Z]{4}\d{7,12})\b/);
  if (iso) return { value: iso[1], confidence: 88 };
  return findLabeledValue(fullText, BL_KEYWORDS, /([A-Z0-9][A-Z0-9\-/]{5,24})/i);
}

export function extractBookingNumber(fullText) {
  return findLabeledValue(fullText, BOOKING_KEYWORDS, /([A-Z0-9][A-Z0-9\-/]{5,20})/i);
}

export function extractShipmentNumber(fullText) {
  return findLabeledValue(fullText, SHIPMENT_KEYWORDS, /([A-Z0-9][A-Z0-9\-/]{5,20})/i);
}

export function extractExtendedFields(pages, fullText) {
  const amounts = extractAmounts(fullText);
  const currency = extractCurrency(fullText);
  const po = extractPurchaseOrder(fullText);
  const ref = extractReference(fullText);
  const container = extractContainer(fullText);
  const bl = extractBillOfLading(fullText);
  const booking = extractBookingNumber(fullText);
  const shipment = extractShipmentNumber(fullText);
  return {
    ...amounts,
    currency: currency.value,
    confidence_currency: currency.confidence,
    purchase_order: po.value,
    confidence_po: po.confidence,
    reference: ref.value,
    confidence_reference: ref.confidence,
    container: container.value,
    confidence_container: container.confidence,
    bill_of_lading: bl.value,
    confidence_bl: bl.confidence,
    booking_number: booking.value,
    confidence_booking: booking.confidence,
    shipment_number: shipment.value,
    confidence_shipment: shipment.confidence,
  };
}

/** Merge two field results — keep highest-confidence non-empty value per field */
export function mergeFieldResults(primary, secondary, fieldMap) {
  const out = { ...primary };
  for (const [field, confField] of fieldMap) {
    const a = primary[field];
    const b = secondary?.[field];
    const ca = primary[confField] || 0;
    const cb = secondary?.[confField] || 0;
    if (b != null && b !== '' && (a == null || a === '' || cb > ca)) {
      out[field] = b;
      out[confField] = cb;
    } else if (a != null && a !== '') {
      out[field] = a;
      out[confField] = ca;
    }
  }
  return out;
}

export function mergeExtractionResults(ocrResult, pdfResult) {
  if (!pdfResult) return ocrResult;
  if (!ocrResult) return pdfResult;
  const scalarFields = [
    ['afm', 'confidence_afm'],
    ['invoice_number', 'confidence_invoice_no'],
    ['invoice_date', 'confidence_date'],
    ['sap_doc_number', 'confidence_sap_doc'],
    ['supplier_name_hint', 'confidence_supplier'],
    ['total_amount', 'confidence_total'],
    ['net_amount', 'confidence_net'],
    ['vat_amount', 'confidence_vat'],
    ['currency', 'confidence_currency'],
    ['purchase_order', 'confidence_po'],
    ['reference', 'confidence_reference'],
    ['container', 'confidence_container'],
    ['bill_of_lading', 'confidence_bl'],
  ];
  const merged = mergeFieldResults(ocrResult, pdfResult, scalarFields);
  if (pdfResult.vat_rate != null && ocrResult.vat_rate == null) merged.vat_rate = pdfResult.vat_rate;

  const candMap = new Map();
  for (const c of [...(ocrResult.sap_doc_candidates || []), ...(pdfResult.sap_doc_candidates || [])]) {
    const prev = candMap.get(c.value);
    if (!prev || c.confidence > prev.confidence) candMap.set(c.value, c);
  }
  merged.sap_doc_candidates = [...candMap.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 15);
  if (merged.sap_doc_candidates[0]) {
    merged.sap_doc_number = merged.sap_doc_candidates[0].value;
    merged.confidence_sap_doc = merged.sap_doc_candidates[0].confidence;
  }
  merged._sources = {
    ocr: ocrResult._meanOcrConfidence || 0,
    pdf: pdfResult._meanOcrConfidence || 95,
  };
  return merged;
}

export function mergeOcrPages(pageSets) {
  const byPage = new Map();
  for (const pages of pageSets) {
    for (const p of pages) {
      const key = p.page_number;
      const existing = byPage.get(key);
      if (!existing || (p.mean_confidence || 0) > (existing.mean_confidence || 0)) {
        byPage.set(key, p);
      } else if (existing && p.text.length > existing.text.length) {
        byPage.set(key, { ...existing, text: p.text, words: p.words.length > existing.words.length ? p.words : existing.words });
      }
    }
  }
  return [...byPage.values()].sort((a, b) => a.page_number - b.page_number);
}
