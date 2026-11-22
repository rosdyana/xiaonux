// xiaonux page: start view, workspace (terminal + worksheet drawer), network,
// file transfer. The machine itself runs in vm.worker.ts.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { FromWorker, FromXv6Worker, NetConfig, ToWorker, ToXv6Worker } from './protocol';
import { X6Bridge, type XvEvents, type XvHandle, type XvStart } from './xv6-bridge';
import { initGuides, LESSONS, LESSONS_DONE_KEY, lessonProgress } from './ui/guides';
import { renderHelperFiles } from './ui/helper';
import { applyDom, mountPickers, onLocaleChange, t, type Key } from './i18n';
import { initConsent } from './consent';
import { activate, addShell, CONSOLE, initialTabs, nextId, removeShell, tabIds, type TabState } from './terminal-tabs';

applyDom();
mountPickers();
initConsent();
const applyMeta = () => {
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
};
applyMeta();
onLocaleChange(applyMeta);

const params = new URLSearchParams(location.search);
// Parameters that point the page at other code or other servers are for
// development only: in a published build a link must not be able to choose
// them (it could load another site's script into this origin).
// MODE, not DEV: DEV follows NODE_ENV, which a shell can set to development
// during a production build; MODE is `development` only for the dev server.
const IS_DEV_SERVER = import.meta.env.MODE === 'development';
const devParam = (k: string) => (IS_DEV_SERVER ? params.get(k) : null);
// The window.xiaonux* hooks (type into the VM, read the terminal, stats) are
// for tests and benchmarks: only the dev server and builds made with
// VITE_TEST_HOOKS=1 (`make serve`) have them, never a published page.
const TEST_HOOKS = IS_DEV_SERVER || import.meta.env.VITE_TEST_HOOKS === '1';
const BOOT_URL = (() => {
  const fallback = '/vm/boot.json';
  const p = devParam('boot');
  if (!p) return fallback;
  const u = new URL(p, location.href);
  return u.origin === location.origin ? u.pathname + u.search : fallback;
})();
const RAM_MB = Number(devParam('ram') ?? 0); // 0 = use the .cfg's memory_size
const CMDLINE = devParam('cmdline') ?? '';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const startView = $('start');
const workspace = $('workspace');
const statusEl = $('status');
const statsEl = $('stats');
const bootBtn = $<HTMLButtonElement>('boot');
const resetBtn = $<HTMLButtonElement>('reset');
const netStatusEl = $('netstatus');
const netChip = $('netchip');
const netChipLabel = $('netchip-label');
const drawer = $('drawer');
const drawerToggle = $('drawer-toggle');

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- start view
const LAST_KEY = 'xiaonux.lastPrompt';
const last = Number(store.get(LAST_KEY));
const renderTiming = () => { if (last > 0) $('start-timing').textContent = t('start.lastTime', { s: (last / 1000).toFixed(2) }); };
renderTiming();
onLocaleChange(renderTiming);

// Guide progress in the worksheet's margin: a red-pen check once started.
function renderSheetProgress() {
  for (const row of document.querySelectorAll<HTMLElement>('.sheet-row[data-lesson]')) {
    const lesson = LESSONS.find((l) => l.id === row.dataset.lesson);
    const done = (lessonProgress()[row.dataset.lesson!] ?? []).length;
    if (!lesson || !done) continue;
    row.classList.add('started');
    let p = row.querySelector<HTMLElement>('.progress');
    if (!p) {
      p = document.createElement('span');
      p.className = 'progress';
      row.querySelector('div')!.append(p);
    }
    p.textContent = t('card.progress', { done, total: lesson.steps.length });
    row.querySelector('[data-try]')!.textContent = t('card.continue');
  }
}
renderSheetProgress();
onLocaleChange(renderSheetProgress);

// ------------------------------------------------------------------ terminal
const dark = matchMedia('(prefers-color-scheme: dark)');
const THEMES: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#fbf8f0', foreground: '#1d3036', cursor: '#a5650a', cursorAccent: '#fbf8f0',
    selectionBackground: '#ecd9b0',
    black: '#1d3036', red: '#b2372a', green: '#3d7a35', yellow: '#8a5a00', blue: '#1f6a85', magenta: '#8a3f7a', cyan: '#18727a', white: '#5c6c6e',
    brightBlack: '#5c6c6e', brightRed: '#c4402f', brightGreen: '#468a3d', brightYellow: '#9a6500', brightBlue: '#257a98', brightMagenta: '#9a4a89', brightCyan: '#1d828b', brightWhite: '#2a3f45',
  },
  dark: {
    background: '#12262b', foreground: '#e9e2d0', cursor: '#e3a43b', cursorAccent: '#12262b',
    selectionBackground: '#2f5058',
    black: '#12262b', red: '#e46a5b', green: '#8db580', yellow: '#e3a43b', blue: '#7fb7c9', magenta: '#d39ac0', cyan: '#7cc7bd', white: '#b8c1b8',
    brightBlack: '#6f8a88', brightRed: '#f08a7c', brightGreen: '#a7cc9a', brightYellow: '#f0bd62', brightBlue: '#9fcbd9', brightMagenta: '#e2b4d2', brightCyan: '#9cd9d0', brightWhite: '#f5efe1',
  },
};
const termOptions = () => ({
  fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 14,
  lineHeight: 1.15,
  cursorBlink: true,
  convertEol: false,
  scrollback: 5000,
  theme: THEMES[dark.matches ? 'dark' : 'light'],
});
const term = new Terminal(termOptions()); // the console (tab 0)
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('term'));
/** A shell tab (2-4): its own xterm, in its own pane under #term. */
interface ShellView { term: Terminal; fit: FitAddon; pane: HTMLElement; tail: string; decoder: TextDecoder }
const shells = new Map<number, ShellView>();
let tabState: TabState = initialTabs();
/** The guest's `tabs` message: how many shells it allows (0 = too old); null until it arrives. */
let tabsMax: number | null = null;
dark.addEventListener('change', () => {
  const theme = THEMES[dark.matches ? 'dark' : 'light'];
  term.options.theme = theme;
  for (const v of shells.values()) v.term.options.theme = theme;
});
// The drawer animates its width; refit the terminal once when it settles,
// not on every frame of the transition.
let drawerMoving = false;
/** Fits the visible terminal (a hidden xterm measures 0 x 0). */
const fitActive = () => (tabState.active === CONSOLE ? fit : shells.get(tabState.active)?.fit)?.fit();
const refit = () => { if (!workspace.hidden && !drawerMoving) fitActive(); };
new ResizeObserver(refit).observe($('term-wrap'));
drawer.addEventListener('transitionrun', (e) => { if (e.propertyName === 'width') drawerMoving = true; });
for (const ev of ['transitionend', 'transitioncancel'] as const) {
  drawer.addEventListener(ev, (e) => { if (e.propertyName === 'width') { drawerMoving = false; refit(); } });
}

