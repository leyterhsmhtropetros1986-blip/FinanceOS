/** Safe extraction defaults — never undefined in UI */

export function blankExtraction() {
  return {
    afm: null,
    invoice_number: null,
    invoice_date: null,
    sap_doc_number: null,
    supplier_name_hint: null,
    supplier_country: null,
    supplier_address: null,
    iban: null,
    delivery_note: null,
    payment_terms: null,
    payment_reference: null,
    vat_breakdown: [],
    confidence_afm: null,
    confidence_invoice_no: null,
    confidence_date: null,
    confidence_sap_doc: null,
    confidence_supplier: null,
    confidence_country: null,
    confidence_address: null,
    confidence_iban: null,
    confidence_delivery_note: null,
    confidence_payment_terms: null,
    confidence_payment_reference: null,
    sap_doc_candidates: [],
    net_amount: null,
    vat_amount: null,
    total_amount: null,
    currency: 'EUR',
    vat_rate: null,
    purchase_order: null,
    reference: null,
    container: null,
    bill_of_lading: null,
  };
}

/** Coerce confidence to 0–100 or null (display as —) */
export function safeConfidence(value) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

/** Guarantee every field exists with safe defaults */
export function normalizeExtraction(raw) {
  const base = blankExtraction();
  if (!raw || typeof raw !== 'object') return { ...base };
  return {
    ...base,
    ...raw,
    afm: raw.afm ?? null,
    invoice_number: raw.invoice_number ?? null,
    invoice_date: raw.invoice_date ?? null,
    sap_doc_number: raw.sap_doc_number ?? null,
    supplier_name_hint: raw.supplier_name_hint ?? null,
    supplier_country: raw.supplier_country ?? null,
    supplier_address: raw.supplier_address ?? null,
    iban: raw.iban ?? null,
    delivery_note: raw.delivery_note ?? null,
    payment_terms: raw.payment_terms ?? null,
    payment_reference: raw.payment_reference ?? null,
    vat_breakdown: Array.isArray(raw.vat_breakdown) ? raw.vat_breakdown : [],
    confidence_afm: safeConfidence(raw.confidence_afm),
    confidence_invoice_no: safeConfidence(raw.confidence_invoice_no),
    confidence_date: safeConfidence(raw.confidence_date),
    confidence_sap_doc: safeConfidence(raw.confidence_sap_doc),
    confidence_supplier: safeConfidence(raw.confidence_supplier),
    confidence_country: safeConfidence(raw.confidence_country),
    confidence_address: safeConfidence(raw.confidence_address),
    confidence_iban: safeConfidence(raw.confidence_iban),
    confidence_delivery_note: safeConfidence(raw.confidence_delivery_note),
    confidence_payment_terms: safeConfidence(raw.confidence_payment_terms),
    confidence_payment_reference: safeConfidence(raw.confidence_payment_reference),
    sap_doc_candidates: Array.isArray(raw.sap_doc_candidates) ? raw.sap_doc_candidates : [],
    currency: raw.currency || 'EUR',
    _fieldSources: (raw._fieldSources && typeof raw._fieldSources === 'object') ? raw._fieldSources : {},
  };
}

export function normalizeOcrResult(result, file) {
  if (!result || typeof result !== 'object') {
    return {
      filename: file?.name || '',
      fileSize: file?.size || 0,
      pageCount: 0,
      processingMs: 0,
      engine: 'manual',
      fullText: '',
      extracted: blankExtraction(),
      extractedList: [blankExtraction()],
      canvases: [],
      errors: [],
      success: false,
      manualMode: true,
    };
  }
  const ext = normalizeExtraction(result.extracted);
  const list = (result.extractedList || [result.extracted])
    .filter(Boolean)
    .map(normalizeExtraction);
  return {
    ...result,
    extracted: ext,
    extractedList: list.length ? list : [ext],
    fullText: result.fullText || '',
    canvases: result.canvases || result.previewCanvases || [],
    errors: result.errors || [],
    success: result.success !== false,
  };
}

