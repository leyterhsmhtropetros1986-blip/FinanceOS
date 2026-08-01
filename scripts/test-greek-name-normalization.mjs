#!/usr/bin/env node
/**
 * Critical regression guard: normalizeForMatch() used `\w` (ASCII-only in
 * JS regex, even with the /u flag) to strip punctuation, which silently
 * wiped out every Greek letter — a purely-Greek supplier name normalized to
 * an empty string. Since this app processes mostly Greek invoices/suppliers,
 * this broke fuzzy name matching, name_normalized (persisted on every
 * supplier record), and the full-text supplier scan for any Greek-named
 * business partner. Fixed via \p{L}/\p{N} (Unicode-aware) instead of \w.
 */
import { normalizeForMatch, similarity } from '../FinanceOS/js/helpers.js';

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

// The core regression: a pure-Greek name must not normalize to empty
{
  const r = normalizeForMatch('ΑΦΟΙ ΜΠΡΑΤΗ ΕΠΕ');
  check(r.length > 0, `Greek name must not normalize to an empty string, got "${r}"`);
  check(r === 'ΑΦΟΙ ΜΠΡΑΤΗ ΕΠΕ', `Greek letters should pass through unchanged, got "${r}"`);
}

// Mixed Greek/Latin names (very common: "DHL EXPRESS (ΕΛΛΑΣ) ΜΟΝΟΠΡΟΣΩΠΗ Α.Ε.")
{
  const r = normalizeForMatch('DHL EXPRESS (ΕΛΛΑΣ) ΜΟΝΟΠΡΟΣΩΠΗ Α.Ε.');
  check(r.includes('ΕΛΛΑΣ'), `mixed-script name must keep its Greek portion, got "${r}"`);
  check(r.includes('DHL'), `mixed-script name must keep its Latin portion, got "${r}"`);
}

// Punctuation/symbols still get stripped (this was the actual intent of \w)
{
  const r = normalizeForMatch('ΤΕΧΝΟ-ΠΛΑΣΤΙΚ, Α.Ε.!');
  check(!r.includes(','), 'punctuation should still be stripped');
  check(!r.includes('!'), 'symbols should still be stripped');
  check(!r.includes('-'), 'hyphens should still be stripped to spaces for token comparison');
}

// Two Greek names that are genuinely similar should now actually compare as similar
// (impossible before the fix — both normalized to '', so similarity() saw two
// empty strings and could return a meaningless 0-length comparison)
{
  const a = normalizeForMatch('ΤΕΧΝΟΠΛΑΣΤΙΚ Α.Ε.');
  const b = normalizeForMatch('ΤΕΧΝΟΠΛΑΣΤΙΚ ΑΕ');
  check(a.length > 0 && b.length > 0, 'both normalized forms must be non-empty for a meaningful comparison');
  check(similarity(a, b) >= 80, `near-identical Greek names should score highly similar, got ${similarity(a, b)}`);
}

console.log(failed ? `${failed} test(s) failed` : '✓ Greek name normalization regression guard passed');
process.exit(failed ? 1 : 0);
