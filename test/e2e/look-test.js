// Accessory fitting: each model in each accessory, close up, from the front and at three quarters.
//   node test/e2e/look-test.js [files...]      -> test/e2e/out/look_<model>_<view>.png
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const PEOPLE = JSON.parse(fs.readFileSync(path.join(EXT, 'assets/models/people/people.json')))
  .filter((p) => (p.kind === 'm' || p.kind === 'f') && !p.featured && p.file !== 'police.glb').map((p) => p.file);
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : PEOPLE;
const SETS = [['тюрбан', 'фуражка', 'венок', 'очки'], ['дхол', 'лента', 'гирлянда', 'тюрбан']];
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 1200, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  p.on('console', (m) => { if (/реквизит|не удалось/.test(m.text())) console.log('  [overlay]', m.text()); });
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 1190, y: 0, w: 5, h: 5 },
    settings: { sound: false, dancers: 1, fx: 0, cows: false, gods: false, graphics: 'high' } }, '*'));
  await p.waitForFunction(() => window.__iindu && window.__iindu.dancers > 0, null, { timeout: 120000 });
  await p.addStyleTag({ content: '#rain,#conf,#caption,#title,#flash,#fx,#frame{display:none!important}' });
  // DANCE=1: dance frames (t = 1.1 and 2.3 s) instead of the rest pose, when shoulders and neck have already moved
  const T = process.env.DANCE ? [1.1, 2.3] : [0.3];
  for (const file of FILES) {
    for (const [k, set] of SETS.entries()) for (const [view, yaw] of [['front', 0], ['side', 0.9]]) for (const t of T) {
      await p.evaluate((a) => window.__iindu.lookTest(a[0], a[1], a[3], a[2]), [file, set, yaw, t]);
      await p.waitForTimeout(500);
      await p.screenshot({ path: path.join(OUT, `look_${file.replace('.glb', '')}_${k}_${view}${T.length > 1 ? '_' + t : ''}.png`) });
    }
    console.log('  примерено', file);
  }
  await ctx.close();
})();
