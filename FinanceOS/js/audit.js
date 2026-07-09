/** Audit trail */
import { state } from './state.js';
import { $, fmtDateTime, escapeHtml } from './utils.js';
import { scheduleSave } from './storage.js';

export function audit(action, outcome, message, opts = {}) {
  const entry = {
    id: state.nextAuditId++,
    invoice_id: opts.invoice_id || null,
    action, outcome, message,
    details: opts.details || {},
    actor: opts.actor || 'system',
    created_at: new Date().toISOString(),
  };
  state.auditLogs.unshift(entry);
  scheduleSave();  // auto-persist
  return entry;
}

// ═══════════════════════════════════════════════════════════
// SEED DATA
// ═══════════════════════════════════════════════════════════

export function initAuditView() {
  $('#audit-action').addEventListener('change', renderAudit);
  $('#audit-outcome').addEventListener('change', renderAudit);
}

// AUDIT VIEW
// ═══════════════════════════════════════════════════════════
$('#audit-action').addEventListener('change', renderAudit);
$('#audit-outcome').addEventListener('change', renderAudit);

export function renderAudit() {
  const action = $('#audit-action').value;
  const outcome = $('#audit-outcome').value;
  const list = $('#audit-list');
  list.innerHTML = '';
  const rows = state.auditLogs.filter(a =>
    (!action || a.action === action) &&
    (!outcome || a.outcome === outcome)
  ).slice(0, 200);

  if (!rows.length) {
    list.innerHTML = '<div class="candidate-meta" style="padding:20px;text-align:center">Δεν υπάρχουν εγγραφές</div>';
    return;
  }
  for (const a of rows) {
    const el = document.createElement('div');
    el.className = `audit-item ${a.outcome}`;
    el.innerHTML = `
      <span class="audit-action">${a.action}</span>
      <span>${a.invoice_id ? `inv #${a.invoice_id}` : '—'} · ${a.actor}</span>
      <span class="audit-message">${escapeHtml(a.message)}</span>
      <span class="audit-time">${fmtDateTime(a.created_at)}</span>
    `;
    list.appendChild(el);
  }
}

// ═══════════════════════════════════════════════════════════