let worker: Worker | null = null;
const send = (m: ToWorker, transfer: Transferable[] = []) => worker?.postMessage(m, transfer);

// `make qemu` in the guest: the shim's x6 lines arrive through the Debian worker
// (onWorker 'x6'), and the xv6 machine runs in its own worker, made on the first
// `x6 begin` (see xv6-bridge.ts). The Debian VM's restarts and resets kill it.
const xv6Bridge = new X6Bridge({
  send: (line) => send({ type: 'x6', line }),
  start: startXv6Machine,
  log: (message) => console.info(`[xiaonux] ${message}`),
});
function startXv6Machine(opts: XvStart, ev: XvEvents): XvHandle {
  const w = new Worker(new URL('./xv6.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<FromXv6Worker>) => {
    const m = e.data;
    switch (m.type) {
      case 'console': ev.console(m.data); break;
      case 'gdb': ev.gdb(m.data); break;
      case 'ready': ev.ready(); break;
      case 'killed': ev.killed(); break;
      case 'stopped': ev.stopped(new Uint8Array(m.fs)); break;
      case 'error': ev.error(m.message); break;
      case 'stats': break;
    }
  };
  w.onerror = (e) => ev.error(e.message || 'the xv6 worker failed');
  const kernel = opts.kernel.buffer as ArrayBuffer;
  const fs = opts.fs.buffer as ArrayBuffer;
  const msg: ToXv6Worker = {
    type: 'start',
    base: new URL('.', new URL(BOOT_URL, location.href)).href,
    kernel,
    fs,
    gdb: opts.gdb,
    wait: opts.wait,
    sync: opts.sync,
  };
  w.postMessage(msg, [kernel, fs]);
  return {
    input: (data) => w.postMessage({ type: 'input-bytes', data } satisfies ToXv6Worker),
    gdbIn: (data) => w.postMessage({ type: 'gdb-in', data } satisfies ToXv6Worker),
    resume: () => w.postMessage({ type: 'resume' } satisfies ToXv6Worker),
    stop: () => w.postMessage({ type: 'stop' } satisfies ToXv6Worker),
    terminate: () => w.terminate(),
  };
}
const encoder = new TextEncoder();
const type = (s: string) => {
  const data = encoder.encode(s);
  send({ type: 'input', data }, [data.buffer]);
};
/** Types into terminal tab `id` (0 = the console). */
function typeTo(id: number, s: string) {
  if (id === CONSOLE) { type(s); return; }
  const data = encoder.encode(s);
  send({ type: 'tab-input', id, data }, [data.buffer]);
}

// -------------------------------------------------------------------- guides
/** Types a guide's command into the active tab and returns that tab's id (see guides.ts). */
const guides = initGuides((s) => {
  const tab = tabState.active;
  typeTo(tab, s);
  activeTerm().focus();
  return tab;
});

// ------------------------------------------------------------------- network
interface NetPrefs { mode: 'off' | 'helper' | 'relay'; helperPort?: number; helperToken?: string }
// Network is off on every visit unless the helper's link pairs this page.
let netPrefs: NetPrefs = { mode: 'off' };
if (params.get('net') === 'helper' && params.get('token')) {
  netPrefs = { mode: 'helper', helperPort: Number(params.get('port') ?? 8787), helperToken: params.get('token')! };
  history.replaceState(null, '', location.pathname + (params.has('autoboot') ? '?autoboot' : ''));
}
// `net=off` only makes things safer, so it works everywhere; turning the relay
// on from a link is dev-only (in a published build it takes a click).
const netParam = params.get('net');
if (netParam === 'off' || (netParam === 'relay' && IS_DEV_SERVER)) netPrefs = { ...netPrefs, mode: netParam };

const RELAY_URL = (devParam('relay') ?? import.meta.env.VITE_RELAY_URL ?? '').replace(/\/$/, '');
const TURNSTILE_SITEKEY: string = devParam('turnstile') === '0' ? '' : (import.meta.env.VITE_TURNSTILE_SITEKEY ?? '');
let relaySession: { session: string; expires: number; allowed?: string[]; ports?: number[]; rotateBytes?: number } | null = null;
const netRadios = [...document.querySelectorAll<HTMLInputElement>('input[name=netmode]')];
if (!RELAY_URL) $('relay-option').hidden = true;

type TurnstileApi = { render: (el: HTMLElement, o: object) => string; remove: (id: string) => void };
/** How long the visitor has to finish the challenge before we say so (instead of waiting forever). */
const TURNSTILE_LIMIT_MS = 60_000;

function turnstileToken(): Promise<string> {
  if (!TURNSTILE_SITEKEY) return Promise.resolve(''); // local dev relay (DEV_NO_TURNSTILE)
  return new Promise((resolve, reject) => {
    const render = () => {
      const box = document.createElement('div');
      box.className = 'turnstile';
      document.body.appendChild(box);
      const ts = (window as unknown as { turnstile: TurnstileApi }).turnstile;
      let id = '';
      let settled = false;
      // Remove through the API first: removing only the element leaves the
      // widget alive ("Cannot find Widget …" when Turnstile refreshes it).
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(limit);
        try { if (id) ts.remove(id); } catch { /* already gone */ }
        box.remove();
        fn();
      };
      const fail = (why: string) => done(() => reject(new Error(why)));
      const limit = setTimeout(() => fail('the relay check did not finish'), TURNSTILE_LIMIT_MS);
      id = ts.render(box, {
        sitekey: TURNSTILE_SITEKEY,
        callback: (t: string) => done(() => resolve(t)),
        'error-callback': () => fail('challenge failed'),
        'timeout-callback': () => fail('the relay check timed out'),
        'expired-callback': () => fail('the relay check expired'),
      });
    };
    if ((window as unknown as { turnstile?: unknown }).turnstile) return render();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true;
    s.onload = render;
    s.onerror = () => reject(new Error('could not load the challenge'));
    document.head.appendChild(s);
  });
}

