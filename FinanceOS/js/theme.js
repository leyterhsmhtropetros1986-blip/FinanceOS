/** Dark / light theme */
import { $ } from './utils.js';

const STORAGE_KEY = 'parastatika-theme';

export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  $('#btn-theme-toggle')?.addEventListener('click', toggleTheme);
}

export function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem(STORAGE_KEY, mode);
  const btn = $('#btn-theme-toggle');
  if (btn) btn.textContent = mode === 'dark' ? '☀' : '🌙';
  btn?.setAttribute('title', mode === 'dark' ? 'Light mode' : 'Dark mode');
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}
