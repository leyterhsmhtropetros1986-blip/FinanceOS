#!/usr/bin/env node
/** Accounting validation tests (Phase 8) */
import { validateAccounting, ACCOUNTING_VALIDATION_STATUS } from '../FinanceOS/js/accounting-validation.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

const good = {
  invoice_number: 'INV-1', invoice_date: '2026-06-01',
  net_amount: 77.42, vat_amount: 18.58, total_amount: 96.00, currency: 'EUR', vat_rate: 24,
};

// Net + VAT = Gross passes
{
  const r = validateAccounting(good);
  check(r.status === ACCOUNTING_VALIDATION_STATUS.VALID, `well-formed invoice should be VALID, got ${r.status} (${r.reasons.join('; ')})`);
}

// Amount mismatch fails
{
  const r = validateAccounting({ ...good, total_amount: 999.99 });
  check(r.status === ACCOUNTING_VALIDATION_STATUS.INVALID, `amount mismatch should be INVALID, got ${r.status}`);
  check(r.checks.find((c) => c.name === 'net_plus_vat_equals_gross').passed === false, 'net_plus_vat_equals_gross check should fail');
}

// Rounding tolerance — 1 cent within default tolerance passes
{
  const r = validateAccounting({ ...good, total_amount: 96.01 });
  check(r.checks.find((c) => c.name === 'net_plus_vat_equals_gross').passed === true, '1-cent rounding difference should pass within default tolerance');
}

// Configurable tolerance — a larger discrepancy passes with a wider tolerance, fails with tight tolerance
{
  const invoice = { ...good, total_amount: 96.05 };
  const loose = validateAccounting(invoice, { toleranceCents: 10 });
  const tight = validateAccounting(invoice, { toleranceCents: 1 });
  check(loose.checks.find((c) => c.name === 'net_plus_vat_equals_gross').passed === true, 'wider tolerance should pass a 5-cent gap');
  check(tight.checks.find((c) => c.name === 'net_plus_vat_equals_gross').passed === false, 'tight tolerance should fail a 5-cent gap');
}

// Missing currency
{
  const r = validateAccounting({ ...good, currency: null });
  check(r.status === ACCOUNTING_VALIDATION_STATUS.INVALID, 'missing currency should be INVALID');
  check(r.reasons.some((m) => m.includes('νόμισμα')), 'reasons should mention missing currency');
}

// VAT rate inconsistency
{
  const r = validateAccounting({ ...good, vat_rate: 13 }); // amounts imply 24%, not 13%
  check(r.checks.find((c) => c.name === 'vat_rate_consistent').passed === false, 'VAT rate mismatch should fail the consistency check');
}

// Missing invoice number
{
  const r = validateAccounting({ ...good, invoice_number: null });
  check(r.status === ACCOUNTING_VALIDATION_STATUS.INVALID, 'missing invoice number should be INVALID');
  check(r.reasons.some((m) => m.includes('αριθμός τιμολογίου')), 'reasons should mention missing invoice number');
}

// Missing/invalid date
{
  const r = validateAccounting({ ...good, invoice_date: null });
  check(r.status === ACCOUNTING_VALIDATION_STATUS.INVALID, 'missing date should be INVALID');
  const future = validateAccounting({ ...good, invoice_date: '2099-01-01' });
  check(future.checks.find((c) => c.name === 'invoice_date_valid').passed === false, 'far-future date should fail plausibility check');
}

// Missing amounts entirely — never silently passes
{
  const r = validateAccounting({ invoice_number: 'INV-1', invoice_date: '2026-06-01', currency: 'EUR' });
  check(r.status === ACCOUNTING_VALIDATION_STATUS.INVALID, 'missing amounts should never be silently valid');
}

console.log(failed ? `${failed} test(s) failed` : '✓ Accounting validation tests passed');
process.exit(failed ? 1 : 0);