async function ensureRelaySession(): Promise<boolean> {
  if (relaySession && relaySession.expires - Date.now() / 1000 > 120) return true;
  try {
    const turnstile = await turnstileToken();
    const r = await fetch(`${RELAY_URL}/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnstile }),
    });
    if (!r.ok) throw new Error(`relay: HTTP ${r.status}`);
    relaySession = await r.json();
    setTimeout(async () => {
      relaySession = null;
      if (netPrefs.mode === 'relay' && (await ensureRelaySession())) send({ type: 'net', net: netConfig() });
    }, Math.max(60, relaySession!.expires - Date.now() / 1000 - 120) * 1000);
    return true;
  } catch (e) {
    showNet(() => t('net.relayUnavailable', { message: (e as Error).message }), 'blocked');
    return false;
  }
}

function netConfig(): NetConfig {
  if (netPrefs.mode === 'relay' && RELAY_URL && relaySession) {
    const t = encodeURIComponent(relaySession.session);
    return { mode: 'relay', wsUrl: `${RELAY_URL.replace(/^http/, 'ws')}/wisp?session=${t}`, pingUrl: `${RELAY_URL}/ping?session=${t}`,
      allowed: relaySession.allowed, ports: relaySession.ports, rotateBytes: relaySession.rotateBytes };
  }
  if (netPrefs.mode === 'helper' && netPrefs.helperToken) {
    const base = `127.0.0.1:${netPrefs.helperPort ?? 8787}`;
    const t = encodeURIComponent(netPrefs.helperToken);
    return { mode: 'helper', wsUrl: `ws://${base}/wisp?token=${t}`, pingUrl: `http://${base}/ping?token=${t}` };
  }
  return { mode: 'off', wsUrl: '', pingUrl: '' };
}

type ChipState = 'off' | 'waiting' | 'on' | 'blocked';
type Text = string | (() => string);
const CHIP_KEYS = { off: 'chip.off', waiting: 'chip.waiting', on: 'chip.on', blocked: 'chip.blocked' } as const;
let netText: Text = '';
let chipLabel: Text = () => t('chip.off');
const str = (x: Text) => (typeof x === 'function' ? x() : x);
/** Texts are functions so they can be redrawn in a new language. */
function showNet(text: Text, chip?: ChipState, chipText?: Text) {
  netText = text;
  netStatusEl.textContent = str(text);
  netStatusEl.dataset.state = chip ?? '';
  if (chip) {
    netChip.dataset.state = chip;
    chipLabel = chipText ?? (() => t(CHIP_KEYS[chip]));
    netChipLabel.textContent = str(chipLabel);
  }
}
onLocaleChange(() => {
  netStatusEl.textContent = str(netText);
  netChipLabel.textContent = str(chipLabel);
});
function syncNetUi() {
  for (const r of netRadios) r.checked = r.value === netPrefs.mode;
  $('helper-help').classList.toggle('emph', netPrefs.mode === 'helper' && !netPrefs.helperToken);
  if (netPrefs.mode === 'off') showNet('', 'off');
  else if (netPrefs.mode === 'helper' && !netPrefs.helperToken) showNet(() => t('net.runHelper'), 'waiting', () => t('net.waitingHelper'));
}
syncNetUi();
renderHelperFiles($('helper-files'));
onLocaleChange(() => renderHelperFiles($('helper-files')));
for (const r of netRadios) r.addEventListener('change', async () => {
  netPrefs.mode = r.value as NetPrefs['mode'];
  syncNetUi();
  if (netPrefs.mode === 'relay') {
    showNet(() => t('net.relayConnecting'), 'waiting');
    if (!(await ensureRelaySession())) return;
    // The relay socket opens on Linux's first connection; until then, say it's ready.
    if (netPrefs.mode === 'relay') showNet(() => t('net.relayReady'), 'on');
  }
  send({ type: 'net', net: netConfig() });
});
netChip.addEventListener('click', () => openDrawer('network'));

// -------------------------------------------------------------------- drawer
const tabs = ['guides', 'network', 'safety'] as const;
type Tab = typeof tabs[number];
const DRAWER_KEY = 'xiaonux.drawer';
function selectTab(t: Tab, focus = false) {
  for (const name of tabs) {
    const tab = $(`tab-${name}`);
    const on = name === t;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${name}`).hidden = !on;
    if (on && focus) tab.focus();
  }
}
function setDrawer(open: boolean) {
  drawer.classList.toggle('open', open);
  drawerToggle.setAttribute('aria-expanded', String(open));
  store.set(DRAWER_KEY, open ? '1' : '0');
}
function openDrawer(t: Tab) { selectTab(t); setDrawer(true); }
for (const name of tabs) $(`tab-${name}`).addEventListener('click', () => selectTab(name));
$('drawer').querySelector('.tabs')!.addEventListener('keydown', (e) => {
  const k = (e as KeyboardEvent).key;
  if (k !== 'ArrowRight' && k !== 'ArrowLeft') return;
  const cur = tabs.findIndex((n) => $(`tab-${n}`).getAttribute('aria-selected') === 'true');
  selectTab(tabs[(cur + (k === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
});
drawerToggle.addEventListener('click', () => setDrawer(!drawer.classList.contains('open')));
const wide = matchMedia('(min-width: 960px)');
// Ctrl+Shift+G moves focus between the terminal and the drawer: Tab can't
// leave the terminal, because the shell needs it for completion.
const isSwitchKey = (e: KeyboardEvent) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyG';
term.attachCustomKeyEventHandler((e) => !isSwitchKey(e));
document.addEventListener('keydown', (e) => {
  if (!isSwitchKey(e) || workspace.hidden) return;
  e.preventDefault();
  if (drawer.contains(document.activeElement)) {
    if (!wide.matches) setDrawer(false);
    activeTerm().focus();
    return;
  }
  setDrawer(true);
  drawer.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
});
// Escape inside the overlay drawer (narrow screens) closes it and returns to the terminal.
drawer.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || wide.matches || !drawer.classList.contains('open')) return;
  setDrawer(false);
  activeTerm().focus();
});
setDrawer(store.get(DRAWER_KEY) === null ? wide.matches : store.get(DRAWER_KEY) === '1' && wide.matches);
// The services tile under the guide can be hidden; it stays hidden in this browser.
const SVC_KEY = 'xiaonux.svc';
$('svc-tile').hidden = store.get(SVC_KEY) === '0';
$('svc-hide').addEventListener('click', () => { $('svc-tile').hidden = true; store.set(SVC_KEY, '0'); });

// ---------------------------------------------------------------- boot/status
let tBoot = 0;
let bytesFetched = 0;
let marks: Record<string, number> = {};
let tail = '';
const decoder = new TextDecoder();
let diskStats: Record<string, unknown> = {};

/** Status text in the bar, kept as a function so a language switch can redraw it. */
let statusDraw: () => void = () => {};
function setStatus(what: Key | (() => void), vars: Record<string, string | number> = {}) {
  statusDraw = typeof what === 'function' ? what : () => { statusEl.textContent = t(what, vars); };
  statusDraw();
}
onLocaleChange(() => statusDraw());

/** Set when this tab's changes won't be kept (the worker's 'disk-mode'); null = they are. */
let notSaved: Key | null = null;
/** Set when the user's files are in the previous system version (the worker's 'disk-mode'). */
let olderVersion: Key | null = null;
/** The full explanation lives in a dismissible note under the bar; the status only says "Previous version". */
const OLDER_NOTE_KEY = 'xiaonux.olderNote';
const olderNote = $('older-note');
$('older-hide').addEventListener('click', () => { olderNote.hidden = true; store.set(OLDER_NOTE_KEY, '0'); });
$('older-reset').addEventListener('click', () => resetBtn.click());
const RESET_REASONS: Record<string, Key> = {
  'other-tab': 'reset.reason.other-tab',
  unavailable: 'reset.reason.unavailable',
  starting: 'reset.reason.starting',
};

/** A reset that did not happen: say so, and let the user try again. */
function resetFailed(reason: string) {
  const why = RESET_REASONS[reason] ?? RESET_REASONS.unavailable;
  setStatus(() => {
    statusEl.textContent = t('status.resetFailed', { reason: t(why) });
    statusEl.title = '';
  });
  statusEl.dataset.state = 'error';
  resetBtn.disabled = false;
}

/** A worker failed to start or died: show why, drop it, and let Start and Reset be used again. */
function workerFailed(w: Worker, message: string) {
  xv6Bridge.kill();
  closeShells();
  w.terminate();
  if (worker === w) worker = null; // else boot() would return early
  setStatus('status.error', { message: message || 'the machine failed to start' });
  statusEl.dataset.state = 'error';
  resetBtn.disabled = false;
  bootBtn.disabled = false;
}

/** The guide checks refer to files that are now gone. Only after a reset really happened. */
function resetDone() {
  store.set(LESSONS_DONE_KEY, '{}');
  store.set(OLDER_NOTE_KEY, '1'); // a later image change should show the note again
  location.reload();
}

function mark(name: string) {
  if (marks[name] !== undefined) return;
  marks[name] = Math.round(performance.now() - tBoot);
  if (name === 'prompt') {
    const s = (marks.prompt / 1000).toFixed(2);
    // The not-saved notice must outlive "Ready in N s": it is the one thing the user needs to know.
    setStatus(() => {
      statusEl.innerHTML = t('status.ready', { s }); // our own markup
      statusEl.title = t('status.readyTitle');
      if (notSaved) {
        statusEl.append(` · ${t(notSaved)}`);
        statusEl.title = t(notSaved);
      } else if (olderVersion) {
        statusEl.append(` · ${t(olderVersion)}`);
        statusEl.title = t('note.older');
      }
    });
    statusEl.dataset.state = notSaved ? 'error' : 'ready';
    store.set(LAST_KEY, String(marks.prompt));
  } else if (name === 'restore' || name === 'vm') {
    setStatus(name === 'restore' ? 'status.restoring' : 'status.booting');
  }
  console.info(`[xiaonux] ${name} at ${marks[name]} ms`);
  if (TEST_HOOKS) (window as unknown as { xiaonux: unknown }).xiaonux = { marks, bytesFetched };
}

const PROMPT = /(?:[#$]|>>>|\(gdb\)) ?$/;
function watchPrompts(bytes: Uint8Array) {
  tail = (tail + decoder.decode(bytes, { stream: true })).slice(-200);
  if (/login: ?$/.test(tail)) mark('login');
  if (/[#$] ?$/.test(tail) && (marks.login !== undefined || marks.restore !== undefined)) mark('prompt');
  if (PROMPT.test(tail)) guides.onPrompt(CONSOLE);
}

// ------------------------------------------------------------- home/history
// The start view and the machine are one page. Entering the machine adds a
// #machine history entry, so the browser's Back (and the wordmark) return to
// the start view while the machine keeps running in its worker.
const MACHINE = '#machine';
const enter = (el: HTMLElement) => {
  el.classList.remove('view-in');
  void el.offsetWidth; // restart the animation
  el.classList.add('view-in');
};
function showWorkspace() {
  if (location.hash !== MACHINE) history.pushState({ view: 'machine' }, '', MACHINE);
  if (!workspace.hidden) return;
  startView.hidden = true;
  workspace.hidden = false;
  document.body.classList.add('in-workspace');
  enter(workspace);
  requestAnimationFrame(() => { fitActive(); activeTerm().focus(); });
}
// Every Start button on the start view (the cover and the closing section) boots the machine.
const bootBtns = document.querySelectorAll<HTMLButtonElement>('[data-boot]');
for (const b of bootBtns) b.addEventListener('click', () => bootBtn.click());
function renderResume() {
  if (!worker) return;
  bootBtn.disabled = false;
  bootBtn.textContent = t('start.resume');
  for (const b of bootBtns) b.textContent = t('start.resume');
  $('start-timing').textContent = t('start.running');
}
onLocaleChange(renderResume);
function showStart() {
  if (workspace.hidden) return;
  workspace.hidden = true;
  startView.hidden = false;
  document.body.classList.remove('in-workspace');
  renderResume();
  enter(startView);
  window.scrollTo(0, 0);
  bootBtn.focus({ preventScroll: true });
}
function goHome() {
  if (workspace.hidden) { window.scrollTo({ top: 0 }); return; }
  if ((history.state as { view?: string } | null)?.view === 'machine') history.back(); // popstate shows the start view
  else { history.replaceState(null, '', location.pathname + location.search); showStart(); }
}
window.addEventListener('popstate', () => {
  if (location.hash === MACHINE) boot();
  else showStart();
});
for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-home]')) {
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // let "open in new tab" work
    e.preventDefault();
    goHome();
  });
}

async function boot(forceCold = false) {
  showWorkspace();
  if (worker) return;
  xv6Bridge.kill();
  closeShells();
  if (netPrefs.mode === 'relay' && RELAY_URL) await ensureRelaySession();
  bootBtn.disabled = true;
  tBoot = performance.now();
  marks = {};
  bytesFetched = 0;
  notSaved = null;
  olderVersion = null;
  setStatus('status.starting');
  statusEl.dataset.state = '';
  worker = new Worker(new URL('./vm.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onWorker(e.data);
  worker.onerror = (e) => {
    // Fatal only until the machine is up: a stray error later must not kill a
    // running machine and its unsaved work (errors in the run loop arrive as
    // {type:'error'} and are shown by onWorker).
    if (marks.vm !== undefined || marks.restore !== undefined) console.error('[xiaonux] worker error', e.message);
    else workerFailed(e.target as Worker, e.message);
  };
  send({ type: 'start', bootUrl: new URL(BOOT_URL, location.href).href, ramMb: RAM_MB, cmdline: CMDLINE, forceCold: forceCold || params.has('cold'), record: params.has('record'), net: netConfig(), jit: params.get('jit') !== '0', jitCheck: params.get('jit') === 'check' });
}

function onWorker(m: FromWorker) {
  switch (m.type) {
    case 'console':
      term.write(m.data);
      watchPrompts(m.data);
      break;
    case 'ready':
      mark(m.restored ? 'restore' : 'vm');
      send({ type: 'resize', cols: term.cols, rows: term.rows });
      break;
    case 'fetch':
      bytesFetched += m.bytes;
      if (marks.prompt === undefined) setStatus('status.downloading', { mb: (bytesFetched / 2 ** 20).toFixed(1) });
      break;
    case 'stats':
      statsEl.textContent = m.mips > 0 ? `${m.mips} MIPS` : t('stats.idle');
      statsEl.title = t('stats.title', { heap: m.heapMb, mb: (bytesFetched / 2 ** 20).toFixed(1) });
      if (TEST_HOOKS) (window as unknown as { xiaonux: unknown }).xiaonux = { marks, bytesFetched, mips: m.mips, heapMb: m.heapMb, outBytes: m.outBytes, disk: diskStats, jit: m.jit };
      break;
    case 'disk':
      diskStats = m.stats as unknown as Record<string, unknown>;
      break;
    case 'restored':
      // Entropy was seeded (else we'd have restarted cold); only the clock failed.
      if (!m.agentOk) console.warn('[xiaonux] guest agent did not set the clock');
      break;
    case 'restart-cold':
      xv6Bridge.kill();
      worker?.terminate();
      worker = null;
      boot(true);
      break;
    case 'net':
      if (m.status === 'rotated') break; // planned switch to a fresh relay socket
      if (m.status === 'disconnected' && m.mode === 'relay') {
        showNet(() => t('net.relayEnded'), 'blocked', () => t('net.relayPaused'));
        break;
      }
      if (m.mode === 'off') break;
      if (m.status === 'connected') showNet(() => t(m.mode === 'helper' ? 'net.connectedHelper' : 'net.connectedRelay'), 'on');
      else if (m.status === 'connecting') showNet(() => t('net.connecting'), 'waiting');
      else {
        const detail = m.detail;
        showNet(() => (detail ? t('net.disconnectedDetail', { detail }) : t('net.disconnected')), 'blocked', () => t('net.lost'));
      }
      break;
    case 'net-blocked':
      { const { host, reason } = m; showNet(() => t('net.blocked', { host, reason }), 'blocked', () => t('net.siteBlocked')); }
      console.info(`[xiaonux] blocked ${m.host}: ${m.reason}`);
      break;
    case 'transfer':
      showTransfer(m.dir === 'up' ? t('transfer.uploading', { name: upName }) : t('transfer.downloading', { name: dlName }), m.done / Math.max(1, m.total));
      break;
    case 'upload-done':
      showTransfer(t('transfer.uploaded', { path: m.path }), 1, true);
      upNext?.();
      break;
    case 'download-done': {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([m.bytes as BlobPart]));
      a.download = m.path.split('/').pop() || 'download';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      showTransfer(t('transfer.downloaded', { name: a.download }), 1, true);
      break;
    }
    case 'transfer-error':
      showTransfer(m.message, 0, true, true);
      upNext?.();
      break;
    case 'jit-export': {
      let bin = '';
      for (let i = 0; i < m.bytes.length; i += 0x8000) bin += String.fromCharCode(...m.bytes.subarray(i, i + 0x8000));
      if (TEST_HOOKS) (window as unknown as { xiaonuxJitBundle: unknown }).xiaonuxJitBundle = { build: m.build, b64: btoa(bin) };
      break;
    }
    case 'saved':
      console.info(`[xiaonux] saved machine (${m.reason}) ${(m.bytes / 2 ** 20).toFixed(1)} MB in ${m.ms} ms`);
      break;
    case 'disk-mode':
      notSaved = m.persistent ? null : m.reason === 'other-tab' ? 'status.notSaved' : 'status.notSavedNoStorage';
      olderVersion = m.current ? null : 'status.olderVersion';
      olderNote.hidden = !olderVersion || store.get(OLDER_NOTE_KEY) === '0';
      if (notSaved) {
        // Show it now; "Ready in N s" re-applies it (see mark()).
        const key = notSaved;
        setStatus(() => {
          statusEl.textContent = t(key);
          statusEl.title = t(key);
        });
        statusEl.dataset.state = 'error';
      }
      break;
    case 'reset-done':
      console.info('[xiaonux] machine reset: your changes were deleted');
      resetDone();
      break;
    case 'reset-failed':
      resetFailed(m.reason);
      break;
    case 'log':
      console.info(`[xiaonux] ${m.message}`);
      break;
    case 'x6':
      xv6Bridge.onLine(m.line);
      break;
    case 'tab-out': {
      const v = shells.get(m.id); // a shell this page doesn't have (closed) is ignored
      if (!v) break;
      v.term.write(m.data);
      v.tail = (v.tail + v.decoder.decode(m.data, { stream: true })).slice(-200);
      if (PROMPT.test(v.tail)) guides.onPrompt(m.id);
      break;
    }
    case 'tab-exit':
      dropShell(m.id);
      break;
    case 'tab-error':
      dropShell(m.id);
      flashStatus('status.tabFailed', { reason: m.reason });
      break;
    case 'tabs':
      tabsMax = m.max;
      renderNewTab();
      break;
    case 'error':
      setStatus('status.error', { message: m.message });
      statusEl.dataset.state = 'error';
      term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`);
      break;
  }
}

