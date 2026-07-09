#!/usr/bin/env node
/** Upload module enterprise safety checks */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'FinanceOS/js');
const upload = readFileSync(join(root, 'upload.js'), 'utf8');
const pipeline = readFileSync(join(root, 'ocr-pipeline.js'), 'utf8');
const schema = readFileSync(join(root, 'extraction-schema.js'), 'utf8');
const html = readFileSync(join(dirname(root), 'index.html'), 'utf8');

const checks = [
  [schema.includes('normalizeExtraction'), 'normalizeExtraction'],
  [schema.includes('safeConfidence'), 'safeConfidence'],
  [upload.includes('USER_FALLBACK'), 'user-friendly fallback message'],
  [upload.includes('enterManualMode'), 'manual mode on failure'],
  [upload.includes('retryOcrForCurrent'), 'retry OCR'],
  [upload.includes('retryAiForCurrent'), 'retry AI'],
  [upload.includes('renderDocumentOnce'), 'early preview before OCR'],
  [upload.includes('applyOcrResultToReview'), 'safe review wrapper'],
  [upload.includes('setConfidence(f, null)') || upload.includes('setConfidence(field, null)'), 'null confidence display'],
  [!upload.includes('toast(`Σφάλμα: ${e.message}`'), 'no technical errors in toast'],
  [pipeline.includes('matchSupplierCached'), 'supplier cache in pipeline'],
  [pipeline.includes('normalizeExtraction'), 'pipeline normalizes extraction'],
  [html.includes('btn-retry-ocr'), 'retry OCR button'],
  [html.includes('upload-status-badge'), 'unified status badge'],
  [html.includes('pipeline-progress'), 'stage progress bars'],
];

let failed = 0;
for (const [ok, label] of checks) {
  if (!ok) { console.error(`FAIL: ${label}`); failed++; }
}
console.log(failed ? `${failed} failed` : `✓ Upload safety checks passed (${checks.length})`);
process.exit(failed ? 1 : 0);
