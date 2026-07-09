#!/usr/bin/env node
/** Load FinanceOS locally in headless Chrome; fail on console errors or failed requests. */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'FinanceOS');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  let p = (req.url || '/').split('?')[0];
  if (p === '/') p = '/index.html';
  try {
    const body = await readFile(join(ROOT, p.replace(/^\//, '')));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const consoleErrors = [];
const failedReqs = [];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));
page.on('requestfailed', (req) => {
  const u = req.url();
  if (/favicon\.ico$/i.test(u)) return;
  failedReqs.push(`${u} — ${req.failure()?.errorText || 'failed'}`);
});

await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('.app', { timeout: 10000 });

// Boot should attach nav listeners
const navWorks = await page.evaluate(() => {
  const btn = document.querySelector('.nav-item[data-view="upload"]');
  if (!btn) return false;
  btn.click();
  return document.getElementById('view-upload')?.classList.contains('is-active');
});

await browser.close();
server.close();

const ignorable = (t) => /Optional libs missing|favicon|Failed to load resource.*404/i.test(t);
const errors = consoleErrors.filter((e) => !ignorable(e));

if (failedReqs.length) {
  console.error('Failed network requests:');
  failedReqs.forEach((r) => console.error(' -', r));
}
if (errors.length) {
  console.error('Console errors:');
  errors.forEach((e) => console.error(' -', e));
}
if (!navWorks) {
  console.error('Navigation click did not activate upload view');
  process.exit(1);
}
if (errors.length || failedReqs.some((r) => r.includes('/js/') || r.includes('/css/'))) {
  process.exit(1);
}
console.log('✓ Browser interactivity smoke test passed.');
