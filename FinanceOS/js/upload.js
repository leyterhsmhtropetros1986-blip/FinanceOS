/** Upload, batch OCR, review panel */
import { state } from './state.js';
import { $, toast, fmtISODate, confidenceClass, escapeHtml } from './utils.js';
import { validateAfmChecksum } from './helpers.js';
import { audit } from './audit.js';
import {
  verifyPermission, writeToDisk, resolveSupplierFolder, findDuplicateInvoice,
  storeArchivedFile, splitPdfByPages, downloadArchiveZip,
} from './storage.js';
import { runClaudeVisionOCRDirect } from './ai.js';
import { runOcrPipeline } from './ocr-pipeline.js';
import {
  matchSupplier, validateForArchive, buildArchiveFilename,
} from './ocr.js';
import { renderToCanvases } from './ocr.js';
import { sanitizeAgainstOcrText } from './ocr-confidence.js';

let uploadZoneEl;
let fileInputEl;

// BATCH PROCESSING — bulk upload πολλών τιμολογίων
// ═══════════════════════════════════════════════════════════

state.batch = {
  queue: [],
  active: false,
  cancelled: false,
  autoArchive: true,
  stats: { archived: 0, review: 0, failed: 0 },
};

export async function handleBatch(files) {
  // Χρειάζεται AI για bulk — Tesseract είναι πολύ αργό
  const useAI = state.settings.provider === 'anthropic' && state.settings.apiKey;
  if (!useAI) {
    if (!confirm(`Έχεις ${files.length} αρχεία αλλά AI OCR δεν είναι ενεργό.\n\n` +
                 `Με Tesseract browser θα πάρει ~${Math.round(files.length * 30 / 60)} λεπτά.\n` +
                 `Με Claude AI θα πάρει ~${Math.round(files.length * 4 / 60)} λεπτά.\n\n` +
                 `Θες να συνεχίσεις με Tesseract;`)) return;
  }

  // Reset και setup queue
  state.batch = {
    queue: files.map((f, idx) => ({
      idx,
      file: f,
      status: 'pending',   // pending | processing | archived | review | failed
      invoice_id: null,
      result: null,
      error: null,
      extracted: null,
      supplier_match: null,
    })),
    active: true,
    cancelled: false,
    autoArchive: $('#batch-auto-archive').checked,
    stats: { archived: 0, review: 0, failed: 0 },
    total: files.length,
  };

  // Show batch UI, hide upload zone
  $('#upload-zone').hidden = true;
  $('#upload-progress').hidden = true;
  $('#review').hidden = true;
  $('#batch-panel').hidden = false;
  $('#batch-summary').hidden = true;
  $('#batch-title').textContent = `Bulk Processing · ${files.length} αρχεία`;
  renderBatchQueue();

  // Process sequentially
  for (let i = 0; i < state.batch.queue.length; i++) {
    if (state.batch.cancelled) break;
    const item = state.batch.queue[i];
    item.status = 'processing';
    updateBatchProgress();
    renderBatchQueue();
    try {
      await processBatchItem(item, useAI);
    } catch (e) {
      console.error('Batch item failed:', e);
      item.status = 'failed';
      item.error = e.message;
      state.batch.stats.failed++;
    }
    updateBatchProgress();
    renderBatchQueue();
    window.dispatchEvent(new CustomEvent('review-badge-update'));
    // Rate limit safety — 500ms between calls
    if (i < state.batch.queue.length - 1 && useAI) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  state.batch.active = false;
  showBatchSummary();
}

export async function processBatchItem(item, useAI) {
  // 1. Unwrap
  const unwrapped = await unwrapFile(item.file);
  const file = unwrapped.file;
  const originalBytes = await file.arrayBuffer();
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  // 2. OCR — always pipeline-first (AI never blocks)
  let result;
  try {
    result = await runOcrPipeline(file, { onProgress: () => {} });
    result.extractedList = result.extractedList || [result.extracted];
    if (useAI && result.fullText) {
      try {
        const aiResult = await Promise.race([
          runClaudeVisionOCRDirect(file, () => {}),
          new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout')), 60000)),
        ]);
        const aiExt = sanitizeAgainstOcrText(aiResult.extracted, result.fullText);
        result.extracted = { ...result.extracted, ...pickOcrVerifiedFields(aiExt, result.extracted) };
      } catch (e) {
        console.warn('Batch AI assist skipped:', e);
      }
    }
  } catch (e) {
    item.status = 'failed';
    item.error = e.message;
    throw e;
  }
  item.result = result;

  const invoices = result.extractedList || [result.extracted];
  const isMulti = invoices.length > 1;
  if (isMulti) {
    audit('unmerge', 'success', `Detected ${invoices.length} invoices in one PDF`,
      { details: { count: invoices.length } });
  }

  // 3. Process κάθε τιμολόγιο ξεχωριστά (μπορεί να είναι 1 ή Ν)
  for (let ii = 0; ii < invoices.length; ii++) {
    const extracted = invoices[ii];

    // Create separate invoice record για κάθε ένα
    const invoice = {
      id: state.nextInvoiceId++,
      original_filename: item.file.name + (isMulti ? ` (μέρος ${ii + 1}/${invoices.length})` : ''),
      file_size_bytes: item.file.size,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    state.invoices.unshift(invoice);
    if (ii === 0) item.invoice_id = invoice.id;
    audit('upload', 'success', `Invoice ${ii + 1}/${invoices.length} from ${item.file.name}`,
      { invoice_id: invoice.id });

    item.extracted = extracted;  // show latest in queue UI

    // Supplier match
    const { best, all } = matchSupplier(extracted.afm, extracted.supplier_name_hint);
    item.supplier_match = best;

    Object.assign(invoice, {
      afm: extracted.afm,
      invoice_number: extracted.invoice_number,
      invoice_date: extracted.invoice_date,
      sap_doc_number: extracted.sap_doc_number,
      supplier_id: best ? best.supplier_id : null,
      page_count: (extracted.page_end || 1) - (extracted.page_start || 1) + 1,
      net_amount: extracted.net_amount,
      vat_amount: extracted.vat_amount,
      total_amount: extracted.total_amount,
      currency: extracted.currency || 'EUR',
      vat_rate: extracted.vat_rate,
      purchase_order: extracted.purchase_order,
      reference: extracted.reference,
      container: extracted.container,
      bill_of_lading: extracted.bill_of_lading,
      confidence_afm: extracted.confidence_afm,
      confidence_invoice_no: extracted.confidence_invoice_no,
      confidence_sap_doc: extracted.confidence_sap_doc,
      confidence_date: extracted.confidence_date,
    });

    // Απόφαση
    const canAutoArchive =
      state.batch.autoArchive &&
      extracted.afm &&
      validateAfmChecksum(extracted.afm) &&
      best && best.confidence >= 90 &&
      extracted.invoice_number &&
      extracted.invoice_date &&
      extracted.sap_doc_number &&
      /^\d{6,12}$/.test(String(extracted.sap_doc_number).replace(/\D/g, '')) &&
      extracted.confidence_sap_doc >= 70;

    // Πρώτα έλεγξε αν υπάρχει ήδη (duplicate)
    const duplicate = canAutoArchive
      ? findDuplicateInvoice(best.supplier_id, extracted.invoice_number, extracted.sap_doc_number)
      : null;

    if (duplicate) {
      // Duplicate detection: δεν το αρχειοθετούμε ξανά
      invoice.status = 'duplicate';
      invoice.status_message = `Ήδη αρχειοθετημένο ως ${duplicate.archived_filename || '#' + duplicate.id}`;
      invoice.duplicate_of = duplicate.id;
      audit('archive', 'warning',
        `Duplicate: ήδη υπάρχει (invoice #${duplicate.id}, file: ${duplicate.archived_filename})`,
        { invoice_id: invoice.id, details: { duplicate_of: duplicate.id } });
      state.batch.stats.duplicate = (state.batch.stats.duplicate || 0) + 1;
    } else if (canAutoArchive) {
      try {
        const filename = buildArchiveFilename(
          invoice.invoice_number,
          invoice.sap_doc_number,
          invoice.invoice_date
        );

        // Ψάξε αν υπάρχει ήδη φάκελος για αυτόν τον προμηθευτή στον δίσκο
        // (matching by SAP code prefix) — αν ναι, χρησιμοποίησέ τον
        const actualFolder = await resolveSupplierFolder(
          best.sap_vendor_code,
          best.folder_path
        );
        const archivedPath = `${actualFolder}/${filename}`;

        // Split PDF αν είναι multi-invoice, αλλιώς κράτα ολόκληρο
        let outputBytes;
        if (isMulti && isPdf) {
          outputBytes = await splitPdfByPages(
            originalBytes,
            extracted.page_start || 1,
            extracted.page_end || 1
          );
        } else {
          outputBytes = originalBytes;
        }

        // Store για ZIP download αργότερα (χρησιμοποίησε το ίδιο folder name)
        storeArchivedFile(actualFolder, filename, outputBytes);

        // Γράψε στον πραγματικό δίσκο αν είναι configured
        let diskPath = null;
        if (state.archiveRoot.handle) {
          try {
            const result = await writeToDisk(actualFolder, filename, outputBytes, extracted.invoice_date);
            diskPath = result.fullPath;
          } catch (e) {
            if (e.code === 'DUPLICATE') {
              // Το αρχείο υπάρχει ήδη στον δίσκο → duplicate on disk
              invoice.status = 'duplicate';
              invoice.status_message = `Το αρχείο ${filename} υπάρχει ήδη στον δίσκο`;
              audit('archive', 'warning', `Duplicate on disk: ${filename}`,
                { invoice_id: invoice.id });
              state.batch.stats.duplicate = (state.batch.stats.duplicate || 0) + 1;
              continue; // επόμενο invoice στο loop
            }
            console.warn('Disk write failed:', e);
            audit('archive', 'warning', `Disk write failed: ${e.message}`, { invoice_id: invoice.id });
          }
        }

        Object.assign(invoice, {
          archived_filename: filename,
          archived_path: diskPath || archivedPath,
          archived_at: new Date().toISOString(),
          archived_by: state.currentUser || 'auto',
          status: 'archived',
        });
        audit('archive', 'success', `Auto-archived: ${diskPath || archivedPath}`,
          { invoice_id: invoice.id, actor: 'auto',
            details: { filename, path: diskPath || archivedPath, split: isMulti, on_disk: !!diskPath, folder: actualFolder } });
        state.batch.stats.archived++;
      } catch (e) {
        invoice.status = 'needs_review';
        invoice.status_message = `Archive error: ${e.message}`;
        state.batch.stats.review++;
      }
    } else {
      invoice.status = 'needs_review';
      const reasons = [];
      if (!extracted.afm) reasons.push('ΑΦΜ λείπει');
      else if (!validateAfmChecksum(extracted.afm)) reasons.push('ΑΦΜ MOD-11 fail');
      if (!best) reasons.push('προμηθευτής μη ματσαρισμένος');
      else if (best.confidence < 90) reasons.push(`match ${best.confidence}%`);
      if (!extracted.invoice_number) reasons.push('αρ. τιμολ.');
      if (!extracted.invoice_date) reasons.push('ημερομ.');
      if (!extracted.sap_doc_number) reasons.push('SAP Doc');
      else if (extracted.confidence_sap_doc < 70) reasons.push(`SAP conf ${extracted.confidence_sap_doc}%`);
      invoice.status_message = reasons.join(', ') || 'μη σίγουρο';
      state.batch.stats.review++;
    }
  }

  // Status του item = τι έγινε συνολικά
  if (invoices.every((_, i) => state.invoices.find(inv => inv.original_filename.includes(item.file.name))?.status === 'archived')) {
    item.status = 'archived';
  } else if (invoices.some(_ => true)) {
    // Αν ένα τουλάχιστον χρειάζεται review
    item.status = invoices.length > 1 ? 'review' : (state.batch.stats.archived > 0 ? 'archived' : 'review');
  }
  // Σωστότερο: κοίτα το status του τελευταίου invoice που δημιουργήθηκε
  const lastInvoice = state.invoices[0];
  item.status = lastInvoice?.status === 'archived' ? 'archived' : 'review';
  if (isMulti) item.multiCount = invoices.length;
}

export function updateBatchProgress() {
  const total = state.batch.total;
  const done = state.batch.queue.filter(x => x.status !== 'pending' && x.status !== 'processing').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('#batch-progress-bar').style.width = `${pct}%`;
  $('#batch-progress-label').textContent = `${done} / ${total}`;
  const s = state.batch.stats;
  const dup = s.duplicate || 0;
  $('#batch-stats').innerHTML =
    `<span style="color:var(--ok);">✓ ${s.archived} αρχειοθετημένα</span> · ` +
    (dup > 0 ? `<span style="color:var(--accent);">⇈ ${dup} duplicates</span> · ` : '') +
    `<span style="color:var(--warn);">⚠ ${s.review} έλεγχος</span> · ` +
    `<span style="color:var(--err);">✗ ${s.failed} απέτυχαν</span>`;
  $('#batch-subtitle').textContent = state.batch.active
    ? `${done} από ${total} · Επεξεργασία σε εξέλιξη…`
    : `${total} αρχεία · Ολοκληρώθηκε`;
}

export function renderBatchQueue() {
  const container = $('#batch-queue');
  container.innerHTML = '';
  for (const item of state.batch.queue) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 20px; border-bottom:1px solid var(--border); display:grid; grid-template-columns:24px 1fr auto auto; gap:12px; align-items:center; font-size:12px;';
    const icon = {
      pending: '<span style="color:var(--text-subtle);">○</span>',
      processing: '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>',
      archived: '<span style="color:var(--ok);font-size:16px;">✓</span>',
      review: '<span style="color:var(--warn);font-size:16px;">⚠</span>',
      failed: '<span style="color:var(--err);font-size:16px;">✗</span>',
      duplicate: '<span style="color:var(--accent);font-size:16px;" title="Duplicate">⇈</span>',
    }[item.status] || '?';
    const ext = item.extracted;
    const summary = ext
      ? `<span class="mono" style="color:var(--text-muted);">ΑΦΜ ${ext.afm || '?'} · ${ext.invoice_number || '?'} · ${ext.sap_doc_number || '?'}</span>`
      : item.error
        ? `<span style="color:var(--err);">${escapeHtml(item.error)}</span>`
        : item.status === 'processing'
          ? '<span style="color:var(--accent);">επεξεργασία…</span>'
          : '<span style="color:var(--text-subtle);">σε αναμονή</span>';
    const supplierText = item.supplier_match
      ? `<span style="color:var(--text);">${escapeHtml(item.supplier_match.name)}</span>`
      : '';
    const actionBtn = (item.status === 'review' || item.status === 'archived')
      ? `<button class="btn btn-ghost" data-idx="${item.idx}" data-act="review" style="font-size:11px;padding:2px 8px;">${item.status === 'archived' ? 'δες' : 'έλεγξε'}</button>`
      : '';
    row.innerHTML = `
      ${icon}
      <div>
        <div style="font-weight:500;">${escapeHtml(item.file.name)}</div>
        <div style="margin-top:2px;font-size:11px;">${summary} ${supplierText ? '· ' + supplierText : ''}</div>
      </div>
      <span style="color:var(--text-subtle);font-family:var(--font-mono);font-size:10px;">${(item.file.size / 1024).toFixed(0)}KB</span>
      ${actionBtn}
    `;
    container.appendChild(row);
  }
  container.querySelectorAll('[data-act="review"]').forEach(b => {
    b.addEventListener('click', () => openBatchItemForReview(parseInt(b.dataset.idx)));
  });
}

export function openBatchItemForReview(idx) {
  const item = state.batch.queue[idx];
  if (!item || !item.result) return;
  const invoice = state.invoices.find(i => i.id === item.invoice_id);
  if (!invoice) return;

  // Set current and populate review panel
  state.currentInvoiceId = invoice.id;
  state.currentUpload = { file: item.file, wrapper: null, canvases: [], invoice, result: item.result };

  $('#batch-panel').hidden = true;
  $('#review').hidden = false;
  showReviewPanel(item.file, invoice, [], null);
  populateReviewFromOCR(item.result, item.file, invoice);

  // Try to render preview
  renderToCanvases(item.file, () => {}).then(canvases => {
    state.currentUpload.canvases = canvases;
    renderPreview(canvases);
  }).catch(e => console.warn('Preview failed:', e));
}

export function showBatchSummary() {
  const s = state.batch.stats;
  const dup = s.duplicate || 0;
  const total = state.batch.total;
  const summary = $('#batch-summary');
  summary.hidden = false;
  const hasArchived = state.archivedFiles.size > 0;
  summary.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <div>
        <div style="font-weight:600; font-size:14px;">✓ Ολοκληρώθηκε</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
          Από ${total} αρχεία:
          <strong style="color:var(--ok);">${s.archived} αρχειοθετήθηκαν αυτόματα</strong>,
          ${dup > 0 ? `<strong style="color:var(--accent);">${dup} duplicates (παραλείφθηκαν)</strong>,` : ''}
          <strong style="color:var(--warn);">${s.review} χρειάζονται έλεγχο</strong>,
          <strong style="color:var(--err);">${s.failed} απέτυχαν</strong>
        </div>
        ${hasArchived ? `<div style="font-size:11px; color:var(--text-subtle); margin-top:6px;">
          ${state.archivedFiles.size} πραγματικά αρχεία έτοιμα για download (με σωστούς φακέλους)
        </div>` : ''}
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${hasArchived ? '<button class="btn btn-primary" id="btn-download-zip">📦 Download ZIP</button>' : ''}
        ${s.review > 0 ? '<button class="btn btn-secondary" id="btn-review-pending">Έλεγχος εκκρεμών</button>' : ''}
        <button class="btn btn-secondary" id="btn-new-batch">Νέο batch</button>
      </div>
    </div>
  `;
  const zipBtn = document.getElementById('btn-download-zip');
  if (zipBtn) zipBtn.addEventListener('click', downloadArchiveZip);
  const reviewBtn = document.getElementById('btn-review-pending');
  if (reviewBtn) reviewBtn.addEventListener('click', () => {
    const firstReview = state.batch.queue.find(x => x.status === 'review');
    if (firstReview) openBatchItemForReview(firstReview.idx);
  });
  document.getElementById('btn-new-batch').addEventListener('click', () => {
    $('#batch-panel').hidden = true;
    $('#upload-zone').hidden = false;
    $('#file-input').value = '';
  });
  toast(`Ολοκληρώθηκε: ${s.archived}✓ ${dup > 0 ? dup + '⇈ ' : ''}${s.review}⚠ ${s.failed}✗`, 'ok');
}

// Το Claude διαβάζει ελληνικά, χειρόγραφα, σφραγίδες — ~95% ακρίβεια
// ═══════════════════════════════════════════════════════════

// UNIVERSAL FILE UNWRAPPER
// Καταλαβαίνει: PDF, εικόνες, .msg (Outlook email), .eml (standard email),
// .zip, .tiff, .heic (iPhone). Βρίσκει το τιμολόγιο μέσα και το επιστρέφει.
// ═══════════════════════════════════════════════════════════
const DIRECT_EXTS = /\.(pdf|jpe?g|png|gif|webp|bmp)$/i;
const IMAGE_MIMES = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};
const guessMime = (name) => {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return IMAGE_MIMES[ext] || 'application/octet-stream';
};

export async function unwrapFile(file, onStatus) {
  const name = file.name.toLowerCase();

  // Άμεσα υποστηριζόμενα
  if (DIRECT_EXTS.test(name)) return { file, wrapper: null };

  // TIFF → PNG (τα rendering-supported browsers δεν χειρίζονται TIFF)
  if (/\.(tif|tiff)$/i.test(name)) {
    onStatus && onStatus('Μετατροπή TIFF → PNG…');
    return await unwrapTiff(file);
  }

  // HEIC / HEIF (iPhone) → JPEG
  if (/\.(heic|heif)$/i.test(name)) {
    onStatus && onStatus('Μετατροπή HEIC → JPEG…');
    return await unwrapHeic(file);
  }

  // Outlook .msg
  if (name.endsWith('.msg')) {
    onStatus && onStatus('Ανάγνωση email (.msg)…');
    return await unwrapMsg(file, onStatus);
  }

  // Standard .eml
  if (name.endsWith('.eml')) {
    onStatus && onStatus('Ανάγνωση email (.eml)…');
    return await unwrapEml(file);
  }

  // ZIP archives
  if (name.endsWith('.zip')) {
    onStatus && onStatus('Άνοιγμα .zip…');
    return await unwrapZip(file);
  }

  // Fallback — try to sniff by magic bytes
  const buffer = await file.slice(0, 8).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    // %PDF magic
    return { file: new File([file], file.name + '.pdf', { type: 'application/pdf' }), wrapper: 'sniffed as PDF' };
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    return { file: new File([file], file.name + '.jpg', { type: 'image/jpeg' }), wrapper: 'sniffed as JPEG' };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { file: new File([file], file.name + '.png', { type: 'image/png' }), wrapper: 'sniffed as PNG' };
  }

  const ext = name.slice(name.lastIndexOf('.')) || '(κανένα)';
  throw new Error(`Δεν αναγνωρίζεται τύπος αρχείου ${ext}. Υποστηρίζονται: PDF, JPG, PNG, TIFF, HEIC, MSG (Outlook email), EML, ZIP.`);
}

// ─── TIFF ────────────────────────────────────────────────
export async function unwrapTiff(file) {
  const buffer = await file.arrayBuffer();
  const ifds = UTIF.decode(buffer);
  if (!ifds.length) throw new Error('Άκυρο TIFF');
  UTIF.decodeImage(buffer, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const canvas = document.createElement('canvas');
  canvas.width = ifds[0].width;
  canvas.height = ifds[0].height;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(canvas.width, canvas.height);
  imgData.data.set(rgba);
  ctx.putImageData(imgData, 0, 0);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const newName = file.name.replace(/\.tiff?$/i, '.png');
  return { file: new File([blob], newName, { type: 'image/png' }), wrapper: 'TIFF → PNG' };
}

// ─── HEIC ────────────────────────────────────────────────
export async function unwrapHeic(file) {
  if (typeof heic2any === 'undefined') throw new Error('HEIC library δεν φορτώθηκε');
  const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const newName = file.name.replace(/\.(heic|heif)$/i, '.jpg');
  return { file: new File([blob], newName, { type: 'image/jpeg' }), wrapper: 'HEIC → JPEG' };
}

// ─── Outlook .msg (OLE Compound File) ────────────────────
export async function unwrapMsg(file, onStatus) {
  // Lazy-load το msgreader — είναι ES module
  onStatus && onStatus('Φόρτωση msgreader…');
  const mod = await import('https://esm.sh/@kenjiuno/msgreader@1.22.0');
  const MsgReader = mod.default || mod.MsgReader || mod;
  const buffer = await file.arrayBuffer();
  const reader = new MsgReader(buffer);
  const info = reader.getFileData();
  if (!info || !info.attachments || !info.attachments.length) {
    throw new Error('Το email δεν έχει συνημμένο.');
  }
  // Βρες πρώτο valid PDF/image συνημμένο
  for (const att of info.attachments) {
    const attName = String(att.fileName || att.name || '').toLowerCase();
    if (DIRECT_EXTS.test(attName) || /\.(tif|tiff|heic|heif)$/i.test(attName)) {
      onStatus && onStatus(`Εξαγωγή ${att.fileName}…`);
      const data = reader.getAttachment(att);
      const bytes = data.content || data;
      const blob = new Blob([bytes], { type: guessMime(attName) });
      const inner = new File([blob], att.fileName, { type: guessMime(attName) });
      // Recursive unwrap αν είναι tiff/heic
      if (/\.(tif|tiff|heic|heif)$/i.test(attName)) {
        const nested = await unwrapFile(inner, onStatus);
        return { file: nested.file, wrapper: `.msg → ${att.fileName} → ${nested.wrapper || 'PDF'}` };
      }
      return { file: inner, wrapper: `.msg → ${att.fileName}` };
    }
  }
  const attList = info.attachments.map(a => a.fileName || '?').join(', ');
  throw new Error(`Το email έχει συνημμένα (${attList}) αλλά κανένα δεν είναι PDF/εικόνα.`);
}

// ─── Standard .eml (MIME) ────────────────────────────────
export async function unwrapEml(file) {
  const text = await file.text();
  // Απλός MIME parser — αρκετά καλός για invoices από scanners
  const boundaryMatch = text.match(/boundary=["']?([^"'\r\n;]+)["']?/i);
  if (!boundaryMatch) throw new Error('Το .eml δεν έχει multipart δομή.');
  const boundary = boundaryMatch[1].trim();
  const parts = text.split(`--${boundary}`).slice(1, -1);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4).trim();
    const ctMatch = headers.match(/Content-Type:\s*([^;\r\n]+)/i);
    const nameMatch = headers.match(/(?:filename|name)=["']?([^"'\r\n;]+)/i);
    const encMatch = headers.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    if (!ctMatch) continue;
    const contentType = ctMatch[1].trim().toLowerCase();
    if (!(contentType === 'application/pdf' || contentType.startsWith('image/'))) continue;
    const filename = (nameMatch ? nameMatch[1] : `attachment${contentType === 'application/pdf' ? '.pdf' : '.bin'}`).trim();
    // Base64 decode
    const encoding = encMatch ? encMatch[1].trim().toLowerCase() : '7bit';
    let bytes;
    if (encoding === 'base64') {
      const b64 = body.replace(/\s+/g, '');
      const binary = atob(b64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(body);
    }
    const blob = new Blob([bytes], { type: contentType });
    return { file: new File([blob], filename, { type: contentType }), wrapper: `.eml → ${filename}` };
  }
  throw new Error('Το email δεν έχει PDF/εικόνα ως συνημμένο.');
}

// ─── ZIP archives ─────────────────────────────────────────
export async function unwrapZip(file) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip δεν φορτώθηκε');
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const candidates = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    if (DIRECT_EXTS.test(path) || /\.(tif|tiff|heic|heif|msg|eml)$/i.test(path)) {
      candidates.push({ path, entry });
    }
  });
  if (!candidates.length) throw new Error('Δεν βρέθηκε PDF/εικόνα μέσα στο zip.');
  // Priority: PDF πρώτα, μετά images
  candidates.sort((a, b) => {
    const aPdf = /\.pdf$/i.test(a.path);
    const bPdf = /\.pdf$/i.test(b.path);
    return (bPdf ? 1 : 0) - (aPdf ? 1 : 0);
  });
  const chosen = candidates[0];
  const blob = await chosen.entry.async('blob');
  const inner = new File([blob], chosen.path.split('/').pop(), { type: guessMime(chosen.path) });
  // Αν είναι κι αυτό wrapper (πχ. .msg μέσα σε .zip) → recursive
  if (/\.(msg|eml|tif|tiff|heic|heif)$/i.test(chosen.path)) {
    const nested = await unwrapFile(inner);
    return { file: nested.file, wrapper: `.zip → ${chosen.path} → ${nested.wrapper || 'PDF'}` };
  }
  return { file: inner, wrapper: `.zip → ${chosen.path}` };
}

// ═══════════════════════════════════════════════════════════

// UPLOAD HANDLER — τώρα δέχεται όλα
// ═══════════════════════════════════════════════════════════
export async function handleFile(originalFile) {
  if (originalFile.size > 100 * 1024 * 1024) {
    toast('Το αρχείο ξεπερνά τα 100MB', 'err');
    return;
  }

  $('#upload-zone').hidden = true;
  $('#upload-progress').hidden = false;
  $('#progress-title').textContent = `Επεξεργασία ${originalFile.name}…`;
  $('#progress-sub').textContent = 'Προετοιμασία…';
  $('#review').hidden = true;

  const invoice = {
    id: state.nextInvoiceId++,
    original_filename: originalFile.name,
    file_size_bytes: originalFile.size,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  state.invoices.unshift(invoice);
  audit('upload', 'success', `Received ${originalFile.name} (${(originalFile.size/1024).toFixed(1)}KB)`, { invoice_id: invoice.id });

  // Step 1: Unwrap
  let file, wrapper;
  try {
    const unwrapped = await unwrapFile(originalFile, (msg) => {
      $('#progress-sub').textContent = msg;
    });
    file = unwrapped.file;
    wrapper = unwrapped.wrapper;
    if (wrapper) {
      audit('unwrap', 'success', wrapper, { invoice_id: invoice.id });
    }
  } catch (e) {
    invoice.status = 'error';
    invoice.status_message = e.message;
    audit('unwrap', 'failure', e.message, { invoice_id: invoice.id });
    $('#upload-progress').hidden = true;
    $('#upload-zone').hidden = false;
    toast(e.message, 'err');
    window.dispatchEvent(new CustomEvent('review-badge-update'));
    return;
  }

  // Step 2: OCR pipeline (always — fields come from OCR/PDF text, not AI guessing)
  const useAI = state.settings.provider === 'anthropic' && state.settings.apiKey;

  state.currentInvoiceId = invoice.id;
  state.currentUpload = { file, wrapper, canvases: [], invoice };
  showReviewPanel(file, invoice, [], wrapper);
  $('#upload-progress').hidden = true;
  $('#review').hidden = false;
  updateProgressInReview('Rendering…');

  let canvases = [];
  try {
    canvases = await renderToCanvases(file, (msg) => updateProgressInReview(msg));
    state.currentUpload.canvases = canvases;
    renderPreview(canvases);
    $('#meta-pages').textContent = canvases.length;
  } catch (e) {
    console.warn('Preview render failed:', e);
  }

  let result;
  try {
    updateProgressInReview('OCR — εξαγωγή πεδίων…');
    result = await runOcrPipeline(file, {
      existingCanvases: canvases.length ? canvases : null,
      onProgress: (msg) => updateProgressInReview(msg),
    });
    if (wrapper) result.wrapper = wrapper;

    // Optional AI assist: only merge values that exist in OCR text
    if (useAI && result.success !== false) {
      try {
        updateProgressInReview('AI assist (επαλήθευση με OCR κείμενο)…');
        const aiResult = await Promise.race([
          runClaudeVisionOCRDirect(file, (msg) => updateProgressInReview(`AI: ${msg}`)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout (60s)')), 60000)),
        ]);
        const aiExt = sanitizeAgainstOcrText(aiResult.extracted, result.fullText || aiResult.fullText || '');
        result.extracted = { ...result.extracted, ...pickOcrVerifiedFields(aiExt, result.extracted) };
        result.engine = `${result.engine} + AI-verified`;
      } catch (aiErr) {
        console.warn('AI assist skipped (non-fatal):', aiErr);
        updateProgressInReview('AI assist skipped — χρησιμοποιήθηκε OCR μόνο');
      }
    }

    state.currentUpload.result = result;
    populateReviewFromOCR(result, file, invoice);
    audit('ocr', 'success', `${result.engine} · ${result.processingMs}ms`,
      { invoice_id: invoice.id, details: { engine: result.engine, errors: result.errors } });
    if (result.extracted?.afm || result.extracted?.sap_doc_number) {
      toast(`✓ OCR ολοκληρώθηκε σε ${result.processingMs}ms`, 'ok');
    } else {
      toast('OCR ολοκληρώθηκε — έλεγξε τα πεδία χειροκίνητα', 'warn');
    }
  } catch (e) {
    console.error('OCR pipeline error:', e);
    invoice.status = 'needs_review';
    invoice.status_message = e.message;
    audit('ocr', 'failure', e.message, { invoice_id: invoice.id });
    updateProgressInReview(`OCR: ${e.message} — συμπλήρωσε χειροκίνητα`, true);
    $('#mean-confidence').textContent = 'OCR failed — manual entry';
    toast(`OCR σφάλμα: ${e.message}`, 'err');
    window.dispatchEvent(new CustomEvent('review-badge-update'));
  }
}

/** Merge AI fields only when they improve OCR and pass text verification */
function pickOcrVerifiedFields(aiExt, ocrExt) {
  const out = { ...ocrExt };
  const fields = [
    ['afm', 'confidence_afm'], ['invoice_number', 'confidence_invoice_no'],
    ['invoice_date', 'confidence_date'], ['sap_doc_number', 'confidence_sap_doc'],
  ];
  for (const [f, c] of fields) {
    if (aiExt[f] && (aiExt[c] || 0) > (ocrExt[c] || 0)) {
      out[f] = aiExt[f];
      out[c] = aiExt[c];
    }
  }
  if (aiExt.sap_doc_candidates?.length) {
    out.sap_doc_candidates = aiExt.sap_doc_candidates;
  }
  return out;
}

export function updateProgressInReview(msg, isError = false) {
  const el = $('#ocr-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--err)' : 'var(--text-muted)';
}

export function showReviewPanel(file, invoice, canvases, wrapper) {
  // Metadata skeleton
  $('#meta-filename').textContent = file.name;
  $('#meta-pages').textContent = canvases.length;
  $('#meta-time').textContent = '—';
  $('#meta-engine').textContent = wrapper ? `preview only (${wrapper})` : 'preview only';
  $('#engine-badge').textContent = wrapper || 'preview';

  // Confidence bars empty
  ['afm', 'invno', 'date', 'sap', 'sup'].forEach(f => setConfidence(f, 0));
  $('#mean-confidence').textContent = 'OCR pending…';

  // Fields empty (χρήστης θα τα γεμίσει ή θα τα γεμίσει το OCR)
  $('#fld-afm').value = '';
  $('#fld-invno').value = '';
  $('#fld-date').value = '';
  $('#fld-sap-manual').value = '';
  populateSupplierDropdown(null, []);
  populateSAPDropdown([], null);
  renderSAPCandidates([]);
  renderSupplierCandidates([]);

  // Hints
  $('#hint-supplier').textContent = 'Πληκτρολόγησε το ΑΦΜ που βλέπεις στο preview → αυτόματο match';
  $('#hint-supplier').className = 'field-hint';
  $('#hint-afm').textContent = '';
  $('#hint-afm').className = 'field-hint';
  $('#hint-sap').textContent = 'Γράψε το χειρόγραφο SAP Doc No που βλέπεις πάνω στο τιμολόγιο';
  $('#hint-sap').className = 'field-hint';

  $('#validation-errors').hidden = true;

  // Show preview canvases
  renderPreview(canvases);
}

export function renderPreview(canvases) {
  const container = $('#preview-container');
  container.innerHTML = '';
  state.previewZoom = state.previewZoom || 100;

  canvases.forEach((c, i) => {
    // Clone the canvas για να είναι safe (δεν επηρεάζεται από OCR operations)
    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = c.width;
    displayCanvas.height = c.height;
    displayCanvas.getContext('2d').drawImage(c, 0, 0);
    displayCanvas.className = 'preview-page';
    displayCanvas.style.width = `${state.previewZoom}%`;
    displayCanvas.dataset.pageIndex = i;
    container.appendChild(displayCanvas);
  });

  $('#preview-page-info').textContent = canvases.length > 1 ? `${canvases.length} σελίδες` : '1 σελίδα';
  $('#preview-zoom-label').textContent = `${state.previewZoom}%`;
}

export function populateReviewFromOCR(result, file, invoice) {
  const ext = result.extracted;

  setConfidence('afm', ext.confidence_afm);
  setConfidence('invno', ext.confidence_invoice_no);
  setConfidence('date', ext.confidence_date);
  setConfidence('sap', ext.confidence_sap_doc);

  // Fill fields μόνο αν είναι άδεια (μη overwrite του user typing)
  if (!$('#fld-afm').value) $('#fld-afm').value = ext.afm || '';
  if (!$('#fld-invno').value) $('#fld-invno').value = ext.invoice_number || '';
  if (!$('#fld-date').value && ext.invoice_date) $('#fld-date').value = fmtISODate(ext.invoice_date);
  if (ext.sap_doc_number) {
    $('#fld-sap-manual').value = ext.sap_doc_number;
  }

  const fullText = result.fullText || '';
  const { best, all } = matchSupplier(ext.afm, ext.supplier_name_hint, fullText);
  ext.confidence_supplier = best ? best.confidence : (all[0] ? all[0].confidence : 0);
  setConfidence('sup', ext.confidence_supplier);

  invoice.afm = ext.afm;
  invoice.invoice_number = ext.invoice_number;
  invoice.invoice_date = ext.invoice_date;
  invoice.sap_doc_number = ext.sap_doc_number;
  invoice.supplier_id = best ? best.supplier_id : null;
  invoice.status = 'needs_review';
  invoice.page_count = result.pageCount;

  populateSupplierDropdown(best, all);
  populateSAPDropdown(ext.sap_doc_candidates, ext.sap_doc_number);
  renderSAPCandidates(ext.sap_doc_candidates);
  renderSupplierCandidates(all);

  const avg = Math.round((ext.confidence_afm + ext.confidence_invoice_no + ext.confidence_date + ext.confidence_sap_doc + ext.confidence_supplier) / 5);
  $('#mean-confidence').textContent = `μέσος όρος: ${avg}%`;

  $('#meta-time').textContent = `${result.processingMs}ms`;
  $('#meta-engine').textContent = result.wrapper ? `${result.engine} (${result.wrapper})` : result.engine;

  // Update hints
  $('#hint-supplier').textContent = best
    ? `✓ Auto-matched: ${best.name} (${best.confidence}%)`
    : (all.length ? `${all.length} υποψήφιοι — έλεγξε ή γράψε το ΑΦΜ` : 'Δεν βρέθηκε — γράψε το ΑΦΜ');
  $('#hint-supplier').className = 'field-hint ' + (best ? 'ok' : 'warn');

  const afmOk = validateAfmChecksum(ext.afm || '');
  $('#hint-afm').textContent = ext.afm
    ? (afmOk ? '✓ Έγκυρο MOD-11' : '⚠ Αποτυχία MOD-11 — έλεγξε')
    : 'OCR δεν βρήκε ΑΦΜ — γράψε το που βλέπεις';
  $('#hint-afm').className = 'field-hint ' + (afmOk ? 'ok' : 'warn');

  const sapAuto = ext.confidence_sap_doc >= 90;
  $('#hint-sap').textContent = sapAuto
    ? '✓ Αυτόματη επιλογή (υψηλή αξιοπιστία)'
    : ext.sap_doc_number
      ? `⚠ Χαμηλή αξιοπιστία (${ext.confidence_sap_doc}%) — έλεγξε`
      : 'Το OCR δεν βρήκε SAP Doc No — γράψε το χειρόγραφο που βλέπεις';
  $('#hint-sap').className = 'field-hint ' + (sapAuto ? 'ok' : 'warn');

  // Debug info
  const rawText = result.fullText || '';
  $('#debug-text').textContent = rawText.slice(0, 5000);
  const found9 = [...rawText.matchAll(/(?<!\d)(\d{9})(?!\d)/g)]
    .map(m => ({ afm: m[1], valid: validateAfmChecksum(m[1]) }))
    .slice(0, 10);
  $('#debug-afms').innerHTML = found9.length
    ? '<strong>9ψήφια:</strong> ' + found9.map(x =>
        `<span class="mono">${x.afm}</span>${x.valid ? '✓' : '✗'}`
      ).join(' · ')
    : '<em style="color:var(--err)">Δεν βρέθηκαν 9ψήφια στο κείμενο</em>';
}

// ═══════════════════════════════════════════════════════════
// LIVE AFM MATCHING — καθώς πληκτρολογείς
// ═══════════════════════════════════════════════════════════
let _afmMatchDebounce;
export function handleAfmInput() {
  clearTimeout(_afmMatchDebounce);
  _afmMatchDebounce = setTimeout(() => {
    const raw = $('#fld-afm').value.trim();
    const digits = raw.replace(/\D/g, '');
    const hintEl = $('#hint-afm');

    if (!digits) {
      hintEl.textContent = '';
      hintEl.className = 'field-hint';
      return;
    }

    if (digits.length < 9) {
      hintEl.textContent = `${digits.length}/9 ψηφία…`;
      hintEl.className = 'field-hint';
      return;
    }

    const afm = digits.slice(0, 9);
    const validMod11 = validateAfmChecksum(afm);

    // Άμεσο lookup στη λίστα προμηθευτών
    const { best, all } = matchSupplier(afm, null);
    if (best) {
      $('#fld-supplier').value = best.supplier_id;
      hintEl.textContent = `✓ ${validMod11 ? 'MOD-11 έγκυρο · ' : ''}Βρέθηκε: ${best.name}`;
      hintEl.className = 'field-hint ok';
      $('#hint-supplier').textContent = `✓ ${best.name} — folder: ${best.folder_path}`;
      $('#hint-supplier').className = 'field-hint ok';
      populateSupplierDropdown(best, all);
      renderSupplierCandidates(all);
      setConfidence('sup', best.confidence);
      setConfidence('afm', validMod11 ? 99 : 75);
    } else if (all.length) {
      hintEl.textContent = `${validMod11 ? '✓ MOD-11 έγκυρο' : '⚠ MOD-11 απέτυχε'} · ${all.length} πιθανοί προμηθευτές`;
      hintEl.className = 'field-hint warn';
      populateSupplierDropdown(null, all);
      renderSupplierCandidates(all);
      setConfidence('sup', all[0].confidence);
      setConfidence('afm', validMod11 ? 88 : 60);
    } else {
      hintEl.textContent = validMod11
        ? '✓ MOD-11 έγκυρο, αλλά ΔΕΝ βρέθηκε σε λίστα προμηθευτών'
        : '⚠ Το ΑΦΜ δεν περνάει MOD-11 (πιθανό τυπογραφικό)';
      hintEl.className = 'field-hint ' + (validMod11 ? 'warn' : 'err');
      $('#hint-supplier').textContent = 'Επίλεξε προμηθευτή χειροκίνητα από dropdown';
      setConfidence('sup', 0);
      setConfidence('afm', validMod11 ? 80 : 40);
    }
  }, 250);
}

export function setConfidence(field, pct) {
  const bar = $(`#conf-${field}`);
  const label = $(`#conf-${field}-pct`);
  const cls = confidenceClass(pct);
  bar.style.width = `${Math.max(pct, 3)}%`;
  bar.className = `conf-bar ${cls}`;
  label.textContent = `${pct}%`;
  label.className = `conf-pct ${cls}`;
}

export function populateSupplierDropdown(best, candidates) {
  const sel = $('#fld-supplier');
  sel.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '— Επιλέξτε προμηθευτή —';
  sel.appendChild(empty);

  const seen = new Set();
  const add = (s, confidence) => {
    if (seen.has(s.supplier_id || s.id)) return;
    seen.add(s.supplier_id || s.id);
    const opt = document.createElement('option');
    opt.value = s.supplier_id || s.id;
    const label = `${s.name} — ${s.afm}`;
    opt.textContent = confidence != null ? `${label} (${confidence}%)` : label;
    sel.appendChild(opt);
  };
  if (best) add(best, best.confidence);
  for (const c of candidates || []) add(c, c.confidence);

  const divider = document.createElement('option');
  divider.disabled = true;
  divider.textContent = '──────────';
  sel.appendChild(divider);
  for (const s of state.suppliers.filter(x => x.status === 'active')) add(s, null);

  if (best) sel.value = best.supplier_id;
}

export function populateSAPDropdown(candidates, best) {
  const sel = $('#fld-sap');
  sel.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '— Επιλέξτε —';
  sel.appendChild(empty);
  for (const c of candidates || []) {
    const opt = document.createElement('option');
    opt.value = c.value;
    opt.textContent = `${c.value} · ${c.confidence}% · σελ ${c.page}`;
    sel.appendChild(opt);
  }
  if (best) sel.value = best;
}

export function renderSAPCandidates(candidates) {
  const container = $('#sap-candidates');
  container.innerHTML = '';
  if (!candidates || !candidates.length) {
    container.innerHTML = '<div class="candidate-meta">Δεν βρέθηκαν</div>';
    return;
  }
  for (const c of candidates) {
    const el = document.createElement('div');
    el.className = 'candidate';
    el.innerHTML = `
      <span class="candidate-value">${c.value}</span>
      <span class="candidate-badge ${confidenceClass(c.confidence)}">${c.confidence}%</span>
      <span class="candidate-meta">${escapeHtml(c.source)} · σελ ${c.page} · ${escapeHtml(c.reason)}</span>
    `;
    el.addEventListener('click', () => {
      $('#fld-sap').value = c.value;
      $('#fld-sap-manual').value = '';
      toast(`SAP Doc No: ${c.value}`, 'ok');
    });
    container.appendChild(el);
  }
}

export function renderSupplierCandidates(candidates) {
  const container = $('#sup-candidates');
  container.innerHTML = '';
  if (!candidates || !candidates.length) {
    container.innerHTML = '<div class="candidate-meta">Δεν βρέθηκαν</div>';
    return;
  }
  for (const c of candidates) {
    const el = document.createElement('div');
    el.className = 'candidate';
    el.innerHTML = `
      <span class="candidate-name">${escapeHtml(c.name)}</span>
      <span class="candidate-badge ${confidenceClass(c.confidence)}">${c.confidence}%</span>
      <span class="candidate-meta">${c.afm} · SAP ${c.sap_vendor_code} · ${c.match_method}</span>
    `;
    el.addEventListener('click', () => {
      $('#fld-supplier').value = c.supplier_id;
      toast(`Προμηθευτής: ${c.name}`, 'ok');
    });
    container.appendChild(el);
  }
}


export function showValidationErrors(errors) {
  const box = $('#validation-errors');
  box.innerHTML = '<div class="validation-errors-title">Απαιτούνται διορθώσεις</div><ul></ul>';
  const ul = box.querySelector('ul');
  for (const e of errors) {
    const li = document.createElement('li');
    li.textContent = `• ${e.message}`;
    ul.appendChild(li);
  }
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function resetUploadView() {
  state.currentInvoiceId = null;
  state.currentUpload = null;
  $('#review').hidden = true;
  $('#upload-zone').hidden = false;
  $('#file-input').value = '';
}

// ═══════════════════════════════════════════════════════════

export function applyPreviewZoom() {
  $('#preview-zoom-label').textContent = `${state.previewZoom}%`;
  document.querySelectorAll('#preview-container .preview-page').forEach(c => {
    c.style.width = `${state.previewZoom}%`;
  });
}

export function initUpload() {
  uploadZoneEl = $('#upload-zone');
  fileInputEl = $('#file-input');
  uploadZoneEl?.addEventListener('click', (e) => {
    if (e.target.tagName !== 'LABEL') fileInputEl.click();
  });
  uploadZoneEl?.addEventListener('dragover', (e) => { e.preventDefault(); uploadZoneEl.classList.add('is-dragover'); });
  uploadZoneEl?.addEventListener('dragleave', () => uploadZoneEl.classList.remove('is-dragover'));
  uploadZoneEl?.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZoneEl.classList.remove('is-dragover');
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length === 1) handleFile(files[0]);
    else handleBatch(files);
  });
  fileInputEl?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    if (files.length === 1) handleFile(files[0]);
    else handleBatch(files);
  });

  document.addEventListener('click', (e) => {
    if (e.target?.id === 'btn-batch-cancel') {
      if (state.batch.active) {
        if (confirm('Ακύρωση batch; Τα αρχεία που έχουν ήδη επεξεργαστεί θα παραμείνουν.')) {
          state.batch.cancelled = true;
          toast('Ακύρωση…', 'warn');
        }
      } else {
        $('#batch-panel').hidden = true;
        $('#upload-zone').hidden = false;
        fileInputEl.value = '';
      }
    }
  });

  $('#btn-archive')?.addEventListener('click', onArchiveClick);
  $('#btn-cancel')?.addEventListener('click', onCancelClick);
  $('#btn-toggle-debug')?.addEventListener('click', onToggleDebug);
  $('#fld-afm')?.addEventListener('input', handleAfmInput);
  $('#preview-zoom-in')?.addEventListener('click', () => {
    state.previewZoom = Math.min(200, (state.previewZoom || 100) + 25);
    applyPreviewZoom();
  });
  $('#preview-zoom-out')?.addEventListener('click', () => {
    state.previewZoom = Math.max(50, (state.previewZoom || 100) - 25);
    applyPreviewZoom();
  });
}

