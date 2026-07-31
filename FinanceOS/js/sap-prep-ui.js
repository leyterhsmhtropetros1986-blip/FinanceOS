/**
 * Renders the SAP Vendor Matching + SAP Preparation blocks in the invoice
 * review panel (Phase 11). Pure view over buildSapReadyRecord() — no
 * business logic lives here, and it never mutates the invoice.
 */
import { $, escapeHtml } from './utils.js';
import { state } from './state.js';
import { buildSapReadyRecord, SAP_PREP_STATUS } from './sap-preparation.js';
import { MATCH_STATUS } from './sap-vendor-matching.js';
import { DUPLICATE_STATUS } from './duplicate-detection.js';
import { ACCOUNTING_VALIDATION_STATUS } from './accounting-validation.js';
import { DOCUMENT_WORKFLOW } from './workflow-classification.js';

const WORKFLOW_LABEL = {
  [DOCUMENT_WORKFLOW.PO_INVOICE]: 'MIRO (PO)',
  [DOCUMENT_WORKFLOW.NON_PO_INVOICE]: 'FB60 (Non-PO)',
  [DOCUMENT_WORKFLOW.FI_JOURNAL]: 'FB01 (FI Journal)',
  [DOCUMENT_WORKFLOW.UNKNOWN]: 'REVIEW',
};

const MATCH_STATUS_LABEL = {
  [MATCH_STATUS.MATCHED]: '✓ MATCHED',
  [MATCH_STATUS.REVIEW_REQUIRED]: '⚠ REVIEW REQUIRED',
  [MATCH_STATUS.NO_MATCH]: '✕ NO MATCH',
  [MATCH_STATUS.CONFLICT]: '✕ CONFLICT',
};

function fmtMoney(v) {
  return v == null ? '—' : Number(v).toFixed(2);
}

function matchStatusClass(status) {
  if (status === MATCH_STATUS.MATCHED) return 'status-active';
  if (status === MATCH_STATUS.CONFLICT || status === MATCH_STATUS.NO_MATCH) return 'status-error';
  return 'status-needs_review';
}

function sapPrepStatusClass(status) {
  if (status === SAP_PREP_STATUS.SAP_READY) return 'status-active';
  if (status === SAP_PREP_STATUS.BLOCKED_DUPLICATE) return 'status-error';
  return 'status-needs_review';
}

function checklistLine(ok, okText, failText, hard) {
  return { icon: ok ? '✓' : hard ? '✕' : '⚠', text: ok ? okText : failText };
}

/** Safe, read-only render — never throws into the review UI. */
export function renderSapPrepPanel(invoice) {
  const panel = $('#sap-prep-panel');
  if (!panel || !invoice) return;
  try {
    const result = buildSapReadyRecord(invoice, {
      suppliers: state.suppliers,
      vendorMappings: state.vendorMappings,
      allInvoices: state.invoices,
    });
    paint(invoice, result);
  } catch (e) {
    console.warn('SAP prep panel render failed (non-fatal):', e);
  }
}

function paint(invoice, result) {
  const { supplierMatchStatus: m, sapPrep, accountingValidationStatus: acc, duplicateStatus: dup, workflowClassification: wf, sapPreparationStatus, missingRequiredFields } = result;

  $('#sap-detected-supplier').textContent = invoice.supplier_name_hint || '—';
  $('#sap-detected-vat').textContent = invoice.afm || '—';
  $('#sap-vendor-code').textContent = m.sapVendorCode || '—';
  $('#sap-vendor-name').textContent = m.sapVendorName || '—';
  $('#sap-match-method').textContent = m.matchMethod || '—';
  $('#sap-match-confidence').textContent = m.confidence != null ? `${m.confidence}%` : '—';
  $('#sap-match-evidence').innerHTML = (m.matchEvidence || []).map((e) => `<div>• ${escapeHtml(e)}</div>`).join('')
    || '<div style="color:var(--text-muted)">—</div>';

  const statusBadge = $('#sap-match-status-badge');
  statusBadge.textContent = MATCH_STATUS_LABEL[m.status] || m.status;
  statusBadge.className = 'status-pill ' + matchStatusClass(m.status);

  $('#sap-po').textContent = sapPrep.poNumber || '—';
  $('#sap-net').textContent = fmtMoney(sapPrep.netAmount);
  $('#sap-vat').textContent = fmtMoney(sapPrep.vatAmount);
  $('#sap-gross').textContent = fmtMoney(sapPrep.grossAmount);
  $('#sap-currency').textContent = sapPrep.currency || '—';

  const wfBadge = $('#sap-workflow-badge');
  wfBadge.textContent = WORKFLOW_LABEL[wf.workflow] || wf.workflow;
  wfBadge.className = 'status-pill ' + (wf.requiresReview ? 'status-needs_review' : 'status-active');

  const checks = [
    checklistLine(m.status === MATCH_STATUS.MATCHED, 'Προμηθευτής/SAP Vendor αντιστοιχίστηκε',
      `SAP Vendor απαιτεί έλεγχο (${MATCH_STATUS_LABEL[m.status] || m.status})`),
    checklistLine(acc.status === ACCOUNTING_VALIDATION_STATUS.VALID, 'Ποσά έγκυρα (Καθαρή + ΦΠΑ = Σύνολο)',
      acc.reasons[0] || 'Λογιστικό σφάλμα'),
    checklistLine(dup.status === DUPLICATE_STATUS.NONE, 'Χωρίς διπλότυπο',
      dup.status === DUPLICATE_STATUS.CONFIRMED ? '✕ Επιβεβαιωμένο διπλότυπο τιμολόγιο' : '⚠ Πιθανό διπλότυπο — έλεγχος',
      dup.status === DUPLICATE_STATUS.CONFIRMED),
    checklistLine(!wf.requiresReview, `Ροή εργασίας: ${WORKFLOW_LABEL[wf.workflow]}`,
      'Δεν προσδιορίστηκε ροή εργασίας (PO / Non-PO)'),
  ];
  if (missingRequiredFields.length) {
    checks.push({ icon: '⚠', text: `Λείπουν πεδία: ${missingRequiredFields.join(', ')}` });
  }
  $('#sap-readiness-checklist').innerHTML = checks.map((c) => `<li>${c.icon} ${escapeHtml(c.text)}</li>`).join('');

  const overall = $('#sap-prep-overall-status');
  if (overall) {
    overall.textContent = sapPreparationStatus;
    overall.className = 'status-pill ' + sapPrepStatusClass(sapPreparationStatus);
  }
}
