// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBytes, tryOpen, sessionNonce, sessionExpires, SESSION_MAX_BYTES, SESSION_MAX_OPENS, type BudgetState,
} from './budget.ts';

const fresh = (): BudgetState => ({ bytes: 0, opens: 0 });

test('opening up to the maximum succeeds and the next open fails', () => {
  const s = fresh();
  for (let i = 0; i < SESSION_MAX_OPENS; i++) assert.equal(tryOpen(s), true, `open ${i + 1}`);
  assert.equal(tryOpen(s), false);
  assert.equal(s.opens, SESSION_MAX_OPENS);
});

test('a refused open is not counted', () => {
  const s = fresh();
  assert.equal(tryOpen(s, 1), true);
  assert.equal(tryOpen(s, 1), false);
  assert.equal(tryOpen(s, 1), false);
  assert.equal(s.opens, 1);
});

test('bytes crossing the limit return false', () => {
  const s = fresh();
  assert.equal(addBytes(s, SESSION_MAX_BYTES - 1), true);
  assert.equal(addBytes(s, 1), false);
  assert.equal(addBytes(s, 1), false);
  assert.equal(s.bytes, SESSION_MAX_BYTES + 1);
});

test('a socket cannot open once the bytes are exhausted', () => {
  const s = fresh();
  assert.equal(tryOpen(s), true);
  assert.equal(addBytes(s, SESSION_MAX_BYTES), false);
  assert.equal(tryOpen(s), false);
  assert.equal(s.opens, 1);
});

test('bytes under the limit leave opens available', () => {
  const s = fresh();
  assert.equal(addBytes(s, 1000), true);
  assert.equal(tryOpen(s), true);
});

test('custom limits are honoured', () => {
  const s = fresh();
  assert.equal(tryOpen(s, 3, 100), true);
  assert.equal(tryOpen(s, 3, 100), true);
  assert.equal(tryOpen(s, 3, 100), true);
  assert.equal(tryOpen(s, 3, 100), false);

  const t = fresh();
  assert.equal(addBytes(t, 99, 100), true);
  assert.equal(addBytes(t, 1, 100), false);
  assert.equal(tryOpen(t, 3, 100), false);
});

test('zero, negative and non-finite byte reports do not break state', () => {
  const s = fresh();
  assert.equal(addBytes(s, 50, 100), true);
  assert.equal(addBytes(s, 0, 100), true);
  assert.equal(addBytes(s, -1000, 100), true);
  assert.equal(addBytes(s, Number.NaN, 100), true);
  assert.equal(addBytes(s, Number.POSITIVE_INFINITY, 100), true);
  assert.equal(s.bytes, 50);
  assert.equal(addBytes(s, 50, 100), false);
  // a negative report cannot hand budget back once it is spent
  assert.equal(addBytes(s, -1000, 100), false);
  assert.equal(s.bytes, 100);
});

test('sessionNonce and sessionExpires read the token parts', () => {
  assert.equal(sessionNonce('1700000000.abc-123.deadbeef'), 'abc-123');
  assert.equal(sessionExpires('1700000000.abc-123.deadbeef'), 1700000000);
  assert.equal(sessionNonce('nonsense'), null);
  assert.equal(sessionNonce('1.2.3.4'), null);
  assert.equal(sessionNonce('1..3'), null);
  assert.equal(sessionExpires('x.y.z'), null);
});
