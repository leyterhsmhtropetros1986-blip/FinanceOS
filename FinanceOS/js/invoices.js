/** Invoices table view */
import { state } from './state.js';
import { $, toast, fmtDate, escapeHtml } from './utils.js';
import { audit } from './audit.js';
import { getFileHandleFromRelPath } from './storage.js';
import { exportArchivedToExcel } from './export.js';
import { updateReviewBadge } from './badges.js';

// INVOICES VIEW
// ═══════════════════════════════════════════════════════════

// ─── View/Download αρχειοθετημένων PDF ──────────────────
export async function getArchivedPdfBytes(invoice) {
  if (!invoice || !invoice.archived_path) return null;
  // 1. In-memory cache
  const stored = state.archivedFiles.get(invoice.archived_path);
  if (stored) return stored.bytes;
  // 2. Fallback: διάβασε από το δίσκο μέσω File System Access API
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
  const status = $('#invoice-filter').value;
  const tbody = $('#invoices-table tbody');
  tbody.innerHTML = '';
  const rows = state.invoices.filter(i => !status || i.status === status);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-row">Δεν υπάρχουν εγγραφές. Ανεβάστε ένα PDF για να ξεκινήσετε.</td></tr>';
    return;
  }
  for (const inv of rows) {
    const supplier = state.suppliers.find(s => s.id === inv.supplier_id);
    const isArchived = inv.status === 'archived';
    const canRetrieve = isArchived && inv.archived_path &&
      (state.archivedFiles.has(inv.archived_path) || state.archiveRoot.handle);
    const archivedBy = inv.archived_by || '—';
    const archivedTip = inv.archived_at
      ? `${archivedBy} · ${new Date(inv.archived_at).toLocaleString('el-GR')}`
      : archivedBy;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${inv.id}</td>
      <td>
        ${canRetrieve
          ? `<a href="#" data-id="${inv.id}" data-act="view" style="color:var(--accent);text-decoration:none;font-weight:500;">${escapeHtml(inv.archived_filename)}</a>`
          : escapeHtml(inv.archived_filename || inv.original_filename)}
      </td>
      <td>${escapeHtml(supplier ? supplier.name : '—')}</td>
      <td class="mono">${inv.afm || '—'}</td>
      <td class="mono">${escapeHtml(inv.invoice_number || '—')}</td>
      <td>${fmtDate(inv.invoice_date)}</td>
      <td class="mono">${inv.sap_doc_number || '—'}</td>
      <td><span class="status-pill status-${inv.status}">${inv.status}</span></td>
      <td title="${escapeHtml(archivedTip)}" style="font-size:12px;color:var(--text-muted);">${escapeHtml(archivedBy)}</td>
      <td style="white-space:nowrap;">
        ${canRetrieve ? `
          <button class="btn btn-secondary" data-id="${inv.id}" data-act="view" title="Άνοιγμα PDF" style="padding:5px 10px;font-size:12px;">View</button>
          <button class="btn btn-ghost" data-id="${inv.id}" data-act="download" title="Λήψη">⬇</button>
        ` : ''}
        ${!isArchived ? `<button class="btn btn-ghost" data-id="${inv.id}" data-act="del">Διαγραφή</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-act="del"]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!confirm('Διαγραφή τιμολογίου;')) return;
      const id = parseInt(b.dataset.id);
      state.invoices = state.invoices.filter(i => i.id !== id);
      audit('delete', 'success', `Deleted invoice ${id}`, { actor: 'user' });
      updateReviewBadge();
      renderInvoices();
    });
  });
  tbody.querySelectorAll('[data-act="view"]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      viewArchivedPdf(parseInt(b.dataset.id));
    });
  });
  tbody.querySelectorAll('[data-act="download"]').forEach((b) => {
    b.addEventListener('click', () => downloadArchivedPdf(parseInt(b.dataset.id)));
  });
}

// ═══════════════════════════════════════════════════════════

export function initInvoices() {
  $('#invoice-filter')?.addEventListener('change', renderInvoices);
  $('#btn-export-excel')?.addEventListener('click', exportArchivedToExcel);
}
