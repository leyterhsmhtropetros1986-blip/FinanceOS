/** Enterprise job queue — parallel OCR, stage tracking, crash recovery */
import { idbOpen } from './storage.js';

export const JOB_STAGES = ['waiting', 'uploading', 'ocr', 'ai', 'validation', 'save', 'completed', 'failed'];
export const DEFAULT_CONCURRENCY = 4;

let _jobs = [];
let _active = 0;
let _cancelled = false;
let _concurrency = DEFAULT_CONCURRENCY;
let _processor = null;
let _listeners = new Set();
let _persistTimer = null;

export function onQueueChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function emit() {
  for (const fn of _listeners) fn(getQueueSnapshot());
  schedulePersist();
}

function schedulePersist() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => persistQueue().catch(() => {}), 800);
}

export function getQueueSnapshot() {
  return {
    jobs: _jobs.map((j) => ({ ...j, file: undefined })),
    active: _active,
    cancelled: _cancelled,
    concurrency: _concurrency,
    stats: computeStats(),
  };
}

function computeStats() {
  const s = { waiting: 0, uploading: 0, ocr: 0, ai: 0, validation: 0, save: 0, completed: 0, failed: 0, total: _jobs.length };
  for (const j of _jobs) {
    const st = j.stage || 'waiting';
    if (s[st] !== undefined) s[st]++;
  }
  return s;
}

export function setQueueConcurrency(n) {
  _concurrency = Math.max(1, Math.min(8, n));
  pump();
}

export function enqueueFiles(files, { source = 'upload' } = {}) {
  const added = [];
  for (const file of files) {
    const job = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name,
      size: file.size,
      source,
      stage: 'waiting',
      progress: 0,
      stageDetail: '',
      result: null,
      error: null,
      invoiceId: null,
      createdAt: new Date().toISOString(),
    };
    _jobs.push(job);
    added.push(job);
  }
  emit();
  pump();
  return added;
}

export function cancelQueue() {
  _cancelled = true;
  emit();
}

export function resetQueue() {
  _jobs = [];
  _active = 0;
  _cancelled = false;
  emit();
  clearPersistedQueue().catch(() => {});
}

export function retryJob(jobId) {
  const job = _jobs.find((j) => j.id === jobId);
  if (!job || job.stage === 'completed') return;
  job.stage = 'waiting';
  job.progress = 0;
  job.error = null;
  _cancelled = false;
  emit();
  pump();
}

export function setJobProcessor(fn) {
  _processor = fn;
}

export function setJobStage(jobId, stage, detail = '', progress = null) {
  const job = _jobs.find((j) => j.id === jobId);
  if (!job) return;
  job.stage = stage;
  job.stageDetail = detail;
  if (progress !== null) job.progress = progress;
  emit();
}

export function completeJob(jobId, result, invoiceId = null) {
  const job = _jobs.find((j) => j.id === jobId);
  if (!job) return;
  job.stage = 'completed';
  job.progress = 1;
  job.result = result;
  job.invoiceId = invoiceId;
  _active = Math.max(0, _active - 1);
  emit();
  pump();
}

export function failJob(jobId, error) {
  const job = _jobs.find((j) => j.id === jobId);
  if (!job) return;
  job.stage = 'failed';
  job.error = String(error?.message || error);
  _active = Math.max(0, _active - 1);
  emit();
  pump();
}

function pump() {
  if (_cancelled || !_processor) return;
  while (_active < _concurrency) {
    const job = _jobs.find((j) => j.stage === 'waiting');
    if (!job) break;
    _active++;
    job.stage = 'uploading';
    emit();
    _processor(job)
      .catch((e) => failJob(job.id, e))
      .finally(() => { /* active decremented in complete/fail */ });
  }
}

export function getJobs() {
  return _jobs;
}

export function isQueueRunning() {
  return _jobs.some((j) => !['completed', 'failed'].includes(j.stage));
}

// ─── IndexedDB crash recovery ───────────────────────────
const QUEUE_KEY = 'enterpriseQueue';

export async function persistQueue() {
  if (!_jobs.length) return;
  const payload = {
    jobs: _jobs.map((j) => ({
      id: j.id, name: j.name, size: j.size, source: j.source,
      stage: j.stage, progress: j.progress, error: j.error,
      invoiceId: j.invoiceId, createdAt: j.createdAt,
    })),
    savedAt: new Date().toISOString(),
  };
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(payload, QUEUE_KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function loadPersistedQueue() {
  const db = await idbOpen();
  return new Promise((res) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(QUEUE_KEY);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => res(null);
  });
}

export async function clearPersistedQueue() {
  const db = await idbOpen();
  return new Promise((res) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(QUEUE_KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}
