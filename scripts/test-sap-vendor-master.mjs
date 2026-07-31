#!/usr/bin/env node
/** SAP Vendor Master import + pre-commit validation tests (Phase 3) */
// suppliers.js transitively imports storage.js, which does top-level browser
// feature detection (`typeof window.showDirectoryPicker`). Minimal test-only
// shim so the module graph can load under plain Node — no app code touched.
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { addEventListener() {} };

const { state } = await import('../FinanceOS/js/state.js');
const { resolveColumns, analyzeVendorMasterImport, importSupplierRows } = await import('../FinanceOS/js/suppliers.js');

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

function resetSuppliers() { state.suppliers = []; }

// resolveColumns picks up the new optional vendor-master columns
{
  const sample = {
    'AFM': '094450902', 'SAP Vendor Code': '300100', 'Name': 'DHL', 'Country': 'GR',
    'IBAN': 'GR1601101250000000012300695', 'Company Code': '1000',
    'Payment Terms': 'NT30', 'Reconciliation Account': '220000', 'Active': '1',
  };
  const cols = resolveColumns(sample);
  check(cols.iban === 'IBAN', `iban column resolved, got ${cols.iban}`);
  check(cols.company_code === 'Company Code', `company_code column resolved, got ${cols.company_code}`);
  check(cols.payment_terms === 'Payment Terms', `payment_terms column resolved, got ${cols.payment_terms}`);
  check(cols.reconciliation_account === 'Reconciliation Account', `reconciliation_account column resolved, got ${cols.reconciliation_account}`);
  check(cols.active === 'Active', `active column resolved, got ${cols.active}`);
}

// analyzeVendorMasterImport never mutates state, reports totals correctly
{
  resetSuppliers();
  const rows = [
    { AFM: '094450902', 'SAP Vendor Code': '300100', Name: 'DHL EXPRESS', Country: 'GR' },
    { AFM: '094452286', 'SAP Vendor Code': '302847', Name: 'PALAPLAST', Country: 'GR' },
    { AFM: '', 'SAP Vendor Code': '', Name: 'NO IDENTIFIERS', Country: 'GR' },      // invalid
    { AFM: '094450902', 'SAP Vendor Code': '300100', Name: 'DHL EXPRESS DUP', Country: 'GR' }, // duplicate within batch
  ];
  const before = state.suppliers.length;
  const report = analyzeVendorMasterImport(rows);
  check(state.suppliers.length === before, 'analyzeVendorMasterImport must never mutate state.suppliers');
  check(report.totalRows === 4, `totalRows got ${report.totalRows}`);
  check(report.invalidRows === 1, `invalidRows got ${report.invalidRows}`);
  check(report.duplicates === 1, `duplicates got ${report.duplicates}`);
  check(report.validRows === 2, `validRows got ${report.validRows}`);
}

// duplicate VAT / duplicate IBAN detection within a batch
{
  resetSuppliers();
  const rows = [
    { AFM: '094450902', 'SAP Vendor Code': '300100', Name: 'A', IBAN: 'GR1601101250000000012300695' },
    { AFM: '094450902', 'SAP Vendor Code': '300200', Name: 'B', IBAN: 'GR1601101250000000012300695' },
  ];
  const report = analyzeVendorMasterImport(rows);
  check(report.duplicateVat.length === 1, `duplicateVat should flag the shared AFM, got ${JSON.stringify(report.duplicateVat)}`);
  check(report.duplicateIban.length === 1, `duplicateIban should flag the shared IBAN, got ${JSON.stringify(report.duplicateIban)}`);
}

// import commits new vendor-master fields; update path shows a diff, never a silent overwrite
{
  resetSuppliers();
  const initialRows = [
    { AFM: '094450902', 'SAP Vendor Code': '300100', Name: 'DHL EXPRESS', Country: 'GR', IBAN: 'GR16 0110 1250 0000 0001 2300 695', 'Company Code': '1000' },
  ];
  const result1 = importSupplierRows(initialRows);
  check(result1.imported === 1, `first import should create 1 supplier, got ${result1.imported}`);
  const supplier = state.suppliers.find((s) => s.afm === '094450902');
  check(!!supplier, 'supplier should exist after import');
  check(supplier.iban === 'GR1601101250000000012300695', `supplier.iban stored normalized, got ${supplier.iban}`);
  check(supplier.company_code === '1000', `supplier.company_code stored, got ${supplier.company_code}`);
  check(supplier.active === true, 'supplier should default active=true when status is active and no explicit active column');

  // Re-import with a changed company code — analyze should show the diff BEFORE any commit
  const updateRows = [
    { AFM: '094450902', 'SAP Vendor Code': '300100', Name: 'DHL EXPRESS', Country: 'GR', 'Company Code': '2000' },
  ];
  const preview = analyzeVendorMasterImport(updateRows);
  check(preview.entries[0].status === 'update', `re-import of existing vendor should be classified as update, got ${preview.entries[0].status}`);
  const change = preview.entries[0].changes.find((c) => c.field === 'company_code');
  check(!!change && change.from === '1000' && change.to === '2000', `diff should show company_code 1000 -> 2000, got ${JSON.stringify(change)}`);
  check(state.suppliers.find((s) => s.afm === '094450902').company_code === '1000', 'preview must not have committed the change yet');

  // Commit — only now should the value change
  importSupplierRows(updateRows);
  check(state.suppliers.find((s) => s.afm === '094450902').company_code === '2000', 'commit should apply the previewed change');
}

// missing vendor code is tracked, not silently dropped
{
  resetSuppliers();
  const rows = [{ AFM: '094450902', 'SAP Vendor Code': '', Name: 'NO SAP CODE YET' }];
  const report = analyzeVendorMasterImport(rows);
  check(report.missingVendorCodes === 1, `missingVendorCodes got ${report.missingVendorCodes}`);
  check(report.validRows === 1, 'a row with AFM but no SAP code is still valid (importable), just flagged');
}

console.log(failed ? `${failed} test(s) failed` : '✓ SAP Vendor Master tests passed');
process.exit(failed ? 1 : 0);
