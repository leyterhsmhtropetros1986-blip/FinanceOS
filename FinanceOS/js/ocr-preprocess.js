/** Canvas preprocessing for improved OCR accuracy */

/** Grayscale + contrast stretch + light sharpen */
export function enhanceCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let min = 255;
  let max = 0;
  const gray = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const stretched = Math.round(((gray[p] - min) / range) * 255);
    d[i] = d[i + 1] = d[i + 2] = stretched;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Adaptive threshold binarization (local mean) */
export function binarizeCanvas(source, blockSize = 31, C = 10) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width;
  const h = canvas.height;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  const half = Math.floor(blockSize / 2);
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowsum = 0;
    for (let x = 0; x < w; x++) {
      rowsum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowsum;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half);
      const y1 = Math.max(0, y - half);
      const x2 = Math.min(w - 1, x + half);
      const y2 = Math.min(h - 1, y + half);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (w + 1) + (x2 + 1)]
        - integral[y1 * (w + 1) + (x2 + 1)]
        - integral[(y2 + 1) * (w + 1) + x1]
        + integral[y1 * (w + 1) + x1];
      const mean = sum / area;
      const v = gray[y * w + x] < mean - C ? 0 : 255;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Simple 3x3 median denoise on grayscale */
export function denoiseCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width;
  const h = canvas.height;
  const out = new Uint8ClampedArray(d);
  const getG = (x, y) => {
    const i = (y * w + x) * 4;
    return d[i];
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const vals = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) vals.push(getG(x + dx, y + dy));
      }
      vals.sort((a, b) => a - b);
      const v = vals[4];
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = out[i];
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function rotateCanvas(source, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const w = source.width;
  const h = source.height;
  const nw = Math.ceil(w * cos + h * sin);
  const nh = Math.ceil(w * sin + h * cos);
  const canvas = document.createElement('canvas');
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, nw, nh);
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -w / 2, -h / 2);
  return canvas;
}

/** Estimate skew via horizontal projection variance */
export function estimateSkewAngle(source, maxDeg = 5) {
  let bestAngle = 0;
  let bestScore = -1;
  for (let deg = -maxDeg; deg <= maxDeg; deg += 0.5) {
    const rotated = deg === 0 ? source : rotateCanvas(source, deg);
    const ctx = rotated.getContext('2d');
    const { width, height } = rotated;
    const step = Math.max(1, Math.floor(width / 200));
    const row = new Float32Array(height);
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        sum += 255 - data[i];
      }
      row[y] = sum;
    }
    const mean = row.reduce((a, b) => a + b, 0) / height;
    let variance = 0;
    for (let y = 0; y < height; y++) variance += (row[y] - mean) ** 2;
    if (variance > bestScore) {
      bestScore = variance;
      bestAngle = deg;
    }
  }
  return bestAngle;
}

/** Full preprocessing pipeline for OCR */
export function preprocessForOcr(source) {
  const enhanced = enhanceCanvas(source);
  const denoised = denoiseCanvas(enhanced);
  const angle = estimateSkewAngle(denoised);
  const deskewed = Math.abs(angle) > 0.25 ? rotateCanvas(denoised, -angle) : denoised;
  return binarizeCanvas(deskewed);
}

/** Variants for multi-pass OCR */
export function getOcrVariants(canvas) {
  return [
    { label: 'original', canvas },
    { label: 'enhanced', canvas: enhanceCanvas(canvas) },
    { label: 'preprocessed', canvas: preprocessForOcr(canvas) },
  ];
}
