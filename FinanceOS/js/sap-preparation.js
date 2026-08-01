/**
 * SAP preparation model (Phase 10) — orchestrates the SAP Vendor Matching
 * Engine (M4), duplicate protection (M6), accounting validation, and
 * workflow classification into one SAPReadyInvoice-shaped record, kept
 * separate from the raw invoice. Fields FinanceOS cannot determine
 * (companyCode, taxCode, glAccount, costCenter, postingDate) are always
 * MISSING rather than guessed — this module never invents them.
 */
import { matchSapVendor, buildMatchInputFromExtraction, MATCH_STATUS } from './sap-vendor-matching.js';
import { checkDuplicate, DUPLICATE_STATUS } from './duplicate-detection.js';
import { validateAccounting, ACCOUNTING_VALIDATION_STATUS } from './accounting-validation.js';
import { classifyWorkflow, DOCUMENT_WORKFLOW } from './workflow-classification.js';

export const SAP_PREP_STATUS = {
  SAP_READY: 'SAP_READY',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  BLOCKED_DUPLICATE: 'BLOCKED_DUPLICATE',
};

/** Sentinel for "FinanceOS genuinely does not know this" — never a guess. */
export const MISSING = 'MISSING';

function evaluateExtractionStatus(invoice) {
  const required = ['invoice_number', 'invoice_date', 'total_amount', 'currency'];
  const missingFields = required.filter((f) => invoice[f] == null || invoice[f] === '');
  return { status: missingFields.length ? 'INCOMPLETE' : 'COMPLETE', missingFields };
}

function buildHeaderText(invoice, vendorMatch) {
  const parts = [];
  if (vendorMatch.sapVendorName) parts.push(vendorMatch.sapVendorName);
  if (invoice.invoice_number) parts.push(invoice.invoice_number);
  return parts.length ? parts.join(' — ') : null;
}

/**
 * @param {object} invoice - the invoice record (flat extraction fields).
 * @param {object} ctx - { suppliers, vendorMappings, allInvoices, toleranceCents }
 */
export function buildSapReadyRecord(invoice, { suppliers = [], vendorMappings = [], allInvoices = [], toleranceCents = 1 } = {}) {
  const extractionStatus = evaluateExtractionStatus(invoice);

  const matchInput = buildMatchInputFromExtraction(invoice);
  const vendorMatch = matchSapVendor(matchInput, { suppliers, vendorMappings });

  const duplicateStatus = checkDuplicate(
    { ...invoice, sap_vendor_code: vendorMatch.sapVendorCode },
    allInvoices,
    { toleranceCents }
  );

  const accountingValidationStatus = validateAccounting(invoice, { toleranceCents });

  const workflowClassification = classifyWorkflow({ ...invoice, sap_vendor_code: vendorMatch.sapVendorCode });

  const matchedSupplier = suppliers.find((s) => s.sap_vendor_code === vendorMatch.sapVendorCode) || null;
  const companyCode = matchedSupplier?.company_code || null;

  // Only sapVendorCode gates SAP_READY when missing — it's the one thing
  // this pipeline's own matching engine is responsible for resolving.
  // companyCode/taxCode/glAccount/costCenter have no master-data source of
  // their own anywhere in this phase (company code lives on the SAP Vendor
  // Master import, but real installs won't have backfilled it on day one)
  // — spec groups them together as "never guess, mark MISSING", so all four
  // are recorded on the record for visibility but never block SAP_READY:
  // gating on any of them would make SAP_READY permanently unreachable
  // until vendor data is fully enriched. Posting-level SAP coding is
  // explicitly deferred to a later, real-SAP-connected phase.
  const missingRequiredFields = [];
  if (!vendorMatch.sapVendorCode) missingRequiredFields.push('sapVendorCode');

  const unresolvedSapCodingFields = ['taxCode'];
  if (!companyCode) unresolvedSapCodingFields.push('companyCode');
  if (workflowClassification.workflow === DOCUMENT_WORKFLOW.NON_PO_INVOICE) {
    // FB60 postings need a GL account and cost center; PO invoices (MIRO)
    // typically derive these from the PO itself, so they are not required here.
    unresolvedSapCodingFields.push('glAccount', 'costCenter');
  }

  const sapPrep = {
    sourceInvoiceId: invoice.id,
    sapVendorCode: vendorMatch.sapVendorCode,
    companyCode: companyCode || MISSING,
    invoiceNumber: invoice.invoice_number || null,
    invoiceDate: invoice.invoice_date || null,
    postingDate: MISSING,
    currency: invoice.currency || null,
    netAmount: invoice.net_amount ?? null,
    vatAmount: invoice.vat_amount ?? null,
    grossAmount: invoice.total_amount ?? null,
    taxCode: MISSING,
    poNumber: invoice.purchase_order || null,
    glAccount: workflowClassification.workflow === DOCUMENT_WORKFLOW.NON_PO_INVOICE ? MISSING : null,
    costCenter: workflowClassification.workflow === DOCUMENT_WORKFLOW.NON_PO_INVOICE ? MISSING : null,
    paymentTerms: matchedSupplier?.payment_terms || invoice.payment_terms || null,
    headerText: buildHeaderText(invoice, vendorMatch),
    itemText: invoice.reference || invoice.payment_reference || null,
    workflow: workflowClassification.workflow,
    validationStatus: null,
  };

  let sapPreparationStatus;
  if (duplicateStatus.status === DUPLICATE_STATUS.CONFIRMED) {
    sapPreparationStatus = SAP_PREP_STATUS.BLOCKED_DUPLICATE;
  } else if (
    extractionStatus.status === 'INCOMPLETE'
    || vendorMatch.status !== MATCH_STATUS.MATCHED
    || accountingValidationStatus.status !== ACCOUNTING_VALIDATION_STATUS.VALID
    || duplicateStatus.status === DUPLICATE_STATUS.POSSIBLE
    || workflowClassification.requiresReview
    || missingRequiredFields.length
  ) {
    sapPreparationStatus = SAP_PREP_STATUS.REVIEW_REQUIRED;
  } else {
    sapPreparationStatus = SAP_PREP_STATUS.SAP_READY;
  }

  sapPrep.validationStatus = sapPreparationStatus;

  return {
    sapPrep,
    extractionStatus,
    supplierMatchStatus: vendorMatch,
    accountingValidationStatus,
    duplicateStatus,
    workflowClassification,
    sapPreparationStatus,
    missingRequiredFields,
    unresolvedSapCodingFields,
  };
}
