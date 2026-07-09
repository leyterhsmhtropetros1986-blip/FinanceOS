/** Persistence: IndexedDB, File System Access, shared JSON */
import { state } from './state.js';
import { $, toast, escapeHtml } from './utils.js';
import { audit } from './audit.js';
import { renderSuppliers } from './suppliers.js';
import { renderInvoices } from './invoices.js';
import { renderAudit } from './audit.js';
import { updateReviewBadge } from './badges.js';
import { updateEngineStatus } from './settings.js';

let _sharedSaveTimer;
let _saveTimer;

// SHARED STATE — αποθήκευση στο archive root ώστε να το δουν κι άλλοι χρήστες
// ═══════════════════════════════════════════════════════════
export function scheduleSharedSave() {
  clearTimeout(_sharedSaveTimer);
  _sharedSaveTimer = setTimeout(() => saveStateToArchiveRoot(), 2000);
}

export async function saveStateToArchiveRoot() {
  if (!state.archiveRoot.handle) return;
  try {
    const ok = await verifyPermission(state.archiveRoot.handle, 'readwrite');
    if (!ok) return;
    // Δημιούργησε hidden metadata folder .parastatika/ μέσα στο archive root
    const metaDir = await state.archiveRoot.handle.getDirectoryHandle('.parastatika', { create: true });
    await writeJsonToDir(metaDir, 'suppliers.json', state.suppliers);
    await writeJsonToDir(metaDir, 'invoices.json', state.invoices);
    await writeJsonToDir(metaDir, 'audit.json', state.auditLogs.slice(0, 5000));
    await writeJsonToDir(metaDir, 'meta.json', {
      lastUpdated: new Date().toISOString(),
      lastUpdatedBy: state.currentUser || 'anonymous',
      counters: { nextInvoiceId: state.nextInvoiceId, nextAuditId: state.nextAuditId },
      version: 1,
    });
    console.log('✓ State saved to archive root');
  } catch (e) {
    console.warn('Shared save failed:', e);
  }
}

