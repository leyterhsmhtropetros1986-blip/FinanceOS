#!/usr/bin/env node
/** Quick SAP extraction regression tests */
import { sapPrefixBoost, SAP_PREFIXES, isValidSapDocNumber } from '../FinanceOS/js/helpers.js';
import { extractSapDocCandidates } from '../FinanceOS/js/ocr.js';

const tests = [
  { num: '1900101132', minBoost: 25 },
  { num: '1700123456', minBoost: 25 },
  { num: '5100045678', minBoost: 25 },
  { num: '6001234567', minBoost: 25 },
  { num: '2012345678', minBoost: 25 },
  { num: '8012345678', minBoost: 8 },
];

let failed = 0;
for (const t of tests) {
  const boost = sapPrefixBoost(t.num);
  if (boost < t.minBoost) {
    console.error(`FAIL ${t.num}: boost ${boost} < ${t.minBoost}`);
    failed++;
  }
}

const pages = [{
  page_number: 1,
  text: 'SAP DOC NO: 5100099887\nInvoice 12345',
  words: [{ text: '5100099887', confidence: 88, x: 400, y: 50, w: 80, h: 12 }],
  width: 800,
  height: 1100,
  mean_confidence: 88,
}];
const cands = extractSapDocCandidates(pages, pages[0].text);
const top = cands[0]?.value;
if (top !== '5100099887') {
  console.error(`FAIL SAP extract: got ${top}, expected 5100099887`);
  failed++;
}

if (!SAP_PREFIXES.includes('510')) {
  console.error('FAIL: 510 not in SAP_PREFIXES');
  failed++;
}

console.log(failed ? `${failed} test(s) failed` : `✓ SAP extraction tests passed (${tests.length + 2} checks)`);
process.exit(failed ? 1 : 0);
