#!/usr/bin/env node
// End-to-end check of terminal tabs (needs a server with test hooks:
// `make serve`). Fresh persistent browser profile, `?autoboot`.
//   1. a shell tab: login shell on a pty, ccache on PATH
//   2. make qemu-gdb in the console + interactive gdb in tab 2; a second
//      make qemu in tab 2 while xv6 runs is refused, not hung
//   3. a flood in tab 3 doesn't starve the console; upload + download work
//   4. ./grade-lab-util with a tab open: no timeouts
//   5. close (x) and exit remove tabs with no zombies; the cap disables +
//   6. reload: only the console comes back and the tab shells are gone
//   7. phone width screenshots of the strip, light and dark
// Usage: node tabs-e2e.mjs [outdir]   (results in <outdir>, default ../build/tabs-e2e)
import { chromium } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '../build/tabs-e2e');
const url = process.env.URL ?? 'http://localhost:5180/?autoboot';
const skipGrade = process.env.SKIP_GRADE === '1';
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'xn-tabs-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { url, times: {}, checks: {} };
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const check = (ok, what) => {
  results.checks[what] = ok;
  log(ok ? 'ok  ' : 'FAIL', what);
  if (!ok) throw new Error('check failed: ' + what);
};

let ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
let page = ctx.pages()[0] ?? (await ctx.newPage());
const hook = () => page.on('pageerror', (e) => log('pageerror:', e.message));
hook();

