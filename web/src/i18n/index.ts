// Page language: English by default, chosen from the visitor's saved choice,
// ?lang=, or the browser's languages. Static text in the HTML is marked with
// data-i18n (text), data-i18n-html (our own markup) and data-i18n-<attr>
// (title, aria-label, placeholder); code calls t() and onLocaleChange().
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import en, { type Key, type Locale } from './en';
import zhTW from './zh-TW';
import id from './id';
import vi from './vi';
import ptBR from './pt-BR';

export type { Key } from './en';

export const LOCALES = [
  { code: 'en', name: 'English', short: 'EN', data: en },
  { code: 'zh-TW', name: '繁體中文', short: '繁中', data: zhTW },
  { code: 'id', name: 'Bahasa Indonesia', short: 'ID', data: id },
  { code: 'vi', name: 'Tiếng Việt', short: 'VI', data: vi },
  { code: 'pt-BR', name: 'Português (Brasil)', short: 'PT', data: ptBR },
] as const satisfies readonly { code: string; name: string; short: string; data: Locale }[];
export type LocaleCode = typeof LOCALES[number]['code'];

const KEY = 'xiaonux.lang';
const ATTRS = ['title', 'aria-label', 'placeholder'] as const;

function match(tag: string): LocaleCode | null {
  const t = tag.toLowerCase();
  if (t === 'zh-tw' || t === 'zh-hk' || t === 'zh-mo' || t.startsWith('zh-hant')) return 'zh-TW';
  if (t === 'id' || t.startsWith('id-') || t === 'in') return 'id';
  if (t === 'vi' || t.startsWith('vi-')) return 'vi';
  if (t === 'pt' || t.startsWith('pt-')) return 'pt-BR';
  if (t === 'en' || t.startsWith('en-')) return 'en';
  return null;
}

function initial(): LocaleCode {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl && match(fromUrl)) return match(fromUrl)!;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LOCALES.some((l) => l.code === saved)) return saved as LocaleCode;
  } catch { /* private mode */ }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const m = match(tag);
    if (m) return m;
  }
  return 'en';
}

let current: LocaleCode = initial();
const listeners: (() => void)[] = [];

const data = (code = current): Locale => LOCALES.find((l) => l.code === code)!.data;

export const locale = () => current;

/** The string for `key` in the current language (English if missing), with {name} filled from `vars`. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const s = data().strings[key] || en.strings[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Localized title, intro and step text of a lesson, falling back to its English JSON. */
export function lessonText<L extends { id: string; title: string; intro: string; steps: { text: string }[] }>(lesson: L) {
  const tr = data().lessons?.[lesson.id];
  return {
    title: tr?.title || lesson.title,
    intro: tr?.intro || lesson.intro,
    step: (i: number) => tr?.steps?.[i] || lesson.steps[i].text,
  };
}

/** Fill every marked element under `root` in the current language. */
export function applyDom(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as Key);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml as Key); // our own strings
  for (const a of ATTRS) {
    for (const el of root.querySelectorAll<HTMLElement>(`[data-i18n-${a}]`)) el.setAttribute(a, t(el.getAttribute(`data-i18n-${a}`) as Key));
  }
  document.documentElement.lang = current;
}

export function onLocaleChange(fn: () => void) { listeners.push(fn); }

export function setLocale(code: LocaleCode) {
  if (code === current) return;
  current = code;
  try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
  for (const s of document.querySelectorAll<HTMLSelectElement>('select[data-lang-picker]')) s.value = code;
  applyDom();
  for (const fn of listeners) fn();
}

/** Fill every <select data-lang-picker> (data-short="1" shows short labels) and wire it up. */
export function mountPickers() {
  for (const s of document.querySelectorAll<HTMLSelectElement>('select[data-lang-picker]')) {
    s.replaceChildren(...LOCALES.map((l) => {
      const o = new Option(s.dataset.short ? l.short : l.name, l.code);
      o.lang = l.code;
      if (s.dataset.short) o.title = l.name;
      return o;
    }));
    s.value = current;
    s.addEventListener('change', () => setLocale(s.value as LocaleCode));
  }
}
