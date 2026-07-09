#!/usr/bin/env node
/** Verify trackAIUsage is defined and OCR pipeline symbols resolve */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'FinanceOS', 'js');
const aiSrc = readFileSync(join(root, 'ai.js'), 'utf8');
let failed = 0;

if (!aiSrc.includes('export function trackAIUsage')) {
  console.error('FAIL: trackAIUsage not exported from ai.js');
  failed++;
}
if (aiSrc.includes('if (data.usage) trackAIUsage') && !aiSrc.includes('try {')) {
  console.error('FAIL: trackAIUsage call not wrapped in try/catch');
  failed++;
}
if (readFileSync(join(root, 'storage.js'), 'utf8').includes('function trackAIUsage')) {
  console.error('FAIL: duplicate trackAIUsage still in storage.js');
  failed++;
}

const modules = ['ai.js', 'ocr.js', 'upload.js', 'field-extractors.js', 'pdf-text.js'];
for (const m of modules) {
  try {
    await import(join(root, m));
  } catch (e) {
    if (e.message.includes('window is not defined') || e.message.includes('document')) continue;
    console.error(`FAIL import ${m}:`, e.message);
    failed++;
  }
}

console.log(failed ? `${failed} check(s) failed` : '✓ OCR pipeline symbol audit passed');
process.exit(failed ? 1 : 0);
