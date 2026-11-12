import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { FromWorker, NetConfig, ToWorker } from './protocol';

const params = new URLSearchParams(location.search);
const BOOT_URL = params.get('boot') ?? '/vm/boot.json';
const RAM_MB = Number(params.get('ram') ?? 0); // 0 = use the .cfg's memory_size
const CMDLINE = params.get('cmdline') ?? '';

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $('status');
const statsEl = $('stats');
const bootBtn = $('boot') as HTMLButtonElement;
const resetBtn = $('reset') as HTMLButtonElement;
const netSel = $('netmode') as HTMLSelectElement;
const netStatusEl = $('netstatus');

// ----- network settings (per browser) -----
interface NetPrefs { mode: 'off' | 'helper' | 'relay'; helperPort?: number; helperToken?: string }
const NET_KEY = 'xiaonux.net';
function loadNetPrefs(): NetPrefs {
  try { return JSON.parse(localStorage.getItem(NET_KEY) ?? '') as NetPrefs; } catch { return { mode: 'off' }; }
}
function saveNetPrefs(p: NetPrefs) {
  try { localStorage.setItem(NET_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}
let netPrefs = loadNetPrefs();
// The helper prints a pairing link: ?net=helper&port=8787&token=...
if (params.get('net') === 'helper' && params.get('token')) {
  netPrefs = { mode: 'helper', helperPort: Number(params.get('port') ?? 8787), helperToken: params.get('token')! };
  saveNetPrefs(netPrefs);
  history.replaceState(null, '', location.pathname + (params.has('autoboot') ? '?autoboot' : ''));
}
netSel.value = netPrefs.mode;

function netConfig(): NetConfig {
  if (netPrefs.mode === 'helper' && netPrefs.helperToken) {
    const base = `127.0.0.1:${netPrefs.helperPort ?? 8787}`;
    const t = encodeURIComponent(netPrefs.helperToken);
    return { mode: 'helper', wsUrl: `ws://${base}/wisp?token=${t}`, pingUrl: `http://${base}/ping?token=${t}` };
  }
  return { mode: 'off', wsUrl: '', pingUrl: '' };
}
function showNet(text: string, blocked = false) {
  netStatusEl.textContent = text;
  netStatusEl.classList.toggle('blocked', blocked);
}
showNet(netPrefs.mode === 'helper' && !netPrefs.helperToken ? 'run xiaonux-net and open its link' : '');
netSel.addEventListener('change', () => {
  netPrefs.mode = netSel.value as NetPrefs['mode'];
  saveNetPrefs(netPrefs);
  if (netPrefs.mode === 'helper' && !netPrefs.helperToken) showNet('run xiaonux-net and open its link');
  else showNet(netPrefs.mode === 'off' ? 'off' : '');
  send({ type: 'net', net: netConfig() });
});
const diskEl = $('disk');
let diskStats: Record<string, unknown> = {};

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 14,
  cursorBlink: true,
  convertEol: false,
  scrollback: 5000,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('term'));
fit.fit();

let worker: Worker | null = null;
const send = (m: ToWorker, transfer: Transferable[] = []) => worker?.postMessage(m, transfer);

// Boot timing: from click to the first shell prompt on the console.
let tBoot = 0;
let bytesFetched = 0;
let marks: Record<string, number> = {};
let tail = '';
const decoder = new TextDecoder();

function mark(name: string) {
  if (marks[name] !== undefined) return;
  marks[name] = Math.round(performance.now() - tBoot);
  render();
  console.info(`[xiaonux] ${name} at ${marks[name]} ms`);
  (window as unknown as { xiaonux: unknown }).xiaonux = { marks, bytesFetched };
}

function render() {
  const parts = Object.entries(marks).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}s`);
  statusEl.textContent = parts.join(' · ') || 'booting…';
}

function watchPrompts(bytes: Uint8Array) {
  tail = (tail + decoder.decode(bytes, { stream: true })).slice(-200);
  if (/login: ?$/.test(tail)) mark('login');
  if (/[#$] ?$/.test(tail) && (marks.login !== undefined || marks.restore !== undefined)) mark('prompt');
}

function boot(forceCold = false) {
  bootBtn.disabled = true;
  tBoot = performance.now();
  marks = {};
  bytesFetched = 0;
  render();
  worker = new Worker(new URL('./vm.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
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
        break;
      case 'stats':
        statsEl.textContent = `heap ${m.heapMb} MB · fetched ${(bytesFetched / 2 ** 20).toFixed(1)} MB`;
        (window as unknown as { xiaonux: unknown }).xiaonux = { marks, bytesFetched, heapMb: m.heapMb, outBytes: m.outBytes, disk: diskStats };
        break;
      case 'disk': {
        const d = m.stats;
        diskStats = d as unknown as Record<string, unknown>;
        const mb = (n: number) => (n / 2 ** 20).toFixed(1);
        diskEl.textContent = `disk ${mb(d.bytesNetwork)} MB net · ${mb(d.bytesCache)} MB cached · ${d.overlayClusters * 4} KB changed (${d.overlayBackend})`;
        break;
      }
      case 'restored':
        if (!m.agentOk) console.warn('[xiaonux] guest agent did not answer; clock/entropy not refreshed');
        break;
      case 'restart-cold':
        worker?.terminate();
        worker = null;
        boot(true);
        break;
      case 'net':
        showNet(m.status === 'connected' ? `connected (${m.mode === 'helper' ? 'this computer' : 'relay'})`
          : m.status === 'connecting' ? 'connecting…' : `disconnected${m.detail ? ` (${m.detail})` : ''}`);
        break;
      case 'net-blocked':
        showNet(`blocked: ${m.host} (${m.reason})`, true);
        console.info(`[xiaonux] blocked ${m.host}: ${m.reason}`);
        break;
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
        statusEl.textContent = `error: ${m.message}`;
        term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`);
        break;
    }
  };
  send({ type: 'start', bootUrl: new URL(BOOT_URL, location.href).href, ramMb: RAM_MB, cmdline: CMDLINE, forceCold: forceCold || params.has('cold'), record: params.has('record'), net: netConfig() });
  term.focus();
}

