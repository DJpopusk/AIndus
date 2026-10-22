// Model quality: each model in rest pose with the same light and camera, a face close-up and the full figure.
//   node test/e2e/qa-portraits.js [files...]   -> test/e2e/out/qa/p_<model>.png
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const OUT = path.join(__dirname, 'out', 'qa'); fs.mkdirSync(OUT, { recursive: true });
const ALL = JSON.parse(fs.readFileSync(path.join(EXT, 'assets/models/people/people.json'))).filter((p) => ['m', 'f', 'animal'].includes(p.kind)).map((p) => p.file);
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 600, height: 600 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 590, y: 0, w: 5, h: 5 },
    settings: { sound: false, dancers: 5, fx: 0, cows: false, gods: false, animals: false, backdrop: false, fall: 'none', graphics: 'high' } }, '*'));
  await p.waitForFunction(() => window.__iindu && window.__iindu.dancers > 0, null, { timeout: 180000 });
  await p.addStyleTag({ content: '#caption,#meter,#hud,#frame,#fire,#fall{display:none!important}' });
  for (const file of FILES) {
    const box = await p.evaluate((f) => window.__iindu.showModel(f, 0), file);
    const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max, h = y1 - y0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const animal = !/^(m|f)$/.test(await p.evaluate((f) => (window.__iindu.kindOf ? window.__iindu.kindOf(f) : ''), file));
    const views = animal ? [['full', [cx, y0 + h * 0.6, z1 + Math.max(h, x1 - x0) * 1.5], [cx, y0 + h * 0.45, cz]]]
      : [['face', [cx, y0 + h * 0.91, cz + h * 0.2], [cx, y0 + h * 0.9, cz]], ['full', [cx, y0 + h * 0.55, cz + h * 1.3], [cx, y0 + h * 0.5, cz]]];
    for (const [v, pos, target] of views) {
      await p.evaluate((c) => window.__iindu.freeze(1, c), { pos, target });
      await p.waitForTimeout(500);
      await p.screenshot({ path: path.join(OUT, `p_${file.replace('.glb', '')}_${v}.png`) });
    }
  }
  console.log('  снято', FILES.length);
  await ctx.close();
})();