export function meanConfidence(ext) {
  const e = normalizeExtraction(ext);
  const vals = [
    e.confidence_afm, e.confidence_invoice_no, e.confidence_date,
    e.confidence_sap_doc, e.confidence_supplier,
  ].filter((v) => v != null);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// ═══════════════════════════════════════════════════════════
// PER-FIELD {value, confidence, source} MODEL (additive — flat keys above
// remain the source of truth for existing UI code; this is a read-only view)
// ═══════════════════════════════════════════════════════════

/** Canonical business field → [rawValueKey, rawConfidenceKey|null] */
const FIELD_KEY_MAP = {
  invoiceNumber: ['invoice_number', 'confidence_invoice_no'],
  invoiceDate: ['invoice_date', 'confidence_date'],
  currency: ['currency', 'confidence_currency'],
  sapDocNumber: ['sap_doc_number', 'confidence_sap_doc'],
  supplierVat: ['afm', 'confidence_afm'],
  supplierName: ['supplier_name_hint', 'confidence_supplier'],
  supplierCountry: ['supplier_country', 'confidence_country'],
  supplierAddress: ['supplier_address', 'confidence_address'],
  iban: ['iban', 'confidence_iban'],
  poNumber: ['purchase_order', 'confidence_po'],
  deliveryNote: ['delivery_note', 'confidence_delivery_note'],
  netAmount: ['net_amount', 'confidence_net'],
  vatAmount: ['vat_amount', 'confidence_vat'],
  vatRate: ['vat_rate', null],
  grossAmount: ['total_amount', 'confidence_total'],
  paymentTerms: ['payment_terms', 'confidence_payment_terms'],
  paymentReference: ['payment_reference', 'confidence_payment_reference'],
};

/** Known provenance from the document-level `engine` string produced by the
 *  OCR pipeline (ocr-pipeline.js / ai.js). This is the real granularity the
 *  pipeline tracks today — it is not upgraded to per-field OCR-vs-PDF-text
 *  precision here because that data does not exist upstream (see plan notes). */
export function deriveSourceFromEngine(engine) {
  const e = String(engine || '').toLowerCase();
  if (!e) return 'unknown';
  if (e.includes('claude') || e.includes('ai')) return 'claude_vision';
  if (e.includes('pdf text') && !e.includes('ocr')) return 'pdf_text';
  if (e.includes('ocr') || e.includes('tesseract')) return 'ocr_tesseract';
  if (e === 'manual') return 'manual';
  return 'unknown';
}

/**
 * Build the spec-shaped { value, confidence, source } wrapper per field.
 * Never invents a source: falls back through (1) a genuinely-known per-field
 * override recorded in extraction._fieldSources (set when AI enrichment
 * overwrites a field, or when an OCR/PDF-text merge picks a winner side),
 * (2) the SAP-doc-candidate's own recorded source for sapDocNumber,
 * (3) the document-level engine, (4) 'unknown'.
 */
export function buildFieldModel(extraction, { engine } = {}) {
  const e = normalizeExtraction(extraction);
  const docSource = deriveSourceFromEngine(engine ?? e.engine);
  const fields = {};
  for (const [canonicalName, [valueKey, confKey]] of Object.entries(FIELD_KEY_MAP)) {
    const value = e[valueKey] ?? null;
    const confidence = confKey ? (e[confKey] ?? null) : null;
    let source = e._fieldSources?.[valueKey] || docSource;
    if (canonicalName === 'sapDocNumber' && e.sap_doc_candidates?.[0]?.source) {
      source = e.sap_doc_candidates[0].source;
    }
    fields[canonicalName] = { value, confidence, source };
  }
  if (Array.isArray(e.vat_breakdown) && e.vat_breakdown.length) {
    fields.vatBreakdown = {
      value: e.vat_breakdown,
      confidence: Math.round(e.vat_breakdown.reduce((a, b) => a + (b.confidence || 0), 0) / e.vat_breakdown.length) || null,
      source: docSource,
    };
  } else {
    fields.vatBreakdown = { value: [], confidence: null, source: docSource };
  }
  return fields;
}
