#!/usr/bin/env node
/** Phase 2 upload features — worker, virtual preview, validation, draft */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'FinanceOS/js');
const checks = [
  [readFileSync(join(root, 'ocr-worker.js'), 'utf8').includes('OffscreenCanvas'), 'OCR web worker'],
  [readFileSync(join(root, 'ocr-worker-bridge.js'), 'utf8').includes('recognizeInWorker'), 'worker bridge'],
  [readFileSync(join(root, 'ocr-pipeline.js'), 'utf8').includes('recognizeInWorker'), 'pipeline uses worker'],
  [readFileSync(join(root, 'preview-virtual.js'), 'utf8').includes('IntersectionObserver'), 'virtual PDF preview'],
  [readFileSync(join(root, 'ocr-render.js'), 'utf8').includes('VIRTUAL_PAGE_THRESHOLD'), 'virtual render mode'],
  [readFileSync(join(root, 'field-validation.js'), 'utf8').includes('field--error'), 'field-level validation'],
  [readFileSync(join(root, 'draft-store.js'), 'utf8').includes('scheduleReviewDraftSave'), 'draft auto-save'],
  [readFileSync(join(root, 'upload.js'), 'utf8').includes('mountVirtualPreview'), 'upload virtual preview'],
  [readFileSync(join(root, 'upload.js'), 'utf8').includes('recoverPendingDrafts'), 'draft recovery'],
  [readFileSync(join(root, 'app.js'), 'utf8').includes('warmupOcrWebWorker'), 'worker warmup on boot'],
];

let failed = 0;
for (const [ok, label] of checks) {
  if (!ok) { console.error(`FAIL: ${label}`); failed++; }
}
console.log(failed ? `${failed} failed` : `✓ Phase 2 upload checks passed (${checks.length})`);
process.exit(failed ? 1 : 0);
