/** User-safe error handling — never expose technical errors in UI */
import { audit } from './audit.js';

export const USER_FALLBACK = 'Δεν ήταν δυνατή η αυτόματη αναγνώριση. Συμπληρώστε τα στοιχεία χειροκίνητα ή δοκιμάστε ξανά.';

export function friendlyMessage(err) {
  if (!err) return USER_FALLBACK;
  const msg = String(err.message || err);
  if (/undefined|null|TypeError|ReferenceError|Cannot read|stack/i.test(msg)) {
    return USER_FALLBACK;
  }
  if (msg.length > 120) return USER_FALLBACK;
  return USER_FALLBACK;
}

export function logStageError(stage, err, invoiceId = null, extra = {}) {
  const technical = err?.stack || String(err?.message || err);
  console.error(`[Upload/${stage}]`, technical);
  audit('ocr', 'failure', `${stage}: ${String(err?.message || err).slice(0, 200)}`, {
    invoice_id: invoiceId,
    details: { stage, ...extra, technical: technical.slice(0, 500) },
  });
}

/** Run a pipeline stage; on failure return fallback without throwing */
export async function runStageSafe(stage, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    logStageError(stage, err);
    return typeof fallback === 'function' ? fallback(err) : fallback;
  }
}

export function runSyncSafe(stage, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    logStageError(stage, err);
    return typeof fallback === 'function' ? fallback(err) : fallback;
  }
}
