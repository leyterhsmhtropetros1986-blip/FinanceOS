/** FinanceOS application entry point */
import { $$ } from './utils.js';
import { loadSettings, applySettingsToUI, initSettings, updateEngineStatus } from './settings.js';
import { idbLoadState, idbLoadHandle, verifyPermission, updateArchiveRootDisplay, loadCurrentUser } from './storage.js';
import { seedSuppliers, renderSuppliers, initSuppliers } from './suppliers.js';
import { renderInvoices, initInvoices } from './invoices.js';
import { renderAudit, initAuditView } from './audit.js';
import { renderDashboard } from './dashboard.js';
import { initUpload } from './upload.js';
import { initSearch } from './search.js';
import { loadArchiveBrowser, initArchiveView } from './archive.js';
import { updateReviewBadge } from './badges.js';
import { state } from './state.js';
import { $, toast } from './utils.js';
import { warmupOcrWorker } from './ocr.js';

export function initNavigation() {
  // NAVIGATION
  // ═══════════════════════════════════════════════════════════
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b === btn));
      $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
      if (view === 'invoices') renderInvoices();
      if (view === 'suppliers') renderSuppliers();
      if (view === 'audit') renderAudit();
      if (view === 'archive') loadArchiveBrowser();
      if (view === 'dashboard') renderDashboard();
    });
  });
  
  
  
  // ═══════════════════════════════════════════════════════════
}

window.addEventListener('error', (e) => {
  console.error('Global error:', e.message, e.filename, e.lineno, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason);
});

// BOOT
// ═══════════════════════════════════════════════════════════

function checkEnvironment() {
  const isIframe = window !== window.top;
  const isSandbox = location.href.startsWith('about:srcdoc') ||
                    location.href.includes('claudeusercontent.com') ||
                    location.href.startsWith('blob:');
  if (isIframe || isSandbox) {
    console.warn('Running in iframe/sandbox — some features (File System Access, workers) may not work.');
    return true;
  }
  return false;
}

function checkLibraries() {
  const required = [
    { name: 'Tesseract.js', check: () => typeof Tesseract !== 'undefined' },
    { name: 'PDF.js',       check: () => typeof pdfjsLib !== 'undefined' },
    { name: 'SheetJS',      check: () => typeof XLSX !== 'undefined' },
    { name: 'JSZip',        check: () => typeof JSZip !== 'undefined' },
    { name: 'UTIF',         check: () => typeof UTIF !== 'undefined' },
    { name: 'pdf-lib',      check: () => typeof PDFLib !== 'undefined' },
  ];
  const optional = [
    { name: 'heic2any',     check: () => typeof heic2any !== 'undefined' },
  ];
  const missingReq = required.filter(l => !l.check());
  const missingOpt = optional.filter(l => !l.check());
  if (missingReq.length) console.error('Missing required libraries:', missingReq.map(l => l.name));
  else console.log('✓ Libraries loaded');
  if (missingOpt.length) console.warn('Optional libs missing:', missingOpt.map(l => l.name));
}

// Boot sequence — φόρτωση persisted state
async function boot() {
  // 1. Load settings from localStorage
  loadSettings();
  loadCurrentUser();

  // 2. Load state (suppliers, invoices, audit) from IndexedDB
  const loaded = await idbLoadState();
  if (loaded && (loaded.sup || loaded.inv || loaded.aud)) {
    console.log(`✓ Restored ${loaded.sup} suppliers, ${loaded.inv} invoices, ${loaded.aud} audit entries`);
  } else {
    seedSuppliers();
  }

  // 3. UI init
  applySettingsToUI();
  initSettings();
  initNavigation();
  initUpload();
  initInvoices();
  initSuppliers();
  initAuditView();
  initSearch();
  initArchiveView();

  // 4. Restore archive root handle
  const handle = await idbLoadHandle();
  if (handle) {
    const ok = await verifyPermission(handle, 'readwrite');
    if (ok) {
      state.archiveRoot = { handle, name: handle.name };
      updateArchiveRootDisplay();
      console.log('✓ Restored archive root:', handle.name);
    } else {
      console.warn('Archive root permission lost — χρειάζεται επανα-επιλογή');
      toast('Ο ριζικός φάκελος χρειάζεται επανα-επιβεβαίωση άδειας', 'warn');
    }
  }

  // 5. Render everything
  renderSuppliers();
  renderInvoices();
  renderAudit();
  renderDashboard();
  updateReviewBadge();
  updateEngineStatus();
  warmupOcrWorker();

  const isSandboxed = checkEnvironment();
  checkLibraries();
  // No noisy toasts on boot — silent if everything is fine
}

window.addEventListener('review-badge-update', updateReviewBadge);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot());
} else {
  boot();
}
