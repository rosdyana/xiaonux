// Opt-in analytics. Google Tag Manager is not loaded, and nothing is sent to
// Google, until the visitor presses Allow. The choice is kept in localStorage;
// "No thanks" (or no answer) loads nothing. Any element marked
// [data-analytics-settings] reopens the choice.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import { onLocaleChange, t } from './i18n';

const GTM_ID = 'GTM-53HXLK2N';
const KEY = 'xiaonux.analytics';
const PRIVACY_URL = 'https://github.com/rosdyana/xiaonux/blob/main/PRIVACY.md';

type Choice = 'granted' | 'denied';

declare global {
  interface Window { dataLayer?: unknown[] }
}

function read(): Choice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch { return null; } // private mode: ask again next time
}

function save(c: Choice) {
  try { localStorage.setItem(KEY, c); } catch { /* private mode */ }
}

let loaded = false;
function loadAnalytics() {
  if (loaded) return;
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  // eslint-disable-next-line prefer-rest-params
  function gtag(..._args: unknown[]) { window.dataLayer!.push(arguments); }
  gtag('js', new Date());
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`;
  document.head.append(s);
}

/** Remove the Google Analytics cookies (_ga, _ga_*, _gid) on every domain they may sit on. */
function clearCookies() {
  const host = location.hostname;
  const parts = host.split('.');
  const domains = ['', host, `.${host}`, parts.length > 2 ? `.${parts.slice(-2).join('.')}` : ''];
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (!/^_g(a|id)/.test(name)) continue;
    for (const d of new Set(domains)) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d ? `; domain=${d}` : ''}`;
    }
  }
}

let banner: HTMLElement | null = null;

function render(el: HTMLElement) {
  el.setAttribute('aria-label', t('consent.label'));
  el.querySelector('.consent-text')!.textContent = t('consent.text');
  const more = el.querySelector<HTMLAnchorElement>('.consent-more')!;
  more.textContent = t('consent.more');
  el.querySelector('[data-choice="denied"]')!.textContent = t('consent.deny');
  el.querySelector('[data-choice="granted"]')!.textContent = t('consent.allow');
}

function choose(c: Choice) {
  const before = read();
  save(c);
  hide();
  if (c === 'granted') loadAnalytics();
  else if (before === 'granted' || loaded) {
    // Turning analytics off after it ran: drop its cookies and reload so the tag is gone.
    clearCookies();
    location.reload();
  }
}

function show() {
  if (!banner) {
    banner = document.createElement('section');
    banner.className = 'consent';
    banner.innerHTML =
      '<p class="consent-text"></p>' +
      `<div class="consent-actions"><a class="consent-more" href="${PRIVACY_URL}" target="_blank" rel="noopener"></a>` +
      '<span class="consent-spacer"></span>' +
      '<button type="button" class="btn btn-quiet btn-small" data-choice="denied"></button>' +
      '<button type="button" class="btn btn-quiet btn-small" data-choice="granted"></button></div>';
    for (const b of banner.querySelectorAll<HTMLButtonElement>('[data-choice]')) {
      b.addEventListener('click', () => choose(b.dataset.choice as Choice));
    }
    render(banner);
    onLocaleChange(() => banner && render(banner));
    document.body.append(banner);
  }
  banner.hidden = false;
}

function hide() { if (banner) banner.hidden = true; }

/** Load analytics if allowed before, otherwise ask (the banner is hidden while the machine is open). */
export function initConsent() {
  const c = read();
  if (c === 'granted') loadAnalytics();
  else if (c === null) show();
  else clearCookies(); // GA can rewrite its session cookie just before an opt-out reload

  for (const el of document.querySelectorAll<HTMLElement>('[data-analytics-settings]')) {
    el.addEventListener('click', (e) => { e.preventDefault(); show(); banner?.querySelector<HTMLButtonElement>('[data-choice="granted"]')?.focus(); });
  }
}