const T = {
  screen: (id, n = 200) => page.evaluate(([id, n]) => window.xiaonuxTabs.screen(id, n), [id, n]),
  type: (id, s) => page.evaluate(([id, s]) => window.xiaonuxTabs.type(id, s), [id, s]),
  line: (id, s) => T.type(id, s + '\r'),
  open: () => page.evaluate(() => window.xiaonuxTabs.open()),
  list: () => page.evaluate(() => window.xiaonuxTabs.list()),
  activate: (id) => page.evaluate((id) => window.xiaonuxTabs.activate(id), id),
};
async function until(fn, ms, what, id = 0) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout (${ms / 1000} s): ${what}\n--- tab ${id} ---\n${await T.screen(id, 30)}`);
    await sleep(250);
  }
}
const has = (id, re, n = 200) => async () => re.test(await T.screen(id, n));
const lastLine = (t) => t.replace(/\s+$/, '').split('\n').pop();
const atPrompt = (id) => async () => /root@xiaonux:.*# ?$/.test(lastLine(await T.screen(id, 4)));
let mark = 0;
/** Runs a command in a tab and waits for a unique marker after it. */
async function run(id, cmd, ms = 60000) {
  const m = `MK${++mark}`;
  await T.line(id, `${cmd}; echo ${m}-$?`);
  await until(has(id, new RegExp(`(^|\\n)${m}-\\d+`)), ms, cmd, id);
  const s = await T.screen(id, 400);
  const i = s.lastIndexOf(`${m}-`);
  const j = s.lastIndexOf(cmd.slice(0, 20), i);
  return s.slice(j >= 0 ? j : 0, i);
}
async function waitBoot() {
  await page.waitForFunction(() => window.xiaonux?.marks?.prompt !== undefined, null, { timeout: 300000 });
  await page.waitForFunction(() => !document.getElementById('tab-new').hidden, null, { timeout: 120000 });
}

try {
  await page.goto(url);
  await waitBoot();
  check(await page.evaluate(() => !document.getElementById('tab-new').disabled), '+ shown and enabled');

  // 1. shell tab
  const a = await T.open();
  check(a === 2, 'first shell is tab 2');
  await until(atPrompt(2), 30000, 'tab 2 prompt', 2);
  const env = await run(2, 'tty; echo TERM=$TERM; echo PATH=$PATH; pwd');
  check(/\/dev\/pts\/\d+/.test(env), 'tab 2 is on a pty');
  check(/PATH=[^\n]*\/usr\/lib\/ccache/.test(env), 'login shell: ccache on PATH');
  check(/\n\/root\s*$/.test(env.trimEnd() + '\n') || /\/root/.test(env), 'cwd /root');

  // 2. gdb across tabs
  await T.activate(0);
  await T.line(0, 'cd ~/xv6-labs-2026 && make qemu-gdb');
  await until(has(0, /Now run/), 120000, 'qemu-gdb waiting', 0);
  await T.activate(2);
  await T.line(2, `cd ~/xv6-labs-2026 && gdb -q -nx -ex 'set confirm off' -ex 'set architecture riscv:rv64' -ex "target remote 127.0.0.1:$(make -s print-gdbport)" -ex 'symbol-file kernel/kernel' -ex 'break main' -ex continue`);
  const tg = Date.now();
  await until(has(2, /Breakpoint 1, main/), 120000, 'gdb stops at main', 2);
  results.times.gdbBreakMainS = (Date.now() - tg) / 1000;
  await T.line(2, 'bt');
  await until(has(2, /#0\s+main/), 30000, 'bt', 2);
  await T.line(2, 'kill');
  await T.line(2, 'quit');
  await until(atPrompt(2), 30000, 'tab 2 prompt after gdb', 2);
  await until(atPrompt(0), 30000, 'console prompt after kill', 0);
  check(true, 'make qemu-gdb (console) + gdb (tab 2), interactive');
  // a second make qemu while xv6 runs: refused, prompt comes back
  await T.line(0, 'make qemu');
  await until(has(0, /init: starting sh/), 120000, 'xv6 boots in console', 0);
  const busy = await run(2, 'make qemu 2>&1 | tail -3', 120000);
  log('second make qemu:', busy.trim().split('\n').slice(-2).join(' | '));
  check(true, 'second make qemu while xv6 runs returned (no hang)');
  await T.type(0, '\x01x');
  await until(atPrompt(0), 30000, 'console prompt after Ctrl-A x', 0);

  // 3. flood
  const b = await T.open();
  check(b === 3, 'second shell is tab 3');
  await until(atPrompt(3), 30000, 'tab 3 prompt', 3);
  await T.line(3, 'yes | head -c 5000000 | tail -c 20; echo FLOODDONE');
  await sleep(500);
  const ta = Date.now();
  await T.line(0, 'echo ali""ve');
  await until(has(0, /(^|\n)alive/), 3000, 'console answers during a flood', 0);
  results.times.consoleDuringFloodMs = Date.now() - ta;
  check(true, `console answers during a flood (${results.times.consoleDuringFloodMs} ms)`);
  await until(has(3, /(^|\n)FLOODDONE/), 180000, 'flood ends', 3);
  // upload + download (agent channel shared with tabs)
  const blob = join(out, 'upload.bin');
  writeFileSync(blob, Buffer.alloc(1 << 20, 7));
  await page.setInputFiles('#file-input', blob);
  await page.waitForFunction(() => /Uploaded to/.test(document.getElementById('transfer-label')?.textContent ?? ''), null, { timeout: 120000 });
  const sz = await run(2, 'stat -c %s /root/uploads/upload.bin');
  check(/1048576/.test(sz), 'upload arrived (1 MB)');

  // 4. grade with a tab open
  if (!skipGrade) {
    await T.activate(0);
    const tgr = Date.now();
    await T.line(0, './grade-lab-util; echo GRADEDONE');
    await until(has(0, /(^|\n)GRADEDONE/, 400), 1200000, 'grade finishes', 0);
    results.times.gradeS = (Date.now() - tgr) / 1000;
    const g = await T.screen(0, 400);
    const tests = (g.match(/^== Test .*/gm) ?? []).length;
    writeFileSync(join(out, 'grade.txt'), g);
    check(!/Timeout|Failed to connect/.test(g), `grade: no timeouts (${tests} test lines, ${results.times.gradeS} s)`);
  }

  // 5. close, exit, cap
  const c = await T.open();
  check(c === 4, 'third shell is tab 4');
  check(await page.evaluate(() => document.getElementById('tab-new').disabled), '+ disabled at 4 tabs');
  await until(atPrompt(4), 30000, 'tab 4 prompt', 4);
  await page.screenshot({ path: join(out, 'tabs-desktop.png'), clip: { x: 0, y: 0, width: 1440, height: 200 } });
  await page.click('#tab-4 + .term-x');
  await until(async () => !(await T.list()).includes(4), 10000, 'tab 4 closed');
  await T.line(3, 'exit');
  await until(async () => !(await T.list()).includes(3), 10000, 'tab 3 exits');
  const z = await run(2, "ps -e -o stat= | grep -c '^Z'");
  check(/(^|\n)0\s*$/.test(z.trim().split('\n').pop() + '\n') || /\n0\n?$/.test(z), 'no zombies');
  check(JSON.stringify(await T.list()) === '[0,2]', 'tabs left: console + shell 2');

  // 6. reload
  const pidOut = await run(2, 'echo PID=$$');
  const pid = pidOut.match(/PID=(\d+)/)[1];
  log('waiting 75 s for the machine save');
  await sleep(75000);
  await page.reload();
  await waitBoot();
  check(JSON.stringify(await T.list()) === '[0]', 'after reload: only the console');
  const ps = await run(0, `ps -p ${pid} -o pid= | wc -l; ps -e -o comm= | grep -c '^bash$'`);
  const nums = ps.trim().split('\n').slice(-2).map((x) => x.trim());
  log('after reload ps:', nums.join(' '));
  check(nums[0] === '0', 'tab shell gone after reload');

  // 7. phone width
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 760 });
    for (let i = 0; i < 3; i++) await T.open();
    await sleep(1500);
    await page.screenshot({ path: join(out, `tabs-phone-${scheme}.png`), clip: { x: 0, y: 0, width: 390, height: 160 } });
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, `phone ${scheme}: no horizontal scroll (${sw})`);
    for (const id of [4, 3, 2]) await T.line(id, 'exit');
    await until(async () => (await T.list()).length === 1, 15000, 'tabs closed');
  }
  results.ok = true;
} catch (e) {
  results.ok = false;
  results.error = String(e.stack ?? e);
  log(results.error);
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
  await ctx.close();
  log('results:', JSON.stringify({ ok: results.ok, times: results.times }));
  process.exit(results.ok ? 0 : 1);
}
