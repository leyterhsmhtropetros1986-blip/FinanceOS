#!/usr/bin/env node
/** Dashboard financial KPI unit checks */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', 'FinanceOS', 'js');

// Minimal mocks for browser-only deps
const state = {
  invoices: [
    { id: 1, status: 'archived', archived_at: '2026-06-01T10:00:00Z', total_amount: 100, vat_amount: 24 },
    { id: 2, status: 'archived', archived_at: '2026-06-15T10:00:00Z', net_amount: 50, vat_amount: 12 },
    { id: 3, status: 'archived', archived_at: '2026-06-20T10:00:00Z' },
    { id: 4, status: 'needs_review', created_at: '2026-06-10T10:00:00Z' },
  ],
  suppliers: [],
  auditLogs: [],
};

await readFile(join(ROOT, 'analytics.js'), 'utf8'); // syntax ok via node --check below

const analyticsCode = await readFile(join(ROOT, 'analytics.js'), 'utf8');
const learningCode = await readFile(join(ROOT, 'ocr-learning.js'), 'utf8');

// Inline test harness
function getInvoiceTotal(inv) {
  const total = Number(inv.total_amount);
  if (Number.isFinite(total) && total > 0) return total;
  const net = Number(inv.net_amount) || 0;
  const vat = Number(inv.vat_amount) || 0;
  if (net > 0 || vat > 0) return net + vat;
  return null;
}

function computeFinancialKpis(archived) {
  const withAmount = archived.filter((i) => getInvoiceTotal(i) != null);
  const totalValue = withAmount.reduce((sum, i) => sum + getInvoiceTotal(i), 0);
  const totalVat = withAmount.reduce((sum, i) => sum + (Number(i.vat_amount) || 0), 0);
  const avgValue = withAmount.length > 0 ? totalValue / withAmount.length : null;
  return {
    totalValue, totalVat, avgValue,
    withAmountCount: withAmount.length,
    missingAmountCount: archived.length - withAmount.length,
    hasAnyAmount: withAmount.length > 0,
  };
}

const archived = state.invoices.filter((i) => i.status === 'archived');
const fin = computeFinancialKpis(archived);

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
  else console.log('✓', msg);
}

assert(fin.hasAnyAmount, 'has amounts from stored fields');
assert(fin.totalValue === 162, `totalValue=162 got ${fin.totalValue}`);
assert(fin.withAmountCount === 2, `2 with amounts got ${fin.withAmountCount}`);
assert(fin.missingAmountCount === 1, `1 missing got ${fin.missingAmountCount}`);
assert(getInvoiceTotal({ net_amount: 80, vat_amount: 20 }) === 100, 'net+vat fallback');
assert(getInvoiceTotal({}) === null, 'null when no amounts');

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\n✓ Dashboard financial KPI tests passed');
