// End-to-end check of the page UI against a running server (make serve):
// "Try it" boots and opens its guide, a guide step types into the shell and
// gets checked, upload lands in /root/uploads with the right SHA-256,
// download returns the same bytes. Saves workspace screenshots.
// Usage: node ui-test.mjs [outdir]
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? '../.impeccable/review';
const url = process.env.URL ?? 'http://localhost:5180/';
const ok = (c, m) => { if (!c) throw new Error(m); console.log('ok  ' + m); };
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const screen = () => page.evaluate(() => window.xiaonuxScreen(40));
const waitScreen = (re, ms = 120000) => page.waitForFunction((src) => new RegExp(src).test(window.xiaonuxScreen(40)), re.source, { timeout: ms });

await page.goto(url);
await page.click('[data-try="triage"]');
ok(await page.isVisible('#workspace'), 'workspace shown after Try it');
ok((await page.inputValue('#lesson-select')) === 'triage', 'triage guide selected');
await page.waitForFunction(() => window.xiaonux?.marks?.prompt !== undefined, null, { timeout: 180000 });
const marks = await page.evaluate(() => window.xiaonux.marks);
console.log('    prompt at', marks.prompt, 'ms', (await page.textContent('#status')));

// guide step 1 (create sample) then step 2 (file)
for (const i of [0, 1]) {
  await page.locator('#lesson-steps .step').nth(i).locator('button:has-text("Type it")').click();
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#lesson-steps .step')[n].classList.contains('done'), i, { timeout: 60000 });
}
await page.waitForTimeout(600);
const pen = await page.evaluate(() => [...document.querySelectorAll('#lesson-steps .step.done .check')].map((c) => getComputedStyle(c).strokeDashoffset));
ok(pen.length === 2 && pen.every((o) => o === '0px'), `guide steps 1-2 checked after running (pen ${pen})`);
await waitScreen(/sample\.sh: POSIX shell script/);
ok(true, 'file identifies the sample');

// upload
const dir = mkdtempSync(join(tmpdir(), 'xn-'));
const data = randomBytes(300 * 1024);
const name = 'test upload.bin';
writeFileSync(join(dir, name), data);
const sha = createHash('sha256').update(data).digest('hex');
await page.setInputFiles('#file-input', join(dir, name));
await page.waitForFunction(() => /Uploaded to/.test(document.getElementById('transfer-label')?.textContent ?? ''), null, { timeout: 120000 });
ok(true, 'upload finished: ' + (await page.textContent('#transfer-label')));
await page.evaluate(() => window.xiaonuxType('clear; sha256sum /root/uploads/test_upload.bin; stat -c %a /root/uploads/test_upload.bin\r'));
await waitScreen(new RegExp(sha));
ok(true, 'sha256 in the VM matches');
await waitScreen(/\n600\s*\n/, 20000);
ok(true, 'upload is mode 600');

// download
await page.click('#download');
await page.fill('#dl-path', '/root/uploads/test_upload.bin');
const dl = page.waitForEvent('download', { timeout: 120000 });
await page.click('#dl-form button[type=submit]');
const d = await dl;
const back = readFileSync(await d.path());
ok(createHash('sha256').update(back).digest('hex') === sha, 'download matches the upload');

await page.click('#tab-network');
await page.screenshot({ path: `${out}/workspace-network.png` });
await page.click('#tab-guides');
await page.evaluate(() => { document.getElementById('panel-guides').scrollTop = 0; });
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/workspace.png` });
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: `${out}/workspace-dark.png` });
await page.setViewportSize({ width: 390, height: 844 });
await page.emulateMedia({ colorScheme: 'light' });
if ((await page.getAttribute('#drawer-toggle', 'aria-expanded')) !== 'true') await page.click('#drawer-toggle');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/workspace-mobile-drawer.png` });
await page.click('#drawer-toggle');
await page.waitForTimeout(400);
await page.evaluate(() => window.xiaonuxType('rm -r ~/lab /root/uploads/test_upload.bin; clear\r'));
await page.evaluate(() => window.xiaonuxSave());
await page.waitForTimeout(1500);
await ctx.close();

// phone with touch: on-screen key row; Ctrl key sends a control character
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const pp = await phone.newPage();
await pp.goto(url + '?autoboot');
await pp.waitForFunction(() => window.xiaonux?.marks?.prompt !== undefined, null, { timeout: 180000 });
ok(await pp.isVisible('#keys'), 'key row shown on a touch screen');
const kb = await pp.locator('#keys button').first().boundingBox();
ok(kb.height >= 44 && kb.width >= 44, `key buttons are ${kb.width}x${kb.height}`);
await pp.evaluate(() => window.xiaonuxType('sleep 30\r'));
await pp.waitForTimeout(500);
await pp.tap('#keys [data-key=ctrl]');
await pp.keyboard.type('c');
await pp.waitForFunction(() => /sleep 30\s*\n+root@[^\n]*# ?$/.test(window.xiaonuxScreen(5)), null, { timeout: 10000 });
ok(true, 'Ctrl key + c interrupts sleep');
await pp.screenshot({ path: `${out}/workspace-mobile.png` });
await browser.close();
console.log('all ok');
