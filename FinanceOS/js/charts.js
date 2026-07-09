/** Chart.js visualizations — από αποθηκευμένα invoice δεδομένα */
import { state } from './state.js';
import { $ } from './utils.js';
import { getInvoiceTotal, statusLabel } from './analytics.js';

export function renderMonthlyChart(archived, periodDays) {
  const ctx = $('#chart-monthly')?.getContext('2d');
  if (!ctx || typeof Chart === 'undefined') return;
  if (state.dashCharts.monthly) state.dashCharts.monthly.destroy();

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
    if (b) {
      b.count++;
      const amt = getInvoiceTotal(inv);
      if (amt != null) b.value += amt;
    }
  }
  const labels = Array.from(buckets.values()).map(b => b.label);
  const counts = Array.from(buckets.values()).map(b => b.count);
  const values = Array.from(buckets.values()).map(b => b.value);
  const hasValues = values.some(v => v > 0);

  const datasets = [
    { label: 'Πλήθος', data: counts, backgroundColor: '#2C5F5B', yAxisID: 'y', borderRadius: 4 },
  ];
  if (hasValues) {
    datasets.push({
      type: 'line', label: 'Αξία (€)', data: values, borderColor: '#B15C00',
      backgroundColor: 'rgba(177,92,0,0.1)', yAxisID: 'y1', tension: 0.3, borderWidth: 2,
    });
  }

  state.dashCharts.monthly = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
      scales: {
        y: { position: 'left', beginAtZero: true, title: { display: true, text: 'Τιμολόγια' }, ticks: { stepSize: 1 } },
        y1: hasValues ? { position: 'right', beginAtZero: true, title: { display: true, text: 'Αξία €' }, grid: { display: false } } : { display: false },
      }
    }
  });
}

export function renderStatusChart() {
  const ctx = $('#chart-status')?.getContext('2d');
  if (!ctx || typeof Chart === 'undefined') return;
  if (state.dashCharts.status) state.dashCharts.status.destroy();

  const counts = { archived: 0, needs_review: 0, duplicate: 0, error: 0, pending: 0, processing: 0 };
  for (const i of state.invoices) counts[i.status] = (counts[i.status] || 0) + 1;

  const entries = [
    ['archived', counts.archived],
    ['needs_review', counts.needs_review],
    ['duplicate', counts.duplicate],
    ['error', counts.error],
    ['processing', counts.processing],
    ['pending', counts.pending],
  ].filter(([, n]) => n > 0);

  state.dashCharts.status = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([s]) => statusLabel(s)),
      datasets: [{
        data: entries.map(([, n]) => n),
        backgroundColor: ['#10684C', '#B15C00', '#2C5F5B', '#A32323', '#5B8DEF', '#948A7B'],
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
    const amt = getInvoiceTotal(inv);
    if (amt != null) cur.value += amt;
    bySupplier.set(supplier.id, cur);
  }
  const top = Array.from(bySupplier.values())
    .sort((a, b) => (b.value || b.count) - (a.value || a.count))
    .slice(0, 10);

  const useValue = top.some(t => t.value > 0);

  state.dashCharts.suppliers = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(t => t.name.slice(0, 25) + (t.name.length > 25 ? '…' : '')),
      datasets: [{
        label: useValue ? 'Αξία (€)' : 'Πλήθος',
        data: top.map(t => useValue ? t.value : t.count),
        backgroundColor: '#2C5F5B',
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, title: { display: true, text: useValue ? 'Αξία €' : 'Τιμολόγια' } } }
    }
  });
}
