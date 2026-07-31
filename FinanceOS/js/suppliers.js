/** Suppliers import & management */
import { state } from './state.js';
import { $, toast, debounce, escapeHtml } from './utils.js';
import { stripAccents, normalizeForMatch } from './helpers.js';
import { normalizeIban } from './normalize.js';
import { audit } from './audit.js';
import { scheduleSave } from './storage.js';

export function seedSuppliers() {
  // Παραδείγματα — αντικαθίστανται όταν εισάγετε τη δική σας λίστα
  const seed = [
    { afm: '094450902', vat_full: 'EL094450902', country: 'GR', sap_vendor_code: '300100', name: 'DHL EXPRESS (ΕΛΛΑΣ) ΜΟΝΟΠΡΟΣΩΠΗ Α.Ε.', status: 'active' },
    { afm: '094452286', vat_full: 'EL094452286', country: 'GR', sap_vendor_code: '302847', name: 'PALAPLAST', status: 'active' },
    { afm: '094299908', vat_full: 'EL094299908', country: 'GR', sap_vendor_code: '303663', name: 'TECHNOPLASTIC', status: 'active' },
    { afm: '094126376', vat_full: 'EL094126376', country: 'GR', sap_vendor_code: '306500', name: 'RIVULIS ABEGE', status: 'active' },
    { afm: '00846110898', vat_full: 'IT00846110898', country: 'IT', sap_vendor_code: '300402', name: 'PLAST PROJECT, SRL', status: 'active' },
    { afm: '364307019', vat_full: 'US364307019', country: 'US', sap_vendor_code: '300995', name: 'THERMAL CARE, INC.', status: 'active' },
  ];
  let id = 1;
  state.suppliers = seed.map(s => ({
    ...s,
    id: id++,
    name_normalized: normalizeForMatch(s.name),
    folder_path: buildSupplierFolder(s.sap_vendor_code, s.name),
  }));
  audit('supplier_import', 'success', `Seed data: ${seed.length} demo suppliers — εισάγετε το δικό σας αρχείο`, { actor: 'system', details: { imported: seed.length } });
}

// ═══════════════════════════════════════════════════════════

// SUPPLIERS VIEW
// ═══════════════════════════════════════════════════════════

