/** Unified upload pipeline status — one badge, no conflicting messages */
import { $ } from './utils.js';

const STATES = {
  loading: { icon: '⏳', label: 'Φόρτωση…', cls: 'upload-status--loading' },
  preview: { icon: '👁', label: 'Preview έτοιμο', cls: 'upload-status--preview' },
  ocr: { icon: '🟡', label: 'OCR σε εξέλιξη…', cls: 'upload-status--ocr' },
  ocr_done: { icon: '🟡', label: 'OCR ολοκληρώθηκε', cls: 'upload-status--ocr-done' },
  ai: { icon: '🔵', label: 'AI εμπλουτισμός', cls: 'upload-status--ai' },
  ready: { icon: '🟢', label: 'Έτοιμο για έλεγχο', cls: 'upload-status--ready' },
  manual: { icon: '🔴', label: 'Απαιτείται χειροκίνητος έλεγχος', cls: 'upload-status--manual' },
};

const STAGE_KEYS = ['upload', 'preview', 'ocr', 'ai', 'save'];

export function setUploadStatus(key, detail = '') {
  const st = STATES[key] || STATES.manual;
  const badge = $('#upload-status-badge');
  const legacy = $('#ocr-status');
  const text = detail ? `${st.icon} ${detail}` : `${st.icon} ${st.label}`;
  if (badge) {
    badge.textContent = text;
    badge.className = `upload-status-badge ${st.cls}`;
    badge.hidden = false;
  }
  if (legacy) {
    legacy.textContent = text;
    legacy.className = `upload-status-inline ${st.cls}`;
  }
  const mean = $('#mean-confidence');
  if (mean && (key === 'manual' || key === 'loading')) {
    mean.textContent = st.label;
    mean.className = `upload-status-inline ${st.cls}`;
  }
}

export function setStageProgress(stages) {
  const bar = $('#pipeline-progress');
  if (!bar) return;
  bar.innerHTML = STAGE_KEYS.map((key) => {
    const s = stages[key] || { pct: 0, state: 'idle' };
    const filled = Math.round((s.pct ?? 0) * 4);
    const blocks = '█'.repeat(filled) + '░'.repeat(4 - filled);
    const cls = s.state === 'done' ? 'is-done' : s.state === 'active' ? 'is-active' : s.state === 'fail' ? 'is-fail' : '';
    return `<div class="pipeline-row ${cls}"><span class="pipeline-label">${labelFor(key)}</span><span class="pipeline-bar mono">${blocks}</span></div>`;
  }).join('');
}

function labelFor(key) {
  return { upload: 'Upload', preview: 'Preview', ocr: 'OCR', ai: 'AI', save: 'Save' }[key] || key;
}

export function resetStageProgress() {
  setStageProgress({
    upload: { pct: 0, state: 'idle' },
    preview: { pct: 0, state: 'idle' },
    ocr: { pct: 0, state: 'idle' },
    ai: { pct: 0, state: 'idle' },
    save: { pct: 0, state: 'idle' },
  });
}
