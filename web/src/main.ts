// xiaonux page: start view, workspace (terminal + worksheet drawer), network,
// file transfer. The machine itself runs in vm.worker.ts.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { FromWorker, NetConfig, ToWorker } from './protocol';
import { initGuides, LESSONS, LESSONS_DONE_KEY, lessonProgress } from './ui/guides';
import { renderHelperFiles } from './ui/helper';
import { applyDom, mountPickers, onLocaleChange, t, type Key } from './i18n';
import { initConsent } from './consent';

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
const term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 14,
  lineHeight: 1.15,
  cursorBlink: true,
  convertEol: false,
  scrollback: 5000,
  theme: THEMES[dark.matches ? 'dark' : 'light'],
});
dark.addEventListener('change', () => { term.options.theme = THEMES[dark.matches ? 'dark' : 'light']; });
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('term'));
// The drawer animates its width; refit the terminal once when it settles,
// not on every frame of the transition.
let drawerMoving = false;
const refit = () => { if (!workspace.hidden && !drawerMoving) fit.fit(); };
new ResizeObserver(refit).observe($('term-wrap'));
drawer.addEventListener('transitionrun', (e) => { if (e.propertyName === 'width') drawerMoving = true; });
for (const ev of ['transitionend', 'transitioncancel'] as const) {
  drawer.addEventListener(ev, (e) => { if (e.propertyName === 'width') { drawerMoving = false; refit(); } });
}

let worker: Worker | null = null;
const send = (m: ToWorker, transfer: Transferable[] = []) => worker?.postMessage(m, transfer);
const encoder = new TextEncoder();
const type = (s: string) => {
  const data = encoder.encode(s);
  send({ type: 'input', data }, [data.buffer]);
};

// -------------------------------------------------------------------- guides
const guides = initGuides((s) => { type(s); term.focus(); });

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

function turnstileToken(): Promise<string> {
  if (!TURNSTILE_SITEKEY) return Promise.resolve(''); // local dev relay (DEV_NO_TURNSTILE)
  return new Promise((resolve, reject) => {
    const render = () => {
      const box = document.createElement('div');
      box.className = 'turnstile';
      document.body.appendChild(box);
      const ts = (window as unknown as { turnstile: { render: (el: HTMLElement, o: object) => void } }).turnstile;
      ts.render(box, {
        sitekey: TURNSTILE_SITEKEY,
        callback: (t: string) => { box.remove(); resolve(t); },
        'error-callback': () => { box.remove(); reject(new Error('challenge failed')); },
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
    term.focus();
    return;
  }
  setDrawer(true);
  drawer.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
});
// Escape inside the overlay drawer (narrow screens) closes it and returns to the terminal.
drawer.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || wide.matches || !drawer.classList.contains('open')) return;
  setDrawer(false);
  term.focus();
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

const PROMPT = /(?:[#$]|>>>) ?$/;
function watchPrompts(bytes: Uint8Array) {
  tail = (tail + decoder.decode(bytes, { stream: true })).slice(-200);
  if (/login: ?$/.test(tail)) mark('login');
  if (/[#$] ?$/.test(tail) && (marks.login !== undefined || marks.restore !== undefined)) mark('prompt');
  if (PROMPT.test(tail)) guides.onPrompt();
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
  requestAnimationFrame(() => { fit.fit(); term.focus(); });
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
  if (netPrefs.mode === 'relay' && RELAY_URL) await ensureRelaySession();
  bootBtn.disabled = true;
  tBoot = performance.now();
  marks = {};
  bytesFetched = 0;
  notSaved = null;
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
term.onData((s) => {
  if (ctrl && s.length === 1) {
    const c = s.toLowerCase().charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) s = String.fromCharCode(c - 0x60);
    setCtrl(false);
  }
  if (s.includes('\r')) guides.onEnter();
  type(s);
});
const KEYS: Record<string, string> = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', pipe: '|', tilde: '~' };
keysEl.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the terminal's keyboard up
keysEl.addEventListener('click', (e) => {
  const k = (e.target as HTMLElement).closest('button')?.dataset.key;
  if (!k) return;
  if (k === 'ctrl') setCtrl(!ctrl);
  else type(KEYS[k]);
  term.focus();
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
  term.focus();
});

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
  if (resetDlg.returnValue !== 'reset') { term.focus(); return; }
  resetBtn.disabled = true;
  setStatus('status.resetting');
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
  (window as unknown as { xiaonuxScreen: (n: number) => string }).xiaonuxScreen = (n = 60) => {
    const b = term.buffer.active;
    const end = b.baseY + b.cursorY + 1;
    const lines: string[] = [];
    for (let i = Math.max(0, end - n); i < end; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };
  (window as unknown as { xiaonuxType: (s: string) => void }).xiaonuxType = type;
}