export async function parseXLSX(file) {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

export function parseCSVToRows(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('Άδειο αρχείο');
  const header = lines[0].split(',').map(h => h.trim().replace(/^\ufeff/, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (cols[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

/**
 * Universal column mapping για δύο formats:
 *   1. Normalized: "AFM", "SAP Vendor Code", "Name", "Folder Path", "Status"
 *   2. SAP raw export: "Προμηθ", "Ονομα 1", "Αριθμός Μητρώου ΦΠΑ", "Χώρ"
 */
const COLUMN_ALIASES = {
  afm: ['afm', 'αφμ', 'α.φ.μ.', 'vat', 'vat_number', 'tax_id'],
  sap: ['sap vendor code', 'sap_vendor_code', 'sap vendor', 'sap_code',
        'προμηθ', 'προμηθευτής', 'vendor code', 'κωδικός sap'],
  name: ['name', 'επωνυμία', 'επωνυμια', 'supplier', 'company',
         'ονομα 1', 'όνομα 1', 'ονομα', 'όνομα'],
  folder: ['folder path', 'folder_path', 'path', 'φάκελος', 'folder'],
  status: ['status', 'κατάσταση', 'κατασταση', 'state'],
  country: ['country', 'χώρα', 'χωρα', 'χώρ', 'χωρ'],
  vat_full: ['vat full', 'vat_full', 'αριθμός μητρώου φπα', 'αριθμος μητρωου φπα'],
  // SAP Vendor Master enrichment (Phase 3) — all optional, never required
  iban: ['iban', 'ιβαν', 'bank account', 'τραπεζικός λογαριασμός'],
  company_code: ['company code', 'company_code', 'εταιρεία sap', 'κωδικός εταιρείας', 'bukrs'],
  payment_terms: ['payment terms', 'payment_terms', 'όροι πληρωμής', 'οροι πληρωμης', 'zterm'],
  reconciliation_account: ['reconciliation account', 'reconciliation_account', 'λογαριασμός συμφωνίας', 'akont'],
  active: ['active', 'ενεργός', 'ενεργος', 'is_active'],
};

export function resolveColumns(sampleRow) {
  const keys = Object.keys(sampleRow || {});
  const normKeys = keys.map(k => stripAccents(k).toLowerCase().replace(/\s+/g, ' ').trim());
  const find = (aliases) => {
    for (const a of aliases) {
      const idx = normKeys.indexOf(stripAccents(a).toLowerCase());
      if (idx !== -1) return keys[idx];
    }
    return null;
  };
  return {
    afm: find(COLUMN_ALIASES.afm),
    sap: find(COLUMN_ALIASES.sap),
    name: find(COLUMN_ALIASES.name),
    folder: find(COLUMN_ALIASES.folder),
    status: find(COLUMN_ALIASES.status),
    country: find(COLUMN_ALIASES.country),
    vat_full: find(COLUMN_ALIASES.vat_full),
    iban: find(COLUMN_ALIASES.iban),
    company_code: find(COLUMN_ALIASES.company_code),
    payment_terms: find(COLUMN_ALIASES.payment_terms),
    reconciliation_account: find(COLUMN_ALIASES.reconciliation_account),
    active: find(COLUMN_ALIASES.active),
  };
}

/** Extract & normalize one vendor-master row's fields — shared by the commit
 *  path (importSupplierRows) and the pre-commit validation preview
 *  (analyzeVendorMasterImport) so both agree on what a row means. */
function extractVendorRowFields(row, cols) {
  const country = cols.country ? String(row[cols.country] || '').trim().toUpperCase() : '';
  const sapCode = cols.sap ? String(row[cols.sap] || '').trim() : '';
  const name = cols.name ? String(row[cols.name] || '').trim() : '';
  const vatCol = cols.vat_full ? row[cols.vat_full] : (cols.afm ? row[cols.afm] : '');
  const { afm, full_vat } = extractAfmFromVat(vatCol, country, cols.afm ? row[cols.afm] : '');

  let identifier = afm;
  if (country === 'GR' && identifier && identifier.length === 8) identifier = '0' + identifier;

  const iban = cols.iban ? (normalizeIban(row[cols.iban]).normalizedValue || null) : null;
  const companyCode = cols.company_code ? (String(row[cols.company_code] || '').trim() || null) : null;
  const paymentTerms = cols.payment_terms ? (String(row[cols.payment_terms] || '').trim() || null) : null;
  const reconciliationAccount = cols.reconciliation_account
    ? (String(row[cols.reconciliation_account] || '').trim() || null) : null;
  const status = cols.status
    ? (String(row[cols.status] || 'active').trim().toLowerCase() || 'active')
    : 'active';
  const active = cols.active
    ? /^(1|true|yes|y|ναι|ενεργ)/i.test(String(row[cols.active] || '').trim())
    : status === 'active';

  return {
    country, sapCode, name, afm: identifier, vat_full: full_vat,
    iban, companyCode, paymentTerms, reconciliationAccount, status, active,
  };
}

/**
 * Pre-commit validation pass for a vendor-master import (Phase 3). Does NOT
 * touch state.suppliers — purely a report so the user can review what would
 * happen (new rows, updates with a field-level diff, duplicates, missing
 * vendor codes, duplicate VAT/IBAN) before anything is overwritten.
 */
export function analyzeVendorMasterImport(rows) {
  const report = {
    totalRows: rows.length,
    validRows: 0,
    invalidRows: 0,
    duplicates: 0,
    missingVendorCodes: 0,
    duplicateVat: [],
    duplicateIban: [],
    entries: [],
    error: null,
  };
  if (!rows.length) { report.error = 'Δεν βρέθηκαν γραμμές'; return report; }

  const cols = resolveColumns(rows[0]);
  if (!cols.sap && !cols.afm) {
    report.invalidRows = rows.length;
    report.error = 'Δεν βρέθηκαν οι στήλες ΑΦΜ ή SAP Vendor Code.';
    return report;
  }

  const seenVatInBatch = new Map();
  const seenIbanInBatch = new Map();
  const seenDedupKeys = new Set();

  rows.forEach((row, i) => {
    const f = extractVendorRowFields(row, cols);
    const rowIndex = i + 2; // +1 header, +1 1-indexed
    const entry = {
      rowIndex, sapVendorCode: f.sapCode || null, name: f.name || null,
      status: 'new', reasons: [], changes: [],
    };

    if (!f.afm && !f.sapCode) { entry.status = 'invalid'; entry.reasons.push('Λείπει και ΑΦΜ και SAP Vendor Code'); }
    if (!f.name) { entry.status = 'invalid'; entry.reasons.push('Λείπει επωνυμία'); }
    if (!f.sapCode) report.missingVendorCodes++;

    const dedupKey = f.sapCode || f.afm;
    if (entry.status !== 'invalid' && dedupKey) {
      if (seenDedupKeys.has(dedupKey)) {
        entry.status = 'duplicate';
        entry.reasons.push('Διπλή εγγραφή μέσα στο ίδιο αρχείο');
        report.duplicates++;
      } else {
        seenDedupKeys.add(dedupKey);
      }
    }

    if (f.afm) seenVatInBatch.set(f.afm, [...(seenVatInBatch.get(f.afm) || []), rowIndex]);
    if (f.iban) seenIbanInBatch.set(f.iban, [...(seenIbanInBatch.get(f.iban) || []), rowIndex]);

    const existing = state.suppliers.find(s =>
      (f.afm && s.afm === f.afm) || (f.sapCode && s.sap_vendor_code === f.sapCode)
    );
    if (existing) {
      entry.matchedExistingId = existing.id;
      if (entry.status === 'new') entry.status = 'update';
      const compareFields = [
        ['name', 'name'], ['sap_vendor_code', 'sapCode'], ['country', 'country'],
        ['iban', 'iban'], ['company_code', 'companyCode'],
        ['payment_terms', 'paymentTerms'], ['reconciliation_account', 'reconciliationAccount'],
      ];
      for (const [existingKey, newKey] of compareFields) {
        const oldVal = existing[existingKey] || null;
        const newVal = f[newKey] || null;
        if (newVal != null && newVal !== oldVal) entry.changes.push({ field: existingKey, from: oldVal, to: newVal });
      }

      // Cross-check: does this row's VAT/IBAN collide with a *different* existing vendor?
      if (f.afm) {
        const clash = state.suppliers.find(s => s.afm === f.afm && s.id !== existing.id);
        if (clash) entry.reasons.push(`ΑΦΜ ήδη σε άλλον SAP vendor (${clash.sap_vendor_code})`);
      }
    } else if (f.afm) {
      const clash = state.suppliers.find(s => s.afm === f.afm);
      if (clash) entry.reasons.push(`ΑΦΜ ήδη σε άλλον SAP vendor (${clash.sap_vendor_code})`);
    }

    if (entry.status === 'new' || entry.status === 'update') report.validRows++;
    else if (entry.status === 'invalid') report.invalidRows++;
    report.entries.push(entry);
  });

  for (const [vat, idxs] of seenVatInBatch) if (idxs.length > 1) report.duplicateVat.push({ vat, rows: idxs });
  for (const [iban, idxs] of seenIbanInBatch) if (idxs.length > 1) report.duplicateIban.push({ iban, rows: idxs });

  return report;
}

/**
 * Επιστρέφει {afm, full_vat} από ένα VAT string τύπου "EL094452286" ή "IT00846110898".
 * Για Ελληνικούς προμηθευτές θέλουμε πάντα το AFM 9 ψηφίων (χωρίς EL prefix).
 */
export function extractAfmFromVat(vatRaw, country, fallbackTaxNum) {
  const vat = String(vatRaw || '').trim().toUpperCase().replace(/[\s\-]/g, '');
  const tax = String(fallbackTaxNum || '').trim().toUpperCase().replace(/[\s\-]/g, '');

  // Αν αρχίζει με 2 γράμματα (country code) → αφαιρέστε τα
  const m = vat.match(/^([A-Z]{2})(.+)$/);
  let afm = null;
  if (m) {
    const rest = m[2].replace(/\D/g, '');
    if ((country || m[1]) === 'GR' && rest.length === 9) afm = rest;
    else if (rest.length >= 8) afm = rest;
  } else if (vat) {
    const digits = vat.replace(/\D/g, '');
    if (country === 'GR' && digits.length === 9) afm = digits;
    else if (digits) afm = digits;
  }

  // Fallback στη στήλη Αριθμός Φόρου 1
  if (!afm && tax) {
    const digits = tax.replace(/\D/g, '');
    if (country === 'GR' && digits.length === 9) afm = digits;
    else if (digits) afm = digits;
  }

  return { afm, full_vat: vat || tax || null };
}

export function slugify(s) {
  return String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40).toUpperCase() || 'UNKNOWN';
}

/**
 * Εξάγει σύντομη επωνυμία από το πλήρες όνομα προμηθευτή.
 * "DHL EXPRESS (ΕΛΛΑΣ) ΜΟΝΟΠΡΟΣΩΠΗ Α.Ε." → "DHL_EXPRESS"
 * "COSMOLAC SA" → "COSMOLAC"
 * "PLAST PROJECT, SRL" → "PLAST_PROJECT"
 */
export function extractShortSupplierName(fullName) {
  if (!fullName) return 'UNKNOWN';
  let name = stripAccents(String(fullName)).toUpperCase();
  // Remove παρενθέσεις (πχ. "(ΕΛΛΑΣ)")
  name = name.replace(/\([^)]*\)/g, ' ');
  // Legal entity suffixes για ελληνικά και διεθνή
  const suffixes = [
    'ΜΟΝΟΠΡΟΣΩΠΗ', 'ΜΟΝΟΠΡΟΣΩΠΗΣ', 'ΑΝΩΝΥΜΗ', 'ΕΤΑΙΡΕΙΑ', 'ΕΤΑΙΡΙΑ',
    'Α.Ε.', 'ΑΕ', 'ΕΠΕ', 'Ε.Π.Ε.', 'ΙΚΕ', 'Ι.Κ.Ε.', 'ΟΕ', 'Ο.Ε.', 'ΕΕ', 'Ε.Ε.',
    'ABEGE', 'ΑΒΕΓΕ', 'ΑΒΕΕ', 'ΑΒΕΤΕ', 'ΑΕΒΕ', 'ΑΕΒΕΤΕ',
    'SA', 'S.A.', 'AE', 'LTD', 'LTD.', 'LIMITED',
    'GMBH', 'BV', 'B.V.', 'NV', 'N.V.',
    'INC', 'INC.', 'LLC', 'L.L.C.',
    'SRL', 'S.R.L.', 'SPA', 'S.P.A.',
    'AG', 'KG', 'OHG', 'CO', 'CO.', 'CORP', 'CORP.', 'CORPORATION',
    'COMPANY', 'GROUP', 'HOLDINGS',
  ];
  for (const s of suffixes) {
    const escaped = s.replace(/\./g, '\\.');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    name = name.replace(re, ' ');
  }
  // Καθάρισμα non-alphanumerics
  name = name.replace(/[^\wΑ-Ω0-9]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = name.split(' ').filter(w => w.length >= 2);
  let shortName = words[0] || 'UNKNOWN';
  // Ενσωματώνει και τη δεύτερη λέξη αν χωράει σε 20 χαρακτήρες
  if (words[1] && (shortName.length + words[1].length + 1) <= 20) {
    shortName = `${words[0]}_${words[1]}`;
  }
  return shortName.slice(0, 30);
}

/**
 * Δημιουργεί το folder path με format: {SAP_CODE}-{SHORT_NAME}
 * πχ. "300100-DHL_EXPRESS", "302847-PALAPLAST", "300402-PLAST_PROJECT"
 */
export function buildSupplierFolder(sapCode, name) {
  const code = String(sapCode || '000000').trim().replace(/[^A-Za-z0-9]/g, '') || '000000';
  const shortName = extractShortSupplierName(name);
  return `${code}-${shortName}`;
}

export function importSupplierRows(rows) {
  const result = { imported: 0, updated: 0, skipped: 0, errors: [] };
  if (!rows.length) throw new Error('Δεν βρέθηκαν γραμμές');
  const cols = resolveColumns(rows[0]);

  if (!cols.sap && !cols.afm) {
    throw new Error(`Δεν βρέθηκαν οι απαραίτητες στήλες.
Βρήκα: ${Object.keys(rows[0]).slice(0, 10).join(', ')}
Χρειάζομαι: ΑΦΜ ή SAP Vendor Code, Επωνυμία, [Folder Path]`);
  }
  if (!cols.name) throw new Error('Λείπει η στήλη Επωνυμία / Ονομα 1 / Name');

  const maxId = state.suppliers.reduce((m, s) => Math.max(m, s.id), 0);
  let nextId = maxId + 1;
  const seenInThisImport = new Set();

  rows.forEach((row, i) => {
    const f = extractVendorRowFields(row, cols);
    const { country, sapCode, name } = f;
    let identifier = f.afm;

    if (!identifier && !sapCode) {
      result.skipped++;
      result.errors.push(`Γραμμή ${i + 2}: λείπει και AFM και SAP code`);
      return;
    }
    if (!name) {
      result.skipped++;
      result.errors.push(`Γραμμή ${i + 2}: λείπει επωνυμία`);
      return;
    }
    // Dedup within this import by SAP code
    const dedupKey = sapCode || identifier;
    if (seenInThisImport.has(dedupKey)) {
      result.skipped++;
      return;
    }
    seenInThisImport.add(dedupKey);

    // Folder path — πάντα με format {SAP_CODE}-{SHORT_NAME}
    // Αγνοούμε τα user-provided folder paths για συνέπεια
    const folder = buildSupplierFolder(sapCode || identifier, name);

    // Match existing by AFM OR SAP code
    const existing = state.suppliers.find(s =>
      (identifier && s.afm === identifier) || (sapCode && s.sap_vendor_code === sapCode)
    );

    const record = {
      afm: identifier || '',
      sap_vendor_code: sapCode,
      name,
      country: country || '',
      vat_full: f.vat_full || '',
      iban: f.iban || (existing?.iban ?? ''),
      company_code: f.companyCode || (existing?.company_code ?? ''),
      payment_terms: f.paymentTerms || (existing?.payment_terms ?? ''),
      reconciliation_account: f.reconciliationAccount || (existing?.reconciliation_account ?? ''),
      active: f.active,
      name_normalized: normalizeForMatch(name),
      folder_path: folder,
      status: f.status,
    };

    if (existing) {
      Object.assign(existing, record);
      result.updated++;
    } else {
      state.suppliers.push({ id: nextId++, ...record });
      result.imported++;
    }
  });

  return result;
}

export function parseCSVLine(line) {
  const cols = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      cols.push(cur); cur = '';
    } else cur += c;
  }
  cols.push(cur);
  return cols.map(c => c.trim());
}

export function showImportSummary(r) {
  const box = $('#import-summary');
  box.hidden = false;
  box.classList.toggle('has-errors', r.errors.length > 0);
  const parts = [
    '<strong>Εισαγωγή ολοκληρώθηκε.</strong>',
    `Νέοι: ${r.imported}`,
    `Ενημερώθηκαν: ${r.updated}`,
    `Παραλείφθηκαν: ${r.skipped}`,
  ];
  box.innerHTML = parts.join(' · ');
  if (r.errors.length) {
    box.innerHTML += `<ul style="margin-top:6px;padding-left:20px;font-size:12px">${r.errors.slice(0, 5).map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  }
  setTimeout(() => { box.hidden = true; }, 8000);
}

export function renderSuppliers() {
  const q = $('#supplier-search').value.trim().toUpperCase();
  const tbody = $('#suppliers-table tbody');
  tbody.innerHTML = '';
  let rows = state.suppliers;
  if (q) {
    rows = rows.filter(s =>
      s.afm.includes(q) ||
      s.sap_vendor_code.includes(q) ||
      s.name_normalized.includes(q)
    );
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Δεν βρέθηκαν προμηθευτές.</td></tr>';
    return;
  }
  for (const s of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${s.afm}</td>
      <td class="mono">${escapeHtml(s.sap_vendor_code)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td class="mono">${escapeHtml(s.iban || '—')}</td>
      <td class="mono">${escapeHtml(s.company_code || '—')}</td>
      <td class="mono">${escapeHtml(s.folder_path)}</td>
      <td><span class="status-pill status-${s.status}">${s.status}</span></td>
    `;
    tbody.appendChild(tr);
  }
}

// ═══════════════════════════════════════════════════════════

let _pendingImportRows = null;

/** Render the pre-commit validation report (Phase 3) — never overwrites
 *  anything until the user explicitly confirms. */
function renderVendorMasterAnalysis(analysis) {
  const box = $('#import-summary');
  box.hidden = false;
  box.classList.toggle('has-errors', analysis.invalidRows > 0 || !!analysis.error);

  if (analysis.error) {
    box.innerHTML = `<strong>Σφάλμα:</strong> ${escapeHtml(analysis.error)}`;
    return;
  }

  const updates = analysis.entries.filter((e) => e.status === 'update' && e.changes.length);
  const parts = [
    '<strong>Προεπισκόπηση εισαγωγής SAP Vendor Master</strong>',
    `Σύνολο γραμμών: ${analysis.totalRows}`,
    `Έγκυρες: ${analysis.validRows}`,
    `Άκυρες: ${analysis.invalidRows}`,
    `Διπλότυπα στο αρχείο: ${analysis.duplicates}`,
    `Χωρίς SAP Vendor Code: ${analysis.missingVendorCodes}`,
  ];
  let html = `<div>${parts.join(' · ')}</div>`;

  if (analysis.duplicateVat.length) {
    html += `<div class="warn">⚠ Διπλό ΑΦΜ μέσα στο αρχείο: ${analysis.duplicateVat.map((d) => `${escapeHtml(d.vat)} (γραμμές ${d.rows.join(', ')})`).join('; ')}</div>`;
  }
  if (analysis.duplicateIban.length) {
    html += `<div class="warn">⚠ Διπλό IBAN μέσα στο αρχείο: ${analysis.duplicateIban.map((d) => `${escapeHtml(d.iban)} (γραμμές ${d.rows.join(', ')})`).join('; ')}</div>`;
  }
  const invalidEntries = analysis.entries.filter((e) => e.status === 'invalid').slice(0, 10);
  if (invalidEntries.length) {
    html += `<ul style="margin-top:6px;padding-left:20px;font-size:12px">${invalidEntries.map((e) => `<li>Γραμμή ${e.rowIndex}: ${escapeHtml(e.reasons.join(', '))}</li>`).join('')}</ul>`;
  }
  if (updates.length) {
    html += `<div style="margin-top:6px"><strong>Αλλαγές σε υπάρχοντες προμηθευτές (${updates.length}):</strong></div>`;
    html += `<ul style="padding-left:20px;font-size:12px">${updates.slice(0, 15).map((e) =>
      `<li>${escapeHtml(e.sapVendorCode || e.name || 'γραμμή ' + e.rowIndex)}: ${e.changes.map((c) => `${escapeHtml(c.field)} "${escapeHtml(c.from ?? '—')}" → "${escapeHtml(c.to)}"`).join(', ')}</li>`
    ).join('')}</ul>`;
  }
  html += `<div style="margin-top:8px;display:flex;gap:8px">
    <button class="btn btn-primary" id="btn-confirm-vendor-import" ${analysis.validRows ? '' : 'disabled'}>✓ Επιβεβαίωση Εισαγωγής (${analysis.validRows})</button>
    <button class="btn btn-secondary" id="btn-cancel-vendor-import">Άκυρο</button>
  </div>`;
  box.innerHTML = html;
}

export function initSuppliers() {
  $('#supplier-search')?.addEventListener('input', debounce(renderSuppliers, 200));
  $('#btn-regen-folders')?.addEventListener('click', () => {
    if (!confirm(`Ενημέρωση όλων των ${state.suppliers.length} προμηθευτών σε format {SAP}-{ΟΝΟΜΑ}?\n\nΘα επηρεαστούν μόνο μελλοντικές αρχειοθετήσεις.`)) return;
    let changed = 0;
    for (const s of state.suppliers) {
      const newFolder = buildSupplierFolder(s.sap_vendor_code, s.name);
      if (s.folder_path !== newFolder) { s.folder_path = newFolder; changed++; }
    }
    audit('supplier_import', 'success', `Regenerated ${changed} folder paths`, { actor: 'user' });
    toast(`Ενημερώθηκαν ${changed} folder paths`, 'ok');
    renderSuppliers();
  });
  $('#excel-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    try {
      let rows;
      if (name.endsWith('.xlsx') || name.endsWith('.xls')) rows = await parseXLSX(file);
      else rows = parseCSVToRows(await file.text());
      _pendingImportRows = rows;
      renderVendorMasterAnalysis(analyzeVendorMasterImport(rows));
    } catch (err) {
      toast(`Σφάλμα εισαγωγής: ${err.message}`, 'err');
      console.error(err);
    }
    e.target.value = '';
  });
  // Event delegation — #import-summary's innerHTML is rebuilt on every preview/summary render
  $('#import-summary')?.addEventListener('click', (e) => {
    if (e.target.id === 'btn-confirm-vendor-import') {
      if (!_pendingImportRows) return;
      const result = importSupplierRows(_pendingImportRows);
      _pendingImportRows = null;
      showImportSummary(result);
      audit('supplier_import', result.errors.length ? 'warning' : 'success',
        `imported=${result.imported} updated=${result.updated} skipped=${result.skipped}`,
        { actor: 'user', details: result });
      renderSuppliers();
      scheduleSave();
      toast(`+${result.imported} νέοι, ${result.updated} ενημερώθηκαν`, 'ok');
    } else if (e.target.id === 'btn-cancel-vendor-import') {
      _pendingImportRows = null;
      $('#import-summary').hidden = true;
    }
  });
}
