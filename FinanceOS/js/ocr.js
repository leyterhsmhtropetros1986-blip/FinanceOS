/** Tesseract OCR & field extraction */
import { state } from './state.js';
import { stripAccents, validateAfmChecksum, similarity, sapPrefixBoost, sapLengthBoost, sapPrefixLabel, isValidSapDocNumber, normalizeForMatch } from './helpers.js';
import { extractExtendedFields } from './field-extractors.js';
import { fuzzyFindSupplierInText } from './ocr-confidence.js';

const MAX_POOL = 4;
const _pool = [];
const _available = [];
const _waiters = [];

// REAL OCR — Tesseract.js (ell+eng) + PDF.js
// ═══════════════════════════════════════════════════════════

async function createPoolWorker(onProgress) {
  const worker = await Tesseract.createWorker(['ell', 'eng'], 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(`OCR: ${Math.round(m.progress * 100)}%`, m.progress);
      }
    },
  });
  await configureWorkerForSpeed(worker);
  return worker;
}

/** Borrow a worker from the pool (up to 4 parallel OCR jobs) */
export async function borrowWorker(onProgress) {
  if (_available.length) return _available.pop();
  if (_pool.length < MAX_POOL) {
    const w = await createPoolWorker(onProgress);
    _pool.push(w);
    return w;
  }
  return new Promise((resolve) => _waiters.push({ resolve, onProgress }));
}

export function releaseWorker(worker) {
  if (_waiters.length) {
    const { resolve } = _waiters.shift();
    resolve(worker);
  } else {
    _available.push(worker);
  }
}

async function configureWorkerForSpeed(worker) {
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });
  } catch (e) {
    console.warn('Tesseract params:', e);
  }
}

export async function getWorker(onProgress) {
  return borrowWorker(onProgress);
}

/** Preload Tesseract during idle time so first invoice is fast */
export function warmupOcrWorker() {
  if (_pool.length) return;
  const run = () => borrowWorker().then((w) => releaseWorker(w)).catch(() => {});
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 4000 });
  } else {
    setTimeout(run, 500);
  }
}

