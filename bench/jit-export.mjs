#!/usr/bin/env node
// Build the shipped translation bundle (Phase 4e): boot the staged VM, warm
// up common commands until their blocks are translated, export every
// translated block (regenerated from the code in RAM, keyed by content), and
// write dist/vm/jit-<sha256>.bin + boot.json { jit: { file, build } }.
// Usage: node jit-export.mjs [url]   (needs `make serve` on :5180)
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const VM = new URL('../dist/vm/', import.meta.url).pathname;
const url = process.argv[2] ?? 'http://localhost:5180/?autoboot&net=off&jit=1';
const WARM = [
  `sh -c 'i=0; while [ $i -lt 30000 ]; do i=$((i+1)); done'`,
  `python3 -c "sum(i*i for i in range(300_000))"`,
  `python3 -c "sum(i*0.5 for i in range(300_000))"`,
  `for n in 1 2 3; do python3 -c pass; done`,
  `python3 -c "import json, re, os, hashlib, zlib, math; print(json.dumps({'a': [1, 2.5]}))"`,
  `gzip -c /usr/bin/python3.13 > /dev/null`,
  `for n in 1 2; do pip --version; done`,
  `apt-cache policy python3 | head -3`,
  `for n in 1 2 3; do ls -la /usr/bin > /dev/null; grep -c root /etc/passwd; done`,
  `sha256sum /usr/bin/python3.13 | cut -c1-8`,
];

const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
await p.goto(url);
await p.waitForFunction(() => window.xiaonux?.marks?.prompt !== undefined, null, { timeout: 120000 });
const prompts = async () => (await p.evaluate(() => window.xiaonuxScreen(100000))).split('\n').filter((l) => /^root@[^#]*# /.test(l + ' ')).length;
for (const cmd of WARM) {
  const n0 = await prompts();
  await p.evaluate((c) => window.xiaonuxType(c + '\r'), cmd);
  const end = Date.now() + 600000;
  while ((await prompts()) <= n0 && Date.now() < end) await new Promise((r) => setTimeout(r, 300));
  const jit = await p.evaluate(() => window.xiaonux?.jit);
  console.log(`warm: ${cmd.slice(0, 50)} -> ${jit?.blocks} blocks`);
}
await p.evaluate(() => window.xiaonuxJitExport());
await p.waitForFunction(() => window.xiaonuxJitBundle, null, { timeout: 120000 });
const { build, b64 } = await p.evaluate(() => window.xiaonuxJitBundle);
await b.close();

const bytes = Buffer.from(b64, 'base64');
const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_LGWIN]: 24 } });
const name = `jit-${createHash('sha256').update(br).digest('hex')}.br`;
for (const f of readdirSync(VM)) if (/^jit-[0-9a-f]+\.(bin|br)$/.test(f) && f !== name) unlinkSync(join(VM, f));
writeFileSync(join(VM, name), br);
const boot = JSON.parse(readFileSync(join(VM, 'boot.json'), 'utf8'));
boot.jit = { file: name, build, raw: bytes.length };
writeFileSync(join(VM, 'boot.json'), JSON.stringify(boot));
const n = bytes.readUInt32LE(8), wasm = bytes.readUInt32LE(12);
console.log(JSON.stringify({ file: name, build, blocks: n, wasm_kb: Math.round(wasm / 1024), raw_kb: Math.round(bytes.length / 1024), br_kb: Math.round(br.length / 1024) }));
