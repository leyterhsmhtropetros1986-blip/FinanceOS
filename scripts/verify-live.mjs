#!/usr/bin/env node
/** Smoke test against deployed or local FinanceOS URL. */
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'https://finance-os-two-blush.vercel.app/';
const consoleErrors = [];
const failedReqs = [];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));
page.on('requestfailed', (req) => {
  const u = req.url();
  if (/favicon\.ico$/i.test(u)) return;
  if (/\/js\/|\/css\//.test(u)) failedReqs.push(u);
});

await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
await page.waitForSelector('.app', { timeout: 15000 });

const tests = {
  navUpload: await page.evaluate(() => {
    document.querySelector('.nav-item[data-view="upload"]')?.click();
    return document.getElementById('view-upload')?.classList.contains('is-active');
  }),
  navDashboard: await page.evaluate(() => {
    document.querySelector('.nav-item[data-view="dashboard"]')?.click();
    return document.getElementById('view-dashboard')?.classList.contains('is-active');
  }),
  dashKpis: await page.evaluate(() => !!document.getElementById('dash-kpis')?.innerHTML?.includes('kpi-card')),
  chartsExist: await page.evaluate(() =>
    ['chart-monthly', 'chart-status', 'chart-suppliers'].every((id) => !!document.getElementById(id))
  ),
  uploadZone: await page.evaluate(() => !!document.getElementById('upload-zone')),
  settingsView: await page.evaluate(() => {
    document.querySelector('.nav-item[data-view="settings"]')?.click();
    return document.getElementById('view-settings')?.classList.contains('is-active');
  }),
  localStorage: await page.evaluate(() => {
    try {
      localStorage.setItem('financeos-test', '1');
      return localStorage.getItem('financeos-test') === '1';
    } catch { return false; }
  }),
};

await browser.close();

const ignorable = (t) => /Optional libs missing|favicon|Failed to load resource.*404/i.test(t);
const errors = consoleErrors.filter((e) => !ignorable(e));

console.log('URL:', url);
console.log('Tests:', tests);
if (failedReqs.length) console.error('Failed asset requests:', failedReqs);
if (errors.length) console.error('Console errors:', errors);

const ok = Object.values(tests).every(Boolean) && !errors.length && !failedReqs.length;
process.exit(ok ? 0 : 1);
