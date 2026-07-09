/** Dashboard view */
import { state } from './state.js';
import { $, escapeHtml } from './utils.js';
import { fmtEUR, getArchivedForPeriod } from './analytics.js';
import { renderMonthlyChart, renderStatusChart, renderSuppliersChart } from './charts.js';

export function renderDashboard() {
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
      <div class="kpi-value">${archived.length}<span class="kpi-unit">τιμολόγια</span></div>
      <div class="kpi-delta">${periodDays > 0 ? `τελευταίες ${periodDays} μέρες` : 'όλα'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Συνολική Αξία</div>
      <div class="kpi-value mono">${fmtEUR(totalValue)}</div>
      <div class="kpi-delta">ΦΠΑ: ${fmtEUR(totalVat)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Μέσο Ποσό</div>
      <div class="kpi-value mono">${fmtEUR(avgValue)}</div>
      <div class="kpi-delta">${uniqueSuppliers} προμηθευτές</div>
    </div>
    <div class="kpi-card ${needsReview > 0 ? 'warn' : ''}">
      <div class="kpi-label">Εκκρεμότητες</div>
      <div class="kpi-value">${needsReview}<span class="kpi-unit">έλεγχος</span></div>
      <div class="kpi-delta">${duplicates} duplicates</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Χρήστες</div>
      <div class="kpi-value">${new Set(archived.map(i => i.archived_by).filter(Boolean)).size || 1}</div>
      <div class="kpi-delta">${state.currentUser ? `συνδεδεμένος: ${state.currentUser}` : 'χωρίς όνομα χρήστη'}</div>
    </div>
  `;

  renderMonthlyChart(archived, periodDays);
  renderStatusChart();
  renderSuppliersChart(archived);
  renderRecentActivity();
}

export function renderRecentActivity() {
  const container = $('#dash-recent');
  if (!container) return;
  const recent = [...state.invoices]
    .filter(i => i.archived_at || i.created_at)
    .sort((a, b) => new Date(b.archived_at || b.created_at) - new Date(a.archived_at || a.created_at))
    .slice(0, 15);
  if (!recent.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-subtle);font-style:italic;">Καμία δραστηριότητα ακόμα</div>';
    return;
  }
  container.innerHTML = recent.map(inv => {
    const supplier = state.suppliers.find(s => s.id === inv.supplier_id);
    const when = new Date(inv.archived_at || inv.created_at);
    const fmt = new Intl.RelativeTimeFormat('el-GR', { numeric: 'auto' });
    const diffMs = Date.now() - when.getTime();
    let ago;
    if (diffMs < 3600000) ago = fmt.format(-Math.round(diffMs / 60000), 'minute');
    else if (diffMs < 86400000) ago = fmt.format(-Math.round(diffMs / 3600000), 'hour');
    else ago = fmt.format(-Math.round(diffMs / 86400000), 'day');
    return `
      <div class="recent-item">
        <div class="recent-dot ${inv.status}"></div>
        <div class="recent-content">
          <div class="recent-title">${escapeHtml(supplier?.name || inv.original_filename || '—')}</div>
          <div class="recent-meta">
            ${inv.total_amount ? `€${Number(inv.total_amount).toFixed(2)} · ` : ''}
            ${escapeHtml(inv.invoice_number || '—')} · ${ago}
            ${inv.archived_by ? ' · ' + escapeHtml(inv.archived_by) : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}
// ═══════════════════════════════════════════════════════════
