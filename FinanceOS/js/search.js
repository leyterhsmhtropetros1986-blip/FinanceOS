/** Debounced search bindings */
import { $, debounce } from './utils.js';
import { renderArchiveBrowser } from './archive.js';
import { renderSuppliers } from './suppliers.js';
import { renderDashboard } from './dashboard.js';

export function initSearch() {
  $('#archive-search')?.addEventListener('input', debounce(renderArchiveBrowser, 200));
  $('#dash-period')?.addEventListener('change', renderDashboard);
}
