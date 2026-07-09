/** Claude Vision AI OCR */
import { state } from './state.js';
import { downscaleCanvas, arrayBufferToBase64 } from './storage.js';
import { saveSettings, updateEngineStatus } from './settings.js';

export function buildAIPrompt() {
  const own = state.settings.ownCompany || {};
  const ownAfmLine = own.afm
    ? `\nΤΟ ΤΙΜΟΛΟΓΙΟ ΑΠΕΥΘΥΝΕΤΑΙ ΣΤΗΝ ΕΤΑΙΡΕΙΑ ΜΑΣ:
- Επωνυμία: ${own.name || '—'}
- ΑΦΜ: ${own.afm}
Ο ΑΦΜ ${own.afm} είναι ΔΙΚΟΣ ΜΑΣ (πελάτης). ΑΓΝΟΗΣΕ ΤΟΝ.
Ψάξε τον ΑΛΛΟ ΑΦΜ στο τιμολόγιο — αυτόν του προμηθευτή που εξέδωσε το τιμολόγιο.\n`
    : '';

  return `Είσαι ειδικός εξαγωγής δεδομένων από ελληνικά τιμολόγια (παραστατικά).

━━━━━ ΚΡΙΣΙΜΟ: ΠΡΟΣΑΝΑΤΟΛΙΣΜΟΣ ━━━━━
Το τιμολόγιο μπορεί να είναι σε **ΟΡΙΖΟΝΤΙΟ (landscape)**, ΚΑΘΕΤΟ (portrait), ή περιστραμμένο κατά 90°/180°/270°.
Ανεξαρτήτως προσανατολισμού, ΠΑΝΤΑ γύρισε το κείμενο στη σωστή θέση για να το διαβάσεις και ΕΞΑΓΑΓΕ τα πεδία.
ΠΟΤΕ ΜΗΝ επιστρέψεις άδεια invoices array επειδή το τιμολόγιο είναι rotated — πάντα προσπάθησε.

━━━━━
Το PDF/εικόνα μπορεί να περιέχει ΕΝΑ ή ΠΕΡΙΣΣΟΤΕΡΑ ξεχωριστά τιμολόγια (merged σε ένα αρχείο).
${ownAfmLine}
ΓΙΑ ΚΑΘΕ ΞΕΧΩΡΙΣΤΟ ΤΙΜΟΛΟΓΙΟ που βλέπεις, εξάγαγε τα πεδία του και ΠΟΙΕΣ σελίδες περιλαμβάνει.

━━━━━ ΠΡΟΜΗΘΕΥΤΗΣ (ΕΚΔΟΤΗΣ) ━━━━━
Ο ΠΡΟΜΗΘΕΥΤΗΣ είναι αυτός που ΕΞΕΔΩΣΕ το τιμολόγιο, ΟΧΙ ο πελάτης που το λαμβάνει.
Στο τιμολόγιο υπάρχουν ΔΥΟ ΑΦΜ:
1. ΤΟΥ ΠΡΟΜΗΘΕΥΤΗ — στην κορυφή, κοντά σε "ΕΔΡΑ HEAD OFFICE", "ΑΦΜ TAX REGISTRATION". ΑΥΤΟΝ ΘΕΛΩ.
2. ΤΟΥ ΠΕΛΑΤΗ (εμάς) — μέσα σε πλαίσιο "ΣΤΟΙΧΕΙΑ ΣΥΝΑΛΛΑΣΣΟΜΕΝΟΥ / CUSTOMER DATA". ΑΓΝΟΗΣΕ.

━━━━━ SAP DOC NUMBER (ΧΕΙΡΟΓΡΑΦΟΣ) ━━━━━
Ο SAP Doc Number είναι πάντα ΧΕΙΡΟΓΡΑΦΟΣ (γραμμένος με στυλό στο πάνω μέρος).
**ΞΕΚΙΝΑΕΙ ΠΑΝΤΑ με ένα από: "1900", "510", "1700", ή "20"**.
Παράδειγμα έγκυρων: 1900101132, 1900101440, 5100078234, 1700005512, 2000123456.
Αν υπάρχουν πολλοί χειρόγραφοι αριθμοί, διάλεξε αυτόν που ξεκινά με τα παραπάνω prefixes.
Αν δεν βλέπεις κανέναν με αυτά τα prefixes, βάλε null.

━━━━━ ΠΕΔΙΑ ━━━━━
Για κάθε τιμολόγιο δώσε:
- page_start / page_end: 1-indexed σελίδες που καλύπτει.
- afm_supplier: 9ψήφιο ΑΦΜ του ΠΡΟΜΗΘΕΥΤΗ (χωρίς country prefix EL/IT/DE).
- invoice_number: Αριθμός τιμολογίου (πχ. TPY-S1-114344).
- invoice_date: YYYY-MM-DD.
- sap_doc_number: Χειρόγραφος αριθμός SAP (6–12 ψηφία). Μην απορρίπτεις έγκυρα νούμερα λόγω prefix — κράτα ακριβώς ό,τι βλέπεις στο έγγραφο.
- supplier_name: Επωνυμία προμηθευτή.
- net_amount: Καθαρή αξία (πριν ΦΠΑ). Δεκαδικός με τελεία (πχ. 77.42). null αν δεν βρεθεί.
- vat_amount: ΦΠΑ. Δεκαδικός με τελεία (πχ. 18.58). null αν δεν βρεθεί.
- total_amount: Συνολικό ποσό (καθαρή + ΦΠΑ). Δεκαδικός με τελεία (πχ. 96.00). null αν δεν βρεθεί.
- currency: 3-letter ISO code (πχ. "EUR", "USD", "GBP"). Default "EUR" για Ελληνικά τιμολόγια.
- vat_rate: Συντελεστής ΦΠΑ % (πχ. 24 για 24%, 13, 6, 0). null αν άγνωστος.
- confidence: 0-100 για κάθε πεδίο.

Επίστρεψε ΜΟΝΟ raw JSON χωρίς κανένα άλλο κείμενο, χωρίς \`\`\`json fences, χωρίς εξηγήσεις:
{
  "invoices": [
    {
      "page_start": 1,
      "page_end": 1,
      "afm_supplier": "094450902",
      "invoice_number": "TPY-S1-114344",
      "invoice_date": "2026-06-10",
      "sap_doc_number": "1900101132",
      "supplier_name": "DHL EXPRESS (ΕΛΛΑΣ)",
      "net_amount": 77.42,
      "vat_amount": 18.58,
      "total_amount": 96.00,
      "currency": "EUR",
      "vat_rate": 24,
      "confidence": {
        "afm_supplier": 99, "invoice_number": 99, "invoice_date": 99,
        "sap_doc_number": 85, "supplier_name": 99,
        "net_amount": 99, "vat_amount": 99, "total_amount": 99
      }
    }
  ]
}

Αν το αρχείο έχει 1 τιμολόγιο, βάλε 1 object. Αν έχει 3, βάλε 3.
Αν πεδίο δεν βρίσκεται, βάλε null και confidence 0.
Αν ΔΕΝ ΜΠΟΡΕΙΣ να διαβάσεις το τιμολόγιο (πολύ κακή ποιότητα, όχι invoice), επίστρεψε {"invoices": []} — ΠΑΝΤΑ έγκυρο JSON.`;
}