export async function renderPdfToCanvases(file, onProgress) {
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const canvases = [];
  const maxPages = Math.min(pdf.numPages, 100);
  for (let p = 1; p <= maxPages; p++) {
    onProgress && onProgress(`Rasterization σελ ${p}/${maxPages}…`, p / maxPages);
    const page = await pdf.getPage(p);
    // 3x scale ≈ 300 DPI — υψηλότερη ανάλυση για καλύτερο OCR σε χαμηλής ποιότητας scans
    const viewport = page.getViewport({ scale: 3.0 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvases.push(canvas);
  }
  return canvases;
}

export async function loadImageToCanvas(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export async function runRealOCR(file, onProgress, existingCanvases = null) {
  const { runOcrPipeline } = await import('./ocr-pipeline.js');
  return runOcrPipeline(file, { onProgress, existingCanvases });
}

/**
 * Ενοποιημένο rasterization: PDF ή image → canvases.
 * Ξεχωριστό από το OCR ώστε να μπορούμε να δείξουμε preview
 * αν το OCR αποτύχει.
 */
export async function renderToCanvases(file, onProgress) {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    return await renderPdfToCanvases(file, onProgress);
  } else {
    return [await loadImageToCanvas(file)];
  }
}

// ═══════════════════════════════════════════════════════════
// FIELD EXTRACTORS — τρέχουν σε πραγματικό OCR text
// ═══════════════════════════════════════════════════════════
const AFM_KEYWORDS = ['ΑΦΜ', 'Α.Φ.Μ', 'AFM', 'VAT', 'TAX ID', 'TIN'];
const INVOICE_KEYWORDS = [
  'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ', 'ΑΡ. ΤΙΜΟΛΟΓΙΟΥ', 'ΤΙΜΟΛΟΓΙΟ', 'INVOICE NO', 'INVOICE #', 'INVOICE NUMBER',
  'ΠΑΡΑΣΤΑΤΙΚΟ', 'Τ.Δ.Α', 'Δ.Α.Τ', 'INV NO', 'INVOICE', 'DEBIT NOTE', 'CREDIT NOTE',
  'ΤΙΜΟΛΟΓΙΟ ΑΞΙΑΣ', 'ΑΡΙΘΜΟΣ', 'NO.', 'NUMBER',
];
const DATE_KEYWORDS = ['ΗΜΕΡΟΜΗΝΙΑ', 'ΗΜ/ΝΙΑ', 'DATE', 'ΕΚΔΟΣΗ'];
const SAP_KEYWORDS = [
  'SAP DOC', 'SAP DOCUMENT', 'SAP', 'DOC NO', 'DOC NUMBER', 'DOCUMENT NUMBER',
  'ΑΡ. ΕΓΓΡΑΦΗΣ', 'ΑΡΙΘΜΟΣ ΕΓΓΡΑΦΗΣ', 'ΚΑΤΑΧΩΡΗΣΗ', 'ΚΑΤΑΧΩΡΙΣΗ', 'ΕΓΓΡΑΦΟ',
  'FI DOC', 'MATERIAL DOC', 'ΧΕΙΡΟΓΡΑΦΟ', 'HANDWRITTEN',
];

export function extractAfm(fullText) {
  const upper = stripAccents(fullText.toUpperCase());
  const candidates = new Map();

  // Βρες πού αρχίζει η ενότητα «στοιχεία πελάτη» — τα ΑΦΜ ΜΕΤΑ από αυτό συνήθως
  // είναι του πελάτη (εσένα), όχι του προμηθευτή που εξέδωσε το τιμολόγιο.
  const CUSTOMER_MARKERS = [
    'CUSTOMER DATA', 'ΣΥΝΑΛΛΑΣΣΟΜΕΝΟΥ', 'ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ',
    'BILL TO', 'SHIP TO', 'ΕΠΩΝΥΜΙΑ NAME', 'ΚΩΔΙΚΟΣ CODE',
  ];
  let customerStart = upper.length;
  for (const marker of CUSTOMER_MARKERS) {
    const p = upper.indexOf(marker);
    if (p !== -1 && p < customerStart) customerStart = p;
  }

  // Pass 1: 9ψήφια κοντά σε keyword — με βαθμολογία θέσης
  for (const kw of AFM_KEYWORDS) {
    let idx = 0;
    while ((idx = upper.indexOf(kw, idx)) !== -1) {
      const win = upper.slice(idx + kw.length, idx + kw.length + 80);
      for (const m of win.matchAll(/(?<!\d)(\d{9})(?!\d)/g)) {
        const afm = m[1];
        const validChecksum = validateAfmChecksum(afm);
        let score = validChecksum ? 96 : 55;
        // Position boost: πριν την ενότητα πελάτη = προμηθευτής
        if (idx < customerStart) {
          score += 3;  // supplier area
        } else {
          score -= 25; // customer area — probably not the supplier's AFM
        }
        // TIN keyword μετά το customer marker → σίγουρα πελάτης
        if (kw === 'TIN' && idx >= customerStart) score -= 15;
        // AFM TAX REGISTRATION είναι ξεκάθαρα του issuer
        const preCtx = upper.slice(Math.max(0, idx - 5), idx + kw.length + 20);
        if (/TAX\s*REGISTRATION|REGISTRATION\s*NUMBER/.test(preCtx)) score = Math.min(99, score + 3);

        score = Math.max(30, Math.min(99, score));
        if ((candidates.get(afm) || 0) < score) candidates.set(afm, score);
      }
      idx += kw.length;
    }
  }

  // Pass 2: MOD-11 valid νούμερα οπουδήποτε (backup)
  for (const m of upper.matchAll(/(?<!\d)(\d{9})(?!\d)/g)) {
    const afm = m[1];
    if (validateAfmChecksum(afm) && !candidates.has(afm)) {
      const score = m.index < customerStart ? 78 : 55;
      candidates.set(afm, score);
    }
  }

  // Pass 3: Handle EL-prefixed AFMs (πχ. EL094450902)
  for (const m of upper.matchAll(/\bEL\s*(\d{9})\b/g)) {
    const afm = m[1];
    if (validateAfmChecksum(afm)) {
      const score = m.index < customerStart ? 97 : 70;
      if ((candidates.get(afm) || 0) < score) candidates.set(afm, score);
    }
  }

  if (!candidates.size) return { value: null, confidence: 0 };
  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  return { value: sorted[0][0], confidence: sorted[0][1] };
}

export function extractInvoiceNumber(fullText) {
  const upper = stripAccents(fullText.toUpperCase());
  let best = null; let bestConf = 0;

  // Shipping invoice patterns (COSCO, DHL, MAERSK, etc.)
  const shippingPatterns = [
    /\b(INV[\s\-]?[A-Z0-9]{4,12})\b/i,
    /\b(TPY[\s\-]?S?\d?[\s\-]?[A-Z0-9/\-]{3,20})\b/i,
    /\b(FT[/\-][0-9]{4}[/\-][0-9]{3,6})\b/i,
    /\b([A-Z]{2,4}[/\-][0-9]{4,10})\b/,
    /\b(INVOICE\s*[#:]?\s*([A-Z0-9][A-Z0-9/\-.]{3,20}))\b/i,
  ];
  for (const pat of shippingPatterns) {
    const m = fullText.match(pat);
    if (m) {
      const candidate = (m[1] || m[0]).trim();
      if (candidate.length >= 4 && /\d/.test(candidate)) {
        const conf = 90;
        if (conf > bestConf) { best = candidate; bestConf = conf; }
      }
    }
  }

  for (const kw of INVOICE_KEYWORDS) {
    let idx = 0;
    while ((idx = upper.indexOf(kw, idx)) !== -1) {
      let win = upper.slice(idx + kw.length, idx + kw.length + 60);
      win = win.replace(/^[\s:.\-#Νο]+/, '');
      const m = win.match(/([A-ZΑ-Ω0-9][A-ZΑ-Ω0-9/\-.]{2,19})/);
      if (m) {
        const candidate = m[1];
        if (/\d/.test(candidate) && !(candidate.length === 9 && /^\d+$/.test(candidate))) {
          const conf = 92;
          if (conf > bestConf) { best = candidate; bestConf = conf; }
        }
      }
      idx += kw.length;
    }
  }
  return { value: best, confidence: bestConf };
}

export function extractDate(fullText) {
  const upper = stripAccents(fullText.toUpperCase());
  const patterns = [/\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/g, /\b(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})\b/g];

  const tryParse = (raw) => {
    raw = raw.replace(/[.\-]/g, '/');
    const parts = raw.split('/').map(x => parseInt(x));
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    let d, m, y;
    if (parts[0] > 1000) { y = parts[0]; m = parts[1]; d = parts[2]; }
    else { d = parts[0]; m = parts[1]; y = parts[2]; }
    if (y < 100) y += 2000;
    if (y < 1990 || y > new Date().getFullYear() + 1) return null;
    const dt = new Date(y, m - 1, d);
    if (isNaN(dt.getTime()) || dt.getMonth() !== m - 1) return null;
    return dt;
  };

  // Pass 1: near keyword
  for (const kw of DATE_KEYWORDS) {
    let idx = 0;
    while ((idx = upper.indexOf(kw, idx)) !== -1) {
      const win = upper.slice(idx + kw.length, idx + kw.length + 40);
      for (const pat of patterns) {
        const m = win.match(pat);
        if (m) {
          const dt = tryParse(m[0]);
          if (dt) return { value: dt.toISOString(), confidence: 95 };
        }
      }
      idx += kw.length;
    }
  }
  // Pass 2: first parsable
  for (const pat of patterns) {
    for (const m of upper.matchAll(pat)) {
      const dt = tryParse(m[1]);
      if (dt) return { value: dt.toISOString(), confidence: 75 };
    }
  }
  return { value: null, confidence: 0 };
}

export function extractSapDocCandidates(pages, fullText) {
  const candidates = new Map();
  const numberRe = /(?<!\d)(\d{6,12})(?!\d)/g;

  const contextBoost = (surrounding) => {
    const upper = stripAccents(surrounding.toUpperCase());
    return SAP_KEYWORDS.some(kw => upper.includes(kw)) ? 22 : 0;
  };

  const addCandidate = (num, score, meta) => {
    if (!isValidSapDocNumber(num)) return;
    const clean = String(num).replace(/\D/g, '');
    if (!candidates.has(clean) || candidates.get(clean).confidence < score) {
      candidates.set(clean, { value: clean, confidence: Math.min(99, score), ...meta });
    }
  };

  // Pass 1: keyword-adjacent numbers in full text (works for PDF text layer)
  const upperFull = stripAccents((fullText || '').toUpperCase());
  for (const kw of SAP_KEYWORDS) {
    let idx = 0;
    while ((idx = upperFull.indexOf(kw, idx)) !== -1) {
      const win = fullText.slice(idx, idx + kw.length + 80);
      for (const m of win.matchAll(numberRe)) {
        addCandidate(m[1], 75 + sapPrefixBoost(m[1]) + sapLengthBoost(m[1]), {
          source: 'context_match', page: 1,
          reason: `near "${kw}", prefix ${sapPrefixLabel(m[1])}`,
        });
      }
      idx += kw.length;
    }
  }

  for (const page of pages) {
    const source = page.source === 'pdf_embedded' ? 'pdf_text' : 'ocr_tesseract';

    for (const m of page.text.matchAll(numberRe)) {
      const num = m[1];
      const start = Math.max(0, m.index - 60);
      const end = Math.min(page.text.length, m.index + num.length + 60);
      const surrounding = page.text.slice(start, end);
      const wb = page.words.find(w => w.text.replace(/\D/g, '') === num);
      const ocrConf = wb ? wb.confidence : (source === 'pdf_text' ? 90 : 50);

      const score = Math.round(ocrConf * 0.35)
        + sapPrefixBoost(num)
        + sapLengthBoost(num)
        + contextBoost(surrounding)
        + (source === 'pdf_text' ? 8 : 0);

      addCandidate(num, score, {
        source, page: page.page_number,
        reason: [
          source, `ocr_conf ${ocrConf}`,
          sapPrefixBoost(num) > 0 ? `prefix ${sapPrefixLabel(num)}` : null,
          contextBoost(surrounding) ? 'near keyword' : null,
        ].filter(Boolean).join(', '),
      });
    }

    // Region scan: top area (handwritten SAP doc often top-right or top-center)
    for (const wb of page.words) {
      const digits = wb.text.replace(/\D/g, '');
      if (!isValidSapDocNumber(digits)) continue;
      if (wb.y > page.height * 0.45) continue;
      const regionBonus = wb.x >= page.width * 0.45 ? 12 : 6;
      const score = Math.round(wb.confidence * 0.45)
        + sapPrefixBoost(digits)
        + sapLengthBoost(digits)
        + regionBonus;
      addCandidate(digits, score, {
        source: 'region_scan', page: page.page_number,
        reason: `top region, ocr_conf ${wb.confidence}, prefix ${sapPrefixLabel(digits)}`,
      });
    }
  }

  return [...candidates.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 15);
}

export function extractSupplierNameHint(pages) {
  if (!pages.length) return { value: null, confidence: 0 };
  const firstText = pages[0].text;
  const companyRe = /\b(Α\.?Ε\.?|Ε\.?Π\.?Ε\.?|Ι\.?Κ\.?Ε\.?|Ο\.?Ε\.?|Ε\.?Ε\.?|SA|LTD|GMBH|BV|INC)\b/i;
  const lines = firstText.split('\n').map(l => l.trim()).filter(l => l);
  for (const line of lines.slice(0, 15)) {
    if (companyRe.test(stripAccents(line.toUpperCase()))) {
      const cleaned = line.replace(/\s+/g, ' ').trim();
      if (cleaned.length >= 4) return { value: cleaned, confidence: 85 };
    }
  }
  for (const line of lines.slice(0, 5)) {
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 6 && /[a-zA-ZΑ-Ωα-ω]/.test(cleaned)) {
      return { value: cleaned, confidence: 55 };
    }
  }
  return { value: null, confidence: 0 };
}

export function extractAllFields(pages, fullText) {
  const afm = extractAfm(fullText);
  const inv = extractInvoiceNumber(fullText);
  const dt = extractDate(fullText);
  const sapCands = extractSapDocCandidates(pages, fullText);
  const sup = extractSupplierNameHint(pages);
  const extended = extractExtendedFields(pages, fullText);

  return {
    afm: afm.value,
    invoice_number: inv.value,
    invoice_date: dt.value,
    sap_doc_number: sapCands[0] ? sapCands[0].value : null,
    supplier_name_hint: sup.value,
    confidence_afm: afm.confidence,
    confidence_invoice_no: inv.confidence,
    confidence_date: dt.confidence,
    confidence_sap_doc: sapCands[0] ? sapCands[0].confidence : 0,
    confidence_supplier: sup.confidence,
    sap_doc_candidates: sapCands,
    total_amount: extended.total_amount,
    net_amount: extended.net_amount,
    vat_amount: extended.vat_amount,
    vat_rate: extended.vat_rate,
    currency: extended.currency,
    purchase_order: extended.purchase_order,
    reference: extended.reference,
    container: extended.container,
    bill_of_lading: extended.bill_of_lading,
    confidence_total: extended.confidence_total,
    confidence_net: extended.confidence_net,
    confidence_vat: extended.confidence_vat,
    confidence_currency: extended.confidence_currency,
    confidence_po: extended.confidence_po,
    confidence_reference: extended.confidence_reference,
    confidence_container: extended.confidence_container,
    confidence_bl: extended.confidence_bl,
  };
}

// ═══════════════════════════════════════════════════════════
// SUPPLIER MATCHING
// ═══════════════════════════════════════════════════════════
export function matchSupplier(extractedAfm, supplierNameHint, fullText = '') {
  const candidates = new Map();

  const rawInput = String(extractedAfm || '').trim().toUpperCase().replace(/[\s\-]/g, '');
  const digitsOnly = rawInput.replace(/\D/g, '');
  const hasPrefix = /^[A-Z]{2}/.test(rawInput);
  const strippedVat = hasPrefix ? rawInput.slice(2) : rawInput;

  // ─── Guard: αν είναι το ΔΙΚΟ ΜΑΣ AFM → δεν είναι προμηθευτής
  const ownAfm = state.settings.ownCompany?.afm;
  if (ownAfm && digitsOnly === ownAfm) {
    console.warn(`Το ΑΦΜ ${digitsOnly} είναι της δικής μας εταιρείας (πελάτης). Δεν κάνουμε match.`);
    return { best: null, all: [], isOwnAfm: true };
  }

  // Step 1a: Full VAT match (e.g. IT00846110898) — για ξένους προμηθευτές
  if (rawInput && rawInput.length >= 5) {
    const hit = state.suppliers.find(s => s.vat_full && s.vat_full.toUpperCase() === rawInput);
    if (hit) candidates.set(hit.id, buildCandidate(hit, 99, 'exact_vat_full'));
  }

  // Step 1b: Exact AFM (9 digits, Greek)
  if (digitsOnly.length === 9 && !candidates.size) {
    const hit = state.suppliers.find(s => s.afm === digitsOnly);
    if (hit) candidates.set(hit.id, buildCandidate(hit, 99, 'exact_vat'));
  }

  // Step 1c: Stripped VAT digits match against AFM column
  if (!candidates.size && strippedVat) {
    const stripDigits = strippedVat.replace(/\D/g, '');
    if (stripDigits.length >= 8) {
      const hit = state.suppliers.find(s => s.afm === stripDigits);
      if (hit) candidates.set(hit.id, buildCandidate(hit, 97, 'stripped_prefix_vat'));
    }
  }

  // Step 2: Zero-pad για 8-digit AFM
  if (!candidates.size && digitsOnly.length >= 7 && digitsOnly.length <= 9) {
    const padded = digitsOnly.padStart(9, '0');
    const hit = state.suppliers.find(s => s.afm === padded);
    if (hit) candidates.set(hit.id, buildCandidate(hit, 94, 'normalized_vat'));
  }

  // Step 3: Near-miss (1 digit different) — μόνο αν δεν βρήκαμε τίποτα
  if (!candidates.size && digitsOnly.length === 9) {
    for (const s of state.suppliers) {
      if (!s.afm || s.afm.length !== 9) continue;
      let diff = 0;
      for (let i = 0; i < 9; i++) if (s.afm[i] !== digitsOnly[i]) diff++;
      if (diff === 1) {
        candidates.set(s.id, buildCandidate(s, 80, 'near_miss_vat'));
        break;
      }
    }
  }

  // Step 4: Fuzzy name matching (πάντα, για extra candidates)
  if (supplierNameHint) {
    const normHint = normalizeForMatch(supplierNameHint);
    if (normHint.length >= 4) {
      const scored = state.suppliers
        .filter(s => s.status === 'active')
        .map(s => ({ s, score: similarity(normHint, s.name_normalized) }))
        .filter(x => x.score >= 60)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      for (const { s, score } of scored) {
        const existing = candidates.get(s.id);
        if (existing) {
          existing.confidence = Math.min(99, Math.round((existing.confidence + score) / 2 + 10));
          existing.match_method += '+fuzzy_name';
        } else {
          candidates.set(s.id, buildCandidate(s, score, 'fuzzy_name'));
        }
      }
    }
  }

  // Step 5: Full-text scan when no strong match yet
  if (fullText && candidates.size === 0) {
    const hit = fuzzyFindSupplierInText(fullText, state.suppliers);
    if (hit) {
      const c = buildCandidate(hit.supplier, hit.score, hit.method || 'text_scan');
      const existing = candidates.get(hit.supplier.id);
      if (!existing || c.confidence > existing.confidence) {
        candidates.set(hit.supplier.id, c);
      }
    }
  }

  const sorted = Array.from(candidates.values()).sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0] && sorted[0].confidence >= 90 ? sorted[0] : null;
  return { best, all: sorted.slice(0, 10) };
}

export function buildCandidate(s, confidence, match_method) {
  return {
    supplier_id: s.id, afm: s.afm, sap_vendor_code: s.sap_vendor_code,
    name: s.name, folder_path: s.folder_path,
    confidence, match_method,
  };
}

// ═══════════════════════════════════════════════════════════
// VALIDATION (spec §7)
// ═══════════════════════════════════════════════════════════
export function validateForArchive(payload) {
  const errors = [];
  if (!payload.supplier_id) errors.push({ field: 'supplier', message: 'Απαιτείται επιλογή προμηθευτή.' });
  if (!payload.afm) errors.push({ field: 'afm', message: 'Απαιτείται ΑΦΜ.' });
  if (!payload.invoice_number) errors.push({ field: 'invoice_number', message: 'Απαιτείται αριθμός τιμολογίου.' });
  if (!payload.invoice_date) errors.push({ field: 'invoice_date', message: 'Απαιτείται ημερομηνία.' });
  if (!payload.sap_doc_number) errors.push({ field: 'sap_doc_number', message: 'Απαιτείται SAP Doc Number.' });

  if (payload.afm) {
    const clean = payload.afm.replace(/[^0-9]/g, '');
    if (clean.length !== 9) errors.push({ field: 'afm', message: `Το ΑΦΜ πρέπει να έχει 9 ψηφία (βρέθηκαν ${clean.length}).` });
    else if (!validateAfmChecksum(clean)) errors.push({ field: 'afm', message: 'Το ΑΦΜ αποτυγχάνει τον έλεγχο MOD-11.' });
  }
  if (payload.sap_doc_number) {
    const clean = payload.sap_doc_number.replace(/[^0-9]/g, '');
    if (clean.length < 6 || clean.length > 12) {
      errors.push({ field: 'sap_doc_number', message: `Το SAP Doc Number πρέπει να έχει 6–12 ψηφία (βρέθηκαν ${clean.length}).` });
    }
  }
  if (payload.invoice_date) {
    const d = new Date(payload.invoice_date);
    const now = new Date();
    const future30 = new Date(now.getTime() + 30 * 86400000);
    if (d.getFullYear() < 1990) errors.push({ field: 'invoice_date', message: 'Η ημερομηνία είναι πολύ παλιά.' });
    else if (d > future30) errors.push({ field: 'invoice_date', message: 'Η ημερομηνία είναι στο μέλλον.' });
  }
  // Duplicate check
  if (payload.supplier_id && payload.invoice_number) {
    const dup = state.invoices.find(i =>
      i.status === 'archived' &&
      i.supplier_id === payload.supplier_id &&
      i.invoice_number === payload.invoice_number &&
      i.id !== payload._excludeId
    );
    if (dup) errors.push({ field: 'invoice_number', message: `Υπάρχει ήδη αρχειοθετημένο τιμολόγιο ${payload.invoice_number} για αυτόν τον προμηθευτή (id=${dup.id}).` });
  }
  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════
// FILENAME BUILDER (spec §6)
// ═══════════════════════════════════════════════════════════
export function sanitizePart(v) {
  return String(v || '').trim().replace(/[^A-Za-z0-9_\-.]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'UNKNOWN';
}
export function buildArchiveFilename(invoiceNo, sapDocNo, dateISO) {
  const dt = new Date(dateISO);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  // Κράτα ΜΟΝΟ το τελευταίο καθαρό αριθμητικό block, αγνοώντας τυχόν year suffix
  //   "TPY-S1-112543" → "112543"
  //   "ΤΔΑ-45/2026"   → "45" (όχι "2026", γιατί είναι έτος)
  //   "FT/2026/00445" → "00445"
  const raw = String(invoiceNo || '').trim();
  const parts = raw.split(/[^0-9A-Za-zΑ-Ωα-ω]+/u).filter(Boolean);
  let digitBlock = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!/^\d+$/.test(parts[i])) continue;
    // Skip 4-digit years (19xx-20xx) αν υπάρχει προηγούμενο block
    const looksLikeYear = parts[i].length === 4 && /^(19|20)\d\d$/.test(parts[i]);
    if (looksLikeYear && i > 0) continue;
    digitBlock = parts[i];
    break;
  }
  // Fallback: όλα τα ψηφία μαζί
  const digitsOnly = digitBlock || raw.replace(/\D/g, '');
  const inv = 'INV' + (digitsOnly || 'UNKNOWN');
  const sap = sanitizePart(sapDocNo);
  return `${inv}_${sap}_${y}${m}${d}.pdf`;
}

// ═══════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════
