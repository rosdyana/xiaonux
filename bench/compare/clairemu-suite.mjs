// Run the xiaonux suite on ClairEmu's public demo (serial console), read-only.
// Drives the public page only (no code fetched or inspected). Run from bench/: node compare/clairemu-suite.mjs
import { chromium } from 'playwright-core';
const TESTS = {
  shell_loop: `sh -c 'i=0; while [ $i -lt 100000 ]; do i=$((i+1)); done'`,
  python: `python3 -c "sum(i*i for i in range(2_000_000))"`,
  python_start: `python3 -c pass`,
  gzip: `gzip -c /usr/bin/python3* > /dev/null`,
};
const guestCmd = (name, cmd) => `${cmd} >/dev/null 2>&1; for n in 1 2 3; do echo "@T ${name} $n $( { TIMEFORMAT=%R; time ${cmd} >/dev/null 2>&1; } 2>&1 )"; done; echo "@DO""NE ${name}"`;
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto('https://emu.kadcom.dev/', { waitUntil: 'load', timeout: 60000 });
const t0 = Date.now();
await p.getByRole('button', { name: 'Coba Linux' }).first().click();
const serial = () => p.evaluate(() => [...document.querySelectorAll('.xterm-rows')].map((e) => e.innerText).join('\n'));
async function waitFor(re, sec) {
  const end = Date.now() + sec * 1000;
  while (Date.now() < end) { const t = await serial(); if (re.test(t)) return t; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`timeout ${re}: ${(await serial()).slice(-400)}`);
}
// the console terminal that shows ttyS0 output
const focus = async () => { const rows = p.locator('.xterm'); const n = await rows.count(); for (let i = 0; i < n; i++) { const t = await rows.nth(i).innerText(); if (/login:|# $|Debian/.test(t)) { await rows.nth(i).click(); return; } } await rows.last().click(); };
try {
  await waitFor(/login:\s*$/m, 900);
  const loginAt = (Date.now() - t0) / 1000;
  await focus();
  // kernel messages may interleave with the login prompts: match loosely
  await p.keyboard.type('root\n', { delay: 30 });
  await waitFor(/[Pp]assword:/, 60);
  await new Promise((r) => setTimeout(r, 1500));
  await p.keyboard.type('pemula\n', { delay: 30 });
  await waitFor(/root@[^\n]*[#$]/, 180);
  await p.keyboard.type('dmesg -n 1\n', { delay: 10 }); // keep the console quiet during the runs
  const promptAt = (Date.now() - t0) / 1000;
  const res = {};
  for (const [k, v] of Object.entries(TESTS)) {
    await p.keyboard.type(guestCmd(k, v) + '\n', { delay: 5 });
    const t = await waitFor(new RegExp(`@DONE ${k}`), 1200);
    res[k] = [...t.matchAll(new RegExp(`@T ${k} \\d ([\\d.]+)`, 'g'))].map((m) => Number(m[1]));
  }
  const med = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]]));
  console.log(JSON.stringify({ target: 'clairemu', login_s: loginAt, prompt_s: promptAt, median: med, runs: res }));
} catch (e) {
  console.log(JSON.stringify({ target: 'clairemu', error: String(e.message).slice(0, 600) }));
}
await b.close();
