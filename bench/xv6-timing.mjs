#!/usr/bin/env node
// xv6 lab build and transfer timings. Boots the probe image (make serve
// with the probe staged, cold boot, no snapshot) in a fresh Chrome profile,
// logs in, and times the xv6 build and the file-transfer paths. Prints one
// JSON object per run. `--summarize a.json b.json c.json` prints the medians.
//
//   node xv6-timing.mjs --profile ../build/xv6-prof-1 [--url http://localhost:5180/?autoboot]
//   node xv6-timing.mjs --summarize run1.json run2.json run3.json
//
// The profile directory must not exist yet (fresh profile per run).
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--summarize') {
  const runs = args.slice(1).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const names = Object.keys(runs[0].timings);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const table = names.map((n) => {
    const vals = runs.map((r) => r.timings[n]);
    return { name: n, median_s: +median(vals).toFixed(2), runs_s: vals.map((v) => +v.toFixed(2)) };
  });
  console.log(JSON.stringify({ runs: runs.length, table }, null, 2));
  process.exit(0);
}

const opt = { url: 'http://localhost:5180/?autoboot', profile: '', login: 'root:root', headed: false, bootTimeout: 900, buildTimeout: 2400, cmdTimeout: 600 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--url') opt.url = args[++i];
  else if (a === '--profile') opt.profile = args[++i];
  else if (a === '--login') opt.login = args[++i];
  else if (a === '--headed') opt.headed = true;
  else if (a === '--build-timeout') opt.buildTimeout = Number(args[++i]);
  else if (a === '--cmd-timeout') opt.cmdTimeout = Number(args[++i]);
  else throw new Error(`unknown argument ${a}`);
}
if (!opt.profile) throw new Error('--profile <new dir> is required');
if (existsSync(opt.profile)) throw new Error(`profile ${opt.profile} exists; use a fresh one`);

// Number of object files compiled in a make run (make echoes each command it runs).
const compiledIn = (text) => (text.match(/-c -o kernel\/[\w.]+\.o /g) || []).map((m) => m.slice(6, -1));
const countCompiles = (text) => compiledIn(text).length;
const SRC_HASH_RE = /([0-9a-f]{64})  \/root\/(t50k|t2m)\.bin/;
const out = { ok: false, timings: {}, checks: {}, steps: [] };
const log = (m) => process.stderr.write(m + '\n');

const browser = await chromium.launchPersistentContext(opt.profile, {
  headless: !opt.headed, channel: 'chrome', acceptDownloads: true, viewport: { width: 1440, height: 900 },
});
const page = browser.pages()[0] ?? (await browser.newPage());
out.chrome = browser.browser()?.version() ?? 'unknown';
out.platform = `${process.platform}/${process.arch}`;
page.on('pageerror', (e) => log(`pageerror: ${e}`));
page.on('crash', () => log('PAGE CRASHED'));