// ---------------------------------------------------------- terminal input
const keysEl = $('keys');
let ctrl = false;
function setCtrl(on: boolean) {
  ctrl = on;
  keysEl.querySelector('[data-key=ctrl]')!.setAttribute('aria-pressed', String(on));
}
/** Keys typed into terminal tab `tab` (0 = the console). */
function onKeys(tab: number, s: string) {
  if (ctrl && s.length === 1) {
    const c = s.toLowerCase().charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) s = String.fromCharCode(c - 0x60);
    setCtrl(false);
  }
  if (s.includes('\r')) guides.onEnter(tab);
  typeTo(tab, s);
}
term.onData((s) => onKeys(CONSOLE, s));
const KEYS: Record<string, string> = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', pipe: '|', tilde: '~' };
keysEl.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the terminal's keyboard up
keysEl.addEventListener('click', (e) => {
  const k = (e.target as HTMLElement).closest('button')?.dataset.key;
  if (!k) return;
  if (k === 'ctrl') setCtrl(!ctrl);
  else typeTo(tabState.active, KEYS[k]);
  activeTerm().focus();
});
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

// ------------------------------------------------------------ file transfer
const transferEl = $('transfer');
let transferTimer = 0;
let upName = '';
let dlName = '';
let upNext: (() => void) | null = null;
function showTransfer(label: string, frac: number, finished = false, error = false) {
  clearTimeout(transferTimer);
  transferEl.hidden = false;
  transferEl.dataset.state = error ? 'error' : finished ? 'done' : '';
  $('transfer-label').textContent = label;
  $('transfer-fill').style.width = `${Math.round(frac * 100)}%`;
  if (finished) transferTimer = window.setTimeout(() => { transferEl.hidden = true; }, error ? 8000 : 4000);
}
async function uploadFiles(files: File[]) {
  if (!worker || marks.prompt === undefined) {
    showTransfer(t('transfer.wait'), 0, true, true);
    return;
  }
  for (const f of files) {
    upName = f.name;
    showTransfer(t('transfer.uploading', { name: f.name }), 0);
    const data = new Uint8Array(await f.arrayBuffer());
    await new Promise<void>((resolve) => {
      upNext = () => { upNext = null; resolve(); };
      send({ type: 'upload', name: f.name, data }, [data.buffer]);
    });
  }
}
const fileInput = $<HTMLInputElement>('file-input');
$('upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  uploadFiles([...(fileInput.files ?? [])]);
  fileInput.value = '';
});
const termWrap = $('term-wrap');
const dropEl = $('drop');
let dragDepth = 0;
termWrap.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropEl.hidden = false;
});
termWrap.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropEl.hidden = true; } });
termWrap.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
termWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.hidden = true;
  uploadFiles([...(e.dataTransfer?.files ?? [])]);
});
const dlPop = $('dl-pop');
const dlPath = $<HTMLInputElement>('dl-path');
dlPop.addEventListener('toggle', (e) => {
  if ((e as ToggleEvent).newState === 'open') { dlPath.focus(); dlPath.setSelectionRange(dlPath.value.length, dlPath.value.length); }
});
$('dl-form').addEventListener('submit', (e) => {
  e.preventDefault();
  dlPop.hidePopover();
  let p = dlPath.value.trim();
  if (!p) return;
  if (!p.startsWith('/')) p = `/root/${p}`;
  if (!worker || marks.prompt === undefined) { showTransfer(t('transfer.wait'), 0, true, true); return; }
  dlName = p.split('/').pop() || p;
  showTransfer(t('transfer.downloading', { name: dlName }), 0);
  send({ type: 'download', path: p.replace(/^\/root\/?/, '') });
  activeTerm().focus();
});

