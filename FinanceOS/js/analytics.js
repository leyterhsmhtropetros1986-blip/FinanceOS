/** Dashboard KPI calculations */
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
