/** Excel & ZIP export */
import { state } from './state.js';
import { toast } from './utils.js';
import { audit } from './audit.js';

export function exportArchivedToExcel() {
  if (typeof XLSX === 'undefined') { toast('SheetJS δεν φόρτωσε', 'err'); return; }
  const rows = state.invoices
    .filter(i => i.status === 'archived' || i.status === 'duplicate')
    .map(inv => {
      const supplier = state.suppliers.find(s => s.id === inv.supplier_id);
      return {
        'ID': inv.id,
        'Αρχικό Αρχείο': inv.original_filename || '',
        'Αρχειοθετημένο Ως': inv.archived_filename || '',
        'Πλήρες Path': inv.archived_path || '',
        'Προμηθευτής': supplier ? supplier.name : '—',
        'SAP Vendor Code': supplier ? supplier.sap_vendor_code : '',
        'Φάκελος': supplier ? supplier.folder_path : '',
        'ΑΦΜ': inv.afm || '',
        'Αριθμός Τιμολογίου': inv.invoice_number || '',
        'Ημερομηνία Τιμολογίου': inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('el-GR') : '',
        'SAP Doc Number': inv.sap_doc_number || '',
        'Καθαρή Αξία': inv.net_amount || '',
        'ΦΠΑ': inv.vat_amount || '',
        'Συντ. ΦΠΑ %': inv.vat_rate || '',
        'Σύνολο': inv.total_amount || '',
        'Νόμισμα': inv.currency || 'EUR',
        'Status': inv.status,
        'Σελίδες': inv.page_count || 1,
        'Αρχειοθετήθηκε': inv.archived_at ? new Date(inv.archived_at).toLocaleString('el-GR') : '',
        'Αρχειοθέτησε': inv.archived_by || '',
        'Ανέβηκε': inv.created_at ? new Date(inv.created_at).toLocaleString('el-GR') : '',
        'Duplicate Of': inv.duplicate_of || '',
      };
    });

  if (!rows.length) { toast('Δεν υπάρχουν αρχειοθετημένα τιμολόγια', 'err'); return; }

  const ws = XLSX.utils.json_to_sheet(rows);
  // Auto-width columns
  const cols = Object.keys(rows[0]);
  ws['!cols'] = cols.map(c => ({
    wch: Math.min(60, Math.max(c.length + 2, ...rows.map(r => String(r[c] || '').length + 2)))
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Αρχειοθετημένα');

  // Δεύτερο sheet: summary ανά προμηθευτή
  const bySupplier = {};
  rows.forEach(r => {
    const key = r['Προμηθευτής'] || '—';
    if (!bySupplier[key]) bySupplier[key] = { count: 0, sap: r['SAP Vendor Code'], folder: r['Φάκελος'] };
    bySupplier[key].count++;
  });
  const summaryRows = Object.entries(bySupplier)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, info]) => ({
      'Προμηθευτής': name,
      'SAP Code': info.sap,
      'Φάκελος': info.folder,
      'Πλήθος Τιμολογίων': info.count,
    }));
  const ws2 = XLSX.utils.json_to_sheet(summaryRows);
  ws2['!cols'] = [{wch: 40}, {wch: 15}, {wch: 40}, {wch: 18}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Ανά Προμηθευτή');

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  XLSX.writeFile(wb, `archived_invoices_${ts}.xlsx`);
  toast(`✓ Εξήχθησαν ${rows.length} εγγραφές σε Excel`, 'ok');
  audit('export', 'success', `Excel export: ${rows.length} αρχειοθετημένα`, { actor: state.currentUser || 'system' });
}

// ═══════════════════════════════════════════════════════════
