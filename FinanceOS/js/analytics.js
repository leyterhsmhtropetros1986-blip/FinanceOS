/** Dashboard KPI calculations — από αποθηκευμένα δεδομένα παραστατικών */
import { state } from './state.js';
import { getLearningStats } from './ocr-learning.js';

export const NO_AMOUNT_LABEL = 'Δεν έχει εξαχθεί';

export const STATUS_LABELS = {
  archived: 'Αρχειοθετήθηκε',
  needs_review: 'Χρειάζεται έλεγχο',
  processing: 'Σε επεξεργασία',
  error: 'Σφάλμα OCR',
  duplicate: 'Αντίγραφο',
  pending: 'Εκκρεμεί',
};

/** Επιστρέφει συνολικό ποσό από αποθηκευμένα πεδία (όχι ephemeral state) */
export function getInvoiceTotal(inv) {
  if (!inv) return null;
  const total = Number(inv.total_amount);
  if (Number.isFinite(total) && total > 0) return total;
  const net = Number(inv.net_amount) || 0;
  const vat = Number(inv.vat_amount) || 0;
  if (net > 0 || vat > 0) return net + vat;
  return null;
}

export function getInvoiceVat(inv) {
  if (!inv) return null;
  const vat = Number(inv.vat_amount);
  return Number.isFinite(vat) && vat > 0 ? vat : null;
}

export function hasExtractedAmount(inv) {
  return getInvoiceTotal(inv) != null;
}

export function fmtEUR(v, { missing = false } = {}) {
  if (missing) return NO_AMOUNT_LABEL;
  if (v == null || !Number.isFinite(v)) return NO_AMOUNT_LABEL;
  return new Intl.NumberFormat('el-GR', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(v);
}

export function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v)}%`;
}

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || '—';
}

export function getArchivedForPeriod(periodDays) {
  const now = new Date();
  const cutoff = periodDays > 0 ? new Date(now.getTime() - periodDays * 86400000) : new Date(0);
  return state.invoices.filter(i =>
    i.status === 'archived' && i.archived_at && new Date(i.archived_at) >= cutoff
  );
}

/** Οικονομικά KPI μόνο από invoices με εξαγόμενα ποσά */
export function computeFinancialKpis(archived) {
  const withAmount = archived.filter(hasExtractedAmount);
  const totalValue = withAmount.reduce((sum, i) => sum + getInvoiceTotal(i), 0);
  const totalVat = withAmount.reduce((sum, i) => sum + (getInvoiceVat(i) || 0), 0);
  const avgValue = withAmount.length > 0 ? totalValue / withAmount.length : null;
  return {
    totalValue,
    totalVat,
    avgValue,
    withAmountCount: withAmount.length,
    missingAmountCount: archived.length - withAmount.length,
    hasAnyAmount: withAmount.length > 0,
  };
}

function parseOcrMsFromTimeline(invoice) {
  if (invoice.ocr_processing_ms > 0) return invoice.ocr_processing_ms;
  const ev = (invoice.timeline || []).find((e) => e.type === 'ocr');
  if (!ev?.detail) return null;
  const m = String(ev.detail).match(/(\d+)\s*ms/);
  return m ? parseInt(m[1], 10) : null;
}

function invoiceMeanConfidence(inv) {
  const vals = [
    inv.confidence_afm, inv.confidence_invoice_no, inv.confidence_date,
    inv.confidence_sap_doc, inv.confidence_supplier, inv.confidence_total,
  ].filter((v) => v != null && Number.isFinite(Number(v)));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + Number(b), 0) / vals.length;
}

/** Επιχειρησιακά KPI OCR / ποιότητας */
export function computeOperationalKpis(invoices) {
  const processed = invoices.filter((i) =>
    i.status !== 'pending' && (i.timeline?.some((e) => e.type === 'ocr') || i.ocr_processing_ms)
  );
  const ocrTimes = processed
    .map(parseOcrMsFromTimeline)
    .filter((ms) => ms != null && ms > 0);
  const avgOcrMs = ocrTimes.length
    ? ocrTimes.reduce((a, b) => a + b, 0) / ocrTimes.length
    : null;

  const ocrAttempts = invoices.filter((i) => (i.timeline || []).some((e) => e.type === 'ocr'));
  const ocrSuccess = ocrAttempts.filter((i) =>
    i.status === 'archived' || i.status === 'needs_review' || hasExtractedAmount(i)
  );
  const ocrSuccessRate = ocrAttempts.length
    ? (ocrSuccess.length / ocrAttempts.length) * 100
    : null;

  const confidences = invoices.map(invoiceMeanConfidence).filter((c) => c != null);
  const avgConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : null;

  const duplicates = invoices.filter((i) => i.status === 'duplicate').length;
  const autoSupplier = invoices.filter((i) =>
    i.supplier_id && (i.confidence_supplier ?? 0) >= 90
  ).length;
  const supplierCandidates = invoices.filter((i) => i.supplier_id).length;
  const autoSupplierRate = supplierCandidates > 0
    ? (autoSupplier / supplierCandidates) * 100
    : null;

  const learning = getLearningStats();

  return {
    avgOcrMs,
    ocrSuccessRate,
    avgConfidence,
    manualCorrections: learning.corrections,
    duplicates,
    autoSupplierRate,
    autoSupplierCount: autoSupplier,
  };
}
