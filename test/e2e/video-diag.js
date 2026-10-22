// Test feed diagnostics: do the videos play and does the model classify. Catches the decoder failure
// (PIPELINE_ERROR_DECODE) that makes the whole e2e fail silently.
//   node test/e2e/video-diag.js [cpu|auto] [warm]
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const HERE = __dirname, EXT = path.resolve(HERE, '../../extension');
const COMPUTE = process.argv[2] || 'cpu', WARM = process.argv[3] === 'warm';
(async () => {
  for (const d of ['ScriptCache', 'Database']) fs.rmSync(path.join(HERE, '.profile', 'Default', 'Service Worker', d), { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(path.join(HERE, '.profile'), { channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--mute-audio', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  await ctx.route('https://www.instagram.com/**', async (route) => {
    const m = new URL(route.request().url()).pathname.match(/\/test\/(\w+)\.webm$/);
    if (m) return route.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(path.join(HERE, 'media', m[1] + '.webm')) });
    return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(HERE, 'reels.html')) });
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  await pop.evaluate((c) => chrome.storage.sync.set({ compute: c, enabled: true, effects: true, threshold: 0.6, autoScroll: false }), COMPUTE);
  if (WARM) {
    await pop.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'WARMUP' }).catch(() => {}));
    for (let i = 0; i < 100; i++) { const st = await pop.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'STATUS' })); if (st.state === 'ready') break; await pop.waitForTimeout(1000); }
    console.log('  прогрето');
  }
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/ИИндус/.test(m.text())) console.log('  [page]', m.text().slice(0, 140)); });
  await page.goto('https://www.instagram.com/reels/test/'); await page.bringToFront();
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    const v = await page.evaluate(() => { const x = document.querySelector('video'); return { rs: x.readyState, t: x.currentTime.toFixed(1), err: x.error && x.error.message }; });
    const st = await pop.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'STATUS' }));
    console.log(`  ${2 * i + 2}s видео`, JSON.stringify(v), '| модель', st.state, st.device, st.runs, (st.lastMs || 0) + 'ms', st.fallback || '');
  }
  await ctx.close();
})();
