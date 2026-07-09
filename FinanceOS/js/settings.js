/** AI & app settings */
import { state } from './state.js';
import { $, toast, escapeHtml } from './utils.js';
import { pickArchiveRoot, clearArchiveRoot, reloadFromShared, updateArchiveRootDisplay, setCurrentUser } from './storage.js';

// SETTINGS PERSISTENCE
// ═══════════════════════════════════════════════════════════
export function loadSettings() {
  try {
    const raw = localStorage.getItem('parastatika_settings');
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch (e) { console.warn('Cannot read settings'); }
}
export function saveSettings() {
  try { localStorage.setItem('parastatika_settings', JSON.stringify(state.settings)); }
  catch (e) {}
}
export function applySettingsToUI() {
  if ($('#ai-provider')) {
    $('#ai-provider').value = state.settings.provider || 'anthropic';
    $('#ai-key').value = state.settings.apiKey || '';
    $('#ai-model').value = state.settings.model || 'claude-sonnet-5';
    if ($('#anthropic-config')) {
      $('#anthropic-config').style.display = (state.settings.provider || 'anthropic') === 'anthropic' ? '' : 'none';
    }
  }
  if ($('#own-company-name')) $('#own-company-name').value = state.settings.ownCompany?.name || '';
  if ($('#own-company-afm'))  $('#own-company-afm').value  = state.settings.ownCompany?.afm  || '';
  if ($('#current-user'))     $('#current-user').value     = state.currentUser || '';
  updateEngineStatus();
}
export function updateEngineStatus() {
  const on = state.settings.provider === 'anthropic' && state.settings.apiKey;
  const badge = $('#badge-ai');
  if (badge) badge.hidden = !on;
  const statusEl = $('#engine-status');
  if (statusEl) {
    const parts = [];
    if (on) {
      const calls = state.settings.totalCalls || 0;
      const cost = state.settings.totalCost || 0;
      parts.push(`AI · ${calls} calls · $${cost.toFixed(3)}`);
    } else {
      parts.push('Tesseract');
    }
    if (state.archiveRoot.handle) {
      parts.push(`📁 ${state.archiveRoot.name}`);
    }
    statusEl.textContent = parts.join(' · ');
  }
}

export function initSettings() {
  const provEl = $('#ai-provider');
  if (!provEl) return;
  provEl.addEventListener('change', (e) => {
    $('#anthropic-config').style.display = e.target.value === 'anthropic' ? '' : 'none';
  });

  // Archive root buttons
  $('#btn-pick-root')?.addEventListener('click', pickArchiveRoot);
  $('#btn-clear-root')?.addEventListener('click', clearArchiveRoot);
  $('#btn-reload-shared')?.addEventListener('click', reloadFromShared);
  updateArchiveRootDisplay();

  // Own company - live save
  $('#own-company-name')?.addEventListener('input', (e) => {
    state.settings.ownCompany = state.settings.ownCompany || {};
    state.settings.ownCompany.name = e.target.value.trim();
    saveSettings();
  });
  $('#own-company-afm')?.addEventListener('input', (e) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 9);
    e.target.value = val;
    state.settings.ownCompany = state.settings.ownCompany || {};
    state.settings.ownCompany.afm = val;
    saveSettings();
  });

  // Current user
  $('#current-user')?.addEventListener('input', (e) => {
    setCurrentUser(e.target.value);
  });
  $('#btn-show-key').addEventListener('click', () => {
    const inp = $('#ai-key');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('#btn-save-settings').addEventListener('click', () => {
    state.settings.provider = $('#ai-provider').value;
    state.settings.apiKey = $('#ai-key').value.trim();
    state.settings.model = $('#ai-model').value;
    saveSettings();
    updateEngineStatus();
    toast('Ρυθμίσεις αποθηκεύτηκαν', 'ok');
  });
  $('#btn-test-key').addEventListener('click', async () => {
    const key = $('#ai-key').value.trim();
    const model = $('#ai-model').value;
    const resultEl = $('#ai-test-result');
    if (!key) {
      resultEl.innerHTML = '<div style="color:var(--warn); font-size:12px;">Βάλε API key πρώτα.</div>';
      return;
    }
    resultEl.innerHTML = '<div style="color:var(--text-muted); font-size:12px;">Δοκιμή σύνδεσης…</div>';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Πες "OK".' }] })
      });
      if (r.ok) {
        const d = await r.json();
        resultEl.innerHTML = `<div style="color:var(--ok); font-size:13px;">✓ Λειτουργεί! Απάντηση: <span class="mono">${escapeHtml((d.content?.[0]?.text || '').slice(0, 30))}</span></div>`;
      } else {
        const errBody = await r.text();
        let msg = `HTTP ${r.status}`;
        try { const j = JSON.parse(errBody); if (j.error?.message) msg = j.error.message; } catch(e) {}
        resultEl.innerHTML = `<div style="color:var(--err); font-size:13px;">✗ ${escapeHtml(msg)}</div>`;
      }
    } catch (e) {
      resultEl.innerHTML = `<div style="color:var(--err); font-size:13px;">✗ ${escapeHtml(e.message)}</div>`;
    }
  });
}

// ═══════════════════════════════════════════════════════════
