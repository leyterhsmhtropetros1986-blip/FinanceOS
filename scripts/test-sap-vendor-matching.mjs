#!/usr/bin/env node
/** SAP Vendor Matching Engine tests (Phases 4-5) */
import { matchSapVendor, MATCH_STATUS, MATCH_METHOD } from '../FinanceOS/js/sap-vendor-matching.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

const suppliers = [
  { id: 1, afm: '094450902', vat_full: 'EL094450902', sap_vendor_code: '100245', name: 'ABC S.A.', country: 'GR', iban: 'GR1601101250000000012300695', active: true, status: 'active' },
  { id: 2, afm: '094452286', vat_full: 'EL094452286', sap_vendor_code: '100837', name: 'COSMOTE A.E.', country: 'GR', iban: null, active: true, status: 'active' },
  { id: 3, afm: '094299908', vat_full: 'EL094299908', sap_vendor_code: '100900', name: 'DUPLICATE VAT CO', country: 'GR', active: true, status: 'active' },
  { id: 4, afm: '094299908', vat_full: 'EL094299908', sap_vendor_code: '100901', name: 'DUPLICATE VAT CO TWO', country: 'GR', active: true, status: 'active' },
  { id: 5, afm: '099999999', vat_full: 'EL099999999', sap_vendor_code: '100999', name: 'INACTIVE VENDOR', country: 'GR', active: false, status: 'inactive' },
];

// 1. Exact VAT → correct vendor, MATCHED
{
  const r = matchSapVendor({ vat: 'EL094450902' }, { suppliers });
  check(r.status === MATCH_STATUS.MATCHED, `exact VAT should MATCH, got ${r.status}`);
  check(r.sapVendorCode === '100245', `exact VAT should resolve to 100245, got ${r.sapVendorCode}`);
  check(r.matchMethod === MATCH_METHOD.VAT_EXACT, `method should be VAT_EXACT, got ${r.matchMethod}`);
  check(r.requiresReview === false, 'exact VAT match should not require review');
  check(r.confidence === 99, `confidence should be 99, got ${r.confidence}`);
}

// spec example — COSMOTE-style exact VAT match, bare AFM input (no country prefix)
{
  const r = matchSapVendor({ vat: '094452286' }, { suppliers });
  check(r.status === MATCH_STATUS.MATCHED, `bare-AFM VAT should still MATCH, got ${r.status}`);
  check(r.sapVendorCode === '100837', `should resolve to COSMOTE 100837, got ${r.sapVendorCode}`);
  check(r.sapVendorName === 'COSMOTE A.E.', `vendor name should read through, got ${r.sapVendorName}`);
}

// 2. Exact IBAN → correct vendor
{
  const r = matchSapVendor({ iban: 'GR16 0110 1250 0000 0001 2300 695' }, { suppliers });
  check(r.status === MATCH_STATUS.MATCHED, `exact IBAN should MATCH, got ${r.status}`);
  check(r.sapVendorCode === '100245', `IBAN should resolve to 100245, got ${r.sapVendorCode}`);
  check(r.matchMethod === MATCH_METHOD.IBAN_EXACT, `method should be IBAN_EXACT, got ${r.matchMethod}`);
}

// 3. PO → correct vendor, via an approved mapping (the only PO data source available)
{
  const vendorMappings = [{ id: 'm1', keyType: 'PO', normalizedKey: '4500012345', sapVendorCode: '100245', active: true }];
  const r = matchSapVendor({ poNumber: '4500012345' }, { suppliers, vendorMappings });
  check(r.status === MATCH_STATUS.MATCHED, `PO mapping should MATCH, got ${r.status}`);
  check(r.sapVendorCode === '100245', `PO should resolve to 100245, got ${r.sapVendorCode}`);
  check(r.matchMethod === MATCH_METHOD.PO_MAPPING, `method should be PO_MAPPING, got ${r.matchMethod}`);
  check(r.usedMappingId === 'm1', 'result should report which mapping was used (for lastUsedAt bump)');
}

// 4. Unknown VAT → NO_MATCH
{
  const r = matchSapVendor({ vat: 'EL999888777' }, { suppliers });
  check(r.status === MATCH_STATUS.NO_MATCH, `unknown VAT should be NO_MATCH, got ${r.status}`);
  check(r.sapVendorCode === null, 'NO_MATCH should never invent a vendor code');
}

// 5. Duplicate VAT across two vendors → REVIEW_REQUIRED
{
  const r = matchSapVendor({ vat: 'EL094299908' }, { suppliers });
  check(r.status === MATCH_STATUS.REVIEW_REQUIRED, `duplicate VAT should be REVIEW_REQUIRED, got ${r.status}`);
  check(r.sapVendorCode === null, 'duplicate VAT must not silently pick one vendor');
  check(r.alternativeMatches.length === 2, `should list both candidates, got ${r.alternativeMatches.length}`);
}