export async function runClaudeVisionOCR(canvases, onProgress) {
  const s = state.settings;
  if (!s.apiKey) throw new Error('Δεν έχει οριστεί API key. Πήγαινε στις Ρυθμίσεις AI.');

  onProgress?.('Προετοιμασία εικόνας…', 0.1);

  const canvas = canvases[0];
  const scaled = downscaleCanvas(canvas, 2000);
  const base64 = scaled.toDataURL('image/jpeg', 0.85).split(',')[1];

  return await callClaudeAPI(
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
    canvases,
    onProgress
  );
}

/**
 * Στέλνει PDF/image bytes ΑΠΕΥΘΕΙΑΣ στο Claude API — χωρίς PDF.js rendering.
 * Το Claude API υποστηρίζει PDF documents native (up to 32MB, 100 pages).
 * Αυτό αποφεύγει το bottleneck του browser PDF rendering.
 */
export async function runClaudeVisionOCRDirect(file, onProgress) {
  const s = state.settings;
  if (!s.apiKey) throw new Error('Δεν έχει οριστεί API key. Πήγαινε στις Ρυθμίσεις AI.');

  onProgress?.('Ανάγνωση αρχείου…', 0.1);
  const buffer = await file.arrayBuffer();

  onProgress?.('Encoding base64…', 0.2);
  const base64 = arrayBufferToBase64(buffer);

  const name = file.name.toLowerCase();
  const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf');

  let content;
  if (isPdf) {
    content = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  } else {
    // Determine image mime type
    let mime = file.type || 'image/jpeg';
    if (name.endsWith('.png')) mime = 'image/png';
    else if (name.endsWith('.gif')) mime = 'image/gif';
    else if (name.endsWith('.webp')) mime = 'image/webp';
    content = { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } };
  }

  return await callClaudeAPI(content, null, onProgress);
}

