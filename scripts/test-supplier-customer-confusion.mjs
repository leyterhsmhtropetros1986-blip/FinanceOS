#!/usr/bin/env node
/**
 * Real-world bug found via a live scanned invoice (BRATIS IRRIGATION issuing
 * to customer RIVULIS, an existing known supplier in the vendor list):
 *  1. extractAfm()'s MOD-11 "anywhere in the document" backup pass had no
 *     defense against line-item/product codes that coincidentally pass the
 *     checksum — a 9-digit item code ("860000097") from the items table was
 *     picked up as the supplier's AFM instead of the real header AFM.
 *  2. fuzzyFindSupplierInText() (the last-resort full-text supplier scan)
 *     had no awareness of customer-vs-supplier document sections at all —
 *     it matched RIVULIS (a known supplier in state.suppliers) with 99%
 *     confidence purely because RIVULIS's name/AFM appear in the invoice's
 *     ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ (customer) block, even though RIVULIS is the CUSTOMER
 *     receiving this particular invoice, not the supplier who issued it.
 *  3. extractInvoiceNumber()'s 60-char window was still too narrow for some
 *     table-header layouts (same class of bug already fixed for dates).
 */
import { extractAfm, extractInvoiceNumber } from '../FinanceOS/js/ocr.js';
import { fuzzyFindSupplierInText } from '../FinanceOS/js/ocr-confidence.js';
import { findCustomerSectionStart, findItemsTableStart } from '../FinanceOS/js/helpers.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

const BRATIS_DOC = `
ΑΦΟΙ ΜΠΡΑΤΗ ΕΠΕ ΑΡΔΕΥΤΙΚΟΣ ΕΞΟΠΛΙΣΜΟΣ
Α.Φ.Μ. 094450902 Δ.Ο.Υ. ΚΕΦΑΛΗΣ ΑΤΤΙΚΗΣ

ΤΥΠΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ ΑΡΙΘΜΟΣ ΗΜΕΡΟΜΗΝΙΑ ΩΡΑ
Τιμολόγιο - Δ.Αποστολής -ΤΔΑ002131 29/7/2026 13:02

ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ
ΚΩΔΙΚΟΣ ΠΕΛΑΤΗ : 30.00.0020
ΕΠΩΝΥΜΙΑ : RIVULIS ΑΝΩΝ.ΒΙΟΜ.ΕΜΠΟΡ.& ΓΕΩΡΓ.
Α.Φ.Μ. : 094126376
Δ.Ο.Υ. : ΘΗΒΩΝ

ΠΕΡΙΓΡΑΦΗ ΕΙΔΟΥΣ ΠΟΣ. ΤΙΜΗ ΜΟΝ. ΚΑΘ. ΤΙΜΗ ΚΑΘ. ΑΞΙΑ
7260048373 ΠΡΟΓΡ/ΣΤΗΣ RB ESP 9V DV KIT
860000097 ΣΤΑΤ.ΕΚΤΟΞ.POP-UP US-4 15VAN
`;

// 1. extractAfm must not pick up an item code from the items table
{
  const afm = extractAfm(BRATIS_DOC);
  check(afm.value !== '860000097', `must not pick the item-table code as AFM, got ${afm.value}`);
  check(afm.value === '094450902', `should pick the real supplier AFM from the header, got ${afm.value}`);
}

// findItemsTableStart sanity: the marker is found, and is after the header AFM
{
  const upper = BRATIS_DOC.toUpperCase();
  const itemsStart = findItemsTableStart(upper);
  check(itemsStart < upper.length, 'items table marker should be found in this document');
  check(itemsStart > upper.indexOf('094450902'), 'items table should start after the header AFM');
}

// 2. fuzzyFindSupplierInText must not match a supplier only present in the customer block
{
  const suppliers = [
    { id: 1, status: 'active', name: 'RIVULIS ABEGE', name_normalized: 'RIVULIS ABEGE', afm: '094126376', vat_full: 'EL094126376' },
  ];
  const hit = fuzzyFindSupplierInText(BRATIS_DOC, suppliers);
  check(hit === null, `must not match a supplier whose only mention is in the ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ block, got ${JSON.stringify(hit)}`);
}

// Positive control: the same function must still work when the supplier's
// AFM genuinely appears in the header/issuer portion of the document
{
  const suppliers = [
    { id: 2, status: 'active', name: 'ΑΦΟΙ ΜΠΡΑΤΗ ΕΠΕ', name_normalized: 'ΑΦΟΙ ΜΠΡΑΤΗ ΕΠΕ', afm: '094450902', vat_full: '' },
  ];
  const hit = fuzzyFindSupplierInText(BRATIS_DOC, suppliers);
  check(hit && hit.supplier.id === 2, `should still match a supplier whose AFM appears in the issuer/header section, got ${JSON.stringify(hit)}`);
}

// findCustomerSectionStart sanity
{
  const upper = BRATIS_DOC.toUpperCase();
  const customerStart = findCustomerSectionStart(upper);
  check(customerStart < upper.length, 'ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ marker should be found');
  check(upper.indexOf('094126376') > customerStart, 'customer AFM should be positioned after the customer-section boundary');
  check(upper.indexOf('094450902') < customerStart, 'supplier AFM should be positioned before the customer-section boundary');
}

// 3. Invoice number: table-header gap wider than the old 60-char window
{
  const r = extractInvoiceNumber(BRATIS_DOC);
  check(r.value === 'ΤΔΑ002131' || r.value === '-ΤΔΑ002131', `should find the printed document number despite the header/value gap, got "${r.value}"`);
}

console.log(failed ? `${failed} test(s) failed` : '✓ Supplier/customer confusion fixes verified');
process.exit(failed ? 1 : 0);
