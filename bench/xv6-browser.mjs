#!/usr/bin/env node
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
// Boot xv6 in the page's xv6 worker (window.xiaonuxXv6, test hooks only) from
// the fixture's kernel.bin and fs.img held in memory. Waits for the shell
// prompt, runs `ls`, optionally `usertests -q`, then stops and checks the fs
// image comes back at its full size. Prints one JSON line.
// Usage: node xv6-browser.mjs [--browser chrome|firefox|webkit] [--url http://localhost:5180/]
//        [--fixture ../build/xv6/master] [--usertests] [--jit 0|1]
// The URL must not carry ?autoboot: the Debian VM then never starts.
import { chromium, firefox, webkit } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = {
  browser: 'chrome',
  url: 'http://localhost:5180/',
  fixture: fileURLToPath(new URL('../build/xv6/master', import.meta.url)),
  usertests: false,
  jit: 1,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--browser') opt.browser = args[++i];
  else if (a === '--url') opt.url = args[++i];
  else if (a === '--fixture') opt.fixture = resolve(args[++i]);
  else if (a === '--usertests') opt.usertests = true;
  else if (a === '--jit') opt.jit = Number(args[++i]);
  else throw new Error(`unknown argument: ${a}`);
}
if (opt.jit !== 0 && opt.jit !== 1) throw new Error('--jit takes 0 or 1');
const engines = { chrome: chromium, firefox, webkit };
const engine = engines[opt.browser];
if (!engine) throw new Error(`unknown browser: ${opt.browser}`);

const FIXTURE_FS_BYTES = 2_048_000;
const PROMPT = '\n$ ';
const FAIL_MARKS = ['FAILED', 'panic', '[xv6 error]', '[xv6 worker]'];
const STEP_TIMEOUT_MS = 120_000;
const USERTESTS_TIMEOUT_MS = 1_800_000;

const out = { browser: opt.browser, jit: opt.jit, url: opt.url, fixture: opt.fixture };
const log = (m) => process.stderr.write(m + '\n');

const launchOpts = opt.browser === 'chrome' ? { headless: true, channel: 'chrome' } : { headless: true };
const browser = await engine.launch(launchOpts);
let sampler = null;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => log(`pageerror: ${e}`));
  page.on('crash', () => log('PAGE CRASHED'));
  page.on('worker', (w) => {
    out.workers = [...(out.workers ?? []), w.url().replace(opt.url, '/')];
    log(`worker: ${w.url()}`);
  });

  await page.goto(opt.url);
  await page.waitForFunction(() => typeof window.xiaonuxXv6 === 'object', null, { timeout: STEP_TIMEOUT_MS })
    .catch(() => { throw new Error('page has no xiaonuxXv6 hook: build with VITE_TEST_HOOKS=1 (make serve)'); });

  const kernel = readFileSync(join(opt.fixture, 'kernel.bin')).toString('base64');
  const fs = readFileSync(join(opt.fixture, 'fs.img')).toString('base64');
  const samples = [];
  sampler = setInterval(() => {
    page.evaluate(() => window.xiaonuxXv6.mips()).then((v) => samples.push(v)).catch(() => {});
  }, 1000);

  const t0 = Date.now();
  await page.evaluate(([k, f, j]) => window.xiaonuxXv6.start(k, f, j === 1), [kernel, fs, opt.jit]);

  // Waits until `want` appears in console output after offset `off`. Fails fast on a
  // failure marker. Returns the elapsed ms since t0.
  const waitText = async (off, want, timeoutMs) => {
    const h = await page.waitForFunction(
      ({ off, want, fails }) => {
        const t = window.xiaonuxXv6.screen().slice(off);
        if (t.includes(want)) return 'ok';
        for (const f of fails) if (t.includes(f)) return 'fail:' + f;
        return null;
      },
      { off, want, fails: FAIL_MARKS },
      { timeout: timeoutMs, polling: 250 },
    ).catch(async (e) => {
      const tail = await page.evaluate(() => window.xiaonuxXv6.screen().slice(-1500));
      throw new Error(`${e.message.split('\n')[0]}\n--- output tail ---\n${tail}`);
    });
    const v = await h.jsonValue();
    if (v !== 'ok') {
      const tail = await page.evaluate(() => window.xiaonuxXv6.screen().slice(-1500));
      throw new Error(`${v}\n--- output tail ---\n${tail}`);
    }
    return Date.now() - t0;
  };
  const offset = () => page.evaluate(() => window.xiaonuxXv6.screen().length);

  // Ready is what the worker reports from vm_on_ready; the prompt is the observable thing.
  await page.waitForFunction(() => window.xiaonuxXv6.ready() !== null, null, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  out.ready_ms = await page.evaluate(() => window.xiaonuxXv6.ready());
  out.boot_to_prompt_ms = await waitText(0, PROMPT, STEP_TIMEOUT_MS);

  let off = await offset();
  await page.evaluate(() => window.xiaonuxXv6.type('ls\n'));
  await waitText(off, PROMPT, STEP_TIMEOUT_MS);
  const lsOut = (await page.evaluate(() => window.xiaonuxXv6.screen())).slice(off).replace(/\r/g, '');
  if (!/(^|[^A-Za-z0-9_])init([^A-Za-z0-9_]|$)/m.test(lsOut)) throw new Error(`ls did not list init:\n${lsOut}`);
  out.ls_ok = true;

  if (opt.usertests) {
    off = await offset();
    const t1 = Date.now();
    await page.evaluate(() => window.xiaonuxXv6.type('usertests -q\n'));
    await waitText(off, 'ALL TESTS PASSED', USERTESTS_TIMEOUT_MS);
    out.usertests_s = Math.round((Date.now() - t1) / 100) / 10;
  }

  const fsBytes = await page.evaluate(() => window.xiaonuxXv6.stop().then((u) => u.length));
  out.fs_bytes = fsBytes;
  if (fsBytes !== FIXTURE_FS_BYTES) throw new Error(`fs image is ${fsBytes} bytes, expected ${FIXTURE_FS_BYTES}`);

  clearInterval(sampler);
  sampler = null;
  out.mips_samples = samples.filter((v) => v > 0);
  console.log(JSON.stringify(out));
} catch (e) {
  if (sampler) clearInterval(sampler);
  out.error = String(e.message ?? e);
  console.log(JSON.stringify(out));
  process.exitCode = 1;
} finally {
  await browser.close();
}
