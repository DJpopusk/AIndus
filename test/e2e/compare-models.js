// Compare models before and after compression: same pose, light and camera, full and close-up shots,
// then PSNR/SSIM with scripts/image-diff.py.   node test/e2e/compare-models.js <folder A> <folder B> [files...]
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const OUT = path.join(__dirname, 'out', 'compare'); fs.mkdirSync(OUT, { recursive: true });
const [A, B, ...FILES] = process.argv.slice(2);
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 900, height: 900 }, deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 2000, y: 0, w: 5, h: 5 },
    settings: { sound: false, dancers: 1, fx: 0, cows: false, gods: false, graphics: 'high' } }, '*'));
  await p.waitForFunction(() => window.__iindu && window.__iindu.dancers > 0, null, { timeout: 120000 });
  await p.addStyleTag({ content: '#rain,#conf,#caption,#title,#flash,#fx,#frame,#hud{display:none!important}' });
  for (const file of FILES) {
    let views = null, xform = null;                 // camera and placement are shared by both versions and taken from the original
    for (const [tag, dir] of [['a', A], ['b', B]]) {
      await p.evaluate((d) => window.__iindu.setPeopleDir(d), dir);
      let box = await p.evaluate((f) => window.__iindu.showModel(f, 0.3), file);
      // the compressed mesh measures slightly differently (quantisation moves the bounds by fractions of a millimetre), and
      // the model would come out a fraction of a percent larger. That is a framing shift, not a quality loss, so it is placed
      // exactly like the original.
      if (!xform) xform = await p.evaluate((f) => window.__iindu.sceneXform(f), file);
      else if (process.env.RAW !== '1') { await p.evaluate((a) => window.__iindu.setSceneXform(a[0], a[1]), [file, xform]); box = await p.evaluate((f) => window.__iindu.showModel(f, 0.3), file); }
      if (!box) { console.log('  нет модели', file); continue; }
      const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, h = y1 - y0;
      views = views || { full: { pos: [cx, y0 + h * 0.55, cz + h * 1.45], target: [cx, y0 + h * 0.5, cz] },
        close: { pos: [cx, y0 + h * 0.9, cz + h * 0.32], target: [cx, y0 + h * 0.88, cz] } };
      for (const [v, cam] of Object.entries(views)) {
        await p.evaluate((c) => window.__iindu.freeze(1, c), cam);
        await p.waitForTimeout(700);
        await p.screenshot({ path: path.join(OUT, `${file.replace('.glb', '')}_${v}_${tag}.png`) });
      }
    }
    console.log('  снято', file);
  }
  await ctx.close();
})();
