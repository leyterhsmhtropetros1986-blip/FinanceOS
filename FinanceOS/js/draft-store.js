/** Auto-save review draft to IndexedDB — crash recovery */
import { idbOpen } from './storage.js';
import { state } from './state.js';
import { $ } from './utils.js';

const DRAFT_PREFIX = 'draft:';
let _timer = null;

export function collectReviewDraft() {
  if (!state.currentInvoiceId) return null;
  const upload = state.currentUpload;
  return {
    invoiceId: state.currentInvoiceId,
    filename: upload?.file?.name || upload?.invoice?.original_filename,
    fileHash: upload?.fileHash || null,
    afm: $('#fld-afm')?.value?.trim() || '',
    invoice_number: $('#fld-invno')?.value?.trim() || '',
    invoice_date: $('#fld-date')?.value || '',
    sap_doc_number: ($('#fld-sap-manual')?.value?.trim() || $('#fld-sap')?.value?.trim() || ''),
    supplier_id: parseInt($('#fld-supplier')?.value, 10) || null,
    savedAt: new Date().toISOString(),
  };
}

export async function saveReviewDraft(draft) {
  if (!draft?.invoiceId) return;
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(draft, `${DRAFT_PREFIX}${draft.invoiceId}`);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function loadReviewDraft(invoiceId) {
  const db = await idbOpen();
  return new Promise((res) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(`${DRAFT_PREFIX}${invoiceId}`);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => res(null);
  });
}

export async function clearReviewDraft(invoiceId) {
  if (!invoiceId) return;
  const db = await idbOpen();
  return new Promise((res) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(`${DRAFT_PREFIX}${invoiceId}`);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

export async function listPendingDrafts() {
  const db = await idbOpen();
  return new Promise((res) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').getAllKeys();
    req.onsuccess = () => {
      const keys = (req.result || []).filter((k) => String(k).startsWith(DRAFT_PREFIX));
      res(keys.map((k) => String(k).replace(DRAFT_PREFIX, '')));
    };
    req.onerror = () => res([]);
  });
}

export function scheduleReviewDraftSave() {
  clearTimeout(_timer);
  _timer = setTimeout(async () => {
    try {
      const draft = collectReviewDraft();
      if (draft) await saveReviewDraft(draft);
    } catch (e) {
      console.warn('Draft save failed:', e);
    }
  }, 2000);
}

export function applyDraftToForm(draft) {
  if (!draft) return;
  if (draft.afm != null) $('#fld-afm').value = draft.afm;
  if (draft.invoice_number != null) $('#fld-invno').value = draft.invoice_number;
  if (draft.invoice_date) $('#fld-date').value = draft.invoice_date;
  if (draft.sap_doc_number) $('#fld-sap-manual').value = draft.sap_doc_number;
  if (draft.supplier_id) $('#fld-supplier').value = String(draft.supplier_id);
}

export function initDraftAutoSave() {
  const fields = ['fld-afm', 'fld-invno', 'fld-date', 'fld-sap-manual', 'fld-sap', 'fld-supplier'];
  for (const id of fields) {
    const el = $(`#${id}`);
    if (!el || el._draftBound) continue;
    el._draftBound = true;
    const handler = () => scheduleReviewDraftSave();
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }
}

export async function restoreDraftIfAny(invoiceId) {
  const draft = await loadReviewDraft(invoiceId);
  if (!draft) return null;
  applyDraftToForm(draft);
  return draft;
}
