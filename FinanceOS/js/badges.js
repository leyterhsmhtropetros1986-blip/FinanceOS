/** Navigation badge updates */
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
