// The xiaonux-net download list in the Network tab: one row per platform,
// this computer's first, each with its size and SHA-256.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0

const PLATFORMS = [
  { label: 'Windows', detail: 'installer (.msi)', match: /windows-x86_64\.msi$/ },
  { label: 'macOS', detail: 'Apple silicon and Intel (.zip)', match: /macos-universal\.zip$/ },
  { label: 'Linux', detail: 'x86_64 (.tar.gz)', match: /linux-x86_64\.tar\.gz$/ },
  { label: 'Linux', detail: 'ARM64 (.tar.gz)', match: /linux-aarch64\.tar\.gz$/ },
];

function thisPlatform(): number {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 0;
  if (/Mac OS X|Macintosh/.test(ua)) return 1;
  if (/Linux/.test(ua)) return /aarch64|arm64/i.test(ua) ? 3 : 2;
  return -1;
}

export async function renderHelperFiles(list: HTMLElement) {
  try {
    const [latest, sums] = await Promise.all([
      fetch('/vm/helper/latest.json', { cache: 'no-cache' }).then((r) => r.json() as Promise<{ files: Record<string, number> }>),
      fetch('/vm/helper/SHA256SUMS', { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : '')),
    ]);
    const sha = new Map(sums.split('\n').map((l) => l.trim().split(/\s+\*?/)).filter((p) => p.length === 2).map(([h, f]) => [f, h]));
    const names = Object.keys(latest.files);
    const mine = thisPlatform();
    const order = mine < 0 ? PLATFORMS : [PLATFORMS[mine], ...PLATFORMS.filter((_, i) => i !== mine)];
    list.replaceChildren(...order.flatMap((p) => {
      const f = names.find((n) => p.match.test(n));
      if (!f) return [];
      const li = document.createElement('li');
      if (p === PLATFORMS[mine]) li.className = 'mine';
      const a = document.createElement('a');
      a.href = `/vm/helper/${f}`;
      a.download = f;
      a.innerHTML = `<b></b> <span></span>`;
      a.querySelector('b')!.textContent = p.label;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = `${(latest.files[f] / 2 ** 20).toFixed(1)} MB`;
      a.querySelector('span')!.append(`${p.detail} · `, size);
      li.append(a);
      if (p === PLATFORMS[mine]) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'For this computer';
        li.append(tag);
      }
      const h = sha.get(f);
      if (h) {
        const code = document.createElement('code');
        code.className = 'sha';
        code.title = `SHA-256 of ${f}`;
        code.textContent = h;
        li.append(code);
      }
      return [li];
    }));
  } catch {
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = 'Downloads aren\'t available on this server. Build them with <code>helper/release.sh</code>.';
    list.replaceChildren(li);
  }
}
