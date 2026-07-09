/** Unified upload engine — drag, paste, file pick, merge, cloud stubs */
import { $, toast } from './utils.js';
import { mergePdfFiles } from './pdf-tools.js';
import { enqueueFiles } from './queue-manager.js';

const CLOUD_SOURCES = [
  { id: 'scanner', label: 'Scanner', icon: '🖨', hint: 'TWAIN/WIA — απαιτεί desktop agent' },
  { id: 'camera', label: 'Κάμερα', icon: '📷', hint: 'Σκανάρισμα από κινητό — σύντομα' },
  { id: 'email', label: 'Email', icon: '✉', hint: 'Import από email — σύντομα' },
  { id: 'outlook', label: 'Outlook', icon: '📧', hint: 'Microsoft Graph — σύντομα' },
  { id: 'gmail', label: 'Gmail', icon: '📬', hint: 'Gmail API — σύντομα' },
  { id: 'onedrive', label: 'OneDrive', icon: '☁', hint: 'OneDrive picker — σύντομα' },
  { id: 'gdrive', label: 'Google Drive', icon: '📁', hint: 'Google Picker — σύντομα' },
  { id: 'dropbox', label: 'Dropbox', icon: '📦', hint: 'Dropbox Chooser — σύντομα' },
];

let _onFilesCallback = null;
let _mergeSelection = [];

export function initUploadEngine({ onFiles, onMergeReady } = {}) {
  _onFilesCallback = onFiles;
  renderSourceToolbar();
  bindPaste();
  bindMergeUI(onMergeReady);
}

function renderSourceToolbar() {
  const bar = $('#upload-sources');
  if (!bar) return;
  bar.innerHTML = `
    <button type="button" class="upload-src-btn is-active" data-src="files" title="Αρχεία / Drag & Drop">
      <span class="upload-src-icon">📂</span><span>Αρχεία</span>
    </button>
    <button type="button" class="upload-src-btn" data-src="paste" title="Ctrl+V">
      <span class="upload-src-icon">📋</span><span>Paste</span>
    </button>
    <button type="button" class="upload-src-btn" data-src="merge" title="Merge PDFs">
      <span class="upload-src-icon">🔗</span><span>Merge PDF</span>
    </button>
    ${CLOUD_SOURCES.map((s) => `
      <button type="button" class="upload-src-btn upload-src-btn--cloud" data-src="${s.id}" title="${s.hint}">
        <span class="upload-src-icon">${s.icon}</span><span>${s.label}</span>
      </button>
    `).join('')}
  `;
  bar.querySelectorAll('.upload-src-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleSourceClick(btn.dataset.src));
  });
}

function handleSourceClick(src) {
  if (src === 'files') {
    $('#file-input')?.click();
    return;
  }
  if (src === 'paste') {
    toast('Πάτα Ctrl+V για επικόλληση εικόνας/PDF', 'ok');
    return;
  }
  if (src === 'merge') {
    openMergeDialog();
    return;
  }
  const cloud = CLOUD_SOURCES.find((c) => c.id === src);
  toast(`${cloud?.label || src}: ${cloud?.hint || 'Σύντομα διαθέσιμο'}`, 'warn');
}

function bindPaste() {
  document.addEventListener('paste', async (e) => {
    const uploadView = $('#view-upload');
    if (!uploadView?.classList.contains('is-active')) return;
    const items = Array.from(e.clipboardData?.items || []);
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    toast(`Paste: ${files.length} αρχείο(α)`, 'ok');
    deliverFiles(files, 'clipboard');
  });
}

function bindMergeUI(onMergeReady) {
  $('#btn-merge-pdfs')?.addEventListener('click', openMergeDialog);
  $('#btn-merge-confirm')?.addEventListener('click', async () => {
    const input = $('#merge-file-input');
    const files = Array.from(input?.files || _mergeSelection);
    if (files.length < 2) {
      toast('Επίλεξε τουλάχιστον 2 PDF', 'err');
      return;
    }
    try {
      const merged = await mergePdfFiles(files);
      $('#merge-dialog')?.close?.();
      toast(`Merge: ${files.length} → 1 PDF`, 'ok');
      if (onMergeReady) onMergeReady(merged);
      else deliverFiles([merged], 'merge');
    } catch (err) {
      toast(`Merge απέτυχε: ${err.message}`, 'err');
    }
  });
}

function openMergeDialog() {
  const dlg = $('#merge-dialog');
  if (dlg?.showModal) dlg.showModal();
  else $('#merge-file-input')?.click();
}

export function deliverFiles(files, source = 'upload') {
  if (!_onFilesCallback) {
    enqueueFiles(files, { source });
    return;
  }
  _onFilesCallback(files, { source });
}

export { CLOUD_SOURCES };
