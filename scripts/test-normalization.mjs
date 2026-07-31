#!/usr/bin/env node
/** Normalization utility tests — VAT, IBAN, supplier name, invoice/PO number */
import {
  normalizeVat, isPlausibleVatFormat,
  normalizeIban, isPlausibleIbanFormat, validateIbanChecksum,
  normalizeSupplierName,
  normalizeInvoiceNumber,
  normalizePoNumber,
} from '../FinanceOS/js/normalize.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

// VAT
{
  const r = normalizeVat('  el 094-450.902  ');
  check(r.originalValue === '  el 094-450.902  ', 'VAT originalValue preserved verbatim');
  check(r.normalizedValue === 'EL094450902', `VAT normalized got ${r.normalizedValue}`);
  check(isPlausibleVatFormat(r.normalizedValue), 'EL094450902 should be plausible VAT format');
  check(!isPlausibleVatFormat('12'), 'too-short VAT should not be plausible');
  const empty = normalizeVat('');
  check(empty.normalizedValue === null, 'empty VAT normalizes to null, not invented');
}

// IBAN
{
  const r = normalizeIban('gr16 0110 1250 0000 0001 2300 695');
  check(r.normalizedValue === 'GR1601101250000000012300695', `IBAN normalized got ${r.normalizedValue}`);
  check(isPlausibleIbanFormat(r.normalizedValue), 'GR IBAN should be plausible format');
  check(validateIbanChecksum(r.normalizedValue) === true, 'known-valid GR IBAN should pass MOD-97 checksum');
  const bad = normalizeIban('GR1601101250000000012300696'); // last digit tampered
  check(validateIbanChecksum(bad.normalizedValue) === false, 'tampered IBAN should fail MOD-97 checksum');
  check(validateIbanChecksum('not-an-iban') === null, 'non-IBAN input returns null (not a false failure)');
}

// Supplier name
{
  const a = normalizeSupplierName('ABC Industrial S.A.');
  const b = normalizeSupplierName('  abc   industrial   sa ');
  check(a.originalValue === 'ABC Industrial S.A.', 'supplier name originalValue preserved verbatim');
  check(a.comparisonKey === b.comparisonKey, `legal-suffix-insensitive comparison should match: "${a.comparisonKey}" vs "${b.comparisonKey}"`);
  const greek = normalizeSupplierName('Παλαπλαστ Α.Ε.');
  check(greek.comparisonKey && greek.comparisonKey.includes('ΠΑΛΑΠΛΑΣΤ'), `Greek accent stripping should keep base letters, got "${greek.comparisonKey}"`);
}

// Invoice number
{
  const r = normalizeInvoiceNumber('  INV-2024 / 001  ');
  check(r.originalValue === '  INV-2024 / 001  ', 'invoice number originalValue preserved verbatim');
  check(r.normalizedValue === 'INV-2024/001', `invoice number normalized got ${r.normalizedValue}`);
}

// PO number
{
  const r = normalizePoNumber(' 4500012345 ', { pattern: /^45\d{8}$/ });
  check(r.normalizedValue === '4500012345', 'PO number whitespace trimmed');
  check(r.matchesExpectedFormat === true, 'PO number should match configured SAP-style pattern');
  const noPattern = normalizePoNumber('XYZ-1');
  check(noPattern.matchesExpectedFormat === null, 'PO number without configured pattern should not be judged invalid');
}

console.log(failed ? `${failed} test(s) failed` : '✓ Normalization tests passed');
process.exit(failed ? 1 : 0);
