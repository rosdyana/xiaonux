#!/usr/bin/env node
// Phase 4 benchmark suite: the plan's CPU tests, 1 warm-up + 3 timed runs
// each (median), in the browser (Playwright) or on native temu.
// Usage:
//   node suite.mjs browser [chrome|webkit] [url]   (default http://localhost:5180/?autoboot&net=off)
//   node suite.mjs native  path/to/temu path/to/vm.cfg
// Prints one JSON line with medians in seconds.
import { spawnSync } from 'node:child_process';

export const TESTS = {
  shell_loop: `sh -c 'i=0; while [ $i -lt 100000 ]; do i=$((i+1)); done'`,
  python: `python3 -c "sum(i*i for i in range(2_000_000))"`,
  python_start: `python3 -c pass`,
  python_float: `python3 -c "sum(i*0.5 for i in range(1_000_000))"`,
  numpy: `python3 -c "import numpy as np; a=np.arange(40000,dtype=np.float64).reshape(200,200)/7.0; b=[a@a for _ in range(3)]; sum(x*1.5 for x in a.ravel())"`,
  gzip: `gzip -c /usr/bin/python3* > /dev/null`,
};
const RUNS = 3;

// One guest command per test: warm-up, then RUNS timed runs printed as "@T name n seconds".
const guestCmd = (name, cmd) =>
  `${cmd} >/dev/null 2>&1; for n in $(seq ${RUNS}); do echo "@T ${name} $n $( { TIMEFORMAT=%R; time ${cmd} >/dev/null 2>&1; } 2>&1 )"; done`;

function parse(text) {
  const res = {};
  for (const m of text.matchAll(/@T (\w+) (\d+) ([\d.]+)/g)) (res[m[1]] ??= []).push(Number(m[3]));
  const med = {};
  for (const [k, v] of Object.entries(res)) {
    const s = [...v].sort((a, b) => a - b);
    med[k] = s[Math.floor(s.length / 2)];
  }
  return { median: med, runs: res };
}

const [mode, a1, a2] = process.argv.slice(2);
const cmds = Object.entries(TESTS).map(([k, v]) => guestCmd(k, v));
let out, jitStats;
if (mode === 'native') {
  const args = ['boot-native.py', a1, a2, '--timeout', '900', '--login', 'root:root'];
  for (const c of cmds) args.push('--cmd', c);
  out = spawnSync('python3', args, { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout;
} else {
  const browser = a1 ?? 'chrome';
  const url = a2 ?? 'http://localhost:5180/?autoboot&net=off';
  const args = ['browser-boot.mjs', '--browser', browser, '--url', url, '--timeout', '900', '--cmd', 'cat /proc/cpuinfo | head -3 >/dev/null', '--cmd', 'pip install -q numpy >/dev/null 2>&1 || true'];
  for (const c of cmds) args.push('--cmd', c);
  // scrollback text, then sample the stats line once more for the MIPS rate
  args.push('--cmd', `echo "@M $(cat /proc/loadavg)"`);
  const r = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const t = r.stdout;
  const j = JSON.parse(t.slice(t.indexOf('{\n')));
  jitStats = j.stats?.jit;
  out = (j.screen ?? '') + '\n' + JSON.stringify(j.stats ?? {});
  if (!j.ok) console.error(j.error);
}
const result = { mode, ...(mode === 'native' ? { temu: a1 } : { browser: a1 ?? 'chrome' }), ...parse(out) };
if (jitStats) result.jit = jitStats;
const mips = out.match(/"mips":(\d+)/);
if (mips) result.mips_last_sample = Number(mips[1]);
console.log(JSON.stringify(result));
