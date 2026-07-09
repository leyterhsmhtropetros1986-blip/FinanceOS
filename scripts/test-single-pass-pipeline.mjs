#!/usr/bin/env node
/** Static checks for single-pass OCR pipeline */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'FinanceOS/js');
const pipeline = readFileSync(join(root, 'ocr-pipeline.js'), 'utf8');
const upload = readFileSync(join(root, 'upload.js'), 'utf8');
const preprocess = readFileSync(join(root, 'ocr-preprocess.js'), 'utf8');

const checks = [
  [pipeline.includes('preprocessOnce'), 'pipeline uses preprocessOnce'],
  [pipeline.includes('recognize(processedCanvases'), 'single OCR recognize per page'],
  [!pipeline.includes('getOcrPassVariants'), 'no multi-pass variants in pipeline'],
  [pipeline.includes('CONF_AI_THRESHOLD'), 'Claude threshold gate'],
  [pipeline.includes('getCachedOcr'), 'OCR cache integrated'],
  [pipeline.includes('renderDocumentOnce'), 'single render entry'],
  [upload.includes('beginOcrExtraction'), 'upload uses job cancellation'],
  [!upload.includes('runInvoiceExtraction'), 'removed duplicate extraction'],
  [!upload.includes('renderToCanvases'), 'upload no separate render'],
  [preprocess.includes('export function preprocessOnce'), 'preprocessOnce exported'],
];

let failed = 0;
for (const [ok, label] of checks) {
  if (!ok) { console.error(`FAIL: ${label}`); failed++; }
}
console.log(failed ? `${failed} check(s) failed` : `✓ Single-pass pipeline checks passed (${checks.length})`);
process.exit(failed ? 1 : 0);