// ------------------------------------------------------------- terminal tabs
// The console is tab 0; shells are tabs 2-4 (terminal-tabs.ts keeps which are open).
// Each shell has its own xterm in its own pane; only the active one is shown.
const tabWrap = $('term-wrap');
const tabsEl = $('term-tabs');
const consoleTab = $<HTMLButtonElement>('tab-0');
const newTabBtn = $<HTMLButtonElement>('tab-new');
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
};
const tabButton = (id: number) => $<HTMLButtonElement>(`tab-${id}`);
function xtermOf(id: number): Terminal | undefined { return id === CONSOLE ? term : shells.get(id)?.term; }
function activeTerm(): Terminal { return xtermOf(tabState.active) ?? term; }

function makeView(id: number): ShellView {
  const pane = el('div', 'term-pane');
  pane.id = `term-${id}`;
  $('term').append(pane);
  const tm = new Terminal(termOptions());
  const f = new FitAddon();
  tm.loadAddon(f);
  tm.open(pane);
  tm.attachCustomKeyEventHandler((e) => !isSwitchKey(e));
  tm.onData((s) => onKeys(id, s));
  tm.onResize(({ cols, rows }) => send({ type: 'tab-resize', id, cols, rows }));
  return { term: tm, fit: f, pane, tail: '', decoder: new TextDecoder() };
}