// 6. Conflicting PO vs VAT → CONFLICT
{
  const vendorMappings = [{ id: 'm2', keyType: 'PO', normalizedKey: '4500099999', sapVendorCode: '100837', active: true }];
  const r = matchSapVendor({ poNumber: '4500099999', vat: 'EL094450902' }, { suppliers, vendorMappings });
  check(r.status === MATCH_STATUS.CONFLICT, `PO vs VAT disagreement should be CONFLICT, got ${r.status}`);
  check(r.sapVendorCode === null, 'CONFLICT must never guess which side wins');
  check(r.alternativeMatches.some((a) => a.sapVendorCode === '100245') && r.alternativeMatches.some((a) => a.sapVendorCode === '100837'), 'CONFLICT should surface both candidates');
}

// 7. Name-only (no VAT, no country) → REVIEW_REQUIRED, never MATCHED
{
  const r = matchSapVendor({ supplierName: 'ABC S.A.' }, { suppliers });
  check(r.status !== MATCH_STATUS.MATCHED, `name-only must never auto-MATCH, got ${r.status}`);
  check(r.status === MATCH_STATUS.REVIEW_REQUIRED, `name-only should surface as REVIEW_REQUIRED, got ${r.status}`);
}

// 8. Fuzzy-name-only (typo, not identical) → suggestion only, never MATCHED
{
  const r = matchSapVendor({ supplierName: 'COSMOTTE A.E.' }, { suppliers }); // typo of "COSMOTE A.E."
  check(r.status !== MATCH_STATUS.MATCHED, `fuzzy name must never auto-MATCH, got ${r.status}`);
  check(r.status === MATCH_STATUS.REVIEW_REQUIRED, `fuzzy name should surface as REVIEW_REQUIRED, got ${r.status}`);
  check(r.matchMethod === MATCH_METHOD.FUZZY_NAME_SUGGESTION, `method should be FUZZY_NAME_SUGGESTION, got ${r.matchMethod}`);
  check(r.alternativeMatches.length > 0, 'fuzzy match should surface at least one candidate');
  check(r.alternativeMatches.every((a) => a.matchMethod === MATCH_METHOD.FUZZY_NAME_SUGGESTION), 'fuzzy candidates must be tagged as suggestion-only');
}

// Exact name match with NO corroboration at all (no VAT, no country) → still only REVIEW, never MATCHED
{
  const r = matchSapVendor({ supplierName: 'COSMOTE A.E.' }, { suppliers });
  check(r.status === MATCH_STATUS.REVIEW_REQUIRED, `exact-name-only (no country/VAT) should be REVIEW_REQUIRED, not silently matched, got ${r.status}`);
}

// Name + country → MATCHED (two independent corroborating signals, still lower confidence than VAT/IBAN)
{
  const r = matchSapVendor({ supplierName: 'COSMOTE A.E.', supplierCountry: 'GR' }, { suppliers });
  check(r.status === MATCH_STATUS.MATCHED, `exact name+country should MATCH, got ${r.status}`);
  check(r.sapVendorCode === '100837', `should resolve to 100837, got ${r.sapVendorCode}`);
  check(r.confidence < 99, 'name+country confidence should be lower than VAT/IBAN-based confidence');
}

// Near-VAT (1 digit off) + compatible name → MATCHED via VAT_NAME, not blind VAT
{
  const r = matchSapVendor({ vat: 'EL094450901', supplierName: 'ABC S.A.' }, { suppliers }); // last digit off by one
  check(r.status === MATCH_STATUS.MATCHED, `near-VAT + name should MATCH, got ${r.status}`);
  check(r.matchMethod === MATCH_METHOD.VAT_NAME, `method should be VAT_NAME, got ${r.matchMethod}`);
  check(r.sapVendorCode === '100245', `should resolve to 100245, got ${r.sapVendorCode}`);
}

// Inactive vendor must never be matched
{
  const r = matchSapVendor({ vat: 'EL099999999' }, { suppliers });
  check(r.status === MATCH_STATUS.NO_MATCH, `inactive vendor VAT should not match, got ${r.status}`);
}

// No evidence at all → NO_MATCH, not a guess
{
  const r = matchSapVendor({}, { suppliers });
  check(r.status === MATCH_STATUS.NO_MATCH, `empty input should be NO_MATCH, got ${r.status}`);
}

console.log(failed ? `${failed} test(s) failed` : '✓ SAP Vendor Matching Engine tests passed');
process.exit(failed ? 1 : 0);
