#!/usr/bin/env node
/** Static checks for fast single-pass OCR pipeline */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'FinanceOS/js');
const pipeline = readFileSync(join(root, 'ocr-pipeline.js'), 'utf8');
const upload = readFileSync(join(root, 'upload.js'), 'utf8');
const preprocess = readFileSync(join(root, 'ocr-preprocess.js'), 'utf8');
const render = readFileSync(join(root, 'ocr-render.js'), 'utf8');
const ocr = readFileSync(join(root, 'ocr.js'), 'utf8');

const checks = [
  [pipeline.includes('preprocessFast'), 'pipeline uses preprocessFast'],
  [pipeline.includes('skipOcr'), 'embedded-text fast path'],
  [!pipeline.includes('runClaudeVisionOCRDirect'), 'no blocking Claude in pipeline'],
  [pipeline.includes('getCachedOcr'), 'OCR cache integrated'],
  [pipeline.includes('renderDocumentOnce'), 'single render entry'],
  [render.includes('embeddedTextIsSufficient'), 'embedded text detection'],
  [render.includes('OCR_MAX_WIDTH'), 'capped OCR resolution'],
  [render.includes('MAX_OCR_PAGES'), 'page limit for OCR'],
  [upload.includes('beginOcrExtraction'), 'upload uses job cancellation'],
  [!upload.includes('runInvoiceExtraction'), 'removed duplicate extraction'],
  [preprocess.includes('export function preprocessFast'), 'preprocessFast exported'],
  [ocr.includes('warmupOcrWorker'), 'worker warmup on boot'],
  [ocr.includes('tessedit_pageseg_mode'), 'tesseract speed params'],
];

let failed = 0;
for (const [ok, label] of checks) {
  if (!ok) { console.error(`FAIL: ${label}`); failed++; }
}
console.log(failed ? `${failed} check(s) failed` : `✓ Fast OCR pipeline checks passed (${checks.length})`);
process.exit(failed ? 1 : 0);