const encoder = new TextEncoder();
term.onData((s) => {
  const data = encoder.encode(s);
  send({ type: 'input', data }, [data.buffer]);
});
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
window.addEventListener('resize', () => fit.fit());
bootBtn.addEventListener('click', () => boot());
resetBtn.addEventListener('click', () => {
  if (!confirm('Delete all your files and changes in this machine?')) return;
  resetBtn.disabled = true;
  if (!worker) {
    // Not booted: a worker that only opens the disk and clears the overlay.
    worker = new Worker(new URL('./vm.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type === 'reset-done') location.reload();
    };
    send({ type: 'start', bootUrl: new URL(BOOT_URL, location.href).href, ramMb: RAM_MB, cmdline: CMDLINE, resetOnly: true });
  } else {
    send({ type: 'reset' });
  }
});
if (params.has('autoboot')) boot();

// Save the running machine when the tab is hidden or closed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') send({ type: 'save', reason: 'hidden' });
});
window.addEventListener('pagehide', () => send({ type: 'save', reason: 'pagehide' }));
(window as unknown as { xiaonuxSave: () => void }).xiaonuxSave = () => send({ type: 'save', reason: 'manual' });

// For automation: read the terminal text and type into the guest.
(window as unknown as { xiaonuxScreen: (n: number) => string }).xiaonuxScreen = (n = 60) => {
  const b = term.buffer.active;
  const end = b.baseY + b.cursorY + 1;
  const lines: string[] = [];
  for (let i = Math.max(0, end - n); i < end; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
};
// For automation: type a line into the guest.
(window as unknown as { xiaonuxType: (s: string) => void }).xiaonuxType = (s: string) => {
  const data = encoder.encode(s);
  send({ type: 'input', data }, [data.buffer]);
};
