#!/usr/bin/env python3
"""Build FinanceOS modular structure from monolithic index.html."""

from pathlib import Path
import re

ROOT = Path('/workspace')
SRC = ROOT / 'index.html'
OUT = ROOT / 'FinanceOS'


def read_src():
    return SRC.read_text(encoding='utf-8')


def write(rel: str, content: str):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content.rstrip() + '\n', encoding='utf-8')


def slice_js(js: str, start_marker: str, end_marker: str | None = None) -> str:
    s = js.index(start_marker)
    if end_marker:
        e = js.index(end_marker, s)
        return js[s:e].strip()
    return js[s:].strip()


def export_funcs(code: str, names: list[str]) -> str:
    for name in names:
        code = code.replace(f'function {name}(', f'export function {name}(')
        code = code.replace(f'async function {name}(', f'export async function {name}(')
    return code


def strip_upload_listeners(body: str) -> str:
    """Remove top-level event listeners moved to initUpload."""
    body = re.sub(
        r"// Batch cancel button\ndocument\.addEventListener\('click'.*?\}\);\n",
        '',
        body,
        flags=re.S,
    )
    body = re.sub(
        r"// ─── Archive action[\s\S]*?// Preview zoom controls[\s\S]*?function applyPreviewZoom\(\) \{[\s\S]*?\}\n",
        '',
        body,
        count=1,
    )
    body = body.replace('export export function', 'export function')
    return body


