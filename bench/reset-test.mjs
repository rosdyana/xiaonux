// Click "Reset machine" in a persistent profile (accepting the confirm dialog).
import { chromium } from 'playwright-core';
const ctx = await chromium.launchPersistentContext(process.argv[2], { channel: 'chrome', headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('dialog', (d) => d.accept());
page.on('console', (m) => m.text().startsWith('[xiaonux]') && console.log(m.text()));
await page.goto('http://localhost:5180/');
await page.click('#reset');
await page.waitForEvent('framenavigated', { timeout: 20000 });
await ctx.close();
console.log('reset done');
