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
const BOOT_URL = params.get('boot') ?? '/vm/boot.json';
const RAM_MB = Number(params.get('ram') ?? 0); // 0 = use the .cfg's memory_size
const CMDLINE = params.get('cmdline') ?? '';

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
    background: '#fdfeff', foreground: '#1b2430', cursor: '#1d4f91', cursorAccent: '#fdfeff',
    selectionBackground: '#c9dbf3',
    black: '#1b2430', red: '#b42a25', green: '#1d7438', yellow: '#855f00', blue: '#1d4f91', magenta: '#8a3ea8', cyan: '#0e6b76', white: '#5f6b79',
    brightBlack: '#5f6b79', brightRed: '#c8302b', brightGreen: '#23843f', brightYellow: '#946b00', brightBlue: '#2a62ad', brightMagenta: '#9a48bb', brightCyan: '#137a86', brightWhite: '#2b3542',
  },
  dark: {
    background: '#0c131c', foreground: '#dbe3ec', cursor: '#7fb0f0', cursorAccent: '#0c131c',
    selectionBackground: '#24426b',
    black: '#0c131c', red: '#ff7a6e', green: '#6fcf8a', yellow: '#e7c160', blue: '#7fb0f0', magenta: '#d39cf0', cyan: '#5fd0dc', white: '#b9c4d1',
    brightBlack: '#6c7a8b', brightRed: '#ff9b91', brightGreen: '#8fe0a6', brightYellow: '#f2d27f', brightBlue: '#a2c7f6', brightMagenta: '#e2b8f6', brightCyan: '#86e0e8', brightWhite: '#f1f5f9',
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
if (params.get('net') === 'relay' || params.get('net') === 'off') netPrefs = { ...netPrefs, mode: params.get('net') as NetPrefs['mode'] };

const RELAY_URL = (params.get('relay') ?? import.meta.env.VITE_RELAY_URL ?? '').replace(/\/$/, '');
const TURNSTILE_SITEKEY: string = params.get('turnstile') === '0' ? '' : (import.meta.env.VITE_TURNSTILE_SITEKEY ?? '');
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

function mark(name: string) {
  if (marks[name] !== undefined) return;
  marks[name] = Math.round(performance.now() - tBoot);
  if (name === 'prompt') {
    const s = (marks.prompt / 1000).toFixed(2);
    setStatus(() => {
      statusEl.innerHTML = t('status.ready', { s }); // our own markup
      statusEl.title = t('status.readyTitle');
    });
    statusEl.dataset.state = 'ready';
    store.set(LAST_KEY, String(marks.prompt));
  } else if (name === 'restore' || name === 'vm') {
    setStatus(name === 'restore' ? 'status.restoring' : 'status.booting');
  }
  console.info(`[xiaonux] ${name} at ${marks[name]} ms`);
  (window as unknown as { xiaonux: unknown }).xiaonux = { marks, bytesFetched };
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
  setStatus('status.starting');
  statusEl.dataset.state = '';
  worker = new Worker(new URL('./vm.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onWorker(e.data);
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
      statsEl.textContent = `${m.mips} MIPS`;
      statsEl.title = t('stats.title', { heap: m.heapMb, mb: (bytesFetched / 2 ** 20).toFixed(1) });
      (window as unknown as { xiaonux: unknown }).xiaonux = { marks, bytesFetched, mips: m.mips, heapMb: m.heapMb, outBytes: m.outBytes, disk: diskStats, jit: m.jit };
      break;
    case 'disk':
      diskStats = m.stats as unknown as Record<string, unknown>;
      break;
    case 'restored':
      if (!m.agentOk) console.warn('[xiaonux] guest agent did not answer; clock/entropy not refreshed');
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
      (window as unknown as { xiaonuxJitBundle: unknown }).xiaonuxJitBundle = { build: m.build, b64: btoa(bin) };
      break;
    }
    case 'saved':
      console.info(`[xiaonux] saved machine (${m.reason}) ${(m.bytes / 2 ** 20).toFixed(1)} MB in ${m.ms} ms`);
      break;
    case 'reset-done':
      console.info('[xiaonux] machine reset: your changes were deleted');
      location.reload();
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
  store.set(LESSONS_DONE_KEY, '{}'); // the files the checks refer to are gone
  resetBtn.disabled = true;
  setStatus('status.resetting');
  if (!worker) {
    worker = new Worker(new URL('./vm.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => { if (e.data.type === 'reset-done') location.reload(); };
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
