// Screenshot of the popup (with fine-tuning expanded) and of the credits page: node test/e2e/popup-shot.js
const { chromium } = require('playwright'); const path = require('path');
const EXT = path.resolve(__dirname, '../../extension'), OUT = path.join(__dirname, 'out');
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), { channel: 'chromium', headless: true, viewport: { width: 332, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host, p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.click('#learn summary'); await p.waitForTimeout(800);
  await p.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
  await p.setViewportSize({ width: 1000, height: 900 });
  await p.goto(`chrome-extension://${id}/credits.html`); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'credits.png') });
  await ctx.close();
})();