def build_upload_module(body: str) -> str:
    return f"""/** Upload, batch OCR, review panel */
import {{ state }} from './state.js';
import {{ $, toast, fmtISODate, confidenceClass, escapeHtml }} from './utils.js';
import {{ validateAfmChecksum }} from './helpers.js';
import {{ audit }} from './audit.js';
import {{
  verifyPermission, writeToDisk, resolveSupplierFolder, findDuplicateInvoice,
  storeArchivedFile, splitPdfByPages, downloadArchiveZip,
}} from './storage.js';
import {{ runClaudeVisionOCRDirect }} from './ai.js';
import {{
  runRealOCR, renderToCanvases, matchSupplier, validateForArchive, buildArchiveFilename,
}} from './ocr.js';

const uploadZone = $('#upload-zone');
const fileInput = $('#file-input');

{body}

export function applyPreviewZoom() {{
  $('#preview-zoom-label').textContent = `${{state.previewZoom}}%`;
  document.querySelectorAll('#preview-container .preview-page').forEach(c => {{
    c.style.width = `${{state.previewZoom}}%`;
  }});
}}

export function initUpload() {{
  uploadZone?.addEventListener('click', (e) => {{
    if (e.target.tagName !== 'LABEL') fileInput.click();
  }});
  uploadZone?.addEventListener('dragover', (e) => {{ e.preventDefault(); uploadZone.classList.add('is-dragover'); }});
  uploadZone?.addEventListener('dragleave', () => uploadZone.classList.remove('is-dragover'));
  uploadZone?.addEventListener('drop', (e) => {{
    e.preventDefault();
    uploadZone.classList.remove('is-dragover');
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length === 1) handleFile(files[0]);
    else handleBatch(files);
  }});
  fileInput?.addEventListener('change', (e) => {{
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    if (files.length === 1) handleFile(files[0]);
    else handleBatch(files);
  }});

  document.addEventListener('click', (e) => {{
    if (e.target?.id === 'btn-batch-cancel') {{
      if (state.batch.active) {{
        if (confirm('Ακύρωση batch; Τα αρχεία που έχουν ήδη επεξεργαστεί θα παραμείνουν.')) {{
          state.batch.cancelled = true;
          toast('Ακύρωση…', 'warn');
        }}
      }} else {{
        $('#batch-panel').hidden = true;
        $('#upload-zone').hidden = false;
        fileInput.value = '';
      }}
    }}
  }});

  $('#btn-archive')?.addEventListener('click', onArchiveClick);
  $('#btn-cancel')?.addEventListener('click', onCancelClick);
  $('#btn-toggle-debug')?.addEventListener('click', onToggleDebug);
  $('#fld-afm')?.addEventListener('input', handleAfmInput);
  $('#preview-zoom-in')?.addEventListener('click', () => {{
    state.previewZoom = Math.min(200, (state.previewZoom || 100) + 25);
    applyPreviewZoom();
  }});
  $('#preview-zoom-out')?.addEventListener('click', () => {{
    state.previewZoom = Math.max(50, (state.previewZoom || 100) - 25);
    applyPreviewZoom();
  }});
}}

async function onArchiveClick() {{
  if (!state.currentInvoiceId) return;
  const invoice = state.invoices.find(i => i.id === state.currentInvoiceId);
  if (!invoice) return;
  const sap = $('#fld-sap-manual').value.trim() || $('#fld-sap').value.trim();
  const payload = {{
    supplier_id: parseInt($('#fld-supplier').value) || 0,
    afm: $('#fld-afm').value.trim(),
    invoice_number: $('#fld-invno').value.trim(),
    invoice_date: $('#fld-date').value || null,
    sap_doc_number: sap,
    _excludeId: invoice.id,
  }};
  const report = validateForArchive(payload);
  if (!report.valid) {{
    showValidationErrors(report.errors);
    audit('validation', 'failure', 'Validation failed', {{ invoice_id: invoice.id, details: {{ errors: report.errors }} }});
    return;
  }}
  const overrides = [];
  if (invoice.afm && invoice.afm !== payload.afm) overrides.push('afm');
  if (invoice.invoice_number && invoice.invoice_number !== payload.invoice_number) overrides.push('invoice_number');
  if (invoice.sap_doc_number && invoice.sap_doc_number !== payload.sap_doc_number) overrides.push('sap_doc_number');
  if (invoice.supplier_id && invoice.supplier_id !== payload.supplier_id) overrides.push('supplier');
  if (overrides.length) {{
    audit('manual_override', 'warning', `User changed: ${{overrides.join(', ')}}`, {{
      invoice_id: invoice.id, actor: 'user', details: {{ overrides }},
    }});
  }}
  const supplier = state.suppliers.find(s => s.id === payload.supplier_id);
  const filename = buildArchiveFilename(payload.invoice_number, payload.sap_doc_number, payload.invoice_date);
  const duplicate = findDuplicateInvoice(supplier.id, payload.invoice_number, payload.sap_doc_number);
  if (duplicate && duplicate.id !== invoice.id) {{
    toast(`⚠ Duplicate: υπάρχει ήδη ως ${{duplicate.archived_filename}}`, 'err');
    audit('archive', 'warning', `Rejected duplicate: υπάρχει ήδη #${{duplicate.id}}`, {{ invoice_id: invoice.id, actor: 'user' }});
    return;
  }}
  const actualFolder = await resolveSupplierFolder(supplier.sap_vendor_code, supplier.folder_path);
  const archivedPath = `${{actualFolder}}/${{filename}}`;
  let outputBytes = null;
  if (state.currentUpload?.file) {{
    try {{
      outputBytes = await state.currentUpload.file.arrayBuffer();
      storeArchivedFile(actualFolder, filename, outputBytes);
    }} catch (e) {{ console.warn('Could not store archived file bytes:', e); }}
  }}
  let diskPath = null;
  if (state.archiveRoot.handle && outputBytes) {{
    try {{
      const result = await writeToDisk(actualFolder, filename, outputBytes);
      diskPath = result.fullPath;
      toast(`✓ Γράφτηκε σε: ${{diskPath}}`, 'ok');
    }} catch (e) {{
      if (e.code === 'DUPLICATE') {{
        toast(`⚠ Το αρχείο ${{filename}} υπάρχει ήδη στον δίσκο — δεν αντικαταστάθηκε`, 'err');
        audit('archive', 'warning', `Disk duplicate rejected: ${{filename}}`, {{ invoice_id: invoice.id }});
        return;
      }}
      console.warn('Disk write failed:', e);
      toast(`Δεν γράφτηκε στον δίσκο: ${{e.message}}`, 'err');
    }}
  }}
  Object.assign(invoice, {{
    supplier_id: payload.supplier_id, afm: payload.afm,
    invoice_number: payload.invoice_number, invoice_date: payload.invoice_date,
    sap_doc_number: payload.sap_doc_number, archived_filename: filename,
    archived_path: diskPath || archivedPath, archived_at: new Date().toISOString(),
    archived_by: state.currentUser || 'unknown', status: 'archived', status_message: null,
  }});
  audit('archive', 'success', `Archived → ${{diskPath || archivedPath}}`, {{
    invoice_id: invoice.id, actor: 'user',
    details: {{ filename, path: diskPath || archivedPath, on_disk: !!diskPath }},
  }});
  toast(`Αρχειοθετήθηκε: ${{filename}}${{diskPath ? ' (στον δίσκο)' : ''}}`, 'ok');
  window.dispatchEvent(new CustomEvent('review-badge-update'));
  resetUploadView();
}}

function onCancelClick() {{
  if (!state.currentInvoiceId) return;
  if (!confirm('Ακύρωση και διαγραφή του τιμολογίου;')) return;
  state.invoices = state.invoices.filter(i => i.id !== state.currentInvoiceId);
  audit('delete', 'success', `Deleted invoice ${{state.currentInvoiceId}}`, {{ actor: 'user' }});
  toast('Ακυρώθηκε', 'ok');
  window.dispatchEvent(new CustomEvent('review-badge-update'));
  resetUploadView();
}}

function onToggleDebug() {{
  const content = $('#debug-content');
  const btn = $('#btn-toggle-debug');
  if (content.hidden) {{ content.hidden = false; btn.textContent = 'απόκρυψη'; }}
  else {{ content.hidden = true; btn.textContent = 'εμφάνιση'; }}
}}
"""


