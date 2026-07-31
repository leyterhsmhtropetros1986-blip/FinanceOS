#!/usr/bin/env node
/**
 * Real-world OCR field-extraction accuracy fixes, found via a live scanned
 * invoice (PRIMEWAY SA freight-forwarding invoice):
 *  1. Invoice number extractor stopped scanning a keyword's window after the
 *     first non-numeric token, and gave a generic "Τιμολόγιο"/"Αριθμός"
 *     label the same confidence as a highly specific one — so it locked onto
 *     an unrelated reference number in a "Στοιχεία Υπόθεσης" section instead
 *     of the document's own printed Σειρά/Αριθμός header value.
 *  2. Date near-keyword window (40 chars) was too narrow for table-formatted
 *     headers, silently falling through to "first date anywhere in the
 *     document" and grabbing an unrelated reference date.
 *  3. Handwritten SAP doc numbers are frequently OCR'd with letter/digit
 *     mix-ups (O/0, I/l/1, S/5, B/8) that broke the strict digit-only regex.
 */
import { extractInvoiceNumber, extractDate, extractSapDocCandidates } from '../FinanceOS/js/ocr.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

// 1. Invoice number: printed header table wins over an unrelated case-details reference
{
  const fullText = `
ΠΡΑΪΜΓΟΥΕΪ ΜΕΤΑΦΟΡΙΚΗ ΛΟΤΖΙΣΤΙΚΣ - ΕΚΤΕΛΩΝΙΣΤΙΚΗ ΑΝΩΝΥΜΗ ΕΤΑΙΡΕΙΑ
Είδος Παραστατικού Σειρά Αριθμός Ημερομηνία Νόμισμα
2.1 ΤΙΜΟΛΟΓΙΟ ΠΑΡΟΧΗΣ ΥΠΗΡΕΣΙΩΝ Β 918 22/07/2026 12:19 EUR

Στοιχεία Υπόθεσης
Αρ. Υπόθεσης : 26.25.822
Οίκος Εξωτερικού : STARPLAST ENGINEEARING
Τιμολόγιο : 30407Α/14-7-26
Αξία & Νόμισμα : 6.700,00 EUR
`;
  const r = extractInvoiceNumber(fullText);
  check(r.value === '918', `should extract the document's own printed number 918, got "${r.value}"`);
  check(r.value !== '30407Α/14-7-26', 'must not pick the unrelated case-reference number from Στοιχεία Υπόθεσης');
}

// Sanity: a document with ONLY the specific label still works as before
{
  const r = extractInvoiceNumber('Αριθμός Τιμολογίου: TPY-S1-114344 ημερομηνία 01/01/2026');
  check(r.value === 'TPY-S1-114344', `specific-label case should still work, got "${r.value}"`);
  check(r.confidence === 95, `specific label should carry high confidence, got ${r.confidence}`);
}

// A generic label ("Αριθμός" alone) should carry lower confidence than a specific one
{
  const generic = extractInvoiceNumber('Αριθμός Φακέλου: 55221');
  const specific = extractInvoiceNumber('Αριθμός Τιμολογίου: 55221');
  check(generic.confidence < specific.confidence, `generic "Αριθμός" should score lower than "Αριθμός Τιμολογίου" (${generic.confidence} vs ${specific.confidence})`);
}

// 2. Date: header-table gap (>40 chars) between "Ημερομηνία" and its value must
// not fall through to a wrong, unrelated date found earlier in the document.
{
  const fullText = `
Αρ.Τελωνειακού Παρ. : Ε.Δ.Ε. - 26GRIM030400795784 , 2026-07-20
Είδος Παραστατικού Σειρά Αριθμός Ημερομηνία Νόμισμα
2.1 ΤΙΜΟΛΟΓΙΟ ΠΑΡΟΧΗΣ ΥΠΗΡΕΣΙΩΝ Β 918 22/07/2026 12:19 EUR
`;
  const r = extractDate(fullText);
  const expected = new Date(2026, 6, 22).toISOString(); // built the same way tryParse() does — timezone-safe comparison
  check(r.value === expected, `should read 22/07/2026 near the ΗΜΕΡΟΜΗΝΙΑ header despite the >40-char gap, got ${r.value} (expected ${expected})`);
  check(r.confidence === 95, `near-keyword date match should carry high confidence, got ${r.confidence}`);
}

// 3. Handwritten SAP doc number with common OCR letter/digit confusions (O/0, I/l/1)
{
  const fullText = 'Πάνω δεξιά, με στυλό: I9OOIO2883\nΤιμολόγιο Νο 12345';
  const cands = extractSapDocCandidates([], fullText);
  check(cands.some((c) => c.value === '1900102883'), `should recover 1900102883 from the OCR-confused "I9OOIO2883", got candidates: ${JSON.stringify(cands.map((c) => c.value))}`);
  check(!cands.some((c) => c.value === '12345'), 'plain invoice number 12345 should never become a SAP doc candidate');
}

// Negative: confusable-correction must not invent a candidate from garbage that doesn't decode to a valid prefix
{
  const cands = extractSapDocCandidates([], 'κωδικός αναφοράς SOSOSOSOSO τυχαία');
  check(cands.length === 0, `garbage confusable text with no valid prefix after correction should yield no candidates, got ${JSON.stringify(cands)}`);
}

console.log(failed ? `${failed} test(s) failed` : '✓ Field extraction accuracy fixes verified');
process.exit(failed ? 1 : 0);
