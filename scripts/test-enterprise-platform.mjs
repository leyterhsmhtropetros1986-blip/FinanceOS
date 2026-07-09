#!/usr/bin/env node
/** Enterprise platform foundation checks */
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = join(root, 'FinanceOS/js');
const files = readdirSync(js).filter((f) => f.endsWith('.js'));

const required = [
  'queue-manager.js', 'upload-engine.js', 'pdf-tools.js', 'theme.js',
  'keyboard-shortcuts.js', 'ocr-learning.js', 'categories.js', 'timeline.js',
];

const checks = [
  [required.every((f) => files.includes(f)), `enterprise modules (${required.length})`],
  [readFileSync(join(js, 'queue-manager.js'), 'utf8').includes('DEFAULT_CONCURRENCY'), 'parallel queue'],
  [readFileSync(join(js, 'upload-engine.js'), 'utf8').includes('paste'), 'clipboard paste'],
  [readFileSync(join(js, 'pdf-tools.js'), 'utf8').includes('mergePdfFiles'), 'merge PDF'],
  [readFileSync(join(js, 'ocr.js'), 'utf8').includes('borrowWorker'), 'worker pool'],
  [readFileSync(join(js, 'ocr-cache.js'), 'utf8').includes('ocrCache'), 'IDB OCR cache'],
  [readFileSync(join(js, 'theme.js'), 'utf8').includes('data-theme'), 'dark mode'],
  [readFileSync(join(root, 'FinanceOS/index.html'), 'utf8').includes('upload-sources'), 'upload toolbar HTML'],
  [readFileSync(join(root, 'FinanceOS/index.html'), 'utf8').includes('stage-pipeline'), 'stage progress UI'],
  [readFileSync(join(root, 'FinanceOS/docs/ENTERPRISE_ROADMAP.md'), 'utf8').includes('Parastatika V3'), 'roadmap doc'],
];

let failed = 0;
for (const [ok, label] of checks) {
  if (!ok) { console.error(`FAIL: ${label}`); failed++; }
}
console.log(failed ? `${failed} check(s) failed` : `✓ Enterprise platform checks passed (${checks.length})`);
process.exit(failed ? 1 : 0);
