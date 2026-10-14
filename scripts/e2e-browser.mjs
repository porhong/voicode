// Drives the real web client in headless Chrome against a running agent, the way a
// phone would: pair from the QR link, start a session, send a prompt, accept the
// approval, check the rendered reply, use the trackpad and open settings.
//
//   voicecode-agent start --project <scratch dir>     (note the pairing code)
//   npm run e2e -- https://127.0.0.1:8443 123-456 [screenshot dir]
//
// This uses real Claude Code (a few cents per run), writes ui.txt into the session's
// project directory and moves the real mouse cursor slightly. Needs Google Chrome.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [base, code, out = 'e2e-shots'] = process.argv.slice(2);
if (!base || !code) {
  console.error('Usage: npm run e2e -- <agent url> <pairing code> [screenshot dir]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  ignoreHTTPSErrors: true, // the test browser does not trust the local CA
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

try {
  await page.goto(`${base}/#pair=${code.replace('-', '')}`);
  await page.getByRole('heading', { name: /Pair with/ }).waitFor();
  log('pair page, code field =', await page.locator('#pair-code').inputValue());
  log('hash cleared:', !new URL(page.url()).hash);
  await shot(page, '1-pair');

  await page.getByRole('button', { name: 'Pair device' }).click();
  await page.getByRole('tab', { name: /Claude/ }).waitFor();
  log('controller loaded');
  await page.getByRole('button', { name: 'New session' }).click();
  await page.locator('.chip').waitFor();
  await shot(page, '2-session');

  await page
    .locator('textarea.composer-input')
    .fill(
      'Use the Write tool to create ui.txt containing exactly: from the browser. Then reply with a short markdown list of what you did, including the file name in backticks.',
    );
  await page.getByRole('button', { name: 'Send' }).click();
  log('prompt sent');

  const card = page.locator('.permission-card');
  await card.waitFor({ timeout: 120_000 });
  log('approval card:', (await card.locator('h3').innerText()).trim());
  log('document.title =', await page.title());
  await shot(page, '3-approval');
  await card.getByRole('button', { name: 'Accept' }).click();

  await page.locator('.turn-end', { hasText: 'Done' }).waitFor({ timeout: 120_000 });
  const reply = page.locator('.msg-assistant').last();
  log('reply html:', (await reply.innerHTML()).slice(0, 300));
  log('title after:', await page.title());
  await shot(page, '4-reply');

  await page.getByRole('tab', { name: 'Trackpad' }).click();
  const pad = page.locator('.trackpad');
  await pad.waitFor();
  const box = await pad.boundingBox();
  // Single-finger drag: moves the real cursor a little, never clicks.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 3, cy + i * 2, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  log('trackpad active (lease held):', await pad.evaluate((el) => el.classList.contains('active')));
  await page.mouse.move(cx + 30, cy + 20);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(cx + 30 - i * 3, cy + 20 - i * 2, { steps: 1 });
  await page.mouse.up();
  await shot(page, '5-trackpad');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor();
  await shot(page, '6-settings');
  log('page errors:', errors.length ? errors : 'none');
} catch (err) {
  await shot(page, 'failure').catch(() => {});
  log('FAILED:', err.message, 'errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
