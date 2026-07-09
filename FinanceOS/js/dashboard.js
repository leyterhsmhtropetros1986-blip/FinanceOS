/** Dashboard view — KPI από αποθηκευμένα δεδομένα παραστατικών */
import { state } from './state.js';
import { $, escapeHtml } from './utils.js';
import {
  fmtEUR, fmtPct, fmtMs, getArchivedForPeriod, getInvoiceTotal,
  computeFinancialKpis, computeOperationalKpis,
} from './analytics.js';
import { renderMonthlyChart, renderStatusChart, renderSuppliersChart } from './charts.js';

export function renderDashboard() {
  const periodDays = parseInt($('#dash-period')?.value || '365', 10);
  const archived = getArchivedForPeriod(periodDays);
  const needsReview = state.invoices.filter(i => i.status === 'needs_review').length;
  const fin = computeFinancialKpis(archived);
  const ops = computeOperationalKpis(state.invoices);

  const totalValueDisplay = fin.hasAnyAmount ? fmtEUR(fin.totalValue) : fmtEUR(null, { missing: true });
  const avgValueDisplay = fin.hasAnyAmount ? fmtEUR(fin.avgValue) : fmtEUR(null, { missing: true });
  const vatDisplay = fin.hasAnyAmount ? fmtEUR(fin.totalVat) : fmtEUR(null, { missing: true });

  $('#dash-kpis').innerHTML = `
    <div class="kpi-card ok">
      <div class="kpi-label">Παραστατικά</div>
      <div class="kpi-value">${archived.length}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Συνολική Αξία</div>
      <div class="kpi-value mono ${fin.hasAnyAmount ? '' : 'kpi-missing'}">${totalValueDisplay}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Μέση Αξία</div>
      <div class="kpi-value mono ${fin.hasAnyAmount ? '' : 'kpi-missing'}">${avgValueDisplay}</div>
    </div>
    <div class="kpi-card ${needsReview > 0 ? 'warn' : ''}">
      <div class="kpi-label">Εκκρεμότητες</div>
      <div class="kpi-value">${needsReview}</div>
    </div>
  `;

  $('#dash-kpis-ext').innerHTML = `
    <div class="kpi-card kpi-card-sm">
      <div class="kpi-label">Σύνολο ΦΠΑ</div>
      <div class="kpi-value mono kpi-value-sm ${fin.hasAnyAmount ? '' : 'kpi-missing'}">${vatDisplay}</div>
    </div>
    <div class="kpi-card kpi-card-sm">
      <div class="kpi-label">Μέσος χρόνος OCR</div>
      <div class="kpi-value mono kpi-value-sm">${fmtMs(ops.avgOcrMs)}</div>
    </div>
    <div class="kpi-card kpi-card-sm">
      <div class="kpi-label">Επιτυχία OCR</div>
      <div class="kpi-value mono kpi-value-sm">${fmtPct(ops.ocrSuccessRate)}</div>
    </div>
    <div class="kpi-card kpi-card-sm">
      <div class="kpi-label">OCR Confidence</div>
      <div class="kpi-value mono kpi-value-sm">${fmtPct(ops.avgConfidence)}</div>
    </div>
    <div class="kpi-card kpi-card-sm">
      <div class="kpi-label">Χειροκίνητες διορθώσεις</div>
      <div class="kpi-value mono kpi-value-sm">${ops.manualCorrections}</div>
    </div>
    <div class="kpi-card kpi-card-sm">
      <div class="kpi-label">Duplicates</div>
      <div class="kpi-value mono kpi-value-sm">${ops.duplicates}</div>
    </div>
    <div class="kpi-card kpi-card-sm">
      <div class="kpi-label">Αυτόματη αναγν. προμηθευτή</div>
      <div class="kpi-value mono kpi-value-sm">${fmtPct(ops.autoSupplierRate)}</div>
    </div>
  `;

  if (fin.missingAmountCount > 0 && archived.length > 0) {
    $('#dash-kpi-hint').hidden = false;
    $('#dash-kpi-hint').textContent =
      `${fin.missingAmountCount} από ${archived.length} αρχειοθετημένα δεν έχουν εξαγόμενο ποσό — εμφανίζονται ως «${escapeHtml('Δεν έχει εξαχθεί')}».`;
  } else if ($('#dash-kpi-hint')) {
    $('#dash-kpi-hint').hidden = true;
  }

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
    const amount = getInvoiceTotal(inv);
    return `
      <div class="recent-item">
        <div class="recent-dot ${inv.status}"></div>
        <div class="recent-content">
          <div class="recent-title">${escapeHtml(supplier?.name || inv.original_filename || '—')}</div>
          <div class="recent-meta">
            ${amount != null ? `€${amount.toFixed(2)} · ` : ''}
            ${escapeHtml(inv.invoice_number || '—')} · ${ago}
            ${inv.archived_by ? ' · ' + escapeHtml(inv.archived_by) : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}
