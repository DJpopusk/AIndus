const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 420, y: 30, w: 160, h: 640 }, settings: { sound: false, dancers: 0, fx: 0.5, cows: false } }, '*'));
  await p.waitForFunction(() => window.__iindu, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  for (const file of process.argv.slice(2)) {
    await p.evaluate(() => window.__iindu.spawnCostume('civil', 0));
    await p.evaluate((f) => window.__iindu.spawnCows(2, f), file);
    for (let i = 0; i < 4; i++) { await p.waitForTimeout(450); await p.screenshot({ path: path.join(__dirname, 'out', `seq_${file}_${i}.png`) }); }
    console.log('  снято', file);
  }
  await ctx.close();
})();
