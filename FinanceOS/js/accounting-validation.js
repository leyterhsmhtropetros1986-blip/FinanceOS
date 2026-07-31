/**
 * Accounting validation (Phase 8) — purely the arithmetic/document-integrity
 * checks an invoice must pass. Supplier-match and duplicate status are
 * computed elsewhere (sap-vendor-matching.js, duplicate-detection.js) and
 * kept as their own separate statuses per spec — this module does not read
 * or recompute them.
 */
export const ACCOUNTING_VALIDATION_STATUS = { VALID: 'VALID', INVALID: 'INVALID' };

const VAT_RATE_TOLERANCE_MULTIPLIER = 5; // rate-based rounding drifts more than a flat amount check

export function validateAccounting(invoice, { toleranceCents = 1 } = {}) {
  const checks = [];
  const net = invoice.net_amount;
  const vat = invoice.vat_amount;
  const gross = invoice.total_amount;
  const currency = invoice.currency;
  const vatRate = invoice.vat_rate;

  if (net != null && vat != null && gross != null) {
    const diffCents = Math.abs(Math.round((net + vat) * 100) - Math.round(gross * 100));
    checks.push({
      name: 'net_plus_vat_equals_gross',
      passed: diffCents <= toleranceCents,
      message: diffCents <= toleranceCents
        ? 'Καθαρή + ΦΠΑ = Σύνολο'
        : `Καθαρή+ΦΠΑ (${(net + vat).toFixed(2)}) ≠ Σύνολο (${gross.toFixed(2)})`,
    });
  } else {
    checks.push({ name: 'net_plus_vat_equals_gross', passed: false, message: 'Λείπουν ποσά (καθαρή/ΦΠΑ/σύνολο) για έλεγχο' });
  }

  checks.push({
    name: 'currency_present',
    passed: !!currency,
    message: currency ? `Νόμισμα: ${currency}` : 'Λείπει νόμισμα',
  });

  if (vatRate != null && net != null && vat != null) {
    const expectedVat = Math.round(net * vatRate) / 100;
    const diffCents = Math.abs(Math.round(expectedVat * 100) - Math.round(vat * 100));
    const passed = diffCents <= toleranceCents * VAT_RATE_TOLERANCE_MULTIPLIER;
    checks.push({
      name: 'vat_rate_consistent',
      passed,
      message: passed
        ? `ΦΠΑ συνεπές με συντελεστή ${vatRate}%`
        : `ΦΠΑ (${vat}) ασύμβατο με συντελεστή ${vatRate}% επί ${net} (αναμενόμενο ≈${expectedVat.toFixed(2)})`,
    });
  }

  checks.push({
    name: 'invoice_number_present',
    passed: !!invoice.invoice_number,
    message: invoice.invoice_number ? 'Αριθμός τιμολογίου υπάρχει' : 'Λείπει αριθμός τιμολογίου',
  });

  const d = invoice.invoice_date ? new Date(invoice.invoice_date) : null;
  const datePlausible = !!d && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getTime() <= Date.now() + 30 * 86400000;
  checks.push({
    name: 'invoice_date_valid',
    passed: datePlausible,
    message: datePlausible ? 'Ημερομηνία έγκυρη' : 'Λείπει ή μη έγκυρη ημερομηνία τιμολογίου',
  });

  const reasons = checks.filter((c) => !c.passed).map((c) => c.message);
  return {
    status: reasons.length ? ACCOUNTING_VALIDATION_STATUS.INVALID : ACCOUNTING_VALIDATION_STATUS.VALID,
    checks,
    reasons,
  };
}
