/** Chart.js visualizations */
import { state } from './state.js';
import { $, escapeHtml } from './utils.js';

export function renderMonthlyChart(archived, periodDays) {
  const ctx = $('#chart-monthly')?.getContext('2d');
  if (!ctx || typeof Chart === 'undefined') return;
  if (state.dashCharts.monthly) state.dashCharts.monthly.destroy();

  // Group by month
  const monthsBack = periodDays === 0 ? 12 : Math.min(12, Math.ceil(periodDays / 30));
  const buckets = new Map();
  const now = new Date();
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.set(key, { count: 0, value: 0, label: d.toLocaleDateString('el-GR', { month: 'short', year: '2-digit' }) });
  }
  for (const inv of archived) {
    if (!inv.archived_at) continue;
    const d = new Date(inv.archived_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const b = buckets.get(key);
    if (b) { b.count++; b.value += Number(inv.total_amount) || 0; }
  }
  const labels = Array.from(buckets.values()).map(b => b.label);
  const counts = Array.from(buckets.values()).map(b => b.count);
  const values = Array.from(buckets.values()).map(b => b.value);

  state.dashCharts.monthly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Πλήθος', data: counts, backgroundColor: '#2C5F5B', yAxisID: 'y', borderRadius: 4 },
        { type: 'line', label: 'Αξία (€)', data: values, borderColor: '#B15C00',
          backgroundColor: 'rgba(177,92,0,0.1)', yAxisID: 'y1', tension: 0.3, borderWidth: 2 }
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
      scales: {
        y: { position: 'left', beginAtZero: true, title: { display: true, text: 'Τιμολόγια' } },
        y1: { position: 'right', beginAtZero: true, title: { display: true, text: 'Αξία €' }, grid: { display: false } },
      }
    }
  });
}

export function renderStatusChart() {
  const ctx = $('#chart-status')?.getContext('2d');
  if (!ctx || typeof Chart === 'undefined') return;
  if (state.dashCharts.status) state.dashCharts.status.destroy();

  const counts = { archived: 0, needs_review: 0, duplicate: 0, error: 0, pending: 0 };
  for (const i of state.invoices) counts[i.status] = (counts[i.status] || 0) + 1;

  state.dashCharts.status = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Αρχειοθετημένα', 'Χρειάζονται έλεγχο', 'Duplicates', 'Σφάλμα', 'Εκκρεμούν'],
      datasets: [{
        data: [counts.archived, counts.needs_review, counts.duplicate, counts.error, counts.pending],
        backgroundColor: ['#10684C', '#B15C00', '#2C5F5B', '#A32323', '#948A7B'],
        borderWidth: 0,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } },
      cutout: '65%',
    }
  });
}

export function renderSuppliersChart(archived) {
  const ctx = $('#chart-suppliers')?.getContext('2d');
  if (!ctx || typeof Chart === 'undefined') return;
  if (state.dashCharts.suppliers) state.dashCharts.suppliers.destroy();

  const bySupplier = new Map();
  for (const inv of archived) {
    if (!inv.supplier_id) continue;
    const supplier = state.suppliers.find(s => s.id === inv.supplier_id);
    if (!supplier) continue;
    const cur = bySupplier.get(supplier.id) || { name: supplier.name, count: 0, value: 0 };
    cur.count++;
    cur.value += Number(inv.total_amount) || 0;
    bySupplier.set(supplier.id, cur);
  }
  const top = Array.from(bySupplier.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  state.dashCharts.suppliers = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(t => t.name.slice(0, 25) + (t.name.length > 25 ? '…' : '')),
      datasets: [{
        label: 'Αξία (€)',
        data: top.map(t => t.value),
        backgroundColor: '#2C5F5B',
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, title: { display: true, text: 'Αξία €' } } }
    }
  });
}

function renderRecentActivity() {
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
