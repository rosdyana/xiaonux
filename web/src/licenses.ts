// Licenses page: renders dist/vm/licenses.json (tools/licenses/gen.py).
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import './style.css';
import { applyDom, locale, mountPickers, onLocaleChange, t } from './i18n';

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

function licenseText(texts: Data['texts'], key: string | null | undefined, label = t('lic.text')) {
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
  if (it.source) extra.append(link(it.source, t('lic.source')));
  if (it.copyright) extra.append(el('code', {}, it.copyright));
  if (it.offer) extra.append(el('p', { className: 'offer' }, it.offer));
  for (const b of it.bundled ?? []) {
    const [before, after = ''] = t('lic.bundles', { package: b.package, version: b.version, license: b.license }).split('{file}');
    const p = el('p', { className: 'bundled' }, before, el('code', {}, b.file), after);
    extra.append(p);
    const lt = licenseText(texts, b.text, t('lic.copyright', { package: b.package }));
    if (lt) extra.append(lt);
  }
  const lt = licenseText(texts, it.text);
  if (lt) extra.append(lt);
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
    const input = el('input', { type: 'search', placeholder: t('lic.filter', { n: g.items.length }), className: 'filter' });
    input.setAttribute('aria-label', t('lic.filterLabel', { title: g.title }));
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      g.items.forEach((it, i) => { rows[i].hidden = !!q && !`${it.name} ${it.license}`.toLowerCase().includes(q); });
    });
    sec.append(input);
  }
  const head = el('tr', {}, ...[t('lic.colComponent'), t('lic.colVersion'), t('lic.colLicense'), ''].map((h) => el('th', { scope: 'col' }, h)));
  sec.append(el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, head), tbody)));
  sec.append(el('a', { className: 'to-top', href: '#top' }, t('lic.top')));
  if (g.common && Object.keys(g.common).length) {
    sec.append(el('h3', {}, t('lic.common')));
    for (const [name, key] of Object.entries(g.common)) {
      const lt = licenseText(texts, key, name);
      if (lt) sec.append(lt);
    }
  }
  return sec;
}

let data: Data | null = null;
function render() {
  document.title = t('lic.title');
  document.getElementById('lic-note')!.hidden = locale() === 'en';
  const box = document.getElementById('groups')!;
  if (!data) {
    const p = el('p');
    p.innerHTML = t('lic.missing'); // our own markup
    box.replaceChildren(p);
    return;
  }
  box.replaceChildren(...data.groups.map((g) => renderGroup(g, data!.texts)));
  document.getElementById('toc')!.replaceChildren(...data.groups.map((g) => link(`#${g.id}`, g.title)));
}

async function main() {
  applyDom();
  mountPickers();
  document.title = t('lic.title');
  document.getElementById('lic-note')!.hidden = locale() === 'en';
  onLocaleChange(render);
  try {
    data = (await (await fetch('/vm/licenses.json')).json()) as Data;
  } catch { /* shown by render() */ }
  render();
}
main();
