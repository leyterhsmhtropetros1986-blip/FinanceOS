/** Invoices table view — search, bulk actions, responsive layout */
import { state } from './state.js';
import { $, toast, fmtDate, escapeHtml } from './utils.js';
import { audit } from './audit.js';
import { getFileHandleFromRelPath, scheduleSave } from './storage.js';
import { exportInvoicesToExcel, exportInvoicesToPdfZip, exportArchivedToExcel, exportSapReadyInvoices } from './export.js';
import { updateReviewBadge } from './badges.js';
import { statusLabel } from './analytics.js';
import { buildSapReadyRecord, SAP_PREP_STATUS } from './sap-preparation.js';

const selectedIds = new Set();
let groupByVendor = false;

const SAP_STATUS_LABEL = {
  [SAP_PREP_STATUS.SAP_READY]: 'SAP READY',
  [SAP_PREP_STATUS.REVIEW_REQUIRED]: 'REVIEW REQUIRED',
  [SAP_PREP_STATUS.BLOCKED_DUPLICATE]: 'DUPLICATE',
};
function sapStatusClass(status) {
  if (status === SAP_PREP_STATUS.SAP_READY) return 'status-active';
  if (status === SAP_PREP_STATUS.BLOCKED_DUPLICATE) return 'status-error';
  return 'status-needs_review';
}

/** Per-render cache — buildSapReadyRecord is recomputed at most once per
 *  invoice per renderInvoices() call, not once per filter/column/row use. */
let _sapPrepCache = new Map();
function getSapPrep(inv) {
  if (_sapPrepCache.has(inv.id)) return _sapPrepCache.get(inv.id);
  let result;
  try {
    result = buildSapReadyRecord(inv, {
      suppliers: state.suppliers,
      vendorMappings: state.vendorMappings,
      allInvoices: state.invoices,
    });
  } catch (e) {
    console.warn('SAP prep computation failed for invoice', inv.id, e);
    result = null;
  }
  _sapPrepCache.set(inv.id, result);
  return result;
}

function truncateFilename(name, head = 10) {
  if (!name) return '—';
  if (name.length <= head + 3) return name;
  return `${name.slice(0, head)}…`;
}

