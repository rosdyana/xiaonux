// Which terminal tabs are open: the console and up to three shells. Pure state;
// the tab strip and the xterm instances live in main.ts.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0

/** The console's tab id (it has no id on the wire). */
export const CONSOLE = 0;
/** Tabs in total, the console included. Shell ids run from 2 to MAX_TABS ("shell 2" ... "shell 4"). */
export const MAX_TABS = 4;
const FIRST_SHELL = 2;

export interface TabState {
  /** open shells, in the order their tabs were made */
  readonly shells: readonly number[];
  /** the tab that gets keystrokes: CONSOLE or a shell id */
  readonly active: number;
}

export const initialTabs = (): TabState => ({ shells: [], active: CONSOLE });

/** Every open tab, left to right. */
export function tabIds(s: TabState): number[] {
  return [CONSOLE, ...s.shells];
}

/** The lowest shell id not in use, or null at the cap. */
export function nextId(s: TabState): number | null {
  for (let id = FIRST_SHELL; id <= MAX_TABS; id++) if (!s.shells.includes(id)) return id;
  return null;
}

export function canOpen(s: TabState): boolean {
  return nextId(s) !== null;
}

/** Adds a shell tab and makes it active. Out-of-range or taken ids change nothing. */
export function addShell(s: TabState, id: number): TabState {
  if (!Number.isInteger(id) || id < FIRST_SHELL || id > MAX_TABS || s.shells.includes(id)) return s;
  return { shells: [...s.shells, id], active: id };
}

/**
 * Removes a shell tab. If it was active, the tab to its left becomes active
 * (the console when it was the first shell). The console and unknown ids are ignored.
 */
export function removeShell(s: TabState, id: number): TabState {
  const ids = tabIds(s);
  const i = ids.indexOf(id);
  if (i <= 0) return s;
  const shells = s.shells.filter((x) => x !== id);
  const active = s.active === id ? ids[i - 1] : s.active;
  return { shells, active };
}

/** Makes an open tab active. Unknown ids change nothing. */
export function activate(s: TabState, id: number): TabState {
  return tabIds(s).includes(id) ? { shells: s.shells, active: id } : s;
}