/** Shows the active tab's pane, hides the others, and fits the one on screen. */
function showActive() {
  const id = tabState.active;
  if (term.element) term.element.style.display = id === CONSOLE ? '' : 'none';
  for (const [sid, v] of shells) v.pane.hidden = sid !== id;
  markTabs();
  fitActive();
}

function markTabs() {
  for (const id of tabIds(tabState)) {
    const on = id === tabState.active;
    tabButton(id).setAttribute('aria-selected', String(on));
    tabButton(id).tabIndex = on ? 0 : -1;
  }
}

/** Rebuilds the strip from the tab state. Labels follow the language, so this runs again on a change. */
function renderTabs() {
  const shellTabs = tabState.shells.map((id) => {
    const tab = el('button', 'term-tab');
    tab.type = 'button';
    tab.id = `tab-${id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', t('tabs.shell', { n: id }));
    tab.setAttribute('aria-controls', `term-${id}`);
    const num = el('span', 'num', String(id));
    num.setAttribute('aria-hidden', 'true');
    tab.append(el('span', 'lbl', t('tabs.shell', { n: id })), num);
    tab.addEventListener('click', () => activateTab(id));
    const close = el('button', 'term-x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('tabs.close', { n: id }));
    close.title = t('tabs.close', { n: id });
    close.addEventListener('click', () => closeShell(id));
    const wrap = el('span', 'term-tab-wrap');
    wrap.setAttribute('role', 'none');
    wrap.append(tab, close);
    return wrap;
  });
  tabsEl.replaceChildren(consoleTab, ...shellTabs);
  tabWrap.classList.toggle('has-shells', tabState.shells.length > 0);
  markTabs();
  renderNewTab();
}

/** `+` is hidden until the guest says what it supports; disabled when it's too old or at the cap. */
function renderNewTab() {
  const known = tabsMax !== null;
  newTabBtn.hidden = !known;
  tabWrap.classList.toggle('tabs-ready', known);
  if (!known) return;
  const free = nextId(tabState) !== null;
  newTabBtn.disabled = tabsMax === 0 || !free;
  newTabBtn.title = tabsMax === 0 ? t('tabs.needsReset') : free ? t('tabs.new') : t('tabs.full');
}

function activateTab(id: number, focusTab = false) {
  tabState = activate(tabState, id);
  showActive();
  if (focusTab) tabButton(id).focus();
  else activeTerm().focus();
}

/** `+`: a new shell with the active terminal's size; its tab shows at once. */
function openShell(): number | null {
  const id = nextId(tabState);
  if (tabsMax === null || tabsMax === 0 || id === null) return null;
  const { cols, rows } = activeTerm();
  shells.set(id, makeView(id));
  tabState = addShell(tabState, id);
  send({ type: 'tab-open', id, cols, rows });
  renderTabs();
  showActive();
  activeTerm().focus();
  return id;
}

/** ×: the guest closes the shell; its tab goes when the guest reports the exit. */
function closeShell(id: number) {
  send({ type: 'tab-close', id });
}

/** The shell is gone (`t exit`) or never opened (`t error`): drop its tab, and focus the one on its left. */
function dropShell(id: number) {
  const view = shells.get(id);
  if (!view) return;
  const wasActive = tabState.active === id;
  tabState = removeShell(tabState, id);
  shells.delete(id);
  view.term.dispose();
  view.pane.remove();
  renderTabs();
  if (wasActive) {
    showActive();
    tabButton(tabState.active).focus();
  }
}

/** Reset, a restart or a failed worker: the guest's shells are gone, so their tabs go too. */
function closeShells() {
  for (const v of shells.values()) {
    v.term.dispose();
    v.pane.remove();
  }
  shells.clear();
  tabState = initialTabs();
  tabsMax = null;
  if (term.element) term.element.style.display = '';
  renderTabs();
}

/** A message in the status bar for four seconds, then the status it replaced (unless something else changed it since). */
function flashStatus(key: Key, vars: Record<string, string | number>) {
  const before = statusDraw;
  const beforeState = statusEl.dataset.state ?? '';
  const draw = () => { statusEl.textContent = t(key, vars); statusEl.title = ''; };
  setStatus(draw);
  statusEl.dataset.state = 'error';
  setTimeout(() => {
    if (statusDraw !== draw) return;
    statusDraw = before;
    before();
    statusEl.dataset.state = beforeState;
  }, 4000);
}

newTabBtn.addEventListener('click', () => openShell());
consoleTab.addEventListener('click', () => activateTab(CONSOLE));
// ARIA tabs: the arrow keys move between tabs and activate them.
tabsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const ids = tabIds(tabState);
  const i = ids.indexOf(tabState.active);
  e.preventDefault();
  activateTab(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length], true);
});
onLocaleChange(renderTabs);
renderTabs();

// --------------------------------------------------------------- start/reset
bootBtn.addEventListener('click', () => boot());
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-try]')) {
  b.addEventListener('click', () => {
    guides.show(b.dataset.try!);
    openDrawer('guides');
    boot();
  });
}
const resetDlg = $<HTMLDialogElement>('reset-dlg');
resetBtn.addEventListener('click', () => { resetDlg.returnValue = ''; resetDlg.showModal(); });
resetDlg.addEventListener('close', () => {
  if (resetDlg.returnValue !== 'reset') { activeTerm().focus(); return; }
  resetBtn.disabled = true;
  setStatus('status.resetting');
  xv6Bridge.kill();
  if (!worker) {
    const w = new Worker(new URL('./vm.worker.ts', import.meta.url), { type: 'module' });
    worker = w;
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'reset-done') resetDone();
      else if (m.type === 'reset-failed') {
        w.terminate();
        if (worker === w) worker = null;
        resetFailed(m.reason);
      } else if (m.type === 'error') workerFailed(w, m.message);
    };
    w.onerror = (e) => workerFailed(w, e.message);
    send({ type: 'start', bootUrl: new URL(BOOT_URL, location.href).href, ramMb: RAM_MB, cmdline: CMDLINE, resetOnly: true });
  } else {
    send({ type: 'reset' });
  }
});
if (location.hash === MACHINE) {
  // Opened at #machine (e.g. Licenses → Back to Linux): start from the start
  // view's entry so Back returns there, then boot.
  history.replaceState(null, '', location.pathname + location.search);
  boot();
} else if (params.has('autoboot')) boot();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') send({ type: 'save', reason: 'hidden' });
});
window.addEventListener('pagehide', () => send({ type: 'save', reason: 'pagehide' }));

// ------------------------------------------------------------ test hooks
if (TEST_HOOKS) {
  (window as unknown as { xiaonuxSave: () => void }).xiaonuxSave = () => send({ type: 'save', reason: 'manual' });
  (window as unknown as { xiaonuxJitExport: () => void }).xiaonuxJitExport = () => send({ type: 'jit-export' });
  const screenText = (tm: Terminal, n = 60): string => {
    const b = tm.buffer.active;
    const end = b.baseY + b.cursorY + 1;
    const lines: string[] = [];
    for (let i = Math.max(0, end - n); i < end; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };
  (window as unknown as { xiaonuxScreen: (n: number) => string }).xiaonuxScreen = (n = 60) => screenText(term, n);
  (window as unknown as { xiaonuxType: (s: string) => void }).xiaonuxType = type;
  // Terminal tabs. Tab 0 is the console.
  (window as unknown as { xiaonuxTabs: unknown }).xiaonuxTabs = {
    open: () => openShell(),
    list: () => tabIds(tabState),
    type: (id: number, s: string) => typeTo(id, s),
    screen: (id: number, n = 60) => screenText(xtermOf(id) ?? term, n),
    activate: (id: number) => activateTab(id),
  };

  // xv6 page runner (bench/xv6-browser.mjs). The worker exists only after
  // start() is called; the page itself never starts it.
  let xv6: Worker | null = null;
  let xv6Text = '';
  let xv6Ready: number | null = null;
  let xv6Mips = 0;
  let xv6Stopped: ((fs: Uint8Array) => void) | null = null;
  const xv6Utf8 = new TextDecoder();
  const b64Bytes = (b64: string): ArrayBuffer => {
    const s = atob(b64);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  };
  (window as unknown as { xiaonuxXv6: unknown }).xiaonuxXv6 = {
    start(kernelB64: string, fsB64: string, jit = true): void {
      if (xv6) throw new Error('xv6 already running');
      xv6Text = '';
      xv6Ready = null;
      xv6Mips = 0;
      const kernel = b64Bytes(kernelB64);
      const fs = b64Bytes(fsB64);
      const w = new Worker(new URL('./xv6.worker.ts', import.meta.url), { type: 'module' });
      xv6 = w;
      w.onmessage = (e: MessageEvent<FromXv6Worker>) => {
        const m = e.data;
        if (m.type === 'console') xv6Text += xv6Utf8.decode(m.data, { stream: true });
        else if (m.type === 'ready') xv6Ready = m.ms;
        else if (m.type === 'stats') xv6Mips = m.mips;
        else if (m.type === 'stopped') {
          if (xv6 === w) xv6 = null;
          xv6Stopped?.(new Uint8Array(m.fs));
          xv6Stopped = null;
        } else if (m.type === 'error') xv6Text += `\n[xv6 error] ${m.message}\n`;
      };
      w.onerror = (e) => { xv6Text += `\n[xv6 worker] ${e.message}\n`; };
      const base = new URL('.', new URL(BOOT_URL, location.href)).href;
      const msg: ToXv6Worker = { type: 'start', base, kernel, fs, jit };
      w.postMessage(msg, [kernel, fs]);
    },
    type(s: string): void {
      if (!xv6) throw new Error('xv6 not running');
      const msg: ToXv6Worker = { type: 'input', data: s };
      xv6.postMessage(msg);
    },
    screen(): string {
      return xv6Text;
    },
    ready(): number | null {
      return xv6Ready;
    },
    mips(): number {
      return xv6Mips;
    },
    stop(): Promise<Uint8Array> {
      const w = xv6;
      if (!w) return Promise.reject(new Error('xv6 not running'));
      return new Promise((resolve) => {
        xv6Stopped = resolve;
        const msg: ToXv6Worker = { type: 'stop' };
        w.postMessage(msg);
      });
    },
  };
}
