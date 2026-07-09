#!/usr/bin/env node
/** SAP handwritten prefix extraction tests */
import {
  sapPrefixBoost, SAP_PREFIXES, SAP_HANDWRITTEN_PREFIXES,
  isValidSapDocNumber, hasAllowedSapPrefix,
} from '../FinanceOS/js/helpers.js';
import { extractSapDocCandidates } from '../FinanceOS/js/ocr.js';

const validTests = [
  { num: '1900101132', minBoost: 30 },
  { num: '1700123456', minBoost: 30 },
  { num: '5100045678', minBoost: 30 },
];

const invalidTests = ['6001234567', '2012345678', '8012345678', '1234567890'];

let failed = 0;
for (const t of validTests) {
  if (!hasAllowedSapPrefix(t.num)) {
    console.error(`FAIL ${t.num}: should have allowed prefix`);
    failed++;
  }
  const boost = sapPrefixBoost(t.num);
  if (boost < t.minBoost) {
    console.error(`FAIL ${t.num}: boost ${boost} < ${t.minBoost}`);
    failed++;
  }
  if (!isValidSapDocNumber(t.num)) {
    console.error(`FAIL ${t.num}: should be valid SAP doc`);
    failed++;
  }
}

for (const num of invalidTests) {
  if (isValidSapDocNumber(num)) {
    console.error(`FAIL ${num}: should be rejected (wrong prefix)`);
    failed++;
  }
  if (hasAllowedSapPrefix(num)) {
    console.error(`FAIL ${num}: should not have allowed prefix`);
    failed++;
  }
}

const pages = [{
  page_number: 1,
  text: 'SAP DOC NO: 5100099887\nInvoice 12345\n1900101132',
  words: [
    { text: '5100099887', confidence: 88, x: 400, y: 50, w: 80, h: 12 },
    { text: '1900101132', confidence: 75, x: 200, y: 40, w: 90, h: 12 },
  ],
  width: 800,
  height: 1100,
  mean_confidence: 88,
}];
const cands = extractSapDocCandidates(pages, pages[0].text);
const top = cands[0]?.value;
if (top !== '5100099887' && top !== '1900101132') {
  console.error(`FAIL SAP extract: top=${top}, expected 5100099887 or 1900101132`);
  failed++;
}
if (cands.some((c) => c.value === '12345')) {
  console.error('FAIL: invoice number 12345 should not be SAP candidate');
  failed++;
}

if (JSON.stringify(SAP_PREFIXES) !== JSON.stringify(SAP_HANDWRITTEN_PREFIXES)) {
  console.error('FAIL: SAP_PREFIXES must match handwritten prefixes only');
  failed++;
}

console.log(failed ? `${failed} test(s) failed` : `✓ SAP extraction tests passed (${validTests.length + invalidTests.length + 3} checks)`);
process.exit(failed ? 1 : 0);
