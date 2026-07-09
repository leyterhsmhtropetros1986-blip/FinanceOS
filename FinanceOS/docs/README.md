# FinanceOS — Parastatika OCR

Enterprise modular architecture for the Parastatika OCR invoice archiving application.

## Project Structure

```
FinanceOS/
├── index.html          # Shell HTML + CDN library imports
├── css/                # Stylesheets (logical split)
├── js/                 # ES module application code
├── assets/             # Static assets (icons, images, fonts)
├── data/               # Local data exports (optional)
└── docs/               # Documentation
```

## Modules

| Module | Responsibility |
|--------|----------------|
| `app.js` | Boot sequence, navigation, global error handlers |
| `state.js` | Central application state |
| `utils.js` | DOM helpers, formatting, debounce |
| `helpers.js` | AFM validation, fuzzy matching, SAP scoring |
| `dashboard.js` | Dashboard KPIs and layout |
| `charts.js` | Chart.js rendering |
| `analytics.js` | KPI metric calculations |
| `upload.js` | File upload, batch processing, review panel |
| `ocr.js` | Tesseract OCR and field extraction |
| `ai.js` | Claude Vision API integration |
| `storage.js` | IndexedDB, File System Access, shared JSON |
| `archive.js` | Archive folder browser |
| `invoices.js` | Invoices table view |
| `suppliers.js` | Supplier import and management |
| `audit.js` | Audit logging |
| `export.js` | Excel and ZIP export |
| `settings.js` | AI and user settings |
| `search.js` | Debounced search bindings |
| `badges.js` | Review badge updates |
| `notifications.js` | Toast notifications |

## Local Development

Open `index.html` via a local static server (required for ES modules):

```bash
cd FinanceOS
python3 -m http.server 8080
```

Visit http://localhost:8080

## Vercel Deployment

1. Push to GitHub
2. Import project in Vercel
3. Set root directory to `FinanceOS`
4. Deploy (static, no build step)

## Browser Support

- Chrome / Edge 90+ (full — File System Access API)
- Firefox / Safari (OCR, upload, AI — no native folder write)

## Git Workflow

```bash
git checkout -b feature/my-change
# edit modules
git add FinanceOS/
git commit -m "Describe change"
git push -u origin feature/my-change
```

## Future Improvements

- Service worker for offline OCR cache
- Backend API for multi-user sync
- Unit tests per module (Vitest)
- TypeScript migration