function matchesSearch(inv, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const supplier = state.suppliers.find(s => s.id === inv.supplier_id);
  const hay = [
    inv.original_filename,
    inv.archived_filename,
    inv.sap_doc_number,
    inv.afm,
    inv.invoice_number,
    supplier?.name,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function getFilteredRows() {
  const status = $('#invoice-filter')?.value || '';
  const query = ($('#invoice-search')?.value || '').trim();
  const workflowFilter = $('#invoice-filter-workflow')?.value || '';
  const currencyFilter = $('#invoice-filter-currency')?.value || '';
  const sapVendorQuery = ($('#invoice-filter-sap-vendor')?.value || '').trim().toLowerCase();

  return state.invoices.filter((i) => {
    if (status && i.status !== status) return false;
    if (!matchesSearch(i, query)) return false;
    if (currencyFilter && (i.currency || '') !== currencyFilter) return false;
    if (workflowFilter || sapVendorQuery) {
      const prep = getSapPrep(i);
      if (workflowFilter && prep?.workflowClassification?.workflow !== workflowFilter) return false;
      if (sapVendorQuery) {
        const code = (prep?.supplierMatchStatus?.sapVendorCode || '').toLowerCase();
        const name = (prep?.supplierMatchStatus?.sapVendorName || '').toLowerCase();
        if (!code.includes(sapVendorQuery) && !name.includes(sapVendorQuery)) return false;
      }
    }
    return true;
  });
}

/** Populate the currency filter's option list from whatever currencies are
 *  actually present — never a hardcoded list. */
function refreshCurrencyFilterOptions() {
  const sel = $('#invoice-filter-currency');
  if (!sel) return;
  const current = sel.value;
  const currencies = [...new Set(state.invoices.map((i) => i.currency).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Όλα τα νομίσματα</option>' +
    currencies.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (currencies.includes(current)) sel.value = current;
}

function updateBulkBar() {
  const bar = $('#invoice-bulk-bar');
  const countEl = $('#invoice-bulk-count');
  if (!bar) return;
  const n = selectedIds.size;
  bar.hidden = n === 0;
  if (countEl) countEl.textContent = `${n} επιλεγμένα`;
}

function toggleSelectAll(checked) {
  const rows = getFilteredRows();
  if (checked) rows.forEach(r => selectedIds.add(r.id));
  else rows.forEach(r => selectedIds.delete(r.id));
  updateBulkBar();
  renderInvoices();
}

// ─── View/Download αρχειοθετημένων PDF ──────────────────
export async function getArchivedPdfBytes(invoice) {
  if (!invoice || !invoice.archived_path) return null;
  const stored = state.archivedFiles.get(invoice.archived_path);
  if (stored) return stored.bytes;
  if (!state.archiveRoot.handle) return null;
  try {
    const fh = await getFileHandleFromRelPath(invoice.archived_path);
    const file = await fh.getFile();
    return await file.arrayBuffer();
  } catch (e) {
    console.warn('Disk read failed:', e);
    return null;
  }
}

export async function viewArchivedPdf(invoiceId) {
  const invoice = state.invoices.find(i => i.id === invoiceId);
  if (!invoice || !invoice.archived_path) {
    toast('Το τιμολόγιο δεν είναι αρχειοθετημένο', 'err');
    return;
  }
  const bytes = await getArchivedPdfBytes(invoice);
  if (!bytes) {
    toast('Δεν βρέθηκε το αρχείο (ούτε σε μνήμη ούτε στον δίσκο)', 'err');
    return;
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function downloadArchivedPdf(invoiceId) {
  const invoice = state.invoices.find(i => i.id === invoiceId);
  if (!invoice || !invoice.archived_path) {
    toast('Το τιμολόγιο δεν είναι αρχειοθετημένο', 'err');
    return;
  }
  const bytes = await getArchivedPdfBytes(invoice);
  if (!bytes) {
    toast('Δεν βρέθηκε το αρχείο', 'err');
    return;
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = invoice.archived_filename || 'invoice.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function invoiceRowHtml(inv) {
  const supplier = state.suppliers.find(s => s.id === inv.supplier_id);
  const isArchived = inv.status === 'archived';
  const canRetrieve = isArchived && inv.archived_path &&
    (state.archivedFiles.has(inv.archived_path) || state.archiveRoot.handle);
  const filename = inv.archived_filename || inv.original_filename || '—';
  const shortName = truncateFilename(filename);
  const prep = getSapPrep(inv);
  const vendorCode = prep?.supplierMatchStatus?.sapVendorCode;
  const vendorLabel = vendorCode
    ? `${vendorCode}${prep.supplierMatchStatus.sapVendorName ? ' — ' + prep.supplierMatchStatus.sapVendorName : ''}`
    : '—';
  const sapStatus = prep?.sapPreparationStatus;
  return `
      <td class="col-check"><input type="checkbox" class="invoice-check" data-id="${inv.id}" ${selectedIds.has(inv.id) ? 'checked' : ''} /></td>
      <td class="col-file" title="${escapeHtml(filename)}">
        ${canRetrieve
          ? `<a href="#" data-id="${inv.id}" data-act="view" class="file-link">${escapeHtml(shortName)}</a>`
          : `<span class="file-link">${escapeHtml(shortName)}</span>`}
      </td>
      <td class="col-supplier">${escapeHtml(supplier ? supplier.name : (inv.supplier_name_hint || '—'))}</td>
      <td class="col-afm mono">${inv.afm || '—'}</td>
      <td class="col-invno mono">${escapeHtml(inv.invoice_number || '—')}</td>
      <td class="col-date">${fmtDate(inv.invoice_date)}</td>
      <td class="col-sap mono">${inv.sap_doc_number || '—'}</td>
      <td class="col-sap-vendor mono" title="${escapeHtml(vendorLabel)}">${escapeHtml(truncateFilename(vendorLabel, 18))}</td>
      <td class="col-sap-status">${sapStatus ? `<span class="status-pill ${sapStatusClass(sapStatus)}">${SAP_STATUS_LABEL[sapStatus] || sapStatus}</span>` : '—'}</td>
      <td class="col-status"><span class="status-pill status-${inv.status}">${statusLabel(inv.status)}</span></td>
      <td class="col-actions">
        ${canRetrieve ? `
          <button class="btn btn-secondary btn-xs" data-id="${inv.id}" data-act="view" title="Άνοιγμα PDF">View</button>
          <button class="btn btn-ghost btn-xs" data-id="${inv.id}" data-act="download" title="Λήψη">⬇</button>
        ` : ''}
        ${!isArchived ? `<button class="btn btn-ghost btn-xs" data-id="${inv.id}" data-act="del">Διαγραφή</button>` : ''}
      </td>
  `;
}

/** Groups filtered invoices by SAP Vendor and renders a header summary row
 *  per vendor followed by its invoice rows — never combines totals across
 *  different currencies (Phase 13). */
function renderGroupedByVendor(tbody, rows) {
  const groups = new Map(); // key: sapVendorCode|UNMATCHED -> { code, name, invoices: [] }
  for (const inv of rows) {
    const prep = getSapPrep(inv);
    const code = prep?.supplierMatchStatus?.sapVendorCode || null;
    const key = code || `UNMATCHED:${inv.supplier_name_hint || inv.afm || inv.id}`;
    if (!groups.has(key)) {
      groups.set(key, { code, name: prep?.supplierMatchStatus?.sapVendorName || inv.supplier_name_hint || null, invoices: [] });
    }
    groups.get(key).invoices.push(inv);
  }

  const sorted = [...groups.values()].sort((a, b) => (a.code || 'zzz').localeCompare(b.code || 'zzz'));

  for (const group of sorted) {
    const byCurrency = new Map(); // currency -> { count, net, vat, gross, ready, review, error }
    for (const inv of group.invoices) {
      const cur = inv.currency || '—';
      if (!byCurrency.has(cur)) byCurrency.set(cur, { count: 0, net: 0, vat: 0, gross: 0, ready: 0, review: 0, error: 0 });
      const agg = byCurrency.get(cur);
      agg.count++;
      agg.net += Number(inv.net_amount) || 0;
      agg.vat += Number(inv.vat_amount) || 0;
      agg.gross += Number(inv.total_amount) || 0;
      const prep = getSapPrep(inv);
      const status = prep?.sapPreparationStatus;
      if (status === SAP_PREP_STATUS.SAP_READY) agg.ready++;
      else if (status === SAP_PREP_STATUS.BLOCKED_DUPLICATE) agg.error++;
      else agg.review++;
    }

    const summaryHtml = [...byCurrency.entries()].map(([cur, agg]) =>
      `<span class="vendor-group-currency">${cur}: ${agg.count} τιμ. · Καθαρή ${agg.net.toFixed(2)} · ΦΠΑ ${agg.vat.toFixed(2)} · Σύνολο ${agg.gross.toFixed(2)} · ✓${agg.ready} ⚠${agg.review} ✕${agg.error}</span>`
    ).join(' &nbsp;|&nbsp; ');

    const headerTr = document.createElement('tr');
    headerTr.className = 'vendor-group-row';
    headerTr.innerHTML = `<td colspan="11">
      <strong>${escapeHtml(group.code || 'ΑΝΤΙΣΤΟΙΧΙΣΗ ΕΚΚΡΕΜΕΙ')}${group.name ? ' — ' + escapeHtml(group.name) : ''}</strong>
      &nbsp;·&nbsp; ${summaryHtml}
    </td>`;
    tbody.appendChild(headerTr);

    for (const inv of group.invoices) {
      const tr = document.createElement('tr');
      tr.dataset.id = inv.id;
      tr.className = 'vendor-group-child';
      tr.innerHTML = invoiceRowHtml(inv);
      tbody.appendChild(tr);
    }
  }
}

export function renderInvoices() {
  const tbody = $('#invoices-table tbody');
  if (!tbody) return;
  _sapPrepCache = new Map();
  tbody.innerHTML = '';
  refreshCurrencyFilterOptions();
  const rows = getFilteredRows();
  const selectAll = $('#invoice-select-all');
  const groupToggle = $('#btn-toggle-vendor-grouping');
  if (groupToggle) groupToggle.classList.toggle('btn-primary', groupByVendor);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-row">Δεν υπάρχουν εγγραφές. Ανεβάστε ένα PDF ή αλλάξτε τα φίλτρα.</td></tr>';
    if (selectAll) selectAll.checked = false;
    updateBulkBar();
    return;
  }

  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every(r => selectedIds.has(r.id));
    selectAll.indeterminate = rows.some(r => selectedIds.has(r.id)) && !selectAll.checked;
  }

  if (groupByVendor) {
    renderGroupedByVendor(tbody, rows);
  } else {
    for (const inv of rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = inv.id;
      tr.innerHTML = invoiceRowHtml(inv);
      tbody.appendChild(tr);
    }
  }

  tbody.querySelectorAll('.invoice-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.id, 10);
      if (cb.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateBulkBar();
      const all = getFilteredRows();
      if (selectAll) {
        selectAll.checked = all.length > 0 && all.every(r => selectedIds.has(r.id));
        selectAll.indeterminate = all.some(r => selectedIds.has(r.id)) && !selectAll.checked;
      }
    });
  });

  tbody.querySelectorAll('[data-act="del"]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!confirm('Διαγραφή τιμολογίου;')) return;
      const id = parseInt(b.dataset.id, 10);
      state.invoices = state.invoices.filter(i => i.id !== id);
      selectedIds.delete(id);
      audit('delete', 'success', `Deleted invoice ${id}`, { actor: 'user' });
      updateReviewBadge();
      renderInvoices();
    });
  });
  tbody.querySelectorAll('[data-act="view"]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      viewArchivedPdf(parseInt(b.dataset.id, 10));
    });
  });
  tbody.querySelectorAll('[data-act="download"]').forEach((b) => {
    b.addEventListener('click', () => downloadArchivedPdf(parseInt(b.dataset.id, 10)));
  });
  updateBulkBar();
}

