# Parastatika V3 — Enterprise Roadmap

Μετατροπή από OCR uploader σε πλήρη πλατφόρμα διαχείρισης παραστατικών.

## Φάσεις

| Phase | Focus | Items |
|-------|--------|-------|
| **P0** ✅ Foundation | Queue, upload engine, parallel OCR, cache, dark mode | 1–3, 9–13, 23, 40 |
| **P1** Processing | Merge/split, rotate, enhancement, compression | 4–8 |
| **P2** Intelligence | AI suggestions, supplier learning, SAP handwriting, categories | 14–19, 34 |
| **P3** Workflow | Bulk save, undo, shortcuts, timeline, versions | 20–22, 24–25, 36–37 |
| **P4** Platform | Archive search, preview, thumbnails, export, audit, AI chat | 26–35, 38–39 |
| **P5** Integrations | Scanner TWAIN, email, Outlook, Gmail, cloud drives | 1 (integrations) |

## Κατάσταση ανά απαίτηση

| # | Feature | Status | Module |
|---|---------|--------|--------|
| 1 | Upload Engine (drag, paste, sources) | 🟡 Partial | `upload-engine.js` |
| 2 | Multi upload 50–300 PDF | ✅ | `queue-manager.js` |
| 3 | Merge PDF | ✅ | `pdf-tools.js` |
| 4 | Split PDF ανά παραστατικό | 🟡 | `pdf-tools.js`, `storage.js` |
| 5 | Auto detect new invoice | 🟡 | `pdf-tools.js` |
| 6 | Rotate / deskew | 🟡 | `ocr-preprocess.js` |
| 7 | Image enhancement | 🟡 | `ocr-preprocess.js` |
| 8 | PDF compression | ⬜ | planned |
| 9 | OCR cache | ✅ | `ocr-cache.js` + IDB |
| 10 | Parallel OCR (4 workers) | ✅ | `queue-manager.js`, `ocr.js` |
| 11 | Queue manager states | ✅ | `queue-manager.js` |
| 12 | Multi-stage progress | ✅ | `enterprise.css`, review UI |
| 13 | Single OCR per file | ✅ | `ocr-pipeline.js` |
| 14 | OCR confidence per field | ✅ | review panel |
| 15 | AI suggestions (<70%) | 🟡 | `ocr-confidence.js` |
| 16 | Supplier learning | 🟡 | `ocr-learning.js` |
| 17 | Smart SAP (header OCR) | 🟡 | `ocr-preprocess.js` cropHeader |
| 18 | Duplicate detection | ✅ | `storage.js` |
| 19 | Auto categories | 🟡 | `categories.js` |
| 20 | Bulk Save All | 🟡 | batch auto-archive |
| 21 | Undo last save | ⬜ | planned |
| 22 | Keyboard shortcuts | ✅ | `keyboard-shortcuts.js` |
| 23 | Dark mode | ✅ | `theme.js` |
| 24 | Timeline | 🟡 | `timeline.js` |
| 25 | Version history | ⬜ | planned |
| 26 | Archive folders | ✅ | `storage.js` |
| 27 | Full-text search | 🟡 | `archive.js` metadata |
| 28 | Instant preview <200ms | 🟡 | `ocr-render.js` |
| 29 | Thumbnail sidebar | ⬜ | planned |
| 30 | Smooth zoom | ✅ | review preview |
| 31 | Resizable side-by-side | 🟡 | CSS |
| 32 | Responsive | 🟡 | `responsive.css` |
| 33 | Animations | 🟡 | `enterprise.css` |
| 34 | OCR learning | 🟡 | `ocr-learning.js` |
| 35 | Export Excel/CSV/PDF/XML | 🟡 | `export.js` |
| 36 | Auto-save 2s | ✅ | `storage.js` |
| 37 | Crash recovery | ✅ | queue IDB persist |
| 38 | AI chat | ⬜ | planned |
| 39 | Audit log | ✅ | `audit.js` |
| 40 | Performance targets | 🟡 | see below |

**Legend:** ✅ Done · 🟡 Partial · ⬜ Planned

## Performance targets (§40)

| Metric | Target | Current |
|--------|--------|---------|
| Preview first page | <200ms | ~300–800ms (PDF text fast path faster) |
| OCR start | <500ms | worker warmup on boot |
| OCR per page | <2s | ~1–2s (capped res) |
| 100 PDF bulk | no UI freeze | parallel queue (4) + yield |
| Single OCR per file | required | cache + pipeline |

## Architecture

```
Upload Engine → Queue Manager (4 parallel) → OCR Pipeline (once) → Cache
                    ↓                              ↓
              IDB persist                    All modules reuse result
                    ↓
         Review → Archive → Timeline → Audit
```