export async function writeJsonToDir(dir, name, data) {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

export async function readJsonFromDir(dir, name) {
  try {
    const fh = await dir.getFileHandle(name, { create: false });
    const file = await fh.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch (e) { return null; }
}

export async function loadStateFromArchiveRoot() {
  if (!state.archiveRoot.handle) return null;
  try {
    const metaDir = await state.archiveRoot.handle.getDirectoryHandle('.parastatika', { create: false });
    const [suppliers, invoices, auditLogs, meta] = await Promise.all([
      readJsonFromDir(metaDir, 'suppliers.json'),
      readJsonFromDir(metaDir, 'invoices.json'),
      readJsonFromDir(metaDir, 'audit.json'),
      readJsonFromDir(metaDir, 'meta.json'),
    ]);
    return { suppliers, invoices, auditLogs, meta };
  } catch (e) {
    console.log('No shared state in archive root (πρώτη χρήση)');
    return null;
  }
}

export async function reloadFromShared() {
  if (!state.archiveRoot.handle) {
    toast('Δεν έχει επιλεγεί ριζικός φάκελος', 'err');
    return;
  }
  toast('Ανάγνωση κοινών δεδομένων…', 'ok');
  const shared = await loadStateFromArchiveRoot();
  if (!shared) {
    toast('Δεν βρέθηκαν κοινά δεδομένα', 'err');
    return;
  }
  let merged = 0;
  if (Array.isArray(shared.suppliers)) {
    state.suppliers = shared.suppliers;
    merged += shared.suppliers.length;
  }
  if (Array.isArray(shared.invoices)) {
    state.invoices = shared.invoices;
    merged += shared.invoices.length;
  }
  if (Array.isArray(shared.auditLogs)) state.auditLogs = shared.auditLogs;
  if (shared.meta?.counters) {
    state.nextInvoiceId = Math.max(state.nextInvoiceId, shared.meta.counters.nextInvoiceId || 1);
    state.nextAuditId = Math.max(state.nextAuditId, shared.meta.counters.nextAuditId || 1);
  }
  renderSuppliers(); renderInvoices(); renderAudit(); updateReviewBadge();
  scheduleSave();
  toast(`✓ Συγχρονίστηκαν ${merged} εγγραφές${shared.meta?.lastUpdatedBy ? ` (τελευταία αλλαγή: ${shared.meta.lastUpdatedBy})` : ''}`, 'ok');
}

// ═══════════════════════════════════════════════════════════

// USER IDENTIFICATION
// ═══════════════════════════════════════════════════════════
export function loadCurrentUser() {
  try { state.currentUser = localStorage.getItem('parastatika_user') || ''; }
  catch (e) { state.currentUser = ''; }
}
export function setCurrentUser(name) {
  state.currentUser = name.trim();
  try { localStorage.setItem('parastatika_user', state.currentUser); } catch (e) {}
  updateEngineStatus();
}
export function promptForUser() {
  const name = prompt('Πώς σε λένε; (για να καταγράφεται ποιος αρχειοθέτησε κάθε τιμολόγιο)', state.currentUser || '');
  if (name && name.trim()) setCurrentUser(name.trim());
}

state.archiveRoot = { handle: null, name: null };

// Cache: SAP code → πραγματικό όνομα φακέλου (αν υπάρχει ήδη ή default)
state.folderCache = new Map();

export const FS_SUPPORTED = typeof window.showDirectoryPicker === 'function';

/**
 * Ψάχνει αν υπάρχει ήδη φάκελος για τον προμηθευτή (matching by SAP code prefix)
 * και τον χρησιμοποιεί. Αλλιώς επιστρέφει το default όνομα.
 *
 * Παράδειγμα: αν υπάρχει ήδη "314070-DHL" και προσπαθούμε να αρχειοθετήσουμε
 * σε "314070-DHL_EXPRESS", θα εντοπίσει και θα χρησιμοποιήσει το "314070-DHL".
 */
export async function resolveSupplierFolder(sapCode, defaultName) {
  if (!state.archiveRoot.handle || !sapCode) return defaultName;
  // Cache hit
  if (state.folderCache.has(sapCode)) return state.folderCache.get(sapCode);
  // Σκανάρισε τον root για υπάρχοντες φακέλους με ίδιο SAP prefix
  const prefix = `${sapCode}-`;
  try {
    for await (const [name, entry] of state.archiveRoot.handle.entries()) {
      if (entry.kind === 'directory' && name.startsWith(prefix)) {
        console.log(`↻ Επαναχρησιμοποίηση φακέλου "${name}" για SAP ${sapCode}`);
        state.folderCache.set(sapCode, name);
        return name;
      }
    }
  } catch (e) {
    console.warn('Folder scan failed:', e);
  }
  // Δεν υπάρχει → cache default
  state.folderCache.set(sapCode, defaultName);
  return defaultName;
}

export function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('parastatika', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function idbSaveHandle(handle) {
  try {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'archiveRoot');
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('IDB save failed:', e); }
}
export async function idbLoadHandle() {
  try {
    const db = await idbOpen();
    return new Promise((res) => {
      const tx = db.transaction('handles', 'readonly');
      const gr = tx.objectStore('handles').get('archiveRoot');
      gr.onsuccess = () => res(gr.result || null);
      gr.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
export async function idbClearHandle() {
  try {
    const db = await idbOpen();
    return new Promise((res) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').delete('archiveRoot');
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch (e) {}
}

// ─── State persistence (suppliers, invoices, audit) ────
export function idbKvGet(store, key) {
  return new Promise((res) => {
    const req = store.get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => res(null);
  });
}
export async function idbSaveState() {
  try {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      const s = tx.objectStore('kv');
      s.put(state.suppliers, 'suppliers');
      s.put(state.invoices, 'invoices');
      s.put(state.auditLogs.slice(0, 2000), 'auditLogs');  // cap 2000
      s.put({ nextInvoiceId: state.nextInvoiceId, nextAuditId: state.nextAuditId }, 'counters');
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('State save failed:', e); }
}
export async function idbLoadState() {
  try {
    const db = await idbOpen();
    return new Promise((res) => {
      const tx = db.transaction('kv', 'readonly');
      const s = tx.objectStore('kv');
      Promise.all([
        idbKvGet(s, 'suppliers'),
        idbKvGet(s, 'invoices'),
        idbKvGet(s, 'auditLogs'),
        idbKvGet(s, 'counters'),
      ]).then(([sup, inv, aud, cnt]) => {
        if (Array.isArray(sup) && sup.length) state.suppliers = sup;
        if (Array.isArray(inv)) state.invoices = inv;
        if (Array.isArray(aud)) state.auditLogs = aud;
        if (cnt) {
          state.nextInvoiceId = cnt.nextInvoiceId || state.nextInvoiceId;
          state.nextAuditId = cnt.nextAuditId || state.nextAuditId;
        }
        res({ sup: sup?.length || 0, inv: inv?.length || 0, aud: aud?.length || 0 });
      });
    });
  } catch (e) { console.warn('State load failed:', e); return null; }
}

// Debounced auto-save μετά από κάθε mutation
export function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => idbSaveState(), 500);
}

export async function verifyPermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const options = { mode };
  try {
    if ((await handle.queryPermission(options)) === 'granted') return true;
    if ((await handle.requestPermission(options)) === 'granted') return true;
  } catch (e) {}
  return false;
}

export async function pickArchiveRoot() {
  if (!FS_SUPPORTED) {
    alert('Ο browser σου δεν υποστηρίζει File System Access API.\n\nΧρησιμοποίησε Chrome ή Edge για αυτή τη λειτουργία.\n\nΣτο μεταξύ, χρησιμοποίησε το κουμπί "Download ZIP" για μαζικό κατέβασμα.');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents',
    });
    const ok = await verifyPermission(handle, 'readwrite');
    if (!ok) { toast('Δεν έχω άδεια γραφής στον φάκελο', 'err'); return; }
    state.archiveRoot = { handle, name: handle.name };
    state.folderCache.clear();
    await idbSaveHandle(handle);
    updateArchiveRootDisplay();
    toast(`✓ Ριζικός φάκελος: ${handle.name}`, 'ok');
    updateEngineStatus();
    renderInvoices();
  } catch (e) {
    if (e.name === 'AbortError') return;   // ο χρήστης έκανε cancel — μη show error

    // Sandboxed context — το αρχείο είναι μαρκαρισμένο ως «unsafe»
    if (e.message && e.message.includes('Sandbox')) {
      showSandboxInstructions();
      return;
    }
    toast('Σφάλμα: ' + e.message, 'err');
  }
}

export function showSandboxInstructions() {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(31,27,21,0.5);z-index:2000;display:grid;place-items:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--r-lg);max-width:600px;width:100%;padding:32px;box-shadow:var(--shadow-lg);">
      <div style="font-family:var(--font-display);font-size:22px;font-weight:600;color:var(--text);margin-bottom:8px;">
        ⚠ Windows μπλόκαρε το αρχείο
      </div>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:20px;line-height:1.7;">
        Το Windows σου έβαλε «Mark of the Web» σε αυτό το HTML γιατί το έλαβες από email/chat.
        Χρειάζεται να το ξεμπλοκάρεις. Ακολούθησε τα βήματα:
      </div>

      <div style="background:var(--bg-sunken);padding:18px;border-radius:var(--r-md);margin-bottom:16px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:12px;">✅ Λύση (30 δευτερόλεπτα):</div>
        <ol style="margin:0 0 0 22px;font-size:13px;line-height:1.9;color:var(--text);">
          <li>Κλείσε αυτό το tab</li>
          <li>Άνοιξε το <strong>File Explorer</strong> και βρες το <code style="background:var(--surface);padding:2px 6px;border-radius:4px;font-family:var(--font-mono);font-size:11px;">parastatika-demo.html</code></li>
          <li><strong>Δεξί-κλικ</strong> → <strong>Properties</strong></li>
          <li>Κάτω-κάτω τσέκαρε το <strong>«Unblock»</strong> ή <strong>«Ξεμπλοκάρισμα»</strong></li>
          <li>Πάτα <strong>OK</strong></li>
          <li>Ξανα-άνοιξε το HTML με διπλό-κλικ</li>
        </ol>
      </div>

      <div style="background:var(--accent-soft);padding:14px 18px;border-radius:var(--r-md);margin-bottom:20px;font-size:12px;color:var(--text);border-left:3px solid var(--accent);">
        <strong>Εναλλακτικά:</strong> μετακίνησε το αρχείο σε <strong>C:\\Users\\[εσύ]\\Documents\\</strong> και ξανα-άνοιξέ το από εκεί (μερικές φορές αυτό αρκεί).
      </div>

      <div style="background:var(--warn-soft);padding:14px 18px;border-radius:var(--r-md);margin-bottom:20px;font-size:12px;color:var(--text);border-left:3px solid var(--warn);">
        <strong>Αν δεν βλέπεις το «Unblock»</strong>: σημαίνει ότι το Windows δεν το έχει μπλοκάρει, αλλά ο browser σου τρέχει σε enterprise sandbox. Δοκίμασε <strong>Chrome</strong> (όχι Edge), ή ζήτησε από τον IT administrator να απενεργοποιήσει το «Attachment Manager».
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px;">
        <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">Κατάλαβα</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

export async function clearArchiveRoot() {
  state.archiveRoot = { handle: null, name: null };
  state.folderCache.clear();
  await idbClearHandle();
  updateArchiveRootDisplay();
  toast('Ριζικός φάκελος καθαρίστηκε', 'ok');
  updateEngineStatus();
  renderInvoices();
}

export function updateArchiveRootDisplay() {
  const el = $('#archive-root-display');
  if (!el) return;
  if (state.archiveRoot.handle) {
    el.innerHTML = `📁 <strong>${escapeHtml(state.archiveRoot.name)}</strong> <span style="color:var(--ok);font-size:11px;margin-left:8px;">✓ ενεργό</span>`;
  } else {
    el.innerHTML = FS_SUPPORTED
      ? '<span style="color:var(--text-muted);">— δεν έχει επιλεγεί —</span>'
      : '<span style="color:var(--warn);">Ο browser δεν υποστηρίζει (χρειάζεται Chrome/Edge)</span>';
  }
}

export async function writeToDisk(supplierFolder, filename, bytes) {
  if (!state.archiveRoot.handle) throw new Error('Δεν έχει επιλεγεί ριζικός φάκελος');
  const ok = await verifyPermission(state.archiveRoot.handle, 'readwrite');
  if (!ok) throw new Error('Δεν υπάρχει άδεια γραφής');

  // Δημιούργησε τον υπο-φάκελο προμηθευτή αν δεν υπάρχει
  const supplierDir = await state.archiveRoot.handle.getDirectoryHandle(supplierFolder, { create: true });

  // Αν υπάρχει ήδη αρχείο με ίδιο όνομα → DUPLICATE, μην το αντικαθιστάς
  if (await fileExists(supplierDir, filename)) {
    const err = new Error(`Duplicate: ${filename} υπάρχει ήδη στον δίσκο`);
    err.code = 'DUPLICATE';
    throw err;
  }

  const fileHandle = await supplierDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return { finalName: filename, fullPath: `${state.archiveRoot.name}/${supplierFolder}/${filename}` };
}

export async function fileExists(dirHandle, filename) {
  try {
    await dirHandle.getFileHandle(filename, { create: false });
    return true;
  } catch (e) { return false; }
}

/**
 * Ψάχνει αν υπάρχει ήδη αρχειοθετημένο τιμολόγιο με ίδιο supplier+invoice_number(+SAP).
 * Επιστρέφει το invoice record ή null.
 */
export function findDuplicateInvoice(supplierId, invoiceNumber, sapDocNumber) {
  if (!invoiceNumber && !sapDocNumber) return null;
  const normInv = String(invoiceNumber || '').trim();
  const normSap = String(sapDocNumber || '').replace(/\D/g, '');
  return state.invoices.find(inv => {
    if (inv.status !== 'archived') return false;
    if (supplierId && inv.supplier_id !== supplierId) return false;
    const iInv = String(inv.invoice_number || '').trim();
    const iSap = String(inv.sap_doc_number || '').replace(/\D/g, '');
    // Match αν είναι ίδιο invoice number Ή ίδιο SAP doc
    return (normInv && iInv === normInv) || (normSap && iSap === normSap);
  });
}

// ═══════════════════════════════════════════════════════════

// PDF SPLITTING — για unmerge πολλαπλών τιμολογίων σε ένα PDF
// ═══════════════════════════════════════════════════════════
export async function splitPdfByPages(pdfBytes, pageStart, pageEnd) {
  if (typeof PDFLib === 'undefined') throw new Error('pdf-lib δεν φόρτωσε');
  const { PDFDocument } = PDFLib;
  const srcDoc = await PDFDocument.load(pdfBytes);
  const newDoc = await PDFDocument.create();
  const total = srcDoc.getPageCount();
  const start = Math.max(1, pageStart);
  const end = Math.min(total, pageEnd);
  const indices = [];
  for (let i = start; i <= end; i++) indices.push(i - 1);  // 0-indexed
  const pages = await newDoc.copyPages(srcDoc, indices);
  pages.forEach(p => newDoc.addPage(p));
  return await newDoc.save();
}

// ═══════════════════════════════════════════════════════════

state.archivedFiles = new Map();  // filename → {bytes, folderPath}

export function storeArchivedFile(folderPath, filename, bytes) {
  const key = `${folderPath}/${filename}`;
  state.archivedFiles.set(key, { folderPath, filename, bytes });
}

export async function downloadArchiveZip() {
  if (typeof JSZip === 'undefined') { toast('JSZip δεν φόρτωσε', 'err'); return; }
  if (state.archivedFiles.size === 0) { toast('Δεν υπάρχουν αρχειοθετημένα', 'err'); return; }
  const zip = new JSZip();
  for (const [key, { folderPath, filename, bytes }] of state.archivedFiles) {
    zip.file(`${folderPath}/${filename}`, bytes);
  }
  toast(`Δημιουργία ZIP με ${state.archivedFiles.size} αρχεία…`, 'ok');
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  a.download = `parastatika_archive_${ts}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  toast('ZIP κατεβαίνει!', 'ok');
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function downscaleCanvas(source, maxWidth) {
  if (source.width <= maxWidth) return source;
  const ratio = maxWidth / source.width;
  const target = document.createElement('canvas');
  target.width = maxWidth;
  target.height = Math.round(source.height * ratio);
  target.getContext('2d').drawImage(source, 0, 0, target.width, target.height);
  return target;
}

// ═══════════════════════════════════════════════════════════
