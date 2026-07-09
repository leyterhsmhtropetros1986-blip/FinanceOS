/** Invoices table view — search, bulk actions, responsive layout */
import { state } from './state.js';
import { $, toast, fmtDate, escapeHtml } from './utils.js';
import { audit } from './audit.js';
import { getFileHandleFromRelPath } from './storage.js';
import { exportInvoicesToExcel, exportInvoicesToPdfZip, exportArchivedToExcel } from './export.js';
import { updateReviewBadge } from './badges.js';
import { statusLabel } from './analytics.js';

const selectedIds = new Set();

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
  return state.invoices.filter(i =>
    (!status || i.status === status) && matchesSearch(i, query)
  );
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

export function renderInvoices() {
  const tbody = $('#invoices-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const rows = getFilteredRows();
  const selectAll = $('#invoice-select-all');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-row">Δεν υπάρχουν εγγραφές. Ανεβάστε ένα PDF ή αλλάξτε τα φίλτρα.</td></tr>';
    if (selectAll) selectAll.checked = false;
    updateBulkBar();
    return;
  }

  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every(r => selectedIds.has(r.id));
    selectAll.indeterminate = rows.some(r => selectedIds.has(r.id)) && !selectAll.checked;
  }

  for (const inv of rows) {
    const supplier = state.suppliers.find(s => s.id === inv.supplier_id);
    const isArchived = inv.status === 'archived';
    const canRetrieve = isArchived && inv.archived_path &&
      (state.archivedFiles.has(inv.archived_path) || state.archiveRoot.handle);
    const filename = inv.archived_filename || inv.original_filename || '—';
    const shortName = truncateFilename(filename);
    const tr = document.createElement('tr');
    tr.dataset.id = inv.id;
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="invoice-check" data-id="${inv.id}" ${selectedIds.has(inv.id) ? 'checked' : ''} /></td>
      <td class="col-file" title="${escapeHtml(filename)}">
        ${canRetrieve
          ? `<a href="#" data-id="${inv.id}" data-act="view" class="file-link">${escapeHtml(shortName)}</a>`
          : `<span class="file-link">${escapeHtml(shortName)}</span>`}
      </td>
      <td class="col-supplier">${escapeHtml(supplier ? supplier.name : '—')}</td>
      <td class="col-afm mono">${inv.afm || '—'}</td>
      <td class="col-invno mono">${escapeHtml(inv.invoice_number || '—')}</td>
      <td class="col-date">${fmtDate(inv.invoice_date)}</td>
      <td class="col-sap mono">${inv.sap_doc_number || '—'}</td>
      <td class="col-status"><span class="status-pill status-${inv.status}">${statusLabel(inv.status)}</span></td>
      <td class="col-actions">
        ${canRetrieve ? `
          <button class="btn btn-secondary btn-xs" data-id="${inv.id}" data-act="view" title="Άνοιγμα PDF">View</button>
          <button class="btn btn-ghost btn-xs" data-id="${inv.id}" data-act="download" title="Λήψη">⬇</button>
        ` : ''}
        ${!isArchived ? `<button class="btn btn-ghost btn-xs" data-id="${inv.id}" data-act="del">Διαγραφή</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
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

export function initInvoices() {
  $('#invoice-filter')?.addEventListener('change', renderInvoices);
  $('#invoice-search')?.addEventListener('input', renderInvoices);
  $('#btn-export-excel')?.addEventListener('click', () => exportArchivedToExcel());
  $('#invoice-select-all')?.addEventListener('change', (e) => toggleSelectAll(e.target.checked));
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
