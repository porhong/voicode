import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const [base, out, scheme = 'dark'] = process.argv.slice(2);
// The demo server's certificate comes from a throwaway CA.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { code } = await (await fetch(`${base}/demo/pair-code`)).json();
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.E2E_BROWSER ?? 'msedge',
  headless: true,
});
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: Number(process.env.W ?? 390), height: Number(process.env.H ?? 844) },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: scheme,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const shot = (n) => page.screenshot({ path: `${out}/${scheme}-${n}.png` });
await page.goto(`${base}/#pair=${code}`);
await page.waitForTimeout(700);
await shot('1-pair');
await page.getByRole('button', { name: 'Pair device' }).click();
await page.waitForTimeout(1200);
await shot('2-home');
// The empty state's button with no session open, the header's "+" otherwise.
await page
  .locator('.empty-card .btn-primary')
  .or(page.getByRole('button', { name: /^New session in / }))
  .first()
  .click();
await page.waitForTimeout(800);
await shot('3-session');
await page.locator('.suggestion').nth(1).click();
await page.waitForTimeout(300);
await shot('4-typed');
await page.getByRole('button', { name: 'Send', exact: true }).click();
await page.waitForTimeout(1500);
await shot('5-approval');
await page.getByRole('button', { name: 'Accept' }).click();
await page.waitForTimeout(1800);
await shot('6-reply');
await page.getByRole('button', { name: 'Sessions' }).click();
await page.waitForTimeout(800);
await shot('7-sessions');
// Controls inside a sheet must be usable (it is portalled out of the inert app).
const sessions = page.getByRole('dialog', { name: 'Sessions' });
await sessions.getByRole('button', { name: 'Close', exact: true }).click();
await sessions.waitFor({ state: 'detached' });

// A Claude session running in a terminal on the PC (the demo fakes one that alternates
// between working and idle every DEMO_PC_TOGGLE_MS): view it, then continue it here.
await page.getByRole('button', { name: /^Sessions/ }).click();
await sessions.getByRole('button', { name: /rate limiting/ }).click();
await page.waitForTimeout(600);
await shot('7b-pc-session');
page.once('dialog', (dialog) => dialog.accept()); // "Allow Claude to work in this folder?"
await page.locator('.pc-bar .btn:not([disabled])').waitFor({ timeout: 30_000 });
await page.getByRole('button', { name: 'Continue on phone' }).click();
await page.locator('.pc-bar').waitFor({ state: 'detached' });
await page.waitForTimeout(500);
await shot('7c-continued');
// The terminal session finishing again while it is not on screen raises a toast.
await page.locator('.toast').first().waitFor({ timeout: 30_000 });
await shot('7d-toast');
await page.getByRole('tab', { name: /Trackpad/ }).click();
await page.waitForTimeout(600);
await shot('8-trackpad');
await page.getByRole('button', { name: 'Settings' }).click();
await page.waitForTimeout(500);
const toggle = page.getByRole('switch', { name: /Read Claude/ });
await toggle.click();
if (!(await toggle.isChecked())) throw new Error('a switch in the settings sheet did not toggle');
await toggle.click();
await shot('9-settings');
console.log('errors:', errors);
await browser.close();
