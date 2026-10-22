// The web show: force the spidey theme and take frames over one loop (12 s).
//   node test/e2e/spidey-show.js      -> test/e2e/out/spidey_<time>.png
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  p.on('console', (m) => { if (/ошибк|не удалось|Error/i.test(m.text())) console.log('  [overlay]', m.text()); });
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.waitForFunction(() => window.__iindu, null, { timeout: 60000 });
  await p.evaluate(() => window.__iindu.forceTheme('spidey'));
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 520, y: 20, w: 400, h: 760 },
    settings: { sound: false, dancers: 5, fx: 0.4, cows: true, gods: false, graphics: 'high' } }, '*'));
  await p.waitForFunction(() => window.__iindu.show && window.__iindu.dancers > 0, null, { timeout: 180000 });
  console.log('  шоу:', JSON.stringify(await p.evaluate(() => ({ show: window.__iindu.show, who: window.__iindu.who }))));
  // specific moments of the loop: aiming, strand in flight, splats, the triple shot, dripping, the caption
  for (const tc of (process.env.T ? process.env.T.split(',').map(Number) : [0.7, 0.9, 1.3, 3.95, 4.25, 5.3, 5.6, 6.4, 7.2, 8.5, 10])) {
    const r = await p.evaluate((t) => window.__iindu.showSim(t), tc);
    await p.waitForTimeout(900);                    // the caption pops up in 0.5 s, longer with software rendering
    await p.screenshot({ path: path.join(OUT, `spidey_${tc.toFixed(2).padStart(5, '0')}.png`) });
    console.log('  ', tc, JSON.stringify(r));
  }
  console.log('  кадров снято, шоу:', JSON.stringify(await p.evaluate(() => window.__iindu.show)));
  await ctx.close();
})();
