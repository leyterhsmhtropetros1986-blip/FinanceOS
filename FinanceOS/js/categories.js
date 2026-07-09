/** Auto-categorize invoices by supplier / keywords */
const RULES = [
  { id: 'transport', label: 'Μεταφορικά', kw: ['COSCO', 'MAERSK', 'MSC', 'DHL', 'FEDEX', 'UPS', 'ΜΕΤΑΦΟΡ', 'FREIGHT', 'SHIPPING', 'ΛΙΜΑΝΙ'] },
  { id: 'rent', label: 'Ενοίκια', kw: ['ΕΝΟΙΚΙ', 'RENT', 'LEASE', 'ΜΙΣΘΩΜΑ'] },
  { id: 'deh', label: 'ΔΕΗ', kw: ['ΔΕΗ', 'DEI', 'ΔΗΜΟΣΙΑ ΕΠΙΧΕΙΡΗΣΗ ΗΛΕΚΤΡΙΣΜΟΥ'] },
  { id: 'ote', label: 'ΟΤΕ', kw: ['ΟΤΕ', 'OTE', 'COSMOTE', 'VODAFONE', 'WIND'] },
  { id: 'fuel', label: 'Καύσιμα', kw: ['ΕΛΙΝ', 'ΕΛΙΝΟΙΛ', 'BP', 'SHELL', 'ΚΑΥΣΙΜ', 'FUEL', 'ΠΡΑΤΗΡΙ'] },
  { id: 'fixed', label: 'Πάγια', kw: ['ΠΑΓΙ', 'FIXED', 'ΜΗΝΙΑΙ', 'SUBSCRIPTION'] },
  { id: 'services', label: 'Υπηρεσίες', kw: ['ΥΠΗΡΕΣΙ', 'SERVICE', 'ΣΥΜΒΟΥΛ', 'CONSULT', 'ΛΟΓΙΣΤ'] },
];

export function categorizeInvoice({ supplierName, fullText, afm }) {
  const hay = `${supplierName || ''} ${fullText || ''} ${afm || ''}`.toUpperCase();
  for (const rule of RULES) {
    if (rule.kw.some((k) => hay.includes(k))) {
      return { id: rule.id, label: rule.label };
    }
  }
  return { id: 'other', label: 'Λοιπά' };
}

export function getCategoryRules() {
  return RULES;
}
