// Screenshots of the page for design review: start view (light/dark, desktop
// and phone) and the licenses page. Usage: node ui-shots.mjs [outdir]
import { chromium } from 'playwright-core';
const out = process.argv[2] ?? '../.impeccable/review';
const url = process.env.URL ?? 'http://localhost:5180/';
const browser = await chromium.launch({ channel: 'chrome' });
for (const [name, opts] of [
  ['desktop', { viewport: { width: 1440, height: 900 }, colorScheme: 'light' }],
  ['desktop-dark', { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }],
  ['mobile', { viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ['mobile-dark', { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(url);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  if (name === 'desktop' || name === 'mobile') {
    // the same view with guide progress saved, as a returning visitor sees it
    await page.evaluate(() => localStorage.setItem('xiaonux.lessons.done', JSON.stringify({ 'unix-basics': [0, 1, 2, 3], triage: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })));
    await page.reload();
    await page.screenshot({ path: `${out}/${name}-progress.png`, fullPage: true });
    await page.evaluate(() => localStorage.removeItem('xiaonux.lessons.done'));
  }
  if (name === 'desktop') {
    await page.goto(new URL('licenses.html', url).href);
    await page.waitForSelector('.lic-group');
    await page.screenshot({ path: `${out}/licenses.png` });
  }
  await ctx.close();
}
await browser.close();
