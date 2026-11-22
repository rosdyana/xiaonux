#!/usr/bin/env node
// End-to-end check of the xv6 lab inside the Debian guest (needs a server with
// test hooks: `VITE_TEST_HOOKS=1 make serve`). Fresh browser context, default
// network (off), `?autoboot`.
//   1. cd /root/xv6-labs-2026 && make qemu -> xv6 $ (timed), ls, echo/cat, Ctrl-A x
//   2. persistence: make qemu-fs keeps the file; a plain make qemu makes a new fs.img
//   3. make qemu-gdb in the background + batch gdb (break main, continue, bt, kill)
//   4. make grade (unsolved util, timed), then a minimal sleep solution applied
//      from a patch and ./grade-lab-util sleep
// Results and logs go to <outdir> (default ../build/xv6-e2e). The sleep patch is
// the second argument (default <outdir>/sleep.patch).
// Usage: node xv6-e2e.mjs [outdir] [sleep.patch]
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '../build/xv6-e2e');
const patch = resolve(process.argv[3] ?? join(out, 'sleep.patch'));
const url = process.env.URL ?? 'http://localhost:5180/?autoboot';
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { url, steps: {}, checks: {} };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const check = (ok, what) => {
  results.checks[what] = ok;
  log(ok ? 'ok  ' : 'FAIL', what);
  if (!ok) throw new Error('check failed: ' + what);
};
// Recorded, but the run goes on (used for grader results, which are data, not pass/fail).
const note = (ok, what) => {
  results.checks[what] = ok;
  log(ok ? 'ok  ' : 'note', what);
};

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => log('pageerror:', e.message));
const screen = (n = 400) => page.evaluate((n) => window.xiaonuxScreen(n), n);
const typeText = (s) => page.evaluate((s) => window.xiaonuxType(s), s);
const line = (s) => typeText(s + '\r');
const lines = (t) => t.split('\n');
const lastLine = (t) => t.replace(/\s+$/, '').split('\n').pop();

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout (${ms / 1000} s): ${what}\n--- screen ---\n${await screen(40)}`);
    await sleep(250);
  }
}
// No ^: after Ctrl-A x the xv6 prompt "$ " has no newline, so the Debian prompt can follow it on one line.
const atDebianPrompt = async () => /root@xiaonux:.*# $/.test(lastLine(await screen(4)) + ' ');
const atXv6Prompt = async () => {
  const t = await screen(400);
  const i = t.lastIndexOf('init: starting sh');
  return i >= 0 && /(^|\n)\$$/.test(t.slice(i).trimEnd());
};
const timed = async (name, fn) => {
  const t = Date.now();
  const v = await fn();
  results.steps[name] = { s: +((Date.now() - t) / 1000).toFixed(1) };
  log(`${name}: ${results.steps[name].s} s`);
  return v;
};

// One xv6 shell command. Typed keys are echoed as they arrive, so a command is
// typed only when the prompt is back on its own line ("$"). A unique sync
// line marks where this command starts, so an earlier echo of the same command
// on the screen cannot satisfy the wait. The body is the output after the marker.
let sync = 0;
async function xv6(cmd, timeoutS = 120) {
  const tag = `SYNC${++sync}`;
  const ms = timeoutS * 1000;
  await until(async () => lastLine(await screen(400)).trim() === '$', ms, `xv6 prompt before: ${cmd}`);
  await line(`echo ${tag}`);
  await until(async () => {
    const t = await screen(400);
    return lines(t).some((l) => l.trim() === tag) && lastLine(t).trim() === '$';
  }, ms, `xv6 sync before: ${cmd}`);
  await line(cmd);
  await until(async () => {
    const t = await screen(400);
    return t.slice(t.lastIndexOf(tag)).includes('$ ' + cmd) && lastLine(t).trim() === '$';
  }, ms, `xv6: ${cmd}`);
  const t = await screen(400);
  return t.slice(t.lastIndexOf(tag) + tag.length).replace(/\r/g, '');
}

async function quitXv6() {
  await typeText('\x01x');
  await until(atDebianPrompt, 60000, 'Debian prompt after Ctrl-A x');
}

async function download(path, file) {
  if (!(await page.isVisible('#dl-path'))) await page.click('#download');
  await page.fill('#dl-path', path);
  const dl = page.waitForEvent('download', { timeout: 180000 });
  await page.click('#dl-form button[type=submit]');
  await (await dl).saveAs(join(out, file));
  log('saved', join(out, file));
}

let failed = null;
try {
  await page.goto(url);
  await until(async () => (await page.evaluate(() => window.xiaonux?.marks?.prompt)) !== undefined, 600000, 'Debian prompt');
  await until(atDebianPrompt, 60000, 'prompt on screen');
  results.bootMarks = await page.evaluate(() => window.xiaonux.marks);
  log('Debian prompt', results.bootMarks);

  // 1. make qemu
  const t1 = Date.now();
  await line('cd /root/xv6-labs-2026 && make qemu');
  await until(atXv6Prompt, 300000, 'xv6 $ after make qemu');
  results.steps.qemuEnterToXv6 = { s: +((Date.now() - t1) / 1000).toFixed(1) };
  log(`make qemu: Enter to xv6 $ ${results.steps.qemuEnterToXv6.s} s`);
  const ls = await xv6('ls');
  check(/(^|\s)init(\s|$)/m.test(ls), 'ls lists init');
  await xv6('echo hi > f');
  check(/^hi\s*$/m.test(await xv6('cat f')), 'cat f prints hi (first session)');
  await timed('quitFirstSession', quitXv6);

  // 2. persistence through the write-back
  await timed('makeQemuFsToXv6', async () => {
    await line('make qemu-fs');
    await until(atXv6Prompt, 300000, 'xv6 $ after make qemu-fs');
  });
  check(/^hi\s*$/m.test(await xv6('cat f')), 'persistence: cat f after make qemu-fs prints hi');
  await quitXv6();
  await timed('makeQemuNewFs', async () => {
    await line('make qemu');
    await until(atXv6Prompt, 300000, 'xv6 $ after make qemu (new fs)');
  });
  const gone = await xv6('cat f');
  results.goneOutput = gone.split('\n').slice(-4);
  note(/cannot open f/.test(gone), 'plain make qemu starts with a new fs.img (cat f: cannot open f)');
  await quitXv6();

  // 3. make qemu-gdb (background) + batch gdb
  await line('make qemu-gdb > /root/qgdb.log 2>&1 &');
  await until(atDebianPrompt, 60000, 'prompt after background make qemu-gdb');
  await timed('gdbStubUp', async () => {
    await line('for i in $(seq 1 120); do grep -q "Now run" /root/qgdb.log && break; sleep 0.5; done; grep -q "Now run" /root/qgdb.log && echo GSTUB0 || echo GSTUB1');
    await until(async () => lines(await screen(400)).some((l) => l.trim() === 'GSTUB0'), 120000, 'gdb stub message in qgdb.log');
  });
  await timed('gdbBatch', async () => {
    await line(`gdb -batch -nx -ex 'set architecture riscv:rv64' -ex "target remote 127.0.0.1:$(make print-gdbport)" -ex 'symbol-file kernel/kernel' -ex 'break main' -ex 'continue' -ex 'bt' -ex 'kill' > /root/gdb.log 2>&1; echo GDBDONE`);
    await until(async () => lines(await screen(400)).some((l) => l.trim() === 'GDBDONE'), 300000, 'gdb batch to finish');
  });
  await line('grep -n "Breakpoint 1\\|^#\\|Inferior\\|rror" /root/gdb.log; echo GJ1');
  await until(async () => lines(await screen(400)).some((l) => l.trim() === 'GJ1'), 60000, 'gdb summary');
  const gdbTxt = await screen(400);
  results.gdbLines = gdbTxt.split('\n').filter((l) => /Breakpoint 1|^#|Inferior|rror/.test(l));
  check(/Breakpoint 1, main/.test(gdbTxt), 'gdb: Breakpoint 1, main');
  await download('/root/gdb.log', 'gdb.log');
  await download('/root/qgdb.log', 'qgdb.log');
  // gdb's kill ends the machine: the background job should end by itself.
  // Only the text after this command's own echo counts (earlier output has `jobs` too).
  const jobsAfter = async () => {
    const t = await screen(400);
    return t.slice(t.lastIndexOf('echo JOBS'));
  };
  await line('sleep 5; jobs; echo JOBS2');
  await until(async () => lines(await screen(400)).some((l) => l.trim() === 'JOBS2'), 60000, 'jobs');
  if (/Running|Stopped/.test(await jobsAfter())) {
    results.jobAfterKill = 'still running; sent kill %1';
    await line('kill %1; sleep 3; jobs; echo JOBS3');
    await until(async () => lines(await screen(400)).some((l) => l.trim() === 'JOBS3'), 60000, 'jobs after kill %1');
    results.jobAfterKillTwo = (await jobsAfter()).includes('Running') ? 'running' : 'ended';
  } else {
    results.jobAfterKill = 'ended by itself';
  }
  log('background make qemu-gdb job:', results.jobAfterKill);
  check(!/Stopped/.test(await jobsAfter()), 'the gdb-session job is not Stopped after the session');
  await timed('makeQemuFsAfterGdb', async () => {
    await line('make qemu-fs');
    await until(atXv6Prompt, 300000, 'xv6 $ after gdb session (no busy)');
  });
  await xv6('echo after-gdb');
  await quitXv6();

  // 3b. a second background session ended by SIGTERM (kill %1), not by gdb's kill
  await timed('killSessionStart', async () => {
    await line('make qemu-gdb > /root/qgdb2.log 2>&1 &');
    await until(atDebianPrompt, 60000, 'prompt after second background make qemu-gdb');
    await line('for i in $(seq 1 120); do grep -q "Now run" /root/qgdb2.log && break; sleep 0.5; done; grep -q "Now run" /root/qgdb2.log && echo GSTUB2 || echo GSTUB3');
    await until(async () => lines(await screen(400)).some((l) => l.trim() === 'GSTUB2'), 120000, 'stub of second session');
  });
  await line('kill %1; sleep 3; jobs -l > /root/jobs5.txt; echo JOBS5; cat /root/jobs5.txt; echo JOBS6');
  await until(async () => lines(await screen(400)).some((l) => l.trim() === 'JOBS6'), 60000, 'kill %1');
  const kt = await screen(400);
  const kBlock = kt.slice(kt.lastIndexOf('\nJOBS5'), kt.lastIndexOf('\nJOBS6'));
  results.killJobOutput = kBlock.split('\n').slice(1).filter((l) => l.trim() !== '');
  check(!/Running|Stopped/.test(kBlock), 'kill %1: the job is gone (not Running or Stopped)');
  await timed('makeQemuFsAfterKill', async () => {
    await line('make qemu-fs');
    await until(atXv6Prompt, 300000, 'xv6 $ after kill %1 (no busy)');
  });
  await xv6('echo after-kill');
  await quitXv6();

  // 4. make grade (unsolved), then the sleep solution
  const tg = Date.now();
  await line('make grade 2>&1 | tee /root/grade1.log; echo GRADE1DONE');
  await until(async () => lines(await screen(400)).some((l) => l.trim() === 'GRADE1DONE'), 90 * 60000, 'make grade');
  results.steps.makeGrade1 = { s: +((Date.now() - tg) / 1000).toFixed(1) };
  log(`make grade (unsolved): ${results.steps.makeGrade1.s} s`);
  await download('/root/grade1.log', 'grade1.log');
  const g1 = readFileSync(join(out, 'grade1.log'), 'utf8');
  note(!/Failed to connect|Timeout/.test(g1), 'make grade: no "Failed to connect" or "Timeout"');
  results.gradeTimeouts = g1.split('\n').filter((l) => /Timeout|Failed to connect/.test(l));
  // xv6.out.test_find_sh only exists if that test ran; a grade that stopped
  // early (the Timeout case) never writes it, and the download would wait 180 s.
  const findTag = `FIND${++sync}`;
  await line(`test -f /root/xv6-labs-2026/xv6.out.test_find_sh && echo ${findTag}Y || echo ${findTag}N`);
  await until(async () => lines(await screen(400)).some((l) => l.trim() === findTag + 'Y' || l.trim() === findTag + 'N'), 60000, 'find_sh output check');
  if (lines(await screen(400)).some((l) => l.trim() === findTag + 'Y')) {
    await download('/root/xv6-labs-2026/xv6.out.test_find_sh', 'xv6.out.test_find_sh');
  } else {
    note(false, 'xv6.out.test_find_sh not written (find sh test did not run)');
  }
  results.grade1Summary = g1.split('\n').filter((l) => /^\s*(Score|== |.*\bPASS\b|.*\bFAIL\b)/.test(l)).slice(-80);

  await page.setInputFiles('#file-input', patch);
  await page.waitForFunction(() => /Uploaded to/.test(document.getElementById('transfer-label')?.textContent ?? ''), null, { timeout: 120000 });
  const tg2 = Date.now();
  await line('cd /root/xv6-labs-2026 && git apply /root/uploads/sleep.patch && git status --short && ./grade-lab-util sleep 2>&1 | tee /root/grade2.log; echo GRADE2DONE');
  await until(async () => lines(await screen(400)).some((l) => l.trim() === 'GRADE2DONE'), 60 * 60000, 'grade sleep');
  results.steps.gradeSleep = { s: +((Date.now() - tg2) / 1000).toFixed(1) };
  log(`./grade-lab-util sleep: ${results.steps.gradeSleep.s} s`);
  await download('/root/grade2.log', 'grade2.log');
  const g2 = readFileSync(join(out, 'grade2.log'), 'utf8');
  results.grade2Summary = g2.split('\n').filter((l) => /OK|FAIL|Score|== /.test(l));
  for (const t of ['sleep, no arguments', 'sleep, returns', 'sleep, makes syscall']) {
    check(g2.split('\n').some((l) => l.includes(t + ': OK')), `sleep solution: "${t}" is OK`);
  }
} catch (e) {
  failed = e;
  writeFileSync(join(out, 'failure-screen.txt'), await screen(400).catch(() => ''));
  log('FAILED:', String(e.message).split('\n')[0]);
} finally {
  results.ok = !failed;
  writeFileSync(join(out, 'e2e.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
