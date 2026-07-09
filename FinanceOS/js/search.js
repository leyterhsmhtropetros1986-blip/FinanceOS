/** Debounced search bindings */
import { $, debounce } from './utils.js';
import { renderDashboard } from './dashboard.js';

export function initSearch() {
  $('#dash-period')?.addEventListener('change', renderDashboard);
}
