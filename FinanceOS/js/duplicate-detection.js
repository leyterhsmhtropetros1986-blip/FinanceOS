/**
 * Duplicate invoice protection (Phase 7) — richer than the existing
 * archive-time check in storage.js:findDuplicateInvoice (which stays
 * untouched and keeps gating the existing archive flow). This module adds
 * amount/currency/VAT-aware checks for the SAP-preparation pipeline and
 * never deletes anything — a possible duplicate is always just surfaced.
 */
import { normalizeVat, normalizeInvoiceNumber } from './normalize.js';

export const DUPLICATE_STATUS = {
  NONE: 'NO_DUPLICATE',
  POSSIBLE: 'POSSIBLE_DUPLICATE',
  CONFIRMED: 'CONFIRMED_DUPLICATE',
};

function amountsMatch(a, b, toleranceCents) {
  if (a == null || b == null) return false;
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= toleranceCents;
}

/**
 * @param {object} invoice - the invoice being checked. Reads: invoice_number,
 *   invoice_date, total_amount, currency, afm, and sap_vendor_code (the SAP
 *   Vendor Matching Engine's result, if any matched invoices carry it).
 * @param {object[]} allInvoices - the full invoice set to compare against.
 * @param {{ toleranceCents?: number }} opts - rounding tolerance for amounts.
 */
export function checkDuplicate(invoice, allInvoices, { toleranceCents = 1 } = {}) {
  const invNumNorm = normalizeInvoiceNumber(invoice.invoice_number).normalizedValue;
  const vendorCode = invoice.sap_vendor_code || null;
  const vatNorm = invoice.afm ? normalizeVat(invoice.afm).normalizedValue : null;
  const gross = invoice.total_amount;
  const currency = invoice.currency || null;
  const date = invoice.invoice_date || null;

  const confirmed = [];
  const possible = [];

  for (const other of allInvoices || []) {
    if (!other || other.id === invoice.id) continue;
    if (other.status === 'deleted') continue;

    const otherInvNumNorm = normalizeInvoiceNumber(other.invoice_number).normalizedValue;
    const otherVendorCode = other.sap_vendor_code || null;
    const otherVatNorm = other.afm ? normalizeVat(other.afm).normalizedValue : null;
    const sameAmount = amountsMatch(gross, other.total_amount, toleranceCents);
    const sameVendor = !!vendorCode && vendorCode === otherVendorCode;
    const sameVat = !!vatNorm && vatNorm === otherVatNorm;
    const sameCurrency = !!currency && currency === (other.currency || null);
    const sameDate = !!date && date === (other.invoice_date || null);

    if (invNumNorm && otherInvNumNorm && invNumNorm === otherInvNumNorm) {
      // Combo A: SAP Vendor + invoice number + invoice date + gross amount + currency
      const comboA = sameVendor && sameDate && sameAmount && sameCurrency;
      // Combo B: VAT + invoice number + amount
      const comboB = sameVat && sameAmount;

      if (comboA) {
        confirmed.push({ id: other.id, reason: 'Ίδιο SAP Vendor + Αρ. Τιμολογίου + Ημερομηνία + Ποσό + Νόμισμα' });
      } else if (comboB) {
        confirmed.push({ id: other.id, reason: 'Ίδιο ΑΦΜ + Αρ. Τιμολογίου + Ποσό' });
      } else if (sameVendor || sameVat || sameAmount) {
        possible.push({
          id: other.id,
          reason: `Ίδιος αριθμός τιμολογίου${sameAmount ? ' + ίδιο ποσό' : ' — διαφορετικό ποσό'}${(sameVendor || sameVat) ? '' : ' — προμηθευτής/ΑΦΜ διαφορετικό ή άγνωστο'}`,
        });
      } else {
        // Same invoice number but nothing else corroborates — still worth a look.
        possible.push({ id: other.id, reason: 'Ίδιος αριθμός τιμολογίου, χωρίς άλλη επιβεβαίωση' });
      }
    } else if (!invNumNorm || !otherInvNumNorm) {
      // Invoice number missing on one/both sides — can't confirm, but a
      // strong vendor+amount+date coincidence is still worth flagging.
      if ((sameVendor || sameVat) && sameAmount && sameDate) {
        possible.push({ id: other.id, reason: 'Αριθμός τιμολογίου λείπει — αλλά ίδιος προμηθευτής/ΑΦΜ + ποσό + ημερομηνία' });
      }
    }
  }

  if (confirmed.length) {
    return {
      status: DUPLICATE_STATUS.CONFIRMED,
      matchedInvoiceIds: confirmed.map((c) => c.id),
      reasons: confirmed.map((c) => c.reason),
    };
  }
  if (possible.length) {
    return {
      status: DUPLICATE_STATUS.POSSIBLE,
      matchedInvoiceIds: possible.map((p) => p.id),
      reasons: possible.map((p) => p.reason),
    };
  }
  return { status: DUPLICATE_STATUS.NONE, matchedInvoiceIds: [], reasons: [] };
}
