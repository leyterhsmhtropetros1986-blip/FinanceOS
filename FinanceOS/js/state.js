/** Application state */
// ─── State ──────────────────────────────────────────────
export const state = {
  suppliers: [],
  invoices: [],
  auditLogs: [],
  currentUpload: null,
  currentInvoiceId: null,
  nextInvoiceId: 1,
  nextAuditId: 1,
  settings: {
    provider: 'anthropic',
    apiKey: '',
    model: 'claude-sonnet-5',
    totalCost: 0,
    totalCalls: 0,
    ownCompany: { name: '', afm: '' },
  },
  currentUser: '',
};

// Runtime extensions (initialized once)
state.dashCharts = {};
state.archiveBrowserCache = null;
state.archiveRoot = { handle: null, name: null };
state.folderCache = new Map();
state.archivedFiles = new Map();
state.batch = {
  queue: [], active: false, cancelled: false, autoArchive: true,
  stats: { archived: 0, review: 0, failed: 0 },
};
