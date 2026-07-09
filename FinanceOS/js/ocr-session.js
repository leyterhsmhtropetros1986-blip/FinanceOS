/** OCR job lifecycle — cancel, cleanup, instrumentation */

let _abortController = null;
let _jobId = 0;
let _objectUrls = new Set();
let _activeCanvases = [];

export function startOcrJob() {
  cancelOcrJob();
  _jobId += 1;
  _abortController = new AbortController();
  return { signal: _abortController.signal, jobId: _jobId };
}

export function cancelOcrJob() {
  if (_abortController) {
    try { _abortController.abort(); } catch (e) { /* ignore */ }
    _abortController = null;
  }
  cleanupOcrMemory();
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('OCR cancelled', 'AbortError');
}

export function trackObjectUrl(url) {
  if (url) _objectUrls.add(url);
  return url;
}

export function trackCanvas(canvas) {
  if (canvas) _activeCanvases.push(canvas);
  return canvas;
}

export function cleanupOcrMemory() {
  for (const url of _objectUrls) {
    try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
  }
  _objectUrls.clear();
  for (const c of _activeCanvases) {
    try {
      c.width = 0;
      c.height = 0;
    } catch (e) { /* ignore */ }
  }
  _activeCanvases = [];
}

export function createTimings() {
  const t0 = performance.now();
  const marks = {};
  return {
    mark(name) { marks[name] = Math.round(performance.now() - t0); },
    finish() {
      marks.total = Math.round(performance.now() - t0);
      console.info('[OCR Pipeline]', marks);
      return marks;
    },
    get marks() { return marks; },
  };
}

/** Yield to main thread — prevents UI freeze between heavy pages */
export function yieldToMain() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}