function getSelectedIds() {
  return [...selectedIds];
}

async function bulkDelete() {
  const ids = getSelectedIds();
  if (!ids.length) return;
  const deletable = ids.filter(id => {
    const inv = state.invoices.find(i => i.id === id);
    return inv && inv.status !== 'archived';
  });
  if (!deletable.length) {
    toast('Δεν μπορούν να διαγραφούν αρχειοθετημένα τιμολόγια', 'err');
    return;
  }
  if (!confirm(`Διαγραφή ${deletable.length} τιμολογίων;`)) return;
  const set = new Set(deletable);
  state.invoices = state.invoices.filter(i => !set.has(i.id));
  deletable.forEach(id => selectedIds.delete(id));
  audit('delete', 'success', `Bulk deleted ${deletable.length} invoices`, { actor: 'user' });
  updateReviewBadge();
  renderInvoices();
  toast(`Διαγράφηκαν ${deletable.length} εγγραφές`, 'ok');
}

function bulkArchive() {
  const ids = getSelectedIds();
  const review = ids.filter(id => state.invoices.find(i => i.id === id)?.status === 'needs_review');
  if (!review.length) {
    toast('Επιλέξτε τιμολόγια «Χρειάζεται έλεγχο» — η αρχειοθέτηση γίνεται από την οθόνη Ανέβασμα', 'err');
    return;
  }
  toast(`Άνοιξε ${review.length} τιμολόγιο/α από την οθόνη Ανέβασμα για αρχειοθέτηση`, 'ok');
}