def main():
    text = read_src()
    css = re.search(r'<style>(.*?)</style>', text, re.S).group(1).strip()
    js_start = text.rindex('<script>\n/* ═══')
    js = text[js_start + len('<script>\n'): text.rindex('</script>')].strip()
    body = re.search(r'<body>(.*?)</body>', text, re.S).group(1)
    body = re.sub(r'\s*<div class="toast-container" id="toast-container"></div>\s*', '\n', body).strip()
    body = re.sub(
        r'<script>\n/\* ═+[\s\S]*?</script>\s*',
        '',
        body,
        count=1,
    )
    head = text[: text.index('<style>')].rstrip()

    # ── CSS split ─────────────────────────────────────────
    css = re.sub(
        r'\.upload-hint \{ margin-top: 12px[^}]+\}\n\.upload-hint code \{[^}]+\}\n',
        '',
        css,
        count=1,
    )
    css_parts = {
        'main.css': slice_js(css, ':root {', '/* ─── Sidebar'),
        'layout.css': slice_js(css, '/* ─── Sidebar', '/* ─── Buttons'),
        'components.css': (
            slice_js(css, '/* ─── Buttons', '/* ─── Form controls')
            + '\n\n'
            + slice_js(css, '/* ─── Side panels', '/* ─── Data tables')
            + '\n\n'
            + slice_js(css, '/* ─── Toasts', '@media')
        ),
        'forms.css': slice_js(css, '/* ─── Form controls', '/* ─── Side panels'),
        'tables.css': slice_js(css, '/* ─── Data tables', '/* ─── Dashboard'),
        'dashboard.css': slice_js(css, '/* ─── Dashboard', '/* ─── Archive browser'),
        'charts.css': (
            '/* Chart canvas containers */\n'
            '.chart-card canvas { display: block; max-width: 100%; }\n'
        ),
        'modals.css': (
            '.modal-overlay { position: fixed; inset: 0; background: rgba(31,27,21,0.5); '
            'z-index: 2000; display: grid; place-items: center; padding: 20px; }\n'
            '.modal-panel { background: var(--surface); border-radius: var(--r-lg); '
            'max-width: 600px; width: 100%; padding: 32px; box-shadow: var(--shadow-lg); }\n'
        ),
        'utilities.css': (
            '.u-mono { font-family: var(--font-mono); }\n'
            '.u-hidden { display: none !important; }\n'
        ),
        'responsive.css': slice_js(css, '@media (max-width: 900px)'),
    }
    for fname, content in css_parts.items():
        write(f'css/{fname}', f'/* FinanceOS — {fname} */\n{content}')

    # ── JS modules ────────────────────────────────────────
    state_code = export_funcs(
        slice_js(js, '// ─── State ─', '// ─── Helpers ─').replace('const state =', 'export const state ='),
        [],
    )
    state_code += """

// Runtime extensions (initialized once)
state.dashCharts = {};
state.archiveBrowserCache = null;
state.archiveRoot = { handle: null, name: null };
state.folderCache = new Map();
state.archivedFiles = new Map();
state.batch = {
  queue: [], active: false, cancelled: false, autoArchive: true,
  stats: { archived: 0, review: 0, failed: 0 },
};
"""
    write('js/state.js', '/** Application state */\n' + state_code)

    helpers_block = slice_js(js, '// ─── Helpers ─', '// GREEK LANGUAGE HELPERS')
    utils_code = f"""/** DOM & formatting utilities */
{helpers_block}
export {{ $, $$, toast, fmtDate, fmtDateTime, fmtISODate, confidenceClass, escapeHtml, debounce }};
"""
    write('js/utils.js', utils_code)

    greek = export_funcs(slice_js(js, '// GREEK LANGUAGE HELPERS', '// AFM MOD-11'), ['stripAccents', 'normalizeForMatch'])
    afm = export_funcs(slice_js(js, '// AFM MOD-11', '// FUZZY MATCHING'), ['validateAfmChecksum'])
    fuzzy = export_funcs(slice_js(js, '// FUZZY MATCHING', '// SAP DOC NUMBER'), ['levenshtein', 'similarity'])
    sap = export_funcs(
        slice_js(js, '// SAP DOC NUMBER', '// DASHBOARD — KPIs').replace('const SAP_PREFIXES', 'export const SAP_PREFIXES'),
        ['sapPrefixBoost', 'sapLengthBoost'],
    )
    write('js/helpers.js', '/** Validation & matching helpers */\n' + greek + '\n\n' + afm + '\n\n' + fuzzy + '\n\n' + sap)

    write('js/notifications.js', "/** Toast notifications */\nexport { toast } from './utils.js';\n")

    audit_fn = export_funcs(slice_js(js, 'function audit(action', 'function seedSuppliers'), ['audit'])
    audit_view = slice_js(js, '// AUDIT VIEW', '// BOOT')
    audit_code = f"""/** Audit trail */
import {{ state }} from './state.js';
import {{ $, fmtDateTime, escapeHtml }} from './utils.js';
import {{ scheduleSave }} from './storage.js';

{audit_fn}

export function initAuditView() {{
  $('#audit-action').addEventListener('change', renderAudit);
  $('#audit-outcome').addEventListener('change', renderAudit);
}}

{export_funcs(audit_view, ['renderAudit'])}
"""
    write('js/audit.js', audit_code)

    storage_fs = slice_js(js, 'state.archiveRoot = { handle: null', '// BATCH PROCESSING')
    storage_shared = slice_js(js, '// SHARED STATE —', '// USER IDENTIFICATION')
    storage_user = slice_js(js, '// USER IDENTIFICATION', '// Χρησιμοποιεί File System Access')
    pdf_split = slice_js(js, '// PDF SPLITTING —', '// ARCHIVE STORAGE —')
    archive_store = slice_js(js, 'state.archivedFiles = new Map', '// SETTINGS PERSISTENCE')

    storage_exports = [
        'scheduleSharedSave', 'saveStateToArchiveRoot', 'writeJsonToDir', 'readJsonFromDir',
        'loadStateFromArchiveRoot', 'reloadFromShared', 'loadCurrentUser', 'setCurrentUser', 'promptForUser',
        'resolveSupplierFolder', 'idbOpen', 'idbSaveHandle', 'idbLoadHandle', 'idbClearHandle',
        'idbKvGet', 'idbSaveState', 'idbLoadState', 'scheduleSave', 'verifyPermission', 'pickArchiveRoot',
        'showSandboxInstructions', 'clearArchiveRoot', 'updateArchiveRootDisplay', 'writeToDisk', 'fileExists',
        'findDuplicateInvoice', 'splitPdfByPages', 'storeArchivedFile', 'downloadArchiveZip',
        'arrayBufferToBase64', 'downscaleCanvas',
    ]
    storage_body = export_funcs(
        storage_shared + '\n\n' + storage_user + '\n\n' + storage_fs + '\n\n' + pdf_split + '\n\n' + archive_store,
        storage_exports,
    )
    storage_body = storage_body.replace(
        'const FS_SUPPORTED = typeof window.showDirectoryPicker',
        'export const FS_SUPPORTED = typeof window.showDirectoryPicker',
    )
    storage_code = f"""/** Persistence: IndexedDB, File System Access, shared JSON */
import {{ state }} from './state.js';
import {{ $, toast, escapeHtml }} from './utils.js';
import {{ audit }} from './audit.js';
import {{ renderSuppliers }} from './suppliers.js';
import {{ renderInvoices }} from './invoices.js';
import {{ renderAudit }} from './audit.js';
import {{ updateReviewBadge }} from './badges.js';
import {{ updateEngineStatus }} from './settings.js';

let _sharedSaveTimer;
let _saveTimer;

{storage_body}
"""
    write('js/storage.js', storage_code)

    ai_body = export_funcs(slice_js(js, 'function buildAIPrompt', '// PDF SPLITTING'), [
        'buildAIPrompt', 'runClaudeVisionOCR', 'runClaudeVisionOCRDirect', 'callClaudeAPI',
        'extractJsonFromText', 'trackAIUsage',
    ])
    write('js/ai.js', f"""/** Claude Vision AI OCR */
import {{ state }} from './state.js';
import {{ downscaleCanvas, arrayBufferToBase64 }} from './storage.js';
import {{ saveSettings, updateEngineStatus }} from './settings.js';

{ai_body}
""")

    settings_body = export_funcs(slice_js(js, '// SETTINGS PERSISTENCE', '// REAL OCR — Tesseract'), [
        'loadSettings', 'saveSettings', 'applySettingsToUI', 'updateEngineStatus', 'initSettings',
    ])
    write('js/settings.js', f"""/** AI & app settings */
import {{ state }} from './state.js';
import {{ $, toast, escapeHtml }} from './utils.js';
import {{ pickArchiveRoot, clearArchiveRoot, reloadFromShared, updateArchiveRootDisplay, setCurrentUser }} from './storage.js';

{settings_body}
""")

    ocr_body = export_funcs(
        slice_js(js, '// REAL OCR — Tesseract', 'function audit(action'),
        [
            'getWorker', 'renderPdfToCanvases', 'loadImageToCanvas', 'runRealOCR', 'renderToCanvases',
            'extractAfm', 'extractInvoiceNumber', 'extractDate', 'extractSapDocCandidates',
            'extractSupplierNameHint', 'extractAllFields', 'matchSupplier', 'buildCandidate',
            'validateForArchive', 'sanitizePart', 'buildArchiveFilename',
        ],
    )
    write('js/ocr.js', f"""/** Tesseract OCR & field extraction */
import {{ state }} from './state.js';
import {{ stripAccents, validateAfmChecksum, similarity, sapPrefixBoost, sapLengthBoost }} from './helpers.js';

let _tesseractWorker = null;

{ocr_body}
""")

    charts_body = export_funcs(
        slice_js(js, 'function renderMonthlyChart', 'state.archiveBrowserCache'),
        ['renderMonthlyChart', 'renderStatusChart', 'renderSuppliersChart'],
    )
    write('js/charts.js', f"""/** Chart.js visualizations */
import {{ state }} from './state.js';
import {{ $, escapeHtml }} from './utils.js';

{charts_body}
""")

    analytics_code = """/** Dashboard KPI calculations */
import { state } from './state.js';

export function fmtEUR(v) {
  return new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);
}

export function getArchivedForPeriod(periodDays) {
  const now = new Date();
  const cutoff = periodDays > 0 ? new Date(now.getTime() - periodDays * 86400000) : new Date(0);
  return state.invoices.filter(i =>
    i.status === 'archived' && i.archived_at && new Date(i.archived_at) >= cutoff
  );
}
"""
    write('js/analytics.js', analytics_code)

    dash_body = export_funcs(
        slice_js(js, 'function renderDashboard', 'function renderMonthlyChart').replace('state.dashCharts = {};', '')
        + '\n\n'
        + export_funcs(slice_js(js, 'function renderRecentActivity', 'state.archiveBrowserCache'), ['renderRecentActivity']),
        ['renderDashboard'],
    )
    dash_body = dash_body.replace('const fmtEUR = (v) => new Intl.NumberFormat', 'const fmtEUR = (v) => new Intl.NumberFormat')
    dash_body = re.sub(
        r"const fmtEUR = \(v\) => new Intl\.NumberFormat\('el-GR', \{ style: 'currency', currency: 'EUR', maximumFractionDigits: 0 \}\)\.format\(v\);",
        "import { fmtEUR } from './analytics.js';\n  // fmtEUR imported",
        dash_body,
        count=1,
    )
    # Fix renderDashboard to use imports
    dash_body = dash_body.replace(
        "  const fmtEUR = (v) => new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);\n",
        "",
    )
    write('js/dashboard.js', f"""/** Dashboard view */
import {{ state }} from './state.js';
import {{ $, escapeHtml }} from './utils.js';
import {{ fmtEUR, getArchivedForPeriod }} from './analytics.js';
import {{ renderMonthlyChart, renderStatusChart, renderSuppliersChart }} from './charts.js';

export function renderDashboard() {{
  const periodDays = parseInt($('#dash-period')?.value || '365');
  const archived = getArchivedForPeriod(periodDays);
  const needsReview = state.invoices.filter(i => i.status === 'needs_review').length;
  const duplicates = state.invoices.filter(i => i.status === 'duplicate').length;
  const totalValue = archived.reduce((sum, i) => sum + (Number(i.total_amount) || 0), 0);
  const totalVat = archived.reduce((sum, i) => sum + (Number(i.vat_amount) || 0), 0);
  const uniqueSuppliers = new Set(archived.map(i => i.supplier_id).filter(Boolean)).size;
  const avgValue = archived.length > 0 ? totalValue / archived.length : 0;

  $('#dash-kpis').innerHTML = `
    <div class="kpi-card ok">
      <div class="kpi-label">Αρχειοθετημένα</div>
      <div class="kpi-value">${{archived.length}}<span class="kpi-unit">τιμολόγια</span></div>
      <div class="kpi-delta">${{periodDays > 0 ? `τελευταίες ${{periodDays}} μέρες` : 'όλα'}}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Συνολική Αξία</div>
      <div class="kpi-value mono">${{fmtEUR(totalValue)}}</div>
      <div class="kpi-delta">ΦΠΑ: ${{fmtEUR(totalVat)}}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Μέσο Ποσό</div>
      <div class="kpi-value mono">${{fmtEUR(avgValue)}}</div>
      <div class="kpi-delta">${{uniqueSuppliers}} προμηθευτές</div>
    </div>
    <div class="kpi-card ${{needsReview > 0 ? 'warn' : ''}}">
      <div class="kpi-label">Εκκρεμότητες</div>
      <div class="kpi-value">${{needsReview}}<span class="kpi-unit">έλεγχος</span></div>
      <div class="kpi-delta">${{duplicates}} duplicates</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Χρήστες</div>
      <div class="kpi-value">${{new Set(archived.map(i => i.archived_by).filter(Boolean)).size || 1}}</div>
      <div class="kpi-delta">${{state.currentUser ? `συνδεδεμένος: ${{state.currentUser}}` : 'χωρίς όνομα χρήστη'}}</div>
    </div>
  `;

  renderMonthlyChart(archived, periodDays);
  renderStatusChart();
  renderSuppliersChart(archived);
  renderRecentActivity();
}}

{export_funcs(slice_js(js, 'function renderRecentActivity', 'state.archiveBrowserCache'), ['renderRecentActivity'])}
""")

    archive_body = export_funcs(slice_js(js, 'state.archiveBrowserCache', 'function exportArchivedToExcel'), [
        'loadArchiveBrowser', 'renderArchiveBrowser', 'openArchivedFileFromDisk',
    ])
    write('js/archive.js', f"""/** Archive folder browser */
import {{ state }} from './state.js';
import {{ $, toast, escapeHtml, debounce }} from './utils.js';
import {{ verifyPermission }} from './storage.js';

{archive_body}
""")

    export_body = export_funcs(slice_js(js, 'function exportArchivedToExcel', '// SHARED STATE —'), ['exportArchivedToExcel'])
    write('js/export.js', f"""/** Excel & ZIP export */
import {{ state }} from './state.js';
import {{ toast }} from './utils.js';
import {{ audit }} from './audit.js';

{export_body}
""")

    upload_batch = slice_js(js, '// BATCH PROCESSING —', 'function buildAIPrompt')
    upload_ui = slice_js(js, '// UPLOAD FLOW', '// UNIVERSAL FILE UNWRAPPER')
    upload_unwrap = slice_js(js, '// UNIVERSAL FILE UNWRAPPER', '// UPLOAD HANDLER —')
    upload_handler = slice_js(js, '// UPLOAD HANDLER —', 'function updateProgressInReview')
    upload_review = slice_js(js, 'function updateProgressInReview', '// INVOICES VIEW')

    upload_exports = [
        'handleBatch', 'processBatchItem', 'updateBatchProgress', 'renderBatchQueue',
        'openBatchItemForReview', 'showBatchSummary', 'unwrapFile', 'unwrapTiff', 'unwrapHeic',
        'unwrapMsg', 'unwrapEml', 'unwrapZip', 'handleFile', 'updateProgressInReview',
        'showReviewPanel', 'renderPreview', 'populateReviewFromOCR', 'handleAfmInput',
        'setConfidence', 'populateSupplierDropdown', 'populateSAPDropdown', 'renderSAPCandidates',
        'renderSupplierCandidates', 'applyPreviewZoom', 'showValidationErrors', 'resetUploadView',
        'initUpload',
    ]
    upload_body = export_funcs(
        upload_batch + '\n\n' + upload_unwrap + '\n\n' + upload_handler + '\n\n' + upload_review,
        upload_exports,
    )
    # Remove inline event listeners from upload - move to initUpload
    upload_body = re.sub(
        r"// Batch cancel button\ndocument\.addEventListener\('click'.*?\}\);\n",
        '',
        upload_body,
        flags=re.S,
    )
    upload_body = re.sub(
        r"\$\('#btn-archive'\)\.addEventListener.*?\}\);\n\n\$\('#btn-cancel'\).*?\}\);\n\n// Toggle debug.*?\}\);\n\n// Live AFM.*?\}\);\n\n// Preview zoom.*?\}\);\nfunction applyPreviewZoom",
        'export function applyPreviewZoom',
        upload_body,
        flags=re.S,
    )

    upload_body = strip_upload_listeners(upload_body)
    upload_body = upload_body.replace('updateReviewBadge();', "window.dispatchEvent(new CustomEvent('review-badge-update'));")
    write('js/upload.js', build_upload_module(upload_body))

    write('js/badges.js', """/** Navigation badge updates */
import { state } from './state.js';
import { $ } from './utils.js';

export function updateReviewBadge() {
  const count = state.invoices.filter(i => i.status === 'needs_review').length;
  const badge = $('#badge-review');
  if (!badge) return;
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = count;
  } else {
    badge.hidden = true;
  }
}
""")

    invoices_body = export_funcs(slice_js(js, '// INVOICES VIEW', '// SUPPLIERS VIEW'), [
        'getArchivedPdfBytes', 'viewArchivedPdf', 'downloadArchivedPdf', 'renderInvoices',
    ])
    invoices_body = re.sub(r"\$\('#invoice-filter'\).*?\n\$\('#btn-export-excel'\).*?\n", '', invoices_body)
    write('js/invoices.js', f"""/** Invoices table view */
import {{ state }} from './state.js';
import {{ $, toast, fmtDate, escapeHtml }} from './utils.js';
import {{ audit }} from './audit.js';
import {{ exportArchivedToExcel }} from './export.js';
import {{ updateReviewBadge }} from './badges.js';

{invoices_body}

export function initInvoices() {{
  $('#invoice-filter')?.addEventListener('change', renderInvoices);
  $('#btn-export-excel')?.addEventListener('click', exportArchivedToExcel);
}}
""")

    suppliers_seed = export_funcs(slice_js(js, 'function seedSuppliers', '// NAVIGATION'), ['seedSuppliers'])
    suppliers_view = slice_js(js, '// SUPPLIERS VIEW', '// AUDIT VIEW')
    suppliers_view = re.sub(r"\$\('#supplier-search'\).*?\n\n", '', suppliers_view)
    suppliers_view = re.sub(r"\$\('#btn-regen-folders'\).*?\}\);\n", '', suppliers_view, flags=re.S)
    suppliers_view = re.sub(r"\$\('#excel-input'\).*?\}\);\n", '', suppliers_view, flags=re.S)
    suppliers_exports = [
        'parseXLSX', 'parseCSVToRows', 'resolveColumns', 'extractAfmFromVat', 'slugify',
        'extractShortSupplierName', 'buildSupplierFolder', 'importSupplierRows', 'parseCSVLine',
        'showImportSummary', 'renderSuppliers',
    ]
    suppliers_body = export_funcs(suppliers_seed + '\n\n' + suppliers_view, suppliers_exports)
    write('js/suppliers.js', f"""/** Suppliers import & management */
import {{ state }} from './state.js';
import {{ $, toast, debounce }} from './utils.js';
import {{ stripAccents }} from './helpers.js';
import {{ audit }} from './audit.js';
import {{ scheduleSave }} from './storage.js';

{suppliers_body}

export function initSuppliers() {{
  $('#supplier-search')?.addEventListener('input', debounce(renderSuppliers, 200));
  $('#btn-regen-folders')?.addEventListener('click', () => {{
    if (!confirm(`Ενημέρωση όλων των ${{state.suppliers.length}} προμηθευτών σε format {{SAP}}-{{ΟΝΟΜΑ}}?\\n\\nΘα επηρεαστούν μόνο μελλοντικές αρχειοθετήσεις.`)) return;
    let changed = 0;
    for (const s of state.suppliers) {{
      const newFolder = buildSupplierFolder(s.sap_vendor_code, s.name);
      if (s.folder_path !== newFolder) {{ s.folder_path = newFolder; changed++; }}
    }}
    audit('supplier_import', 'success', `Regenerated ${{changed}} folder paths`, {{ actor: 'user' }});
    toast(`Ενημερώθηκαν ${{changed}} folder paths`, 'ok');
    renderSuppliers();
  }});
  $('#excel-input')?.addEventListener('change', async (e) => {{
    const file = e.target.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    try {{
      let rows;
      if (name.endsWith('.xlsx') || name.endsWith('.xls')) rows = await parseXLSX(file);
      else rows = parseCSVToRows(await file.text());
      const result = importSupplierRows(rows);
      showImportSummary(result);
      audit('supplier_import', result.errors.length ? 'warning' : 'success',
        `imported=${{result.imported}} updated=${{result.updated}} skipped=${{result.skipped}}`,
        {{ actor: 'user', details: result }});
      renderSuppliers();
      toast(`+${{result.imported}} νέοι, ${{result.updated}} ενημερώθηκαν`, 'ok');
    }} catch (err) {{
      toast(`Σφάλμα εισαγωγής: ${{err.message}}`, 'err');
      console.error(err);
    }}
    e.target.value = '';
  }});
}}
""")

    write('js/search.js', """/** Debounced search bindings */
import { $, debounce } from './utils.js';
import { renderArchiveBrowser } from './archive.js';
import { renderSuppliers } from './suppliers.js';
import { renderDashboard } from './dashboard.js';

export function initSearch() {
  $('#archive-search')?.addEventListener('input', debounce(renderArchiveBrowser, 200));
  $('#dash-period')?.addEventListener('change', renderDashboard);
}
""")

    nav = slice_js(js, '// NAVIGATION', '// UPLOAD FLOW')
    boot = slice_js(js, '// BOOT', '').replace('(async () => {', 'async function boot() {').replace('})();', '}')
    boot = boot.replace('loadSettings();', 'loadSettings();\n  loadCurrentUser();')
    boot = boot.replace('initSettings();', 'initSettings();\n  initNavigation();\n  initUpload();\n  initInvoices();\n  initSuppliers();\n  initAuditView();\n  initSearch();')

    write('js/app.js', f"""/** FinanceOS application entry point */
import {{ $$ }} from './utils.js';
import {{ loadSettings, applySettingsToUI, initSettings, updateEngineStatus }} from './settings.js';
import {{ idbLoadState, idbLoadHandle, verifyPermission, updateArchiveRootDisplay, loadCurrentUser }} from './storage.js';
import {{ seedSuppliers, renderSuppliers, initSuppliers }} from './suppliers.js';
import {{ renderInvoices, initInvoices }} from './invoices.js';
import {{ renderAudit, initAuditView }} from './audit.js';
import {{ renderDashboard }} from './dashboard.js';
import {{ initUpload }} from './upload.js';
import {{ initSearch }} from './search.js';
import {{ loadArchiveBrowser }} from './archive.js';
import {{ updateReviewBadge }} from './badges.js';
import {{ state }} from './state.js';
import {{ $, toast }} from './utils.js';

export function initNavigation() {{
{chr(10).join('  ' + line for line in nav.splitlines() if not line.strip().startswith('function updateReviewBadge') and not line.strip().startswith('// Archive browser') and not line.strip().startswith("$('#archive-search')") and not line.strip().startswith("$('#btn-archive-refresh')") and not line.strip().startswith('// Dashboard period') and not line.strip().startswith("$('#dash-period')"))}
}}

window.addEventListener('error', (e) => {{
  console.error('Global error:', e.message, e.filename, e.lineno, e.error);
}});
window.addEventListener('unhandledrejection', (e) => {{
  console.error('Unhandled rejection:', e.reason);
}});

{boot}

  window.addEventListener('review-badge-update', updateReviewBadge);

boot();
""")

    # index.html
    css_links = '\n'.join(
        f'<link rel="stylesheet" href="css/{f}" />'
        for f in ['main.css', 'layout.css', 'components.css', 'forms.css', 'tables.css',
                  'dashboard.css', 'charts.css', 'modals.css', 'utilities.css', 'responsive.css']
    )
    html = f"""{head}
<link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&display=swap" as="style" />
{css_links}
<script>
(function () {{
  var p = location.pathname;
  var base = '/';
  if (p.indexOf('/FinanceOS') !== -1) {{
    base = p.slice(0, p.indexOf('/FinanceOS') + '/FinanceOS'.length + 1);
  }}
  if (!document.querySelector('base[data-app-base]')) {{
    var b = document.createElement('base');
    b.setAttribute('data-app-base', '1');
    b.href = base;
    document.head.prepend(b);
  }}
}})();
</script>
</head>
<body>

{body}

<div class="toast-container" id="toast-container"></div>
<script type="module" src="js/app.js" defer></script>
</body>
</html>
"""
    write('index.html', html)

    write('.gitignore', """node_modules/
dist/
.DS_Store
Thumbs.db
.idea/
.vscode/
.env
.env.local
*.log
""")

    write('vercel.json', """{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/css/:path*", "destination": "/FinanceOS/css/:path*" },
    { "source": "/js/:path*", "destination": "/FinanceOS/js/:path*" },
    { "source": "/assets/:path*", "destination": "/FinanceOS/assets/:path*" },
    { "source": "/data/:path*", "destination": "/FinanceOS/data/:path*" },
    { "source": "/FinanceOS", "destination": "/FinanceOS/index.html" },
    { "source": "/", "destination": "/FinanceOS/index.html" }
  ]
}
""")

    for d in ['assets/icons', 'assets/images', 'assets/logos', 'assets/fonts', 'data']:
        write(f'{d}/.gitkeep', '')

    write('docs/README.md', generate_readme())
    print('FinanceOS build complete')


