/** Safe extraction defaults — never undefined in UI */

export function blankExtraction() {
  return {
    afm: null,
    invoice_number: null,
    invoice_date: null,
    sap_doc_number: null,
    supplier_name_hint: null,
    confidence_afm: null,
    confidence_invoice_no: null,
    confidence_date: null,
    confidence_sap_doc: null,
    confidence_supplier: null,
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
    confidence_afm: safeConfidence(raw.confidence_afm),
    confidence_invoice_no: safeConfidence(raw.confidence_invoice_no),
    confidence_date: safeConfidence(raw.confidence_date),
    confidence_sap_doc: safeConfidence(raw.confidence_sap_doc),
    confidence_supplier: safeConfidence(raw.confidence_supplier),
    sap_doc_candidates: Array.isArray(raw.sap_doc_candidates) ? raw.sap_doc_candidates : [],
    currency: raw.currency || 'EUR',
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
