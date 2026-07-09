/** Global keyboard shortcuts */
import { $, toast } from './utils.js';
import { state } from './state.js';

export function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;

    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      $('#btn-archive')?.click();
      return;
    }

    if (e.ctrlKey && e.key === 'ArrowRight') {
      e.preventDefault();
      navigateQueueItem(1);
      return;
    }
    if (e.ctrlKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateQueueItem(-1);
      return;
    }

    if (e.key === 'Enter' && !typing && $('#review') && !$('#review').hidden) {
      const fields = ['fld-supplier', 'fld-afm', 'fld-invno', 'fld-date', 'fld-sap-manual'];
      const active = document.activeElement?.id;
      const idx = fields.indexOf(active);
      if (idx >= 0 && idx < fields.length - 1) {
        e.preventDefault();
        $(`#${fields[idx + 1]}`)?.focus();
      }
    }
  });
}

function navigateQueueItem(dir) {
  const queue = state.batch?.queue;
  if (!queue?.length) return;
  const cur = queue.findIndex((q) => q.invoice_id === state.currentInvoiceId);
  const next = cur + dir;
  if (next < 0 || next >= queue.length) {
    toast(dir > 0 ? 'Τελευταίο αρχείο' : 'Πρώτο αρχείο', 'warn');
    return;
  }
  const item = queue[next];
  if (item?.idx !== undefined) {
    import('./upload.js').then((m) => m.openBatchItemForReview?.(item.idx));
  }
}
