/** Archive folder browser */
import { state } from './state.js';
import { $, toast, escapeHtml, debounce } from './utils.js';
import { verifyPermission } from './storage.js';

state.archiveBrowserCache = null;  // { folders: [{name, files: [names]}] }

export async function loadArchiveBrowser(force = false) {
  const container = $('#archive-browser-content');
  if (!state.archiveRoot.handle) {
    container.innerHTML = `<div class="archive-empty">
      Δεν έχει επιλεγεί ριζικός φάκελος.<br>
      Πήγαινε στις <strong>⚙ Ρυθμίσεις AI</strong> για να τον ορίσεις.
    </div>`;
    return;
  }
  container.innerHTML = `<div class="archive-empty">Ανάγνωση δίσκου…</div>`;

  try {
    // Verify permission
    const ok = await verifyPermission(state.archiveRoot.handle, 'read');
    if (!ok) {
      container.innerHTML = `<div class="archive-empty" style="color:var(--err);">
        Δεν υπάρχει άδεια ανάγνωσης. Επίλεξε ξανά τον φάκελο στις Ρυθμίσεις.
      </div>`;
      return;
    }

    // Scan όλους τους φακέλους και τα αρχεία
    const folders = [];
    for await (const [name, handle] of state.archiveRoot.handle.entries()) {
      if (handle.kind !== 'directory') continue;
      if (name.startsWith('.')) continue;  // skip hidden (.parastatika/)
      const files = [];
      for await (const [fname, fhandle] of handle.entries()) {
        if (fhandle.kind === 'file' && !fname.startsWith('.')) {
          try {
            const file = await fhandle.getFile();
            files.push({ name: fname, size: file.size, modified: file.lastModified });
          } catch (e) {
            files.push({ name: fname, size: 0, modified: 0 });
          }
        }
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      folders.push({ name, files });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));

    state.archiveBrowserCache = { folders, scannedAt: Date.now() };
    renderArchiveBrowser();
  } catch (e) {
    console.error('Archive scan failed:', e);
    container.innerHTML = `<div class="archive-empty" style="color:var(--err);">
      Σφάλμα ανάγνωσης: ${escapeHtml(e.message)}
    </div>`;
  }
}

export function renderArchiveBrowser() {
  const container = $('#archive-browser-content');
  const cache = state.archiveBrowserCache;
  if (!cache || !cache.folders) return;

  const q = ($('#archive-search')?.value || '').trim().toLowerCase();

  const filtered = cache.folders
    .map(f => {
      if (!q) return f;
      const folderMatches = f.name.toLowerCase().includes(q);
      const matchingFiles = folderMatches
        ? f.files
        : f.files.filter(x => x.name.toLowerCase().includes(q));
      if (!folderMatches && !matchingFiles.length) return null;
      return { ...f, files: matchingFiles };
    })
    .filter(Boolean);

  if (!filtered.length) {
    container.innerHTML = `<div class="archive-empty">
      ${q ? `Καμία αντιστοιχία για "${escapeHtml(q)}"` : 'Ο φάκελος είναι άδειος. Ανέβασε τιμολόγια για να δημιουργηθούν subfolders.'}
    </div>`;
    return;
  }

  const totalFiles = filtered.reduce((sum, f) => sum + f.files.length, 0);
  container.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">
      <strong>${filtered.length}</strong> προμηθευτές · <strong>${totalFiles}</strong> αρχεία
      ${q ? `· φιλτραρίσμα: "${escapeHtml(q)}"` : ''}
    </div>
    ${filtered.map((f, idx) => `
      <div class="folder-block">
        <div class="folder-title" data-folder-idx="${idx}">
          <span class="folder-caret">▼</span>
          <span>📁 ${escapeHtml(f.name)}</span>
          <span class="folder-count">${f.files.length} ${f.files.length === 1 ? 'αρχείο' : 'αρχεία'}</span>
        </div>
        <div class="folder-files">
          ${f.files.map(file => `
            <a href="#" class="folder-file"
               data-folder="${escapeHtml(f.name)}"
               data-file="${escapeHtml(file.name)}"
               title="${(file.size/1024).toFixed(1)}KB · ${file.modified ? new Date(file.modified).toLocaleString('el-GR') : ''}">
              <span class="folder-file-icon">📄</span>
              <span class="folder-file-name">${escapeHtml(file.name)}</span>
            </a>
          `).join('')}
        </div>
      </div>
    `).join('')}
  `;

  // Wire up handlers
  container.querySelectorAll('.folder-title').forEach(t => {
    t.addEventListener('click', () => t.classList.toggle('collapsed'));
  });
  container.querySelectorAll('.folder-file').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const folder = link.dataset.folder;
      const filename = link.dataset.file;
      await openArchivedFileFromDisk(folder, filename);
    });
  });
}

export async function openArchivedFileFromDisk(folderName, filename) {
  try {
    const dir = await state.archiveRoot.handle.getDirectoryHandle(folderName);
    const fh = await dir.getFileHandle(filename);
    const file = await fh.getFile();
    const url = URL.createObjectURL(file);
    const win = window.open(url, '_blank');
    if (!win) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast(`Δεν άνοιξε: ${e.message}`, 'err');
  }
}
// ═══════════════════════════════════════════════════════════
