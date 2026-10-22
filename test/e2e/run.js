// E2E run in Chromium through Playwright (branded Chrome 137+ ignores --load-extension).
// Run: npm test (first npm install && npx playwright install chromium && test/e2e/make-videos.sh)
// The page https://www.instagram.com/reels/test/ is replaced by the local reels.html (route),
// so the content script fires through manifest.matches.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const MEDIA = path.join(HERE, 'media');
const EXT = path.resolve(HERE, '../../extension');
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
const HEADLESS = process.env.HEADLESS !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// watchdog: the whole run must take less than 30 minutes, otherwise the test is considered stuck
setTimeout(() => { console.error('FAIL: тест висит больше 30 минут, прерываю'); process.exit(2); }, 30 * 60 * 1000).unref();

(async () => {
  const userDataDir = path.join(HERE, '.profile');
  // The profile is kept between runs because it holds the downloaded model weights (Service Worker/CacheStorage, ~150 MB).
  // Chrome caches the background service worker script separately and may serve a stale one, so that cache is deleted.
  // Otherwise the test runs an old background.js (this happened: new messages came back as unknown).
  for (const dir of ['ScriptCache', 'Database']) {
    fs.rmSync(path.join(userDataDir, 'Default', 'Service Worker', dir), { recursive: true, force: true });
  }
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.CHANNEL || 'chromium',
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--mute-audio', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  // replace instagram.com
  await ctx.route('https://www.instagram.com/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/test/')) {
      const f = path.join(MEDIA, path.basename(u.pathname));
      return route.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(f) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(HERE, 'reels.html')) });
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  // the profile persists between runs (it holds the model weights cache) and Chrome can serve an old
  // service worker. The extension is reloaded so the test surely runs fresh code.
  const extId = new URL(sw.url()).host;
  console.log('extension id', extId);

  // warm up the model through the popup page
  const popup = await ctx.newPage();
  popup.on('console', (m) => console.log('  [popup]', m.text()));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  // The model runs on the CPU. In headless Chromium any graphics use from the model worker (a WebGPU adapter,
  // even a probe WebGL context) before the video starts breaks the page's decoder: PIPELINE_ERROR_DECODE, reels do not
  // play. A normal window does not have this problem. test/e2e/bench-compute.js measures the GPU path on a real GPU.
  await popup.evaluate(() => chrome.storage.sync.set({ compute: 'cpu' }));
  await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'WARMUP' }).catch(() => {}));
  const t0 = Date.now();
  for (;;) {
    const st = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'STATUS' }).catch((e) => ({ error: String(e) })));
    const files = Object.entries(st?.progress || {});
    const pct = files.length ? Math.round(files.reduce((a, [, p]) => a + p, 0) / files.length) : 0;
    process.stdout.write(`\r  model: ${st?.state} ${pct}% ${st?.error || ''}   (${Math.round((Date.now() - t0) / 1000)}s)   `);
    if (st?.state === 'ready') break;
    if (st?.state === 'error') { console.log('\nMODEL ERROR', st.error); await ctx.close(); process.exit(1); }
    if (Date.now() - t0 > 15 * 60 * 1000) { console.log('\nTIMEOUT loading model'); await ctx.close(); process.exit(1); }
    await sleep(1500);
  }
  console.log('\n  model ready in', Math.round((Date.now() - t0) / 1000), 's');
  // the profile persists between runs, so settings are pinned to keep the test deterministic
  await popup.evaluate((fall) => chrome.storage.sync.set({ threshold: 0.6, interval: 500, autoScroll: false, effects: true, autoLike: true, enabled: true, fall }), process.env.FALL || 'theme');
  const modelText = await popup.locator('#modelText').textContent();
  console.log('  popup says:', modelText);

  // reels page
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); logs.push(t); if (t.includes('ИИндус') && m.type() !== 'debug') console.log('  [page]', t); });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('https://www.instagram.com/reels/test/');
  await page.bringToFront();

  const overlayFrame = () => page.frames().find((f) => f.url().startsWith('chrome-extension://'));
  const state = async () => {
    const f = overlayFrame();
    const ov = f ? await f.evaluate(() => window.__iindu ? ({ running: window.__iindu.running, dancers: window.__iindu.dancers, audioPaused: window.__iindu.audio.paused, src: window.__iindu.audio.currentSrc.split('/').pop(), caption: document.getElementById('caption').className }) : 'no __iindu').catch((e) => 'err ' + e.message) : 'no overlay frame';
    const likes = await page.evaluate(() => window.__likes);
    return { overlay: ov, likes };
  };

  const results = {};
  async function expectReel(name, expectIndian, waitMs = 9000) {
    console.log(`\n== reel: ${name} (ожидаем ${expectIndian ? 'ИНДУС' : 'не индус'})`);
    await sleep(waitMs);
    const s = await state();
    console.log('  state:', JSON.stringify(s));
    results[name] = s;
    await page.screenshot({ path: path.join(HERE, 'out', `shot_${name}.png`) });
  }

  await expectReel('bhangra', true, 12000);
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: innerHeight, behavior: 'instant' }));
  await expectReel('cat', false);
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: innerHeight * 2, behavior: 'instant' }));
  await expectReel('bollywood', true);
  // real time: a reel with cat -> bhangra -> cat; watch the effects timeline
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: innerHeight * 3, behavior: 'instant' }));
  await sleep(600);
  // play() may never resolve (background tab, machine asleep); the test once hung for a day. A timeout guards it.
  const playState = await page.evaluate(async () => { const v = document.querySelector('[data-reel=mixed] video'); v.currentTime = 0;
    const r = await Promise.race([v.play().then(() => 'ok', (e) => 'play failed: ' + e.message), new Promise((ok) => setTimeout(() => ok('play timeout'), 5000))]);
    return `${r}, rs=${v.readyState}`; });
  console.log('  [mixed video]', playState);
  console.log('\n== reel: mixed (кот 0-4с → болливуд 4-10с → кот 10-16с)');
  const timeline = [];
  for (let i = 0; i < 17; i++) {
    await sleep(1000);
    const f = overlayFrame();
    const t = await page.evaluate(() => document.querySelector('[data-reel=mixed] video').currentTime.toFixed(1));
    const on = f ? await f.evaluate(() => window.__iindu?.running).catch(() => null) : null;
    const pct = f ? await f.evaluate(() => document.getElementById('mPct').textContent).catch(() => '?') : '?';
    timeline.push(`${t}s:${on ? 'ON' : 'off'}(${pct})`);
  }
  console.log('  timeline:', timeline.join(' '));
  results.mixed = { timeline, likes: await page.evaluate(() => window.__likes) };
  await page.screenshot({ path: path.join(HERE, 'out', 'shot_mixed.png') });

  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: innerHeight * 4, behavior: 'instant' }));
  await expectReel('family', false);
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: innerHeight * 5, behavior: 'instant' }));
  await expectReel('georgian', false);
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: innerHeight * 6, behavior: 'instant' }));
  await expectReel('arab', false);
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: innerHeight * 7, behavior: 'instant' }));
  await expectReel('portrait', false);

  // auto-scroll: turn it on through storage, go back to the start and see which reels were visited
  console.log('\n== автопролистывание (скип не-индуса 6 с, индус 6 с)');
  await popup.evaluate(() => chrome.storage.sync.set({ autoScroll: true, skipAfter: 6, dwell: 6 }));
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: 0, behavior: 'instant' }));
  const visited = [];
  for (let i = 0; i < 70; i++) {
    await sleep(1000);
    const cur = await page.evaluate(() => { const f = document.getElementById('feed'); return document.querySelectorAll('.reel')[Math.round(f.scrollTop / innerHeight)]?.dataset.reel; });
    if (visited[visited.length - 1] !== cur) visited.push(cur);
  }
  console.log('  посетили:', visited.join(' → '));
  results.autoscroll = visited;
  await popup.evaluate(() => chrome.storage.sync.set({ autoScroll: false }));

  // Indian reels in a row: the celebration has to move to the new reel instead of stacking
  console.log('\n== два индийских рилса подряд (проверка наложения празднований)');
  await popup.evaluate(() => chrome.storage.sync.set({ autoScroll: false }));
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(6000);
  const fr1 = overlayFrame();
  const st1 = fr1 ? await fr1.evaluate(() => ({ id: window.__iindu.celebration, theme: window.__iindu.theme, rect: Math.round(window.__iindu.rect?.x || 0), song: document.getElementById('song').textContent })) : null;
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: innerHeight * 2, behavior: 'instant' })); // straight to bollywood
  await sleep(7000);
  const st2 = fr1 ? await fr1.evaluate(() => ({ id: window.__iindu.celebration, theme: window.__iindu.theme, rect: Math.round(window.__iindu.rect?.x || 0), running: window.__iindu.running, dancers: window.__iindu.dancers })) : null;
  console.log('  1-й рилс:', JSON.stringify(st1), '\n  2-й рилс:', JSON.stringify(st2));
  results.chain = { st1, st2 };
  await page.screenshot({ path: path.join(HERE, 'out', 'shot_chain.png') });

  // visual check of the celebration themes
  console.log('\n== темы празднования');
  const fr = overlayFrame();
  for (const th of ['holi', 'diwali', 'wedding', 'bhangra', 'cricket', 'street']) {
    const got = fr ? await fr.evaluate((t) => window.__iindu.setTheme(t), th) : null;
    await sleep(1400);
    await page.screenshot({ path: path.join(HERE, 'out', `theme_${th}.png`) });
    console.log(`  ${th} → ${got}`);
  }

  // ---------- fine-tuning: labels from the popup, training, effect on the verdict ----------
  console.log('\n== дообучение');
  await popup.bringToFront();
  await popup.reload();
  await popup.click('#learn summary');
  await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'FORGET', all: true }));  // the test must be repeatable
  await popup.reload(); await popup.click('#learn summary');
  const labelOn = async (reelIndex, indian, times) => {
    await page.bringToFront();
    await page.evaluate((i) => document.getElementById('feed').scrollTo({ top: innerHeight * i, behavior: 'instant' }), reelIndex);
    await sleep(2500);                                   // let the model analyse a frame of this reel
    await popup.bringToFront();
    for (let k = 0; k < times; k++) {
      await popup.click(indian ? '#lnYes' : '#lnNo');
      await popup.waitForFunction(() => !/запоминаю/.test(document.getElementById('lnResult').textContent), null, { timeout: 15000 }).catch(() => {});
      await sleep(400);
    }
    return (await popup.locator('#lnResult').textContent()).trim();
  };
  console.log('  ', await labelOn(0, true, 3));          // bhangra
  console.log('  ', await labelOn(2, true, 2));          // bollywood
  console.log('  ', await labelOn(1, false, 3));         // cat
  console.log('  ', await labelOn(5, false, 2));         // Georgian dance
  console.log('   примеров:', await popup.locator('#lnCount').textContent(), '| превью:', await popup.locator('#lnShots img').count());
  await popup.click('#lnTrain');
  await popup.waitForFunction(() => !/учусь/.test(document.getElementById('lnResult').textContent), null, { timeout: 60000 });
  console.log('   обучение:', (await popup.locator('#lnResult').textContent()).trim(), '|', (await popup.locator('#lnModel').textContent()).trim());
  // dataset: labelled frames must land in IndexedDB together with their JPEGs
  const ds = await popup.evaluate(() => new Promise((ok) => { const r = indexedDB.open('iindu-dataset', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('frames', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => { const q = r.result.transaction('frames').objectStore('frames').getAll(); q.onsuccess = () => ok(q.result.map((x) => ({ y: x.y, kb: Math.round((x.jpeg?.size || 0) / 1024), w: x.w, h: x.h, site: x.site }))); }; }));
  console.log('   датасет:', ds.length, 'кадров, пример', JSON.stringify(ds[ds.length - 1] || null));
  results.dataset = ds.length;
  // the personal head must show up in the live verdict on the page (CLASSIFY_ACTIVE does not work here:
  // capturing the tab needs activeTab, which only a click on the extension icon grants)
  await page.bringToFront();
  await page.evaluate(() => document.getElementById('feed').scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(4000);
  const fr2 = overlayFrame();
  const parts = fr2 ? await fr2.evaluate(() => window.__iindu.lastParts) : null;
  console.log('   части вердикта:', JSON.stringify(parts));
  results.learning = { parts };

  console.log('\nlikes:', await page.evaluate(() => window.__likes));
  console.log('like svg labels:', await page.evaluate(() => [...document.querySelectorAll('.like svg')].map((s) => s.getAttribute('aria-label'))));
  const errors = logs.filter((l) => /error|ошибка/i.test(l));
  console.log('page errors/ошибки:', errors.length ? errors : 'none');
  fs.writeFileSync(path.join(HERE, 'out', 'results.json'), JSON.stringify({ results, logs }, null, 2));
  await ctx.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
