#!/usr/bin/env node
/** SAP preparation model + workflow classification tests (Phases 9-10) */
import { buildSapReadyRecord, SAP_PREP_STATUS, MISSING } from '../FinanceOS/js/sap-preparation.js';
import { classifyWorkflow, DOCUMENT_WORKFLOW } from '../FinanceOS/js/workflow-classification.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

const suppliers = [
  { id: 1, afm: '094450902', vat_full: 'EL094450902', sap_vendor_code: '100245', name: 'ABC S.A.', country: 'GR', company_code: '1000', payment_terms: 'NT30', active: true, status: 'active' },
];

const wellFormedInvoice = {
  id: 1, invoice_number: 'INV-1001', invoice_date: '2026-06-01',
  net_amount: 77.42, vat_amount: 18.58, total_amount: 96.00, currency: 'EUR', vat_rate: 24,
  afm: 'EL094450902', purchase_order: '4500012345',
};

// --- Workflow classification ---
{
  const po = classifyWorkflow({ purchase_order: '4500012345', sap_vendor_code: '100245', total_amount: 96 });
  check(po.workflow === DOCUMENT_WORKFLOW.PO_INVOICE, `PO + vendor should classify as PO_INVOICE, got ${po.workflow}`);

  const nonPo = classifyWorkflow({ purchase_order: '', afm: '094450902', total_amount: 96 });
  check(nonPo.workflow === DOCUMENT_WORKFLOW.NON_PO_INVOICE, `no PO but vendor+amount should classify as NON_PO_INVOICE, got ${nonPo.workflow}`);

  const unknown = classifyWorkflow({});
  check(unknown.workflow === DOCUMENT_WORKFLOW.UNKNOWN, `no signals should classify as UNKNOWN, got ${unknown.workflow}`);
  check(unknown.requiresReview === true, 'UNKNOWN workflow should require review');
}

// --- SAP_READY eligibility: a fully valid PO invoice with an exact VAT match should be SAP_READY ---
{
  const result = buildSapReadyRecord(wellFormedInvoice, { suppliers, allInvoices: [wellFormedInvoice] });
  check(result.sapPreparationStatus === SAP_PREP_STATUS.SAP_READY, `well-formed PO invoice should be SAP_READY, got ${result.sapPreparationStatus} (missing: ${result.missingRequiredFields.join(',')})`);
  check(result.sapPrep.sapVendorCode === '100245', 'sapPrep should carry the matched vendor code');
  check(result.sapPrep.companyCode === '1000', 'sapPrep should read companyCode from the matched vendor master row');
  check(result.sapPrep.workflow === DOCUMENT_WORKFLOW.PO_INVOICE, 'sapPrep workflow should be PO_INVOICE');
}

// --- Four statuses stay separate ---
{
  const result = buildSapReadyRecord(wellFormedInvoice, { suppliers, allInvoices: [wellFormedInvoice] });
  check('extractionStatus' in result, 'result should expose extractionStatus separately');
  check('supplierMatchStatus' in result, 'result should expose supplierMatchStatus separately');
  check('accountingValidationStatus' in result, 'result should expose accountingValidationStatus separately');
  check('duplicateStatus' in result, 'result should expose duplicateStatus (part of SAP prep gating) separately');
}

// --- Missing SAP vendor (no VAT/PO/name match at all) → REVIEW_REQUIRED, never guessed ---
{
  const invoice = { ...wellFormedInvoice, id: 2, afm: 'EL999888777', purchase_order: null };
  const result = buildSapReadyRecord(invoice, { suppliers, allInvoices: [invoice] });
  check(result.sapPreparationStatus === SAP_PREP_STATUS.REVIEW_REQUIRED, `unmatched vendor should force REVIEW_REQUIRED, got ${result.sapPreparationStatus}`);
  check(result.sapPrep.sapVendorCode === null, 'unmatched vendor must never invent a SAP vendor code');
  check(result.missingRequiredFields.includes('sapVendorCode'), 'missingRequiredFields should list sapVendorCode');
}