export async function callClaudeAPI(contentBlock, canvases, onProgress) {
  const s = state.settings;
  onProgress?.('Αποστολή σε Claude Vision…', 0.3);

  const t0 = performance.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: s.model || 'claude-sonnet-5',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [contentBlock, { type: 'text', text: buildAIPrompt() }]
      }]
    })
  });

  onProgress?.('Ανάλυση απάντησης…', 0.9);

  if (!response.ok) {
    let errBody = '';
    try { errBody = await response.text(); } catch (e) {}
    let errMsg = `API error ${response.status}`;
    try { const j = JSON.parse(errBody); if (j.error?.message) errMsg = j.error.message; }
    catch (e) { errMsg += ': ' + errBody.slice(0, 200); }
    throw new Error(errMsg);
  }

  const data = await response.json();
  console.log('Claude response:', data);  // debug

  // Concatenate ALL text blocks (Claude sometimes returns multiple)
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n');

  if (!text.trim()) {
    console.error('Empty Claude response:', data);
    const reason = data.stop_reason || 'unknown';
    throw new Error(`Το Claude επέστρεψε κενή απάντηση (stop_reason: ${reason}). Δοκίμασε ξανά ή έλεγξε αν το αρχείο είναι σωστό.`);
  }

  // Extract JSON — handle markdown fences, prefix text, etc.
  const jsonStr = extractJsonFromText(text);
  if (!jsonStr) {
    console.error('No JSON in Claude response. Full text:', text);
    throw new Error(`Το Claude δεν επέστρεψε JSON. Απάντηση: "${text.slice(0, 300)}${text.length > 300 ? '…' : ''}"`);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error('JSON parse failed. Extracted:', jsonStr);
    throw new Error(`Άκυρο JSON από Claude: ${e.message}. Δοκίμασε ξανά.`);
  }

  const processingMs = Math.round(performance.now() - t0);
  try {
    if (data.usage) trackAIUsage(data.usage, s.model);
  } catch (e) {
    console.warn('AI usage tracking failed (non-fatal):', e);
  }

  // Normalize response
  const invoicesArray = Array.isArray(parsed.invoices)
    ? parsed.invoices
    : (parsed.afm_supplier !== undefined ? [parsed] : []);

  if (!invoicesArray.length) {
    throw new Error(`Το Claude δεν βρήκε τιμολόγιο. Απάντηση: ${text.slice(0, 200)}`);
  }

  const extractedList = invoicesArray.map(inv => {
    const conf = inv.confidence || {};
    return {
      afm: inv.afm_supplier || null,
      invoice_number: inv.invoice_number || null,
      invoice_date: inv.invoice_date || null,
      sap_doc_number: inv.sap_doc_number || null,
      supplier_name_hint: inv.supplier_name || null,
      net_amount: typeof inv.net_amount === 'number' ? inv.net_amount : null,
      vat_amount: typeof inv.vat_amount === 'number' ? inv.vat_amount : null,
      total_amount: typeof inv.total_amount === 'number' ? inv.total_amount : null,
      currency: inv.currency || 'EUR',
      vat_rate: typeof inv.vat_rate === 'number' ? inv.vat_rate : null,
      page_start: inv.page_start || 1,
      page_end: inv.page_end || 1,
      confidence_afm: conf.afm_supplier ?? 0,
      confidence_invoice_no: conf.invoice_number ?? 0,
      confidence_date: conf.invoice_date ?? 0,
      confidence_sap_doc: conf.sap_doc_number ?? 0,
      confidence_supplier: conf.supplier_name ?? 0,
      confidence_amount: conf.total_amount ?? conf.net_amount ?? 0,
      sap_doc_candidates: inv.sap_doc_number ? [{
        value: inv.sap_doc_number,
        confidence: conf.sap_doc_number ?? 0,
        source: 'claude_vision', page: inv.page_start || 1, reason: 'AI extraction',
      }] : [],
    };
  });

  return {
    pageCount: canvases ? canvases.length : Math.max(...invoicesArray.map(i => i.page_end || 1)),
    processingMs,
    engine: `Claude Vision (${s.model || 'claude-sonnet-5'})`,
    canvases: canvases || [],
    fullText: text,
    extractedList,
    extracted: extractedList[0],
    supplierHint: invoicesArray[0]?.supplier_name,
    aiUsage: data.usage,
    isMultiInvoice: extractedList.length > 1,
  };
}

/**
 * Robust JSON extraction από Claude response.
 * Χειρίζεται: markdown fences, prefix text, JSON σε οποιοδήποτε σημείο.
 */
export function extractJsonFromText(text) {
  if (!text) return null;
  // Try 1: markdown code fence ```json ... ```
  let m = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (m) return m[1];
  // Try 2: μεγαλύτερο possible JSON object (greedy)
  m = text.match(/\{[\s\S]*\}/);
  if (m) return m[0];
  return null;
}

/** Track token usage & cost — must never throw or block OCR */
export function trackAIUsage(usage, model) {
  try {
    if (!usage) return;
    const rates = {
      'claude-sonnet-5':           { in: 3.0,  out: 15.0 },
      'claude-haiku-4-5-20251001': { in: 1.0,  out: 5.0  },
    };
    const rate = rates[model] || rates['claude-sonnet-5'];
    const cost = (usage.input_tokens / 1e6) * rate.in + (usage.output_tokens / 1e6) * rate.out;
    state.settings.totalCost = (state.settings.totalCost || 0) + cost;
    state.settings.totalCalls = (state.settings.totalCalls || 0) + 1;
    saveSettings();
    updateEngineStatus();
  } catch (e) {
    console.warn('trackAIUsage failed (non-fatal):', e);
  }
}

// ═══════════════════════════════════════════════════════════
