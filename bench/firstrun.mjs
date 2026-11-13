// First-run timings: each test once in a fresh profile (no warm-up).
import { spawnSync } from 'node:child_process';
const url = process.argv[2] ?? 'http://localhost:5180/?autoboot&net=off';
const SETS = {
  long: {
    shell_loop: `sh -c 'i=0; while [ $i -lt 100000 ]; do i=$((i+1)); done'`,
    python: `python3 -c "sum(i*i for i in range(2_000_000))"`,
    python_float: `python3 -c "sum(i*0.5 for i in range(1_000_000))"`,
    gzip: `gzip -c /usr/bin/python3* > /dev/null`,
  },
  short: {
    python_start: `python3 -c pass`,
    python_import: `python3 -c "import json, re, hashlib, zlib, math"`,
    pip_version: `pip --version`,
    ls: `ls -la /usr/bin`,
    sha256: `sha256sum /usr/bin/python3.13`,
    apt_policy: `apt-cache policy python3`,
  },
};
const T = SETS[process.argv[3] ?? 'long'];
const prof = process.argv[4];
const args = ['browser-boot.mjs', '--url', url, '--timeout', '900', '--cmd', 'sleep 4', ...(prof ? ['--profile', prof] : [])];
for (const [k, c] of Object.entries(T)) args.push('--cmd', `echo "@T ${k} 1 $( { TIMEFORMAT=%R; time ${c} >/dev/null 2>&1; } 2>&1 )"`);
const r = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{\n')));
const res = {};
for (const m of (j.screen ?? '').matchAll(/@T (\w+) \d ([\d.]+)/g)) res[m[1]] = Number(m[2]);
const logs = r.stderr.split('\n').filter((l) => l.includes('shipped translations'));
console.log(JSON.stringify({ firstRun: res, jit: j.stats?.jit, logs }));