// --- MISSING-field handling: GL/cost center/tax code/company code/posting date are never guessed ---
{
  const result = buildSapReadyRecord(wellFormedInvoice, { suppliers, allInvoices: [wellFormedInvoice] });
  check(result.sapPrep.postingDate === MISSING, 'postingDate must always be MISSING (never guessed)');
  check(result.sapPrep.taxCode === MISSING, 'taxCode must always be MISSING (no tax-code mapping table yet)');
  check(result.unresolvedSapCodingFields.includes('taxCode'), 'taxCode should be listed as an unresolved SAP-coding field');
  // No master data source exists anywhere in this phase for tax code/GL/cost
  // center, so their absence is surfaced but must not block SAP_READY —
  // otherwise SAP_READY would be permanently unreachable for every invoice.
  check(result.sapPreparationStatus === SAP_PREP_STATUS.SAP_READY, 'unresolved tax code alone should not block SAP_READY');
  // This invoice is PO_INVOICE (MIRO-bound) — GL/cost center are not required at header level
  check(result.sapPrep.glAccount === null, 'PO_INVOICE should not force glAccount to MISSING (MIRO derives it from the PO)');

  const nonPoInvoice = { ...wellFormedInvoice, id: 3, purchase_order: null };
  const nonPoResult = buildSapReadyRecord(nonPoInvoice, { suppliers, allInvoices: [nonPoInvoice] });
  check(nonPoResult.sapPrep.workflow === DOCUMENT_WORKFLOW.NON_PO_INVOICE, 'invoice without PO should classify as NON_PO_INVOICE');
  check(nonPoResult.sapPrep.glAccount === MISSING, 'NON_PO_INVOICE (FB60-bound) should mark glAccount MISSING, not guess it');
  check(nonPoResult.sapPrep.costCenter === MISSING, 'NON_PO_INVOICE should mark costCenter MISSING, not guess it');
  check(nonPoResult.unresolvedSapCodingFields.includes('glAccount') && nonPoResult.unresolvedSapCodingFields.includes('costCenter'), 'NON_PO_INVOICE should list glAccount+costCenter as unresolved');
  check(nonPoResult.sapPreparationStatus === SAP_PREP_STATUS.SAP_READY, 'unresolved GL/cost center alone should not block SAP_READY either — same reasoning as taxCode');
}

// --- companyCode has no populated master data in most real installs yet —
// its absence must NOT block SAP_READY (same reasoning as taxCode/GL/cost
// center: gating on it would make SAP_READY unreachable for everyone until
// vendor master data is fully enriched). Confirmed against real usage where
// this previously blocked every single invoice, including fully-matched,
// fully-valid, non-duplicate ones. ---
{
  const suppliersNoCompanyCode = [{ ...suppliers[0], company_code: '' }];
  const result = buildSapReadyRecord(wellFormedInvoice, { suppliers: suppliersNoCompanyCode, allInvoices: [wellFormedInvoice] });
  check(result.sapPreparationStatus === SAP_PREP_STATUS.SAP_READY, `missing companyCode alone must not block SAP_READY, got ${result.sapPreparationStatus}`);
  check(result.sapPrep.companyCode === MISSING, 'companyCode should still read as MISSING on the record for visibility');
  check(result.unresolvedSapCodingFields.includes('companyCode'), 'companyCode should be listed as an unresolved SAP-coding field');
  check(!result.missingRequiredFields.includes('companyCode'), 'companyCode must not appear in the blocking missingRequiredFields list');
}

// --- Confirmed duplicate blocks SAP readiness outright ---
{
  const dup1 = { ...wellFormedInvoice, id: 10 };
  const dup2 = { ...wellFormedInvoice, id: 11 };
  const result = buildSapReadyRecord(dup1, { suppliers, allInvoices: [dup1, dup2] });
  check(result.sapPreparationStatus === SAP_PREP_STATUS.BLOCKED_DUPLICATE, `confirmed duplicate should block SAP prep, got ${result.sapPreparationStatus}`);
}

// --- Accounting failure blocks SAP readiness ---
{
  const badAmounts = { ...wellFormedInvoice, id: 20, total_amount: 999.99 };
  const result = buildSapReadyRecord(badAmounts, { suppliers, allInvoices: [badAmounts] });
  check(result.sapPreparationStatus === SAP_PREP_STATUS.REVIEW_REQUIRED, `accounting failure should force REVIEW_REQUIRED, got ${result.sapPreparationStatus}`);
}

console.log(failed ? `${failed} test(s) failed` : '✓ SAP preparation model tests passed');
process.exit(failed ? 1 : 0);
