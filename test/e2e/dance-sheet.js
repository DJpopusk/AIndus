// Every dance on one model, full body, a few frames each: the visual check for picking dances.
//   node test/e2e/dance-sheet.js tshirt.glb [dance names...]   -> test/e2e/out/dsheet/<model>/<nnn>_<dance>_<k>.png
// Without names it renders the whole library. Combine the frames into a contact sheet afterwards.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
(async () => {
  const [file, ...pick] = process.argv.slice(2);
  const out = path.join(__dirname, 'out', 'dsheet', file.replace('.glb', ''));
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 900, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 860, y: 30, w: 30, h: 700 },
    settings: { sound: false, dancers: 1, fx: 0.05, cows: false, gods: false, backdrop: false, animals: false, traffic: false, fall: 'none' } }, '*'));
  await p.waitForFunction(() => window.__iindu && window.__iindu.dancers > 0, null, { timeout: 120000 });
  await p.evaluate(() => window.__iindu.cam([0, 1.0, 4.4], [0, 0.95, 0]));
  const all = await p.evaluate(() => window.__iindu.dances);
  const names = pick.length ? pick : all;
  for (const [k, n] of names.entries()) {
    const i = all.indexOf(n); if (i < 0) { console.log('  нет танца', n); continue; }
    await p.evaluate((a) => window.__iindu.spawnPerson(a[0], 1, a[1]), [file, i]);
    for (let f = 0; f < 4; f++) {
      await p.waitForTimeout(800);
      await p.screenshot({ path: path.join(out, `${String(k).padStart(3, '0')}_${n}_${f}.png`), clip: { x: 230, y: 40, width: 440, height: 740 } });
    }
  }
  console.log('снято', names.length, 'танцев ->', out);
  await ctx.close();
})();
