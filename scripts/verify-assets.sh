#!/usr/bin/env bash
# Verify FinanceOS static assets exist and respond (local or deployed).
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)/FinanceOS"

echo "=== File system audit: $ROOT ==="
missing=0
while IFS= read -r rel; do
  if [[ ! -f "$ROOT/$rel" ]]; then
    echo "MISSING: $rel"
    missing=$((missing + 1))
  fi
done < <(cat <<'LIST'
index.html
css/main.css
css/layout.css
css/components.css
css/forms.css
css/tables.css
css/dashboard.css
css/charts.css
css/modals.css
css/utilities.css
css/responsive.css
js/app.js
js/state.js
js/utils.js
js/helpers.js
js/dashboard.js
js/charts.js
js/analytics.js
js/upload.js
js/ocr.js
js/ai.js
js/storage.js
js/archive.js
js/invoices.js
js/suppliers.js
js/audit.js
js/export.js
js/settings.js
js/search.js
css/archive.css
js/ocr-preprocess.js
js/pdf-text.js
  js/ocr-pipeline.js
  js/ocr-confidence.js
LIST
)

if [[ "$missing" -eq 0 ]]; then
  echo "All required files present on disk."
else
  echo "$missing file(s) missing on disk."
fi

echo ""
echo "=== HTTP audit: $BASE_URL ==="
html=$(curl -fsS "$BASE_URL/" 2>/dev/null || curl -fsS "$BASE_URL/FinanceOS/index.html" 2>/dev/null || true)
if [[ -z "$html" ]]; then
  echo "WARN: Could not fetch HTML from $BASE_URL"
else
  echo "HTML fetched ($(echo "$html" | wc -c) bytes)"
fi

fail=0
check() {
  local path="$1"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL$path")
  if [[ "$code" == "200" ]]; then
    echo "OK  $path"
  else
    echo "FAIL $path (HTTP $code)"
    fail=$((fail + 1))
  fi
}

for path in \
  /css/main.css /css/layout.css /css/components.css /css/forms.css /css/tables.css \
  /css/dashboard.css /css/charts.css /css/modals.css /css/utilities.css /css/responsive.css \
  /js/app.js /js/state.js /js/utils.js /js/upload.js /js/ocr.js /js/ai.js /js/storage.js \
  /FinanceOS/css/main.css /FinanceOS/js/app.js; do
  check "$path"
done

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "All HTTP checks passed."
  exit 0
else
  echo "$fail HTTP check(s) failed."
  exit 1
fi
