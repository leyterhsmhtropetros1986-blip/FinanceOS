/** Invoice lifecycle timeline events */
import { state } from './state.js';

export function appendTimelineEvent(invoiceId, type, detail = '') {
  const inv = state.invoices.find((i) => i.id === invoiceId);
  if (!inv) return;
  if (!inv.timeline) inv.timeline = [];
  inv.timeline.unshift({
    type,
    detail,
    at: new Date().toISOString(),
    actor: state.currentUser || 'system',
  });
  inv.timeline = inv.timeline.slice(0, 50);
}

export const TIMELINE_LABELS = {
  upload: 'Upload',
  ocr: 'OCR',
  edited: 'Edited',
  saved: 'Saved',
  exported: 'Exported',
  archived: 'Archived',
  failed: 'Failed',
};

export function renderTimelineHtml(timeline = []) {
  if (!timeline.length) return '<div class="timeline-empty">—</div>';
  return timeline.map((ev) => `
    <div class="timeline-item">
      <span class="timeline-dot"></span>
      <div>
        <div class="timeline-type">${TIMELINE_LABELS[ev.type] || ev.type}</div>
        <div class="timeline-detail">${ev.detail || ''}</div>
        <div class="timeline-time">${new Date(ev.at).toLocaleString('el-GR')}</div>
      </div>
    </div>
  `).join('');
}
