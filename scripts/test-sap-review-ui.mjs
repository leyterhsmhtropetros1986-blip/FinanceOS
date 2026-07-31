#!/usr/bin/env node
/** Phase 11-13 review UI wiring checks — DOM hooks, module imports resolve */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, '..', 'FinanceOS/js');
const upload = readFileSync(join(root, 'upload.js'), 'utf8');
const invoices = readFileSync(join(root, 'invoices.js'), 'utf8');
const sapPrepUi = readFileSync(join(root, 'sap-prep-ui.js'), 'utf8');
const html = readFileSync(join(dirname(root), 'index.html'), 'utf8');

const checks = [
  // Review panel — SAP Vendor Match + SAP Preparation block (Phase 11)
  [html.includes('id="sap-prep-panel"'), 'SAP prep panel container in index.html'],
  [html.includes('id="sap-vendor-code"'), 'SAP vendor code field in index.html'],
  [html.includes('id="sap-match-status-badge"'), 'SAP match status badge in index.html'],
  [html.includes('id="sap-workflow-badge"'), 'SAP workflow badge in index.html'],
  [html.includes('id="sap-readiness-checklist"'), 'SAP readiness checklist in index.html'],
  [upload.includes("import { renderSapPrepPanel } from './sap-prep-ui.js'"), 'upload.js imports renderSapPrepPanel'],
  [upload.includes('renderSapPrepPanel(invoice)'), 'upload.js calls renderSapPrepPanel during review population'],
  [sapPrepUi.includes('buildSapReadyRecord'), 'sap-prep-ui.js is a view over buildSapReadyRecord'],
  [sapPrepUi.includes('try {') && sapPrepUi.includes('console.warn'), 'sap-prep-ui.js render is defensive (never throws into review UI)'],

  // Invoices table — new filters, SAP columns (Phase 11-12)
  [html.includes('id="invoice-filter-workflow"'), 'workflow filter in index.html'],
  [html.includes('id="invoice-filter-currency"'), 'currency filter in index.html'],
  [html.includes('id="invoice-filter-sap-vendor"'), 'SAP vendor filter in index.html'],
  [html.includes('col-sap-vendor'), 'SAP Vendor column in invoices table'],
  [html.includes('col-sap-status'), 'SAP Status column in invoices table'],
  [invoices.includes('getSapPrep'), 'invoices.js computes SAP prep per row'],
  [invoices.includes('refreshCurrencyFilterOptions'), 'currency filter populated dynamically, not hardcoded'],

  // Bulk "Prepare for SAP" (Phase 12) — explicitly not a posting action
  [html.includes('id="btn-bulk-prepare-sap"'), 'Prepare for SAP bulk button in index.html'],
  [invoices.includes('bulkPrepareForSap'), 'invoices.js implements bulkPrepareForSap'],
  [invoices.includes("SAP_PREP_STATUS.SAP_READY"), 'Prepare for SAP only acts on SAP_READY rows'],
  [!/posttosap|post_to_sap|btn-post-to-sap/i.test(invoices) && !html.includes('btn-post-to-sap'), 'no "post to SAP" action/button exists anywhere in invoices.js or index.html'],
  [invoices.includes("audit('sap_ready'") , 'Prepare for SAP is audit-logged'],

  // Vendor grouping (Phase 13) — never combines totals across currencies
  [html.includes('id="btn-toggle-vendor-grouping"'), 'vendor grouping toggle in index.html'],
  [invoices.includes('renderGroupedByVendor'), 'invoices.js implements vendor grouping'],
  [invoices.includes('byCurrency'), 'vendor grouping aggregates per currency, not combined'],
];

let failed = 0;
for (const [ok, label] of checks) {
  if (!ok) { console.error(`FAIL: ${label}`); failed++; }
}

// Module-load smoke test — DOM shim only, no assertions on behavior
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { addEventListener() {}, querySelectorAll: () => [] };
for (const m of ['upload.js', 'invoices.js', 'sap-prep-ui.js', 'suppliers.js']) {
  try {
    await import(pathToFileURL(join(root, m)));
  } catch (e) {
    console.error(`FAIL import ${m}:`, e.message);
    failed++;
  }
}

console.log(failed ? `${failed} check(s) failed` : `✓ SAP review UI wiring checks passed (${checks.length})`);
process.exit(failed ? 1 : 0);
