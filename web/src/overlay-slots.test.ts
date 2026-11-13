// Unit tests for the overlay slot allocator. Run: pnpm test
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotAllocator } from './overlay-slots.ts';

/** Slots a fresh allocator would hand out, in order (drains a copy of the state). */
function drain(a: SlotAllocator, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a.alloc());
  return out;
}

test('fresh allocator with no save hands out 1, 2, 3 and everything is writable', () => {
  const live = new Uint32Array(8);
  const a = new SlotAllocator(0, live, null);
  assert.deepEqual(drain(a, 3), [1, 2, 3]);
  assert.equal(a.slots, 3);
  for (let s = 1; s <= 5; s++) assert.equal(a.writable(s), true);
});

test('after a save, its slots are not writable and the next slot is new', () => {
  const live = new Uint32Array(8);
  const a = new SlotAllocator(0, live, null);
  live[0] = a.alloc();
  live[1] = a.alloc();
  live[2] = a.alloc();
  a.onSaved(live);
  assert.deepEqual([1, 2, 3].map((s) => a.writable(s)), [false, false, false]);
  assert.equal(a.alloc(), 4);
  assert.equal(a.writable(4), true);
});

test('a rewritten saved cluster takes a new slot; the old one frees at the next save', () => {
  const live = new Uint32Array(8);
  const a = new SlotAllocator(0, live, null);
  live[0] = a.alloc();
  live[1] = a.alloc();
  live[2] = a.alloc();
  a.onSaved(live);
  // rewrite the cluster at slot 2
  assert.equal(a.writable(live[1]), false);
  const s = a.alloc();
  assert.equal(s, 4);
  live[1] = s;
  // slot 2 is still part of the save: not handed out
  assert.equal(a.alloc(), 5);
  a.unalloc(5);
  a.onSaved(live); // live is now {1,4,3}
  assert.deepEqual([...live.slice(0, 3)], [1, 4, 3]);
  assert.equal(a.alloc(), 2);
});

test('a slot that is live but not saved is writable in place', () => {
  const live = new Uint32Array(8);
  const a = new SlotAllocator(0, live, null);
  live[0] = a.alloc();
  a.onSaved(live);
  const s = a.alloc();
  live[1] = s;
  assert.equal(a.writable(s), true);
  assert.equal(a.writable(live[0]), false);
});

test('built from an existing data file: free slots are those neither live nor saved', () => {
  const live = new Uint32Array(8);
  live[0] = 1;
  live[1] = 5;
  const savedIndex = new Uint32Array(8);
  savedIndex[0] = 1;
  savedIndex[1] = 2;
  const a = new SlotAllocator(10, live, savedIndex);
  assert.equal(a.slots, 10);
  // slots 2 (saved) and 5 (live), 1 (both) are taken; the rest come out lowest first
  assert.deepEqual(drain(a, 7), [3, 4, 6, 7, 8, 9, 10]);
  assert.equal(a.alloc(), 11);
  assert.equal(a.writable(2), false);
  assert.equal(a.writable(5), true);
});

test('unalloc gives the slot back, lowest first', () => {
  const live = new Uint32Array(4);
  const a = new SlotAllocator(0, live, null);
  assert.equal(a.alloc(), 1);
  const s = a.alloc();
  assert.equal(s, 2);
  a.unalloc(s);
  assert.equal(a.alloc(), 2);
  assert.equal(a.alloc(), 3);
  // out-of-order give-backs still come out lowest first, and twice is harmless
  a.unalloc(3);
  a.unalloc(1);
  a.unalloc(1);
  assert.deepEqual(drain(a, 3), [1, 3, 4]);
});

test('an index that names a slot beyond the given count still protects it', () => {
  const live = new Uint32Array(4);
  const savedIndex = new Uint32Array(4);
  savedIndex[0] = 7;
  const a = new SlotAllocator(3, live, savedIndex);
  assert.equal(a.writable(7), false);
  const got = drain(a, 8);
  assert.ok(!got.includes(7), `handed out saved slot 7: ${got}`);
});

// A deterministic PRNG so a failure reproduces.
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('invariant: random writes, saves, reloads and rollbacks never touch a saved slot', () => {
  const N = 24; // clusters
  const rand = rng(0x5eed);
  const live = new Uint32Array(N);
  let a = new SlotAllocator(0, live, null);

  // Shadow model. 'data' is what each slot holds; a write stores a fresh token.
  const data = new Map<number, number>();
  let fileSlots = 0; // highest slot ever written
  let savedIndex: Uint32Array | null = null; // the active save's index
  let savedTokens: number[] = []; // what each saved cluster held at the save
  let savedHigh = 0; // alloc.slots at the save (state[2])
  let token = 0;
  let writes = 0;
  let saves = 0;
  let rollbacks = 0;
  let reuses = 0;
  let failed = 0;

  const savedSet = () => new Set(savedIndex ? [...savedIndex].filter((s) => s) : []);

  const checkLive = () => {
    const seen = new Set<number>();
    for (let c = 0; c < N; c++) {
      if (!live[c]) continue;
      assert.ok(!seen.has(live[c]), `duplicate live slot ${live[c]}`);
      seen.add(live[c]);
    }
  };

  const checkSavedIntact = () => {
    if (!savedIndex) return;
    for (let c = 0; c < N; c++) {
      if (!savedIndex[c]) continue;
      assert.equal(data.get(savedIndex[c]), savedTokens[c], `saved cluster ${c} (slot ${savedIndex[c]}) was overwritten`);
    }
  };

  for (let i = 0; i < 1000; i++) {
    const r = rand();
    if (r < 0.7) {
      // write a cluster, exactly like opfsOverlay.write
      const c = Math.floor(rand() * N);
      const old = live[c];
      if (old && a.writable(old)) {
        assert.ok(!savedSet().has(old), `in-place write to saved slot ${old}`);
        data.set(old, ++token);
      } else {
        const s = a.alloc();
        assert.ok(!savedSet().has(s), `alloc handed out saved slot ${s}`);
        for (let o = 0; o < N; o++) {
          if (o !== c) assert.notEqual(live[o], s, `alloc handed out slot ${s} used by live cluster ${o}`);
        }
        if (s <= fileSlots) reuses++;
        if (rand() < 0.05) {
          // the write failed: the slot goes back and the index is unchanged
          a.unalloc(s);
          failed++;
        } else {
          data.set(s, ++token);
          fileSlots = Math.max(fileSlots, s);
          live[c] = s;
        }
      }
      writes++;
    } else if (r < 0.85) {
      a.onSaved(live);
      savedIndex = live.slice();
      savedTokens = [...live].map((s) => data.get(s) ?? 0);
      savedHigh = a.slots;
      saves++;
    } else if (r < 0.95) {
      if (savedIndex) {
        // resume the save: the index goes back, the allocator is rebuilt from it
        live.set(savedIndex);
        a = new SlotAllocator(savedHigh, live, live);
        rollbacks++;
      }
    } else {
      // a reload without resuming: the live index and the save both persist
      a = new SlotAllocator(fileSlots, live, savedIndex);
    }
    checkLive();
    checkSavedIntact();
  }

  // the loop actually exercised every path
  assert.ok(writes > 500 && saves > 20 && rollbacks > 10 && reuses > 50 && failed > 5,
    `weak coverage: writes=${writes} saves=${saves} rollbacks=${rollbacks} reuses=${reuses} failed=${failed}`);
  // reuse keeps the file bounded: far fewer slots than writes
  assert.ok(fileSlots < writes / 4, `file grew to ${fileSlots} slots for ${writes} writes`);
});
