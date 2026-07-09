/** Bridge to OCR Web Workers — recognition off main thread */

const POOL_SIZE = 2;
const _workers = [];
const _idle = [];
const _waitQueue = [];
let _nextId = 0;

function workerUrl() {
  const base = document.querySelector('base[data-app-base]')?.getAttribute('href') || '/';
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}js/ocr-worker.js`;
}

function spawnWorker() {
  const w = new Worker(workerUrl());
  w._ready = new Promise((resolve, reject) => {
    const id = `init-${_nextId++}`;
    const onMsg = (e) => {
      if (e.data?.id !== id) return;
      w.removeEventListener('message', onMsg);
      if (e.data.ok) resolve();
      else reject(new Error(e.data.error || 'Worker init failed'));
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ id, type: 'init' });
  });
  return w;
}

async function acquireWorker() {
  if (_idle.length) return _idle.pop();
  if (_workers.length < POOL_SIZE) {
    const w = spawnWorker();
    _workers.push(w);
    await w._ready;
    return w;
  }
  return new Promise((resolve) => _waitQueue.push(resolve));
}

function releaseWorker(w) {
  if (_waitQueue.length) {
    _waitQueue.shift()(w);
  } else {
    _idle.push(w);
  }
}

/**
 * Run Tesseract recognize on canvas in a Web Worker.
 * @param {HTMLCanvasElement} canvas
 */
export async function recognizeInWorker(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const worker = await acquireWorker();
  const id = `ocr-${_nextId++}`;

  try {
    const data = await new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (e.data?.id !== id) return;
        worker.removeEventListener('message', onMsg);
        if (e.data.ok) resolve(e.data.data);
        else reject(new Error(e.data.error || 'OCR worker failed'));
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({
        id,
        type: 'recognize',
        width,
        height,
        buffer: imageData.data.buffer,
      }, [imageData.data.buffer]);
    });
    return data;
  } finally {
    releaseWorker(worker);
  }
}

/** Pre-warm one worker on idle */
export function warmupOcrWebWorker() {
  acquireWorker().then(releaseWorker).catch(() => {});
}

export async function shutdownOcrWorkers() {
  for (const w of _workers) {
    try {
      w.postMessage({ id: 'term', type: 'terminate' });
      w.terminate();
    } catch (e) { /* ignore */ }
  }
  _workers.length = 0;
  _idle.length = 0;
}