def generate_readme():
    return """# FinanceOS — Parastatika OCR

Enterprise modular architecture for the Parastatika OCR invoice archiving application.

## Project Structure

```
FinanceOS/
├── index.html          # Shell HTML + CDN library imports
├── css/                # Stylesheets (logical split)
├── js/                 # ES module application code
├── assets/             # Static assets (icons, images, fonts)
├── data/               # Local data exports (optional)
└── docs/               # Documentation
```

## Modules

| Module | Responsibility |
|--------|----------------|
| `app.js` | Boot sequence, navigation, global error handlers |
| `state.js` | Central application state |
| `utils.js` | DOM helpers, formatting, debounce |
| `helpers.js` | AFM validation, fuzzy matching, SAP scoring |
| `dashboard.js` | Dashboard KPIs and layout |
| `charts.js` | Chart.js rendering |
| `analytics.js` | KPI metric calculations |
| `upload.js` | File upload, batch processing, review panel |
| `ocr.js` | Tesseract OCR and field extraction |
| `ai.js` | Claude Vision API integration |
| `storage.js` | IndexedDB, File System Access, shared JSON |
| `archive.js` | Archive folder browser |
| `invoices.js` | Invoices table view |
| `suppliers.js` | Supplier import and management |
| `audit.js` | Audit logging |
| `export.js` | Excel and ZIP export |
| `settings.js` | AI and user settings |
| `search.js` | Debounced search bindings |
| `notifications.js` | Toast notifications |

## Local Development

Open `index.html` via a local static server (required for ES modules):

```bash
cd FinanceOS
python3 -m http.server 8080
```

Visit http://localhost:8080

## Vercel Deployment

1. Push to GitHub
2. Import project in Vercel
3. Set root directory to `FinanceOS`
4. Deploy (static, no build step)

## Browser Support

- Chrome / Edge 90+ (full — File System Access API)
- Firefox / Safari (OCR, upload, AI — no native folder write)

## Git Workflow

```bash
git checkout -b feature/my-change
# edit modules
git add FinanceOS/
git commit -m "Describe change"
git push -u origin feature/my-change
```

## Future Improvements

- Service worker for offline OCR cache
- Backend API for multi-user sync
- Unit tests per module (Vitest)
- TypeScript migration
"""


if __name__ == '__main__':
    main()
