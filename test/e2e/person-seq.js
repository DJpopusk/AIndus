// Motion frames of one model: spawn several copies on different dances and take a series of shots.
// Shows skinning artefacts that a single still frame hides.
//   node test/e2e/person-seq.js modi1.glb modi2.glb
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 1400, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  p.on('console', (m) => { if (/ИИндус/.test(m.text())) console.log('  [overlay]', m.text()); });
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 1340, y: 30, w: 50, h: 700 },
    settings: { sound: false, dancers: 1, fx: 0.3, cows: false, gods: false } }, '*'));
  await p.waitForFunction(() => window.__iindu && window.__iindu.dancers > 0, null, { timeout: 90000 });
  const frames = +(process.env.FRAMES || 5);
  for (const file of process.argv.slice(2)) {
    // all dances, five models at a time
    const n = (await p.evaluate(() => window.__iindu.dances)).length;
    for (let first = 0; first < n; first += 5) {
      await p.evaluate((a) => window.__iindu.spawnPerson(a[0], 5, a[1]), [file, first]);
      for (let i = 0; i < frames; i++) {
        await p.waitForTimeout(700);
        await p.screenshot({ path: path.join(OUT, `pseq_${file.replace('.glb', '')}_${first}_${i}.png`) });
      }
    }
    console.log('  снято', file);
  }
  await ctx.close();
})();
