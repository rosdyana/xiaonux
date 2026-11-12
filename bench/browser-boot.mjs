#!/usr/bin/env node
// Boot the VM in a real browser via Playwright, log in, run commands,
// and print timings as JSON.
// Usage: node browser-boot.mjs [--browser chrome|webkit] [--url URL]
//        [--login root:root] [--cmd "uname -a"]... [--timeout 600] [--headed]
import { chromium, webkit } from 'playwright-core';

const args = process.argv.slice(2);
const opt = { browser: 'chrome', url: 'http://localhost:5180/?autoboot', login: '', cmds: [], timeout: 600, headed: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--browser') opt.browser = args[++i];
  else if (a === '--url') opt.url = args[++i];
  else if (a === '--login') opt.login = args[++i];
  else if (a === '--cmd') opt.cmds.push(args[++i]);
  else if (a === '--timeout') opt.timeout = Number(args[++i]);
  else if (a === '--headed') opt.headed = true;
}

const browser = opt.browser === 'webkit'
  ? await webkit.launch({ headless: !opt.headed })
  : await chromium.launch({ channel: 'chrome', headless: !opt.headed });
const page = await browser.newPage();

page.on('console', (m) => {
  process.stderr.write('console: ' + m.text() + '\n');
});
page.on('pageerror', (e) => process.stderr.write(`pageerror: ${e}\n`));

// Read the terminal buffer text (last N lines).
const screen = (n = 60) => page.evaluate((n) => window.xiaonuxScreen(n), n);
const typeLine = (s) => page.evaluate((s) => window.xiaonuxType(s + '\r'), s);

async function waitFor(pred, timeoutS, what) {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${what}\n--- screen ---\n${await screen(30)}`);
}

const marks = () => page.evaluate(() => window.xiaonux?.marks ?? {});
const result = { browser: opt.browser, ok: false };
const t0 = Date.now();
try {
  await page.goto(opt.url);
  if (opt.login) {
    const [user, pass] = opt.login.split(':');
    await waitFor(async () => (await marks()).login !== undefined, opt.timeout, 'login prompt');
    await typeLine(user);
    if (pass) {
      await waitFor(async () => /Password: ?$/m.test(await screen(3)), 60, 'password prompt');
      await typeLine(pass);
    }
  }
  await waitFor(async () => /[#$] ?$/m.test((await screen(2)).trimEnd() + ' '), opt.timeout, 'shell prompt');
  result.marks = await marks();
  result.prompt_wall_s = (Date.now() - t0) / 1000;
  result.cmds = [];
  // A prompt line: ends with "# " or "$ " (possibly after the typed command).
  const prompts = async () => (await screen(100000)).split('\n').filter((l) => /[#$] /.test(l + ' ') && /^\S*@?\S*[:~ \/\w]*[#$]/.test(l)).length;
  for (const c of opt.cmds) {
    const n0 = await prompts();
    const t1 = Date.now();
    await typeLine(c);
    await waitFor(async () => (await prompts()) > n0 && /[#$] ?$/.test((await screen(1)).trimEnd() + ' '), opt.timeout, `command: ${c}`);
    result.cmds.push({ cmd: c, s: (Date.now() - t1) / 1000 });
  }
  result.stats = await page.evaluate(() => window.xiaonux);
  result.screen = await screen(40);
  result.ok = true;
} catch (e) {
  result.error = String(e.message ?? e);
} finally {
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