function bulkMerge() {
  toast('Η συγχώνευση PDF γίνεται από την οθόνη Ανέβασμα (drag & drop πολλαπλά αρχεία)', 'ok');
}

function bulkMove() {
  toast('Η μετακίνηση φακέλου απαιτεί σύνδεση με τον δίσκο αρχείων — χρησιμοποιήστε την οθόνη Αρχείο', 'ok');
}

/** "Prepare for SAP" (Phase 12) — explicitly NOT "Post to SAP". Only ever
 *  stamps FinanceOS-local metadata; never contacts SAP in any way. Only
 *  allowed for the subset of the current selection that is SAP_READY. */
function bulkPrepareForSap() {
  const ids = getSelectedIds();
  if (!ids.length) { toast('Επιλέξτε τουλάχιστον ένα τιμολόγιο', 'err'); return; }
  const invoices = ids.map((id) => state.invoices.find((i) => i.id === id)).filter(Boolean);
  const ready = invoices.filter((inv) => getSapPrep(inv)?.sapPreparationStatus === SAP_PREP_STATUS.SAP_READY);
  const notReady = invoices.length - ready.length;

  const blockedByDuplicate = invoices.filter((inv) => getSapPrep(inv)?.sapPreparationStatus === SAP_PREP_STATUS.BLOCKED_DUPLICATE);
  if (blockedByDuplicate.length) {
    audit('duplicate_detected', 'warning',
      `${blockedByDuplicate.length} επιλεγμένο(α) τιμολόγιο(α) μπλοκαρίστηκαν από «Prepare for SAP» λόγω επιβεβαιωμένου διπλότυπου`,
      { actor: 'user', details: { invoiceIds: blockedByDuplicate.map((i) => i.id) } });
  }

  if (!ready.length) {
    toast('Κανένα από τα επιλεγμένα δεν είναι SAP READY — ελέγξτε προμηθευτή/ποσά/διπλότυπα πρώτα', 'err');
    return;
  }
  const now = new Date().toISOString();
  for (const inv of ready) {
    inv.sap_prepared_at = now;
    inv.sap_prepared_by = state.currentUser || 'anonymous';
  }
  audit('sap_ready', 'success', `Prepared ${ready.length} invoice(s) for SAP${notReady ? ` (${notReady} skipped — not SAP_READY)` : ''}`,
    { actor: 'user', details: { invoiceIds: ready.map((i) => i.id) } });
  scheduleSave();
  renderInvoices();
  toast(`✓ ${ready.length} τιμολόγια προετοιμάστηκαν για SAP${notReady ? ` (${notReady} παραλείφθηκαν)` : ''} — δεν έγινε καταχώρηση στο SAP`, 'ok');
}

