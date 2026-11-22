import test from 'node:test';
import assert from 'node:assert/strict';
import { activate, addShell, canOpen, CONSOLE, initialTabs, MAX_TABS, nextId, removeShell, tabIds } from './terminal-tabs.ts';

test('starts with the console only, active, and room to open', () => {
  const s = initialTabs();
  assert.deepEqual(tabIds(s), [CONSOLE]);
  assert.equal(s.active, CONSOLE);
  assert.equal(canOpen(s), true);
  assert.equal(nextId(s), 2);
});

test('a new shell takes the next free id and becomes active', () => {
  let s = addShell(initialTabs(), 2);
  assert.deepEqual(tabIds(s), [CONSOLE, 2]);
  assert.equal(s.active, 2);
  s = addShell(s, 3);
  assert.equal(nextId(s), 4);
  assert.equal(s.active, 3);
});

test('the cap is MAX_TABS in total, the console included', () => {
  assert.equal(MAX_TABS, 4);
  let s = initialTabs();
  for (const id of [2, 3, 4]) s = addShell(s, id);
  assert.deepEqual(tabIds(s), [0, 2, 3, 4]);
  assert.equal(canOpen(s), false);
  assert.equal(nextId(s), null);
});

test('out-of-range and duplicate ids change nothing', () => {
  const s = addShell(initialTabs(), 2);
  assert.equal(addShell(s, 1), s);
  assert.equal(addShell(s, 5), s);
  assert.equal(addShell(s, 0), s);
  assert.equal(addShell(s, 2.5), s);
  assert.equal(addShell(s, 2), s);
});

test('a freed id can be used again', () => {
  let s = addShell(addShell(initialTabs(), 2), 3);
  s = removeShell(s, 2);
  assert.equal(nextId(s), 2);
});

test('closing the active shell activates the tab on its left', () => {
  let s = addShell(addShell(addShell(initialTabs(), 2), 3), 4);
  s = activate(s, 3);
  s = removeShell(s, 3);
  assert.deepEqual(tabIds(s), [CONSOLE, 2, 4]);
  assert.equal(s.active, 2);
});

test('closing the first shell while active activates the console', () => {
  const s = removeShell(addShell(initialTabs(), 2), 2);
  assert.deepEqual(tabIds(s), [CONSOLE]);
  assert.equal(s.active, CONSOLE);
});

test('closing a background shell keeps the active tab', () => {
  let s = addShell(addShell(initialTabs(), 2), 3);
  s = activate(s, CONSOLE);
  const after = removeShell(s, 3);
  assert.equal(after.active, CONSOLE);
  assert.deepEqual(tabIds(after), [CONSOLE, 2]);
});

test('the console and unknown ids cannot be removed', () => {
  const s = addShell(initialTabs(), 2);
  assert.equal(removeShell(s, CONSOLE), s);
  assert.equal(removeShell(s, 4), s);
});

test('activate only accepts open tabs', () => {
  const s = addShell(initialTabs(), 2);
  assert.equal(activate(s, 3), s);
  assert.equal(activate(s, CONSOLE).active, CONSOLE);
  assert.equal(activate(s, 2).active, 2);
});
