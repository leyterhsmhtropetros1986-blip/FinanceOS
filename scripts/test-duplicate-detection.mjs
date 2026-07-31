#!/usr/bin/env node
/** Duplicate invoice protection tests (Phase 7) */
import { checkDuplicate, DUPLICATE_STATUS } from '../FinanceOS/js/duplicate-detection.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

const base = {
  id: 1, invoice_number: 'INV-1001', invoice_date: '2026-06-01',
  total_amount: 96.00, currency: 'EUR', afm: '094450902', sap_vendor_code: '100245',
};

// CONFIRMED — Combo A: SAP Vendor + invoice number + date + gross + currency
{
  const others = [{ ...base, id: 2 }];
  const r = checkDuplicate({ ...base, id: 99 }, others);
  check(r.status === DUPLICATE_STATUS.CONFIRMED, `identical combo-A fields should be CONFIRMED, got ${r.status}`);
  check(r.matchedInvoiceIds.includes(2), 'should reference the matching invoice id');
}

// CONFIRMED — Combo B: VAT + invoice number + amount (vendor code unresolved)
{
  const other = { id: 3, invoice_number: 'INV-1001', invoice_date: '2026-06-05', total_amount: 96.00, currency: 'USD', afm: '094450902', sap_vendor_code: null };
  const r = checkDuplicate({ ...base, id: 99, sap_vendor_code: null }, [other]);
  check(r.status === DUPLICATE_STATUS.CONFIRMED, `VAT+invoice#+amount combo should be CONFIRMED even with different date/currency, got ${r.status}`);
}

// Rounding tolerance — 1 cent apart still counts as same amount
{
  const other = { ...base, id: 4, total_amount: 96.01 };
  const r = checkDuplicate({ ...base, id: 99 }, [other], { toleranceCents: 1 });
  check(r.status === DUPLICATE_STATUS.CONFIRMED, `1-cent rounding difference within tolerance should still be CONFIRMED, got ${r.status}`);
}

// Amount clearly different beyond tolerance, same vendor+invoice# → POSSIBLE, not CONFIRMED
{
  const other = { ...base, id: 5, total_amount: 250.00 };
  const r = checkDuplicate({ ...base, id: 99 }, [other], { toleranceCents: 1 });
  check(r.status === DUPLICATE_STATUS.POSSIBLE, `same invoice# but very different amount should be POSSIBLE, got ${r.status}`);
}

// Different currencies (both extracted, no vendor/VAT overlap match) → not a duplicate outright unless VAT combo satisfied
{
  const other = { id: 6, invoice_number: 'INV-1001', invoice_date: '2026-06-01', total_amount: 96.00, currency: 'USD', afm: null, sap_vendor_code: '100245' };
  const r = checkDuplicate({ ...base, id: 99 }, [other]);
  check(r.status === DUPLICATE_STATUS.POSSIBLE, `same vendor+invoice#+amount but different currency should be POSSIBLE (currency must match for combo A), got ${r.status}`);
}

// Different invoice numbers entirely → NO_DUPLICATE even if vendor+amount match (recurring invoices are normal)
{
  const other = { ...base, id: 7, invoice_number: 'INV-2002' };
  const r = checkDuplicate({ ...base, id: 99 }, [other]);
  check(r.status === DUPLICATE_STATUS.NONE, `different invoice numbers should not be flagged just because vendor+amount match, got ${r.status}`);
}

// Missing invoice number on one side, but vendor+amount+date all agree → POSSIBLE (never CONFIRMED without the anchor)
{
  const other = { ...base, id: 8, invoice_number: '' };
  const r = checkDuplicate({ ...base, id: 99, invoice_number: '' }, [other]);
  check(r.status === DUPLICATE_STATUS.POSSIBLE, `missing invoice number should cap status at POSSIBLE, got ${r.status}`);
}

// Never confirmed duplicate is silently removed — checkDuplicate is read-only and reports, does not mutate
{
  const invoices = [{ ...base, id: 2 }];
  const before = JSON.stringify(invoices);
  checkDuplicate({ ...base, id: 99 }, invoices);
  check(JSON.stringify(invoices) === before, 'checkDuplicate must never mutate the invoices it inspects');
}

// No duplicates at all
{
  const r = checkDuplicate({ ...base, id: 99 }, []);
  check(r.status === DUPLICATE_STATUS.NONE, `empty invoice list should be NO_DUPLICATE, got ${r.status}`);
  check(r.matchedInvoiceIds.length === 0, 'NO_DUPLICATE should have no matched ids');
}

console.log(failed ? `${failed} test(s) failed` : '✓ Duplicate detection tests passed');
process.exit(failed ? 1 : 0);
