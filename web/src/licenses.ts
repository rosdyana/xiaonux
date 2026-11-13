// Licenses page: renders dist/vm/licenses.json (tools/licenses/gen.py).
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import './style.css';

interface Bundled { file: string; package: string; version: string; license: string; text?: string | null }
interface Item {
  name: string; version?: string | null; license: string; url?: string | null; text?: string | null;
  source?: string; offer?: string; copyright?: string; bundled?: Bundled[];
}
interface Group { id: string; title: string; note?: string; items: Item[]; common?: Record<string, string> }
interface Data { groups: Group[]; texts: Record<string, string> }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  e.append(...kids);
  return e;
};
const link = (href: string, label: string) => el('a', { href, rel: 'noopener' }, label);

function licenseText(texts: Data['texts'], key: string | null | undefined, label = 'License text') {
  if (!key || !texts[key]) return null;
  const d = el('details', { className: 'lic' }, el('summary', {}, label));
  d.addEventListener('toggle', () => {
    if (d.open && !d.querySelector('pre')) d.append(el('pre', {}, texts[key]));
  });
  return d;
}

function itemRow(it: Item, texts: Data['texts']) {
  const name = el('th', { scope: 'row' }, it.url ? link(it.url, it.name) : it.name);
  const extra = el('td', { className: 'extra' });
  if (it.source) extra.append(link(it.source, 'Source'));
  if (it.copyright) extra.append(el('code', {}, it.copyright));
  if (it.offer) extra.append(el('p', { className: 'offer' }, it.offer));
  for (const b of it.bundled ?? []) {
    const p = el('p', { className: 'bundled' }, 'Bundles ', el('code', {}, b.file), ` from Debian ${b.package} ${b.version}: ${b.license}`);
    extra.append(p);
    const t = licenseText(texts, b.text, `${b.package} copyright`);
    if (t) extra.append(t);
  }
  const t = licenseText(texts, it.text);
  if (t) extra.append(t);
  return el('tr', {}, name, el('td', { className: 'ver' }, it.version ?? ''), el('td', {}, it.license), extra);
}

function renderGroup(g: Group, texts: Data['texts']) {
  const sec = el('section', { id: g.id, className: 'lic-group' });
  sec.append(el('h2', {}, g.title, el('span', { className: 'count' }, ` ${g.items.length}`)));
  if (g.note) sec.append(el('p', { className: 'note' }, g.note));
  const tbody = el('tbody');
  const rows = g.items.map((it) => itemRow(it, texts));
  tbody.append(...rows);
  if (g.items.length > 20) {
    const input = el('input', { type: 'search', placeholder: `Filter ${g.items.length} entries`, className: 'filter' });
    input.setAttribute('aria-label', `Filter ${g.title}`);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      g.items.forEach((it, i) => { rows[i].hidden = !!q && !`${it.name} ${it.license}`.toLowerCase().includes(q); });
    });
    sec.append(input);
  }
  const head = el('tr', {}, ...['Component', 'Version', 'License', ''].map((h) => el('th', { scope: 'col' }, h)));
  sec.append(el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, head), tbody)));
  if (g.common && Object.keys(g.common).length) {
    sec.append(el('h3', {}, 'Common license texts'));
    for (const [name, key] of Object.entries(g.common)) {
      const t = licenseText(texts, key, name);
      if (t) sec.append(t);
    }
  }
  return sec;
}

async function main() {
  const box = document.getElementById('groups')!;
  try {
    const data = (await (await fetch('/vm/licenses.json')).json()) as Data;
    box.replaceChildren(...data.groups.map((g) => renderGroup(g, data.texts)));
    document.getElementById('toc')!.append(...data.groups.map((g) => link(`#${g.id}`, g.title)));
  } catch {
    box.replaceChildren(el('p', {}, 'The license list isn\'t on this server. Run ', el('code', {}, 'make licenses'), ' and reload.'));
  }
}
main();
