import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayId, pickDisk } from './overlay-pick.ts';

const H = (c: string) => c.repeat(64);
const cur = `disk-${H('a')}.json`;
const p0 = `disk-${H('b')}.json`;
const p1 = `disk-${H('c')}.json`;
const holds = (...names: string[]) => (id: string) => names.some((n) => overlayId(n) === id);

test('no data anywhere boots the current image', () => {
  assert.deepEqual(pickDisk(cur, [p0, p1], () => false), { manifest: cur, isCurrent: true });
});

test('current data wins over previous data', () => {
  assert.deepEqual(pickDisk(cur, [p0, p1], holds(cur, p0)), { manifest: cur, isCurrent: true });
});

test('only an older image holding data boots that image', () => {
  assert.deepEqual(pickDisk(cur, [p0, p1], holds(p1)), { manifest: p1, isCurrent: false });
});

test('when two older images hold data the newest one wins', () => {
  assert.deepEqual(pickDisk(cur, [p0, p1], holds(p0, p1)), { manifest: p0, isCurrent: false });
});

test('overlayId takes the first 16 hex characters of the manifest hash', () => {
  assert.equal(
    overlayId('disk-5fc2eed8ed8f5e87c34b68f14835b8ecba6d13a0b8c7ef66ed1ca7f1c41f1043.json'),
    '5fc2eed8ed8f5e87',
  );
});
