#!/usr/bin/env node
/** Human-approved vendor mapping tests (Phase 6) */
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { addEventListener() {} };

const { state } = await import('../FinanceOS/js/state.js');
const {
  recordApprovedMapping, disableMapping, reactivateMapping, touchMappingUsage,
  listMappings, normalizeMappingKey,
} = await import('../FinanceOS/js/vendor-mappings.js');
const { matchSapVendor, MATCH_STATUS, MATCH_METHOD } = await import('../FinanceOS/js/sap-vendor-matching.js');

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}
function resetMappings() { state.vendorMappings = []; }

// normalizeMappingKey per type
{
  check(normalizeMappingKey('VAT', ' el 094-450.902 ') === 'EL094450902', `VAT key normalized, got ${normalizeMappingKey('VAT', ' el 094-450.902 ')}`);
  check(normalizeMappingKey('PO', ' 4500012345 ') === '4500012345', 'PO key trimmed');
  check(normalizeMappingKey('NAME', 'ABC Industrial S.A.') === normalizeMappingKey('NAME', 'abc industrial sa'), 'NAME key is legal-suffix/case insensitive');
}

// create a new mapping — carries createdAt/createdBy/reason/lastUsedAt/active
{
  resetMappings();
  const { mapping, action } = recordApprovedMapping({
    keyType: 'VAT', rawKey: 'EL094450902', sapVendorCode: '100245',
    createdBy: 'accountant1', reason: 'Manual review 2026-07-30',
  });
  check(action === 'created', `first record for a key should be 'created', got ${action}`);
  check(mapping.sapVendorCode === '100245', 'mapping stores target vendor code');
  check(mapping.createdBy === 'accountant1', 'mapping stores createdBy');
  check(mapping.reason === 'Manual review 2026-07-30', 'mapping stores reason');
  check(mapping.lastUsedAt === null, 'new mapping has no lastUsedAt yet');
  check(mapping.active === true, 'new mapping defaults to active');
  check(!!mapping.createdAt, 'mapping stores createdAt timestamp');
  check(state.vendorMappings.length === 1, 'mapping should be persisted into state.vendorMappings');
}

// re-recording the same key corrects in place — never a silent duplicate
{
  resetMappings();
  recordApprovedMapping({ keyType: 'VAT', rawKey: 'EL094450902', sapVendorCode: '100245', createdBy: 'a1' });
  const { mapping, action } = recordApprovedMapping({ keyType: 'VAT', rawKey: 'EL094450902', sapVendorCode: '100999', createdBy: 'a2', reason: 'correction' });
  check(action === 'corrected', `re-recording the same key should correct in place, got ${action}`);
  check(state.vendorMappings.length === 1, `correction must not create a duplicate entry, got ${state.vendorMappings.length}`);
  check(mapping.sapVendorCode === '100999', 'corrected mapping should point to the new vendor code');
  check(mapping.history.length === 1 && mapping.history[0].from === '100245' && mapping.history[0].to === '100999', 'correction should be recorded in history');
}

// disable / reactivate
{
  resetMappings();
  const { mapping } = recordApprovedMapping({ keyType: 'NAME', rawKey: 'ABC S.A.', sapVendorCode: '100245', createdBy: 'a1' });
  disableMapping(mapping.id, { by: 'a2' });
  check(state.vendorMappings.find((m) => m.id === mapping.id).active === false, 'disableMapping should set active=false');
  check(listMappings({ activeOnly: true }).length === 0, 'disabled mapping should be excluded from activeOnly listing');
  reactivateMapping(mapping.id, { by: 'a3' });
  check(state.vendorMappings.find((m) => m.id === mapping.id).active === true, 'reactivateMapping should set active=true again');
}

// touchMappingUsage
{
  resetMappings();
  const { mapping } = recordApprovedMapping({ keyType: 'PO', rawKey: '4500012345', sapVendorCode: '100245', createdBy: 'a1' });
  check(mapping.lastUsedAt === null, 'lastUsedAt starts null');
  touchMappingUsage(mapping.id);
  check(!!state.vendorMappings.find((m) => m.id === mapping.id).lastUsedAt, 'touchMappingUsage should set lastUsedAt');
}

// listMappings filters by keyType
{
  resetMappings();
  recordApprovedMapping({ keyType: 'VAT', rawKey: 'EL094450902', sapVendorCode: '100245', createdBy: 'a1' });
  recordApprovedMapping({ keyType: 'NAME', rawKey: 'ABC S.A.', sapVendorCode: '100245', createdBy: 'a1' });
  check(listMappings({ keyType: 'VAT' }).length === 1, 'listMappings should filter by keyType');
  check(listMappings().length === 2, 'listMappings without filter should return all');
}

// End-to-end: an approved mapping resolves a match that raw vendor-master data alone could not,
// and VAT-based mappings outrank name-based ones when both exist.
{
  resetMappings();
  const suppliers = [{ id: 1, afm: '', sap_vendor_code: '100245', name: 'ABC INDUSTRIAL SA', country: 'GR', active: true, status: 'active' }];
  recordApprovedMapping({ keyType: 'NAME', rawKey: 'ABC INDUSTRIAL SA', sapVendorCode: '100245', createdBy: 'a1' });
  const byName = matchSapVendor({ supplierName: 'ABC INDUSTRIAL SA' }, { suppliers, vendorMappings: state.vendorMappings });
  check(byName.status === MATCH_STATUS.MATCHED, `NAME mapping should allow a MATCH where raw data alone could not, got ${byName.status}`);
  check(byName.matchMethod === MATCH_METHOD.NAME_MAPPING, `method should be NAME_MAPPING, got ${byName.matchMethod}`);

  // Now also approve a VAT mapping for a DIFFERENT vendor with the same name — VAT must win
  const suppliers2 = [
    { id: 1, afm: '', sap_vendor_code: '100245', name: 'ABC INDUSTRIAL SA', country: 'GR', active: true, status: 'active' },
    { id: 2, afm: '', sap_vendor_code: '100999', name: 'ABC INDUSTRIAL SA (OTHER BRANCH)', country: 'GR', active: true, status: 'active' },
  ];
  recordApprovedMapping({ keyType: 'VAT', rawKey: 'EL094450902', sapVendorCode: '100999', createdBy: 'a1' });
  const byBoth = matchSapVendor({ vat: 'EL094450902', supplierName: 'ABC INDUSTRIAL SA' }, { suppliers: suppliers2, vendorMappings: state.vendorMappings });
  check(byBoth.sapVendorCode === '100999', `VAT-based mapping should outrank NAME-based mapping, got ${byBoth.sapVendorCode}`);
  check(byBoth.matchMethod === MATCH_METHOD.VAT_MAPPING, `method should be VAT_MAPPING, got ${byBoth.matchMethod}`);
}

console.log(failed ? `${failed} test(s) failed` : '✓ Vendor mapping tests passed');
process.exit(failed ? 1 : 0);
