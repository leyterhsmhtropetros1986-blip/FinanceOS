/** Enterprise Document Management — Archive browser */
import { state } from './state.js';
import { $, toast, escapeHtml, debounce, fmtDate } from './utils.js';
import { verifyPermission } from './storage.js';
import { getArchivedPdfBytes } from './invoices.js';

const LS_VIEW = 'financeos-archive-view';
const LS_PINNED = 'financeos-archive-pinned';
const LS_RECENT = 'financeos-archive-recent';
const LS_FAV_FOLDERS = 'financeos-archive-fav-folders';

state.archiveBrowserCache = null;
state.archiveIndex = null;
state.archiveUi = {
  view: localStorage.getItem(LS_VIEW) || 'grid',
  filters: {},
  sort: 'date-desc',
  selected: new Set(),
};

async function collectFilesRecursive(dirHandle, prefix) {
  const files = [];
  for await (const [fname, fhandle] of dirHandle.entries()) {
    if (fname.startsWith('.')) continue;
    const relPath = prefix ? `${prefix}/${fname}` : fname;
    if (fhandle.kind === 'file') {
      try {
        const file = await fhandle.getFile();
        files.push({ name: fname, relPath, size: file.size, modified: file.lastModified });
      } catch {
        files.push({ name: fname, relPath, size: 0, modified: 0 });
      }
    } else if (fhandle.kind === 'directory') {
      files.push(...await collectFilesRecursive(fhandle, relPath));
    }
  }
  return files;
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}
function saveJson(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function getSupplierName(id) {
  return state.suppliers.find((s) => s.id === id)?.name || '—';
}

function parseFilenameMeta(filename) {
  const m = filename.match(/^INV([^_]+)_([^_]+)_(\d{8})\.pdf$/i);
  if (!m) return { invoiceNo: null, sapDoc: null, date: null };
  const d = m[3];
  return {
    invoiceNo: m[1],
    sapDoc: m[2],
    date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
  };
}

/** Build unified document index from disk scan + invoice records */
export function buildArchiveIndex(cache) {
  const invoiceByPath = new Map();
  const invoiceByFilename = new Map();
  for (const inv of state.invoices) {
    if (inv.archived_filename) invoiceByFilename.set(inv.archived_filename, inv);
    if (inv.archived_path) {
      const parts = inv.archived_path.split('/');
      const fname = parts[parts.length - 1];
      const folder = parts.length > 1 ? parts[parts.length - 2] : '';
      invoiceByPath.set(`${folder}/${fname}`, inv);
    }
  }

  const docs = [];
  for (const folder of cache.folders) {
    for (const file of folder.files) {
      const key = `${folder.name}/${file.relPath || file.name}`;
      const inv = invoiceByPath.get(key) || invoiceByFilename.get(file.name);
      const parsed = parseFilenameMeta(file.name);
      const avgConf = inv ? Math.round(
        ((inv.confidence_afm || 0) + (inv.confidence_invoice_no || 0)
          + (inv.confidence_sap_doc || 0) + (inv.confidence_date || 0)) / 4
      ) : null;
      docs.push({
        id: key,
        folder: folder.name,
        filename: file.relPath || file.name,
        size: file.size,
        modified: file.modified,
        invoiceId: inv?.id || null,
        supplierId: inv?.supplier_id || null,
        supplierName: inv ? getSupplierName(inv.supplier_id) : folder.name.split('-').slice(1).join('-') || folder.name,
        invoiceNumber: inv?.invoice_number || parsed.invoiceNo,
        sapDocNumber: inv?.sap_doc_number || parsed.sapDoc,
        afm: inv?.afm || null,
        date: inv?.invoice_date || parsed.date,
        amount: inv?.total_amount || null,
        vat: inv?.vat_amount || null,
        currency: inv?.currency || 'EUR',
        status: inv?.status || 'archived',
        ocrConfidence: avgConf,
        archivedBy: inv?.archived_by || null,
        tags: [inv?.purchase_order, inv?.reference, inv?.container].filter(Boolean),
      });
    }
  }
  return docs;
}

function applyFilters(docs) {
  const f = state.archiveUi.filters;
  const q = (f.q || '').toLowerCase();
  return docs.filter((d) => {
    if (q && ![
      d.filename, d.folder, d.supplierName, d.invoiceNumber,
      d.sapDocNumber, d.afm, d.archivedBy,
    ].some((x) => String(x || '').toLowerCase().includes(q))) return false;
    if (f.supplier && d.supplierId !== parseInt(f.supplier, 10)) return false;
    if (f.status && d.status !== f.status) return false;
    if (f.year && d.date && !d.date.startsWith(f.year)) return false;
    if (f.month && d.date && d.date.slice(5, 7) !== f.month) return false;
    if (f.minConf && (d.ocrConfidence || 0) < parseInt(f.minConf, 10)) return false;
    if (f.sapPrefix && d.sapDocNumber && !String(d.sapDocNumber).startsWith(f.sapPrefix)) return false;
    return true;
  });
}

function sortDocs(docs) {
  const s = state.archiveUi.sort;
  const copy = [...docs];
  const cmp = (a, b) => {
    if (s === 'name-asc') return a.filename.localeCompare(b.filename);
    if (s === 'name-desc') return b.filename.localeCompare(a.filename);
    if (s === 'supplier') return (a.supplierName || '').localeCompare(b.supplierName || '');
    if (s === 'amount-desc') return (b.amount || 0) - (a.amount || 0);
    const da = new Date(a.date || a.modified || 0);
    const db = new Date(b.date || b.modified || 0);
    return s === 'date-asc' ? da - db : db - da;
  };
  return copy.sort(cmp);
}

function formatAmount(doc) {
  if (!doc.amount) return '—';
  return new Intl.NumberFormat('el-GR', {
    style: 'currency', currency: doc.currency || 'EUR',
  }).format(doc.amount);
}

function confClass(c) {
  if (c == null) return '';
  if (c >= 85) return 'ok';
  if (c >= 65) return 'warn';
  return 'err';
}

function pushRecent(doc) {
  const recent = loadJson(LS_RECENT, []).filter((r) => r.id !== doc.id);
  recent.unshift({ id: doc.id, filename: doc.filename, folder: doc.folder, at: Date.now() });
  saveJson(LS_RECENT, recent.slice(0, 20));
}

async function openDoc(doc, preview = false) {
  pushRecent(doc);
  try {
    if (doc.invoiceId) {
      const inv = state.invoices.find((i) => i.id === doc.invoiceId);
      const bytes = inv ? await getArchivedPdfBytes(inv) : null;
      if (bytes) {
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        if (preview) showPreview(doc, url);
        else window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
    }
    await openArchivedFileFromDisk(doc.folder, doc.filename, preview ? doc : null);
  } catch (e) {
    toast(`Δεν άνοιξε: ${e.message}`, 'err');
  }
}

function showPreview(doc, url) {
  const existing = $('#archive-preview-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'archive-preview-overlay';
  overlay.className = 'archive-preview-overlay';
  overlay.innerHTML = `
    <div class="archive-preview-panel">
      <div class="archive-preview-head">
        <div>
          <strong>${escapeHtml(doc.filename)}</strong>
          <div style="font-size:12px;color:var(--text-muted);">${escapeHtml(doc.supplierName)} · SAP ${escapeHtml(doc.sapDocNumber || '—')}</div>
        </div>
        <button class="btn btn-secondary" id="archive-preview-close">✕</button>
      </div>
      <div class="archive-preview-body">
        <iframe src="${url}" title="PDF preview"></iframe>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#archive-preview-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function renderStats(docs) {
  const el = $('#archive-stats');
  if (!el) return;
  const totalSize = docs.reduce((s, d) => s + (d.size || 0), 0);
  const suppliers = new Set(docs.map((d) => d.supplierName)).size;
  const avgConf = docs.filter((d) => d.ocrConfidence).length
    ? Math.round(docs.filter((d) => d.ocrConfidence).reduce((s, d) => s + d.ocrConfidence, 0) / docs.filter((d) => d.ocrConfidence).length)
    : '—';
  el.innerHTML = `
    <div class="archive-stat"><div class="archive-stat-label">Έγγραφα</div><div class="archive-stat-value">${docs.length}</div></div>
    <div class="archive-stat"><div class="archive-stat-label">Προμηθευτές</div><div class="archive-stat-value">${suppliers}</div></div>
    <div class="archive-stat"><div class="archive-stat-label">Αποθήκευση</div><div class="archive-stat-value">${(totalSize / 1048576).toFixed(1)} MB</div></div>
    <div class="archive-stat"><div class="archive-stat-label">Μέσο OCR</div><div class="archive-stat-value">${avgConf}${avgConf !== '—' ? '%' : ''}</div></div>`;
}

function renderQuickBar() {
  const el = $('#archive-quick-bar');
  if (!el) return;
  const pinned = loadJson(LS_PINNED, []);
  const recent = loadJson(LS_RECENT, []).slice(0, 8);
  const favFolders = loadJson(LS_FAV_FOLDERS, []);
  let html = '';
  for (const p of pinned) {
    html += `<button class="archive-chip is-pinned" data-pin-supplier="${escapeHtml(p)}">★ ${escapeHtml(p)}</button>`;
  }
  for (const f of favFolders) {
    html += `<button class="archive-chip" data-fav-folder="${escapeHtml(f)}">📁 ${escapeHtml(f)}</button>`;
  }
  for (const r of recent) {
    html += `<button class="archive-chip" data-recent="${escapeHtml(r.id)}">🕐 ${escapeHtml(r.filename)}</button>`;
  }
  el.innerHTML = html || '<span style="font-size:12px;color:var(--text-muted);">Δεν υπάρχουν πρόσφατα</span>';
  el.querySelectorAll('[data-recent]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const doc = state.archiveIndex?.find((d) => d.id === btn.dataset.recent);
      if (doc) openDoc(doc, true);
    });
  });
  el.querySelectorAll('[data-fav-folder]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.archiveUi.filters = { ...state.archiveUi.filters, q: btn.dataset.favFolder };
      const search = $('#archive-search');
      if (search) search.value = btn.dataset.favFolder;
      renderArchiveBrowser();
    });
  });
}

function renderGrid(docs) {
  const start = state.archiveUi._scrollStart || 0;
  const pageSize = 48;
  const slice = docs.slice(start, start + pageSize);
  return `
    <div class="archive-grid" id="archive-grid">
      ${slice.map((d) => `
        <article class="doc-card" data-id="${escapeHtml(d.id)}">
          <div class="doc-thumb">
            ${d.ocrConfidence != null ? `<span class="doc-conf-badge">${d.ocrConfidence}%</span>` : ''}
            <span class="doc-thumb-placeholder">📄</span>
          </div>
          <div class="doc-body">
            <div class="doc-supplier" title="${escapeHtml(d.supplierName)}">${escapeHtml(d.supplierName)}</div>
            <div class="doc-meta">
              <span class="mono">INV ${escapeHtml(d.invoiceNumber || '—')}</span><br>
              SAP <span class="mono">${escapeHtml(d.sapDocNumber || '—')}</span><br>
              ${d.date ? fmtDate(d.date) : '—'} · ${escapeHtml(d.status)}
            </div>
            <div class="doc-amount">${formatAmount(d)}${d.vat ? ` <span style="font-size:10px;color:var(--text-muted);">ΦΠΑ ${d.vat}</span>` : ''}</div>
            ${d.tags.length ? `<div class="doc-tags">${d.tags.map((t) => `<span class="doc-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="doc-actions">
            <button data-act="open" data-id="${escapeHtml(d.id)}">Άνοιγμα</button>
            <button data-act="preview" data-id="${escapeHtml(d.id)}">Preview</button>
            <button data-act="download" data-id="${escapeHtml(d.id)}">⬇</button>
          </div>
        </article>`).join('')}
    </div>
    ${docs.length > pageSize ? `<div style="text-align:center;padding:12px;"><button class="btn btn-secondary" id="archive-load-more">Φόρτωσε περισσότερα (${docs.length - start - pageSize} ακόμα)</button></div>` : ''}`;
}

function renderList(docs) {
  const start = state.archiveUi._scrollStart || 0;
  const pageSize = 80;
  const slice = docs.slice(start, start + pageSize);
  return `
    <div class="archive-list-scroll">
      <div class="archive-list">
        <div class="archive-list-header">
          <span></span><span>Αρχείο</span><span>Προμηθευτής</span><span>SAP Doc</span>
          <span>Ποσό</span><span>Ημερ.</span><span>OCR</span><span></span>
        </div>
        ${slice.map((d) => `
          <div class="archive-list-row" data-id="${escapeHtml(d.id)}">
            <span>📄</span>
            <span class="mono" style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(d.filename)}</span>
            <span>${escapeHtml(d.supplierName)}</span>
            <span class="mono">${escapeHtml(d.sapDocNumber || '—')}</span>
            <span class="mono">${formatAmount(d)}</span>
            <span>${d.date ? fmtDate(d.date) : '—'}</span>
            <span class="${confClass(d.ocrConfidence)}">${d.ocrConfidence != null ? d.ocrConfidence + '%' : '—'}</span>
            <span><button class="btn btn-ghost" data-act="preview" data-id="${escapeHtml(d.id)}" style="font-size:11px;padding:2px 6px;">preview</button></span>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderFolderView(cache, docs) {
  const q = (state.archiveUi.filters.q || '').toLowerCase();
  const filtered = cache.folders
    .map((f) => {
      const folderMatches = !q || f.name.toLowerCase().includes(q);
      const matchingFiles = folderMatches
        ? f.files
        : f.files.filter((x) => x.name.toLowerCase().includes(q)
          || docs.some((d) => d.filename === x.name && d.folder === f.name
            && [d.supplierName, d.sapDocNumber, d.invoiceNumber].some((v) => String(v || '').toLowerCase().includes(q))));
      if (!matchingFiles.length) return null;
      return { ...f, files: matchingFiles };
    })
    .filter(Boolean);

  if (!filtered.length) {
    return `<div class="archive-empty">Καμία αντιστοιχία</div>`;
  }
  return filtered.map((f, idx) => `
    <div class="folder-block">
      <div class="folder-title" data-folder-idx="${idx}">
        <span class="folder-caret">▼</span>
        <span>📁 ${escapeHtml(f.name)}</span>
        <button class="archive-chip" data-pin-folder="${escapeHtml(f.name)}" style="margin-left:8px;font-size:10px;">☆</button>
        <span class="folder-count">${f.files.length} αρχεία</span>
      </div>
      <div class="folder-files">
        ${f.files.map((file) => {
          const doc = docs.find((d) => d.folder === f.name && d.filename === file.name);
          return `
            <a href="#" class="folder-file" data-folder="${escapeHtml(f.name)}" data-file="${escapeHtml(file.name)}">
              <span class="folder-file-icon">📄</span>
              <span class="folder-file-name">${escapeHtml(file.name)}</span>
              ${doc?.sapDocNumber ? `<span class="mono" style="font-size:10px;color:var(--text-muted);">${escapeHtml(doc.sapDocNumber)}</span>` : ''}
            </a>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function wireDocActions(container, docs) {
  container.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const doc = docs.find((d) => d.id === btn.dataset.id);
      if (!doc) return;
      if (btn.dataset.act === 'open') await openDoc(doc, false);
      else if (btn.dataset.act === 'preview') await openDoc(doc, true);
      else if (btn.dataset.act === 'download') await downloadDoc(doc);
    });
  });
  container.querySelectorAll('.archive-list-row, .doc-card').forEach((row) => {
    row.addEventListener('dblclick', () => {
      const doc = docs.find((d) => d.id === row.dataset.id);
      if (doc) openDoc(doc, true);
    });
  });
  container.querySelectorAll('.folder-title').forEach((t) => {
    t.addEventListener('click', (e) => {
      if (e.target.closest('[data-pin-folder]')) return;
      t.classList.toggle('collapsed');
    });
  });
  container.querySelectorAll('[data-pin-folder]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fav = loadJson(LS_FAV_FOLDERS, []);
      const name = btn.dataset.pinFolder;
      if (!fav.includes(name)) { fav.push(name); saveJson(LS_FAV_FOLDERS, fav); toast(`Αγαπημένος φάκελος: ${name}`, 'ok'); }
      renderQuickBar();
    });
  });
  container.querySelectorAll('.folder-file').forEach((link) => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const doc = docs.find((d) => d.folder === link.dataset.folder && d.filename === link.dataset.file);
      if (doc) await openDoc(doc, false);
      else await openArchivedFileFromDisk(link.dataset.folder, link.dataset.file);
    });
  });
  $('#archive-load-more')?.addEventListener('click', () => {
    state.archiveUi._scrollStart = (state.archiveUi._scrollStart || 0) + 48;
    renderArchiveBrowser();
  });
  loadLazyThumbnails(container, docs);
}

/** Lazy-render PDF first page as thumbnail when card scrolls into view */
function loadLazyThumbnails(container, docs) {
  const cards = container.querySelectorAll('.doc-card .doc-thumb');
  if (!cards.length || !window.IntersectionObserver) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const thumb = entry.target;
      observer.unobserve(thumb);
      const card = thumb.closest('.doc-card');
      const doc = docs.find((d) => d.id === card?.dataset.id);
      if (!doc || !state.archiveRoot.handle) continue;
      renderDocThumbnail(doc, thumb).catch(() => {});
    }
  }, { rootMargin: '100px' });
  cards.forEach((c) => observer.observe(c));
}

async function renderDocThumbnail(doc, thumbEl) {
  const dir = await state.archiveRoot.handle.getDirectoryHandle(doc.folder);
  const fh = await dir.getFileHandle(doc.filename);
  const file = await fh.getFile();
  if (!file.type.includes('pdf') && !doc.filename.endsWith('.pdf')) return;
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 0.3 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  thumbEl.querySelector('.doc-thumb-placeholder')?.remove();
  thumbEl.appendChild(canvas);
}

async function downloadDoc(doc) {
  if (doc.invoiceId) {
    const inv = state.invoices.find((i) => i.id === doc.invoiceId);
    if (inv) {
      const bytes = await getArchivedPdfBytes(inv);
      if (bytes) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        a.download = doc.filename;
        a.click();
        return;
      }
    }
  }
  try {
    const dir = await state.archiveRoot.handle.getDirectoryHandle(doc.folder);
    const fh = await dir.getFileHandle(doc.filename);
    const file = await fh.getFile();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = doc.filename;
    a.click();
  } catch (e) {
    toast(`Download failed: ${e.message}`, 'err');
  }
}

export async function loadArchiveBrowser(force = false) {
  const container = $('#archive-browser-content');
  if (!state.archiveRoot.handle) {
    container.innerHTML = `<div class="archive-empty">
      Δεν έχει επιλεγεί ριζικός φάκελος.<br>
      Πήγαινε στις <strong>⚙ Ρυθμίσεις AI</strong> για να τον ορίσεις.
    </div>`;
    return;
  }
  if (!force && state.archiveBrowserCache) {
    state.archiveIndex = buildArchiveIndex(state.archiveBrowserCache);
    renderArchiveBrowser();
    return;
  }
  container.innerHTML = `<div class="archive-empty">Ανάγνωση δίσκου…</div>`;

  try {
    const ok = await verifyPermission(state.archiveRoot.handle, 'read');
    if (!ok) {
      container.innerHTML = `<div class="archive-empty" style="color:var(--err);">Δεν υπάρχει άδεια ανάγνωσης.</div>`;
      return;
    }
    const folders = [];
    for await (const [name, handle] of state.archiveRoot.handle.entries()) {
      if (handle.kind !== 'directory' || name.startsWith('.')) continue;
      const files = await collectFilesRecursive(handle, '');
      files.sort((a, b) => a.relPath.localeCompare(b.relPath));
      folders.push({ name, files });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    state.archiveBrowserCache = { folders, scannedAt: Date.now() };
    state.archiveIndex = buildArchiveIndex(state.archiveBrowserCache);
    renderArchiveBrowser();
  } catch (e) {
    console.error('Archive scan failed:', e);
    container.innerHTML = `<div class="archive-empty" style="color:var(--err);">Σφάλμα: ${escapeHtml(e.message)}</div>`;
  }
}

export function renderArchiveBrowser() {
  const container = $('#archive-browser-content');
  const cache = state.archiveBrowserCache;
  if (!cache?.folders) return;

  const docs = sortDocs(applyFilters(state.archiveIndex || buildArchiveIndex(cache)));
  renderStats(docs);
  renderQuickBar();

  const view = state.archiveUi.view;
  let body = '';
  if (view === 'folder') body = renderFolderView(cache, docs);
  else if (view === 'list') body = renderList(docs);
  else body = renderGrid(docs);

  container.innerHTML = body;
  wireDocActions(container, docs);
}

export async function openArchivedFileFromDisk(folderName, filename, docForPreview = null) {
  try {
    const dir = await state.archiveRoot.handle.getDirectoryHandle(folderName);
    const fh = await dir.getFileHandle(filename);
    const file = await fh.getFile();
    const url = URL.createObjectURL(file);
    if (docForPreview) {
      showPreview(docForPreview, url);
    } else {
      const win = window.open(url, '_blank');
      if (!win) { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.click(); }
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast(`Δεν άνοιξε: ${e.message}`, 'err');
  }
}

export function initArchiveView() {
  const setView = (v) => {
    state.archiveUi.view = v;
    state.archiveUi._scrollStart = 0;
    localStorage.setItem(LS_VIEW, v);
    document.querySelectorAll('[data-archive-view]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.archiveView === v);
    });
    renderArchiveBrowser();
  };

  document.querySelectorAll('[data-archive-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.archiveView));
  });

  const bindFilter = (id, key, transform = (v) => v) => {
    $(`#${id}`)?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) state.archiveUi.filters[key] = transform(val);
      else delete state.archiveUi.filters[key];
      state.archiveUi._scrollStart = 0;
      renderArchiveBrowser();
    });
  };

  bindFilter('archive-filter-supplier', 'supplier', (v) => parseInt(v, 10));
  bindFilter('archive-filter-status', 'status');
  bindFilter('archive-filter-year', 'year');
  bindFilter('archive-filter-month', 'month');
  bindFilter('archive-filter-conf', 'minConf');
  bindFilter('archive-filter-sap-prefix', 'sapPrefix');

  $('#archive-sort')?.addEventListener('change', (e) => {
    state.archiveUi.sort = e.target.value;
    renderArchiveBrowser();
  });

  $('#archive-search')?.addEventListener('input', debounce((e) => {
    state.archiveUi.filters.q = e.target.value.trim();
    state.archiveUi._scrollStart = 0;
    renderArchiveBrowser();
  }, 200));

  $('#btn-archive-refresh')?.addEventListener('click', () => loadArchiveBrowser(true));

  populateArchiveFilters();
}

function populateArchiveFilters() {
  const supEl = $('#archive-filter-supplier');
  if (supEl) {
    const opts = state.suppliers.filter((s) => s.status === 'active')
      .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    supEl.innerHTML = `<option value="">Όλοι οι προμηθευτές</option>${opts}`;
  }
}