const screen = (n = 5000) => page.evaluate((n) => window.xiaonuxScreen(n), n);
const typeText = (s) => page.evaluate((s) => window.xiaonuxType(s), s);
const marks = () => page.evaluate(() => window.xiaonux?.marks ?? {});
async function waitFor(pred, timeoutS, what) {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}\n--- screen ---\n${(await screen(40))}`);
}

// Run one shell command in the guest and wait for its exit-status sentinel.
let seq = 0;
async function run(cmd, timeoutS = opt.cmdTimeout) {
  const n = ++seq;
  // The start tag is computed by the shell, so only its output line matches
  // the tag (the typed line shows $((...)) literally). Long typed lines wrap in
  // the terminal, so the echoed command line can't be used as a marker.
  const tag = `__S${n * 7919 + 13}`;
  const t0 = performance.now();
  await typeText(`echo __S$((${n}*7919+13)); ${cmd}; echo __DONE_${n}_$?\r`);
  const m = await waitFor(async () => (await screen()).match(new RegExp(`__DONE_${n}_(\\d+)`)), timeoutS, cmd);
  const secs = (performance.now() - t0) / 1000;
  const text = await screen();
  // Keep only the output after this command's start tag.
  const at = text.indexOf(`${tag}\n`);
  if (at < 0) throw new Error(`start tag ${tag} not found on screen for: ${cmd}`);
  const output = text.slice(at);
  out.steps.push({ cmd, exit: Number(m[1]), s: +secs.toFixed(2) });
  if (Number(m[1]) !== 0) throw new Error(`exit ${m[1]} from: ${cmd}\n${output.slice(-1500)}`);
  return { secs, output };
}
// Untimed helper (no timing recorded, still checks the exit status).
async function prep(cmd) {
  const r = await run(cmd);
  return r.output;
}

try {
  await page.goto(opt.url);
  const [user, pass] = opt.login.split(':');
  await waitFor(async () => (await marks()).login !== undefined, opt.bootTimeout, 'login prompt');
  await typeText(`${user}\r`);
  await waitFor(async () => /Password: ?$/m.test(await screen(3)), 120, 'password prompt');
  await typeText(`${pass}\r`);
  await waitFor(async () => (await marks()).prompt !== undefined, opt.bootTimeout, 'shell prompt');
  out.bootPromptMs = (await marks()).prompt;
  log(`prompt at ${out.bootPromptMs} ms`);

  // The emulated guest has no clock sync. Set it to the host time (untimed)
  // so that files built now are newer than the source files in the tree
  // (git archive stamps them with the commit date); otherwise make treats
  // every object as stale and the no-op and one-file numbers are meaningless.
  const dateOf = (t) => (t.match(/\w{3} \w{3}\s+\d+ [\d:]+ \w+ \d{4}/)?.[0] ?? 'unparsed');
  out.guestDateBeforeSync = dateOf(await prep('date'));
  await prep(`date -s @${Math.floor(Date.now() / 1000)} >/dev/null`);
  out.guestDate = dateOf(await prep('date'));
  out.hostDate = new Date().toString();

  // gcc_version: first run, includes the lazy disk fetch of the compiler.
  out.timings.gcc_version = (await run('gcc --version')).secs;

  // full_build from a clean tree, then a no-op make.
  const MAKE = 'make TOOLPREFIX= CPUS=1 kernel/kernel fs.img';
  const full = await run(`cd /root/xv6-clean && ${MAKE}`, opt.buildTimeout);
  out.timings.full_build = full.secs;
  out.checks.full_build_compiled = /-c -o kernel\/proc\.o kernel\/proc\.c/.test(full.output);
  out.checks.full_build_compiles = countCompiles(full.output);
  out.compiled = { full_build: compiledIn(full.output) };
  const noop = await run(`cd /root/xv6-clean && ${MAKE}`);
  out.timings.noop_make = noop.secs;
  out.checks.noop_make_compiles = countCompiles(noop.output);
  out.compiled.noop_make = compiledIn(noop.output);

  // one_file: touch proc.c and rebuild the kernel. Proof of work: the compile
  // and the link must appear, otherwise the mtime check failed (clock skew).
  // Diagnostic (untimed): file times and a dry run just before the touch.
  out.diag = { beforeTouch: (await prep('cd /root/xv6-clean && ls -l --full-time kernel/proc.c kernel/proc.o kernel/entry.o kernel/kernel; date +%s.%N; make TOOLPREFIX= CPUS=1 kernel/kernel -n | grep -c " -c -o"; true')).slice(-1400) };
  const one = await run(`cd /root/xv6-clean && touch kernel/proc.c && make TOOLPREFIX= CPUS=1 kernel/kernel`, opt.buildTimeout);
  out.timings.one_file = one.secs;
  out.checks.one_file_compiled = /-c -o kernel\/proc\.o kernel\/proc\.c/.test(one.output);
  out.checks.one_file_compiles = countCompiles(one.output);
  out.compiled.one_file = compiledIn(one.output);
  out.checks.one_file_linked = /-o kernel\/kernel /.test(one.output);

  // prebuilt_relink: the pre-built tree (what a student sees), touch + relink.
  const pre = await run(`cd /root/xv6-built && touch kernel/proc.c && make TOOLPREFIX= CPUS=1 kernel/kernel`, opt.buildTimeout);
  out.timings.prebuilt_relink = pre.secs;
  out.checks.prebuilt_relink_compiled = /-c -o kernel\/proc\.o kernel\/proc\.c/.test(pre.output);
  out.checks.prebuilt_relink_compiles = countCompiles(pre.output);
  out.compiled.prebuilt_relink = compiledIn(pre.output);
  out.checks.prebuilt_relink_linked = /-o kernel\/kernel /.test(pre.output);

  // Transfers: make the file and its hash (untimed), then time the download.
  for (const [name, size, file] of [['get_50k', 51200, 't50k.bin'], ['get_2m', 2048000, 't2m.bin']]) {
    await prep(`head -c ${size} /dev/urandom > /root/${file}`);
    const shaOut = await prep(`sha256sum /root/${file}`);
    const guestSha = shaOut.match(SRC_HASH_RE)?.[1];
    if (!guestSha) throw new Error(`could not read guest sha256 for ${file}\n${shaOut.slice(-500)}`);
    const t0 = performance.now();
    await page.click('#download');
    await page.fill('#dl-path', `/root/${file}`);
    const dl = page.waitForEvent('download', { timeout: opt.cmdTimeout * 1000 });
    await page.click('#dl-form button[type=submit]');
    const d = await dl;
    out.timings[name] = (performance.now() - t0) / 1000;
    const data = readFileSync(await d.path());
    const localSha = createHash('sha256').update(data).digest('hex');
    out.checks[`${name}_sha_match`] = localSha === guestSha;
    out.checks[`${name}_bytes`] = data.length;
    log(`${name}: ${out.timings[name].toFixed(2)} s, sha match ${localSha === guestSha}`);
    if (localSha !== guestSha) throw new Error(`${name}: sha256 mismatch`);
    if (data.length !== size) throw new Error(`${name}: got ${data.length} bytes, want ${size}`);
  }

  out.checks.one_file_ok = out.checks.one_file_compiled && out.checks.one_file_linked;
  out.checks.prebuilt_relink_ok = out.checks.prebuilt_relink_compiled && out.checks.prebuilt_relink_linked;
  out.checks.noop_make_ok = out.checks.noop_make_compiles === 0;
  if (!out.checks.one_file_ok || !out.checks.prebuilt_relink_ok || !out.checks.full_build_compiled || !out.checks.noop_make_ok) {
    throw new Error(`build checks failed: ${JSON.stringify(out.checks)}`);
  }
  out.ok = true;
} catch (e) {
  out.error = String(e.message ?? e).slice(0, 4000);
} finally {
  try {
    out.stats = await page.evaluate(() => window.xiaonux ?? null);
  } catch { /* page may be gone */ }
  await browser.close();
  for (const [k, v] of Object.entries(out.timings)) out.timings[k] = +v.toFixed(2);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
