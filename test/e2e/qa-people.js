// Human model check: each model in three different dances at two moments, for skinning artefacts, scale and transparency.
//   node test/e2e/qa-people.js [files...]   -> test/e2e/out/qa/<model>.png (all people from people.json by default)
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const OUT = path.join(__dirname, 'out', 'qa'); fs.mkdirSync(OUT, { recursive: true });
const ALL = JSON.parse(fs.readFileSync(path.join(EXT, 'assets/models/people/people.json'))).filter((p) => p.kind === 'm' || p.kind === 'f').map((p) => p.file);
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 1200, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  p.on('console', (m) => { if (/модель |не вышло|ошибк/i.test(m.text())) console.log('  ', m.text()); });
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 1190, y: 0, w: 5, h: 5 },
    settings: { sound: false, dancers: 5, fx: 0, cows: false, gods: false, graphics: 'high', fall: 'none' } }, '*'));
  await p.waitForFunction(() => window.__iindu && window.__iindu.dancers > 0, null, { timeout: 180000 });
  await p.addStyleTag({ content: '#caption,#meter,#hud,#frame,#fire{display:none!important}' });
  for (const file of FILES) {
    const shots = [];
    for (const first of [2, 8]) {
      await p.evaluate((a) => window.__iindu.spawnPerson(a[0], 3, a[1]), [file, first]);
      await p.waitForTimeout(900);
      const f = path.join(OUT, `_${file}_${first}.png`); await p.screenshot({ path: f }); shots.push(f);
    }
    console.log('  ✓', file);
  }
  await ctx.close();
})();