export function initInvoices() {
  $('#invoice-filter')?.addEventListener('change', renderInvoices);
  $('#invoice-search')?.addEventListener('input', renderInvoices);
  $('#invoice-filter-workflow')?.addEventListener('change', renderInvoices);
  $('#invoice-filter-currency')?.addEventListener('change', renderInvoices);
  $('#invoice-filter-sap-vendor')?.addEventListener('input', renderInvoices);
  $('#btn-toggle-vendor-grouping')?.addEventListener('click', () => {
    groupByVendor = !groupByVendor;
    renderInvoices();
  });
  $('#btn-export-excel')?.addEventListener('click', () => exportArchivedToExcel());
  $('#btn-export-sap-ready')?.addEventListener('click', () => exportSapReadyInvoices());
  $('#invoice-select-all')?.addEventListener('change', (e) => toggleSelectAll(e.target.checked));
  $('#btn-bulk-prepare-sap')?.addEventListener('click', bulkPrepareForSap);
  $('#btn-bulk-excel')?.addEventListener('click', () => {
    const ids = getSelectedIds();
    if (!ids.length) { toast('Επιλέξτε τουλάχιστον ένα τιμολόγιο', 'err'); return; }
    exportInvoicesToExcel(ids);
  });
  $('#btn-bulk-pdf')?.addEventListener('click', async () => {
    const ids = getSelectedIds();
    if (!ids.length) { toast('Επιλέξτε τουλάχιστον ένα τιμολόγιο', 'err'); return; }
    await exportInvoicesToPdfZip(ids);
  });
  $('#btn-bulk-delete')?.addEventListener('click', bulkDelete);
  $('#btn-bulk-archive')?.addEventListener('click', bulkArchive);
  $('#btn-bulk-merge')?.addEventListener('click', bulkMerge);
  $('#btn-bulk-move')?.addEventListener('click', bulkMove);
}

// ═══════════════════════════════════════════════════════════
