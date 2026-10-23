// Full scene as in real use: dancers, cows and gods around the reel, a series of frames.
//   node test/e2e/scene-shot.js [runs=3] [frames=3]
// Window 1440x800 with a 400 px reel in the middle, like Instagram on a laptop; W=1920 H=1080 for a large
// monitor; BG=0 without the backdrop photo.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const RUNS = +(process.argv[2] || 3), FRAMES = +(process.argv[3] || 3);
const W = +(process.env.W || 1440), H = +(process.env.H || 800), RW = Math.round(H * 0.5);   // a 9:16 reel almost full height
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: W, height: H },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  p.on('console', (m) => { if (/не удалось|ошибка|Error/i.test(m.text())) console.log('  [overlay]', m.text()); });
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  for (let r = 0; r < RUNS; r++) {
    await p.evaluate((a) => window.postMessage({ type: 'IINDU_START', id: a.id, score: 0.9, rect: { x: (a.W - a.RW) / 2, y: 20, w: a.RW, h: a.H - 40 },
      settings: { sound: false, dancers: a.n, fx: 0.4, cows: true, gods: true, animals: true, backdrop: a.bg, graphics: a.gfx } }, '*'), { id: r + 1, W, H, RW, gfx: process.env.GFX || 'high', bg: process.env.BG !== '0', n: +(process.env.N || 6) });
    await p.waitForFunction(() => window.__iindu && window.__iindu.dancers > 0 && window.__iindu.cows > 0, null, { timeout: 120000 });
    await p.waitForTimeout(+(process.env.WAIT || 4000));
    const info = await p.evaluate(() => ({ scene: window.__iindu.scene, stage: window.__iindu.stage }));
    for (let i = 0; i < FRAMES; i++) {
      await p.waitForTimeout(700);
      await p.screenshot({ path: path.join(OUT, `scene_${W}_${r}_${i}.png`) });
    }
    console.log(`  прогон ${r}:`, JSON.stringify(info));
  }
  await ctx.close();
})();
