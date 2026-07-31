/**
 * Human-approved SAP vendor mappings (Phase 6).
 *
 * When an accountant manually confirms "this invoice's supplier is SAP
 * vendor X", that decision is stored here as a deterministic lookup entry
 * (normalized VAT/PO/name → SAP vendor code) so future invoices carrying the
 * same key can be matched without re-review. This is explicitly NOT an ML
 * model — no training, no weights, just an editable, auditable table that
 * sap-vendor-matching.js consults as one more deterministic signal.
 *
 * VAT-keyed mappings always outrank name-keyed ones — see MATCH priority
 * order in sap-vendor-matching.js (VAT_MAPPING sits above NAME_MAPPING).
 */
import { state } from './state.js';
import { normalizeVat, normalizeSupplierName, normalizePoNumber } from './normalize.js';
import { scheduleSave } from './storage.js';
import { audit } from './audit.js';

export const MAPPING_KEY_TYPES = ['VAT', 'PO', 'NAME'];

let _nextId = 1;

function nextMappingId() {
  const maxNum = state.vendorMappings.reduce((m, x) => {
    const n = Number(String(x.id).replace(/\D/g, '')) || 0;
    return Math.max(m, n);
  }, 0);
  _nextId = Math.max(_nextId, maxNum + 1);
  return `vm${_nextId++}`;
}

/** Normalize a raw key consistently with what sap-vendor-matching.js compares against. */
export function normalizeMappingKey(keyType, rawKey) {
  if (keyType === 'VAT') return normalizeVat(rawKey).normalizedValue;
  if (keyType === 'PO') return normalizePoNumber(rawKey).normalizedValue;
  if (keyType === 'NAME') return normalizeSupplierName(rawKey).comparisonKey;
  return null;
}

/**
 * Create or correct an approved mapping. If an active mapping already exists
 * for the same (keyType, normalizedKey), it is corrected in place (never a
 * silent second, conflicting entry) and the previous target is recorded in
 * matchEvidence-style history; a fresh entry is created otherwise.
 */
export function recordApprovedMapping({ keyType, rawKey, sapVendorCode, createdBy, reason }) {
  if (!MAPPING_KEY_TYPES.includes(keyType)) throw new Error(`Άγνωστος τύπος mapping: ${keyType}`);
  const normalizedKey = normalizeMappingKey(keyType, rawKey);
  if (!normalizedKey) throw new Error('Άκυρο κλειδί mapping (κενό μετά την κανονικοποίηση)');
  if (!sapVendorCode) throw new Error('Απαιτείται SAP Vendor Code');

  const now = new Date().toISOString();
  const existing = state.vendorMappings.find(
    (m) => m.active !== false && m.keyType === keyType && m.normalizedKey === normalizedKey
  );

  if (existing) {
    const previousVendorCode = existing.sapVendorCode;
    existing.sapVendorCode = sapVendorCode;
    existing.reason = reason || existing.reason;
    existing.correctedAt = now;
    existing.correctedBy = createdBy || existing.correctedBy || null;
    existing.history = [...(existing.history || []), { at: now, by: createdBy || null, from: previousVendorCode, to: sapVendorCode }];
    scheduleSave();
    const action = previousVendorCode === sapVendorCode ? 'unchanged' : 'corrected';
    if (action === 'corrected') {
      audit('mapping_changed', 'success', `${keyType} mapping ${normalizedKey}: ${previousVendorCode} → ${sapVendorCode}`,
        { actor: createdBy || 'system', details: { mappingId: existing.id, keyType, normalizedKey, from: previousVendorCode, to: sapVendorCode } });
    }
    return { mapping: existing, action };
  }

  const mapping = {
    id: nextMappingId(),
    keyType,
    rawKey: String(rawKey),
    normalizedKey,
    sapVendorCode,
    createdAt: now,
    createdBy: createdBy || null,
    reason: reason || null,
    lastUsedAt: null,
    active: true,
    history: [],
  };
  state.vendorMappings.push(mapping);
  scheduleSave();
  audit('mapping_created', 'success', `${keyType} mapping ${normalizedKey} → ${sapVendorCode}`,
    { actor: createdBy || 'system', details: { mappingId: mapping.id, keyType, normalizedKey, sapVendorCode } });
  return { mapping, action: 'created' };
}

export function disableMapping(id, { by } = {}) {
  const m = state.vendorMappings.find((x) => x.id === id);
  if (!m) return null;
  m.active = false;
  m.disabledAt = new Date().toISOString();
  m.disabledBy = by || null;
  scheduleSave();
  return m;
}

export function reactivateMapping(id, { by } = {}) {
  const m = state.vendorMappings.find((x) => x.id === id);
  if (!m) return null;
  m.active = true;
  m.reactivatedAt = new Date().toISOString();
  m.reactivatedBy = by || null;
  scheduleSave();
  return m;
}

/** Called by the SAP-prep orchestrator after a mapping-based match is used,
 *  so "unused for N months" can be surfaced later during mapping review. */
export function touchMappingUsage(id) {
  const m = state.vendorMappings.find((x) => x.id === id);
  if (!m) return null;
  m.lastUsedAt = new Date().toISOString();
  scheduleSave();
  return m;
}

export function listMappings({ keyType, activeOnly } = {}) {
  return state.vendorMappings.filter((m) =>
    (!keyType || m.keyType === keyType) && (!activeOnly || m.active !== false)
  );
}
