/**
 * PO / Non-PO / FI Journal classification (Phase 9) — prepares invoices for
 * future MIRO (PO), FB60 (non-PO), and FB01 (FI journal) integration without
 * automating any of them. FI_JOURNAL is architecturally reserved but never
 * auto-assigned today: nothing in the current extraction pipeline gives
 * FinanceOS a reliable signal that a document is a non-vendor FI posting
 * (accrual, provision, etc.) rather than a vendor invoice, so choosing it
 * automatically would be a guess — exactly what this phase must not do.
 */
export const DOCUMENT_WORKFLOW = {
  PO_INVOICE: 'PO_INVOICE',
  NON_PO_INVOICE: 'NON_PO_INVOICE',
  FI_JOURNAL: 'FI_JOURNAL',
  UNKNOWN: 'UNKNOWN',
};

export function classifyWorkflow(invoice) {
  const hasPo = !!String(invoice.purchase_order || '').trim();
  const hasVendorSignal = !!invoice.sap_vendor_code || !!invoice.afm;
  const hasGross = invoice.total_amount != null;

  if (hasPo && hasVendorSignal) {
    return { workflow: DOCUMENT_WORKFLOW.PO_INVOICE, requiresReview: false, reason: 'PO number + στοιχεία προμηθευτή παρόντα → μελλοντικό MIRO' };
  }
  if (!hasPo && hasVendorSignal && hasGross) {
    return { workflow: DOCUMENT_WORKFLOW.NON_PO_INVOICE, requiresReview: false, reason: 'Χωρίς PO, με προμηθευτή και ποσό → μελλοντικό FB60' };
  }
  return { workflow: DOCUMENT_WORKFLOW.UNKNOWN, requiresReview: true, reason: 'Ανεπαρκή στοιχεία για ταξινόμηση PO/Non-PO/FI Journal' };
}
