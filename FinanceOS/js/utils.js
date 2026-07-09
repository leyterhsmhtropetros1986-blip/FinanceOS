/** DOM & formatting utilities */
// ─── Helpers ────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('el-GR');
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('el-GR', { hour12: false });
}
function fmtISODate(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 10);
}
function confidenceClass(pct) {
  if (pct == null || pct === undefined || Number.isNaN(pct)) return '';
  if (pct >= 90) return 'ok';
  if (pct >= 70) return 'warn';
  return 'err';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ═══════════════════════════════════════════════════════════
export { $, $$, toast, fmtDate, fmtDateTime, fmtISODate, confidenceClass, escapeHtml, debounce };
