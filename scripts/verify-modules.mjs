#!/usr/bin/env node
/**
 * Verify FinanceOS JS modules: syntax, invalid export patterns, top-level DOM hooks.
 */
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const JS_DIR = new URL('../FinanceOS/js/', import.meta.url).pathname;
const files = (await readdir(JS_DIR)).filter((f) => f.endsWith('.js')).sort();

let failed = 0;

for (const file of files) {
  const path = join(JS_DIR, file);
  const code = await readFile(path, 'utf8');
  const check = spawnSync('node', ['--check', path], { encoding: 'utf8' });
  if (check.status !== 0) {
    console.error(`SYNTAX FAIL: ${file}\n${check.stderr}`);
    failed++;
    continue;
  }
  if (/async export function|export async export/.test(code)) {
    console.error(`INVALID EXPORT: ${file}`);
    failed++;
  }
  const topLevelDom = code.match(/^(?:\$\(|document\.|window\.)\S*addEventListener/m);
  if (topLevelDom && file !== 'app.js') {
    console.error(`TOP-LEVEL LISTENER: ${file} — move into init*()`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} module check(s) failed.`);
  process.exit(1);
}
console.log(`✓ All ${files.length} modules passed static checks.`);