async function onArchiveClick() {
  if (!state.currentInvoiceId) return;
  const invoice = state.invoices.find(i => i.id === state.currentInvoiceId);
  if (!invoice) return;
  const sap = $('#fld-sap-manual').value.trim() || $('#fld-sap').value.trim();
  const payload = {
    supplier_id: parseInt($('#fld-supplier').value) || 0,
    afm: $('#fld-afm').value.trim(),
    invoice_number: $('#fld-invno').value.trim(),
    invoice_date: $('#fld-date').value || null,
    sap_doc_number: sap,
    _excludeId: invoice.id,
  };
  const report = validateForArchive(payload);
  if (!report.valid) {
    showValidationErrors(report.errors);
    audit('validation', 'failure', 'Validation failed', { invoice_id: invoice.id, details: { errors: report.errors } });
    return;
  }
  const overrides = [];
  if (invoice.afm && invoice.afm !== payload.afm) overrides.push('afm');
  if (invoice.invoice_number && invoice.invoice_number !== payload.invoice_number) overrides.push('invoice_number');
  if (invoice.sap_doc_number && invoice.sap_doc_number !== payload.sap_doc_number) overrides.push('sap_doc_number');
  if (invoice.supplier_id && invoice.supplier_id !== payload.supplier_id) overrides.push('supplier');
  if (overrides.length) {
    audit('manual_override', 'warning', `User changed: ${overrides.join(', ')}`, {
      invoice_id: invoice.id, actor: 'user', details: { overrides },
    });
  }
  const supplier = state.suppliers.find(s => s.id === payload.supplier_id);
  const filename = buildArchiveFilename(payload.invoice_number, payload.sap_doc_number, payload.invoice_date);
  const duplicate = findDuplicateInvoice(supplier.id, payload.invoice_number, payload.sap_doc_number);
  if (duplicate && duplicate.id !== invoice.id) {
    toast(`⚠ Duplicate: υπάρχει ήδη ως ${duplicate.archived_filename}`, 'err');
    audit('archive', 'warning', `Rejected duplicate: υπάρχει ήδη #${duplicate.id}`, { invoice_id: invoice.id, actor: 'user' });
    return;
  }
  const actualFolder = await resolveSupplierFolder(supplier.sap_vendor_code, supplier.folder_path);
  const archivedPath = `${actualFolder}/${filename}`;
  let outputBytes = null;
  if (state.currentUpload?.file) {
    try {
      outputBytes = await state.currentUpload.file.arrayBuffer();
      storeArchivedFile(actualFolder, filename, outputBytes);
    } catch (e) { console.warn('Could not store archived file bytes:', e); }
  }
  let diskPath = null;
  if (state.archiveRoot.handle && outputBytes) {
    try {
      const result = await writeToDisk(actualFolder, filename, outputBytes, payload.invoice_date);
      diskPath = result.fullPath;
      toast(`✓ Γράφτηκε σε: ${diskPath}`, 'ok');
    } catch (e) {
      if (e.code === 'DUPLICATE') {
        toast(`⚠ Το αρχείο ${filename} υπάρχει ήδη στον δίσκο — δεν αντικαταστάθηκε`, 'err');
        audit('archive', 'warning', `Disk duplicate rejected: ${filename}`, { invoice_id: invoice.id });
        return;
      }
      console.warn('Disk write failed:', e);
      toast(`Δεν γράφτηκε στον δίσκο: ${e.message}`, 'err');
    }
  }
  Object.assign(invoice, {
    supplier_id: payload.supplier_id, afm: payload.afm,
    invoice_number: payload.invoice_number, invoice_date: payload.invoice_date,
    sap_doc_number: payload.sap_doc_number, archived_filename: filename,
    archived_path: diskPath || archivedPath, archived_at: new Date().toISOString(),
    archived_by: state.currentUser || 'unknown', status: 'archived', status_message: null,
  });
  audit('archive', 'success', `Archived → ${diskPath || archivedPath}`, {
    invoice_id: invoice.id, actor: 'user',
    details: { filename, path: diskPath || archivedPath, on_disk: !!diskPath },
  });
  toast(`Αρχειοθετήθηκε: ${filename}${diskPath ? ' (στον δίσκο)' : ''}`, 'ok');
  window.dispatchEvent(new CustomEvent('review-badge-update'));
  resetUploadView();
}

function onCancelClick() {
  if (!state.currentInvoiceId) return;
  if (!confirm('Ακύρωση και διαγραφή του τιμολογίου;')) return;
  state.invoices = state.invoices.filter(i => i.id !== state.currentInvoiceId);
  audit('delete', 'success', `Deleted invoice ${state.currentInvoiceId}`, { actor: 'user' });
  toast('Ακυρώθηκε', 'ok');
  window.dispatchEvent(new CustomEvent('review-badge-update'));
  resetUploadView();
}

function onToggleDebug() {
  const content = $('#debug-content');
  const btn = $('#btn-toggle-debug');
  if (content.hidden) { content.hidden = false; btn.textContent = 'απόκρυψη'; }
  else { content.hidden = true; btn.textContent = 'εμφάνιση'; }
}
