#!/usr/bin/env node
/** Extraction model upgrade tests — new fields, {value,confidence,source} model, never-invent guarantee */
import { blankExtraction, buildFieldModel, deriveSourceFromEngine } from '../FinanceOS/js/extraction-schema.js';
import {
  extractIban, extractDeliveryNote, extractPaymentTerms, extractPaymentReference,
  extractVatBreakdown, mergeExtractionResults,
} from '../FinanceOS/js/field-extractors.js';
import { inferCountryFromVat } from '../FinanceOS/js/normalize.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

// New extractors
{
  const text = 'ΠΡΟΜΗΘΕΥΤΗΣ ABC\nIBAN: GR16 0110 1250 0000 0001 2300 695\nΔΕΛΤΙΟ ΑΠΟΣΤΟΛΗΣ: DN-2024-001\nΟΡΟΙ ΠΛΗΡΩΜΗΣ: 30 ημέρες\nΑΙΤΙΟΛΟΓΙΑ ΠΛΗΡΩΜΗΣ: INV-2024-77\n13% 45.00\n24% 120.00';
  const iban = extractIban(text);
  check(iban.value === 'GR1601101250000000012300695', `IBAN extracted got ${iban.value}`);
  check(iban.confidence >= 90, 'IBAN near keyword should have high confidence');

  const dn = extractDeliveryNote(text);
  check(dn.value === 'DN-2024-001', `delivery note extracted got ${dn.value}`);

  const pt = extractPaymentTerms(text);
  check(!!pt.value && pt.value.includes('30'), `payment terms extracted got ${pt.value}`);

  const pr = extractPaymentReference(text);
  check(!!pr.value, `payment reference extracted got ${pr.value}`);

  const breakdown = extractVatBreakdown(text);
  const rates = breakdown.map((b) => b.rate).sort();
  check(JSON.stringify(rates) === JSON.stringify([13, 24]), `VAT breakdown rates got ${JSON.stringify(rates)}`);
}

// Never invent: no IBAN/delivery-note/payment info in text → stays null, not fabricated
{
  const plain = 'ΤΙΜΟΛΟΓΙΟ 12345 ΗΜΕΡΟΜΗΝΙΑ 01/01/2026 ΣΥΝΟΛΟ 100.00';
  check(extractIban(plain).value === null, 'no IBAN present should not be invented');
  check(extractDeliveryNote(plain).value === null, 'no delivery note present should not be invented');
  check(extractVatBreakdown(plain).length === 0, 'no VAT breakdown pattern should not be invented');
}

// Country inference from VAT — decoded, not guessed
{
  check(inferCountryFromVat('EL094450902') === 'GR', 'EL prefix should decode to GR');
  check(inferCountryFromVat('IT00846110898') === 'IT', 'IT prefix should decode to IT');
  check(inferCountryFromVat('094450902') === 'GR', 'bare 9-digit AFM should decode to GR (Greek scheme)');
  check(inferCountryFromVat('') === null, 'empty VAT should not invent a country');
  check(inferCountryFromVat('ZZ1234') === null, 'unknown prefix should not invent a country');
}

// buildFieldModel — shape and never-invent guarantee
{
  const blank = blankExtraction();
  const fields = buildFieldModel(blank, { engine: 'fast OCR' });
  check(fields.supplierVat.value === null, 'blank extraction: supplierVat.value should stay null');
  check(fields.supplierVat.confidence === null, 'blank extraction: supplierVat.confidence should stay null');
  check(fields.supplierVat.source === 'ocr_tesseract', `blank extraction should still report a known source, got ${fields.supplierVat.source}`);
  check(Array.isArray(fields.vatBreakdown.value) && fields.vatBreakdown.value.length === 0, 'vatBreakdown defaults to empty array, not invented data');

  const populated = {
    ...blank,
    afm: '094450902', confidence_afm: 99,
    invoice_number: 'INV-1', confidence_invoice_no: 95,
    iban: 'GR1601101250000000012300695', confidence_iban: 92,
  };
  const f2 = buildFieldModel(populated, { engine: 'Claude Vision (claude-sonnet-5)' });
  check(f2.supplierVat.value === '094450902', 'populated supplierVat value should pass through');
  check(f2.supplierVat.confidence === 99, 'populated supplierVat confidence should pass through');
  check(f2.supplierVat.source === 'claude_vision', `AI engine should map to claude_vision source, got ${f2.supplierVat.source}`);
  check(f2.iban.value === 'GR1601101250000000012300695', 'populated IBAN should pass through the field model');

  const example = {
    ...blank,
    afm: 'EL123456789', confidence_afm: 99,
  };
  const f3 = buildFieldModel(example, { engine: 'fast OCR' });
  check(f3.supplierVat.confidence === 99, 'spec example: confidence should read through unchanged');
}

// deriveSourceFromEngine mapping
{
  check(deriveSourceFromEngine('PDF text (fast)') === 'pdf_text', 'PDF-text-only engine should map to pdf_text');
  check(deriveSourceFromEngine('fast OCR') === 'ocr_tesseract', 'OCR engine should map to ocr_tesseract');
  check(deriveSourceFromEngine('fast OCR + PDF text') === 'ocr_tesseract', 'mixed engine defaults to ocr_tesseract at document level');
  check(deriveSourceFromEngine('Claude Vision (claude-sonnet-5)') === 'claude_vision', 'Claude engine should map to claude_vision');
  check(deriveSourceFromEngine('manual') === 'manual', 'manual engine should map to manual');
  check(deriveSourceFromEngine('') === 'unknown', 'empty engine should map to unknown, not a guess');
}

// per-field source tracking survives an AI-enrichment-style merge
{
  const base = { ...blankExtraction(), afm: '094450902', confidence_afm: 90, iban: null, confidence_iban: 0, _fieldSources: { afm: 'ocr_tesseract' } };
  const aiExtracted = { iban: 'GR1601101250000000012300695', confidence_iban: 92 };
  const aiFieldSources = { ...base._fieldSources };
  for (const [k, v] of Object.entries(aiExtracted)) {
    if (v == null || k.startsWith('confidence_')) continue;
    aiFieldSources[k] = 'claude_vision';
  }
  const merged = { ...base, ...aiExtracted, _fieldSources: aiFieldSources };
  check(merged._fieldSources.afm === 'ocr_tesseract', 'untouched field should keep its original source after AI merge');
  check(merged._fieldSources.iban === 'claude_vision', 'AI-supplied field should be tagged claude_vision after merge');
}

// mergeExtractionResults now tracks _fieldSources per winning side
{
  const ocrResult = { ...blankExtraction(), invoice_number: 'OCR-123', confidence_invoice_no: 60 };
  const pdfResult = { ...blankExtraction(), invoice_number: 'PDF-999', confidence_invoice_no: 95, _meanOcrConfidence: 95 };
  const merged = mergeExtractionResults(ocrResult, pdfResult);
  check(merged.invoice_number === 'PDF-999', 'higher-confidence PDF-text value should win the merge');
  check(merged._fieldSources.invoice_number === 'pdf_text', `merge should tag the winning side, got ${merged._fieldSources.invoice_number}`);
}

console.log(failed ? `${failed} test(s) failed` : '✓ Extraction field-model tests passed');
process.exit(failed ? 1 : 0);
