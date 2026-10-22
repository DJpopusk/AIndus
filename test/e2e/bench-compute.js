// Model speed benchmark: CPU (WASM, with as many threads as allowed) and GPU (WebGPU).
//   node test/e2e/bench-compute.js [cpu gpu]      HEADLESS=0 runs in a window (on macOS that gives the real GPU)
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : ['cpu', 'gpu', 'auto'];
const NAMES = ['bhangra', 'cat', 'bollywood', 'family'];
const IMGS = NAMES.map((n) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'media', n + '.jpg')).toString('base64'));
(async () => {
  const headless = process.env.HEADLESS !== '0';
  // the profile caches the background service worker script; without clearing it an old background.js would run
  for (const d of ['ScriptCache', 'Database']) fs.rmSync(path.join(__dirname, '.profile', 'Default', 'Service Worker', d), { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile'), {
    channel: 'chromium', headless, viewport: { width: 900, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU',
      ...(process.env.SWIFTSHADER ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  console.log('изоляция страницы попапа:', await p.evaluate(() => self.crossOriginIsolated), '| ядер:', await p.evaluate(() => navigator.hardwareConcurrency),
    '| WebGPU в попапе:', await p.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter())));
  const bg = (msg) => p.evaluate((m) => chrome.runtime.sendMessage({ target: 'background', ...m }), msg);
  if (MODES[0] === 'upgrade') {
    // as after an update: the GPU weights are not cached, so the model must answer at once (CPU) and switch to the GPU by itself
    const gone = await p.evaluate(async () => { const c = await caches.open('transformers-cache');
      const keys = (await c.keys()).filter((r) => /vision_model_fp16\.onnx$/.test(r.url)); for (const k of keys) await c.delete(k); return keys.length; });
    console.log('убрал из кэша файлов fp16:', gone);
    await p.evaluate(() => chrome.storage.sync.set({ compute: 'auto', hiPrecision: false }));
    const t0 = Date.now();
    const r = await bg({ type: 'CLASSIFY', dataUrl: IMGS[0], threshold: 0.6 });
    console.log(`первый ответ через ${((Date.now() - t0) / 1000).toFixed(1)} с: ${r.device}, ${r.dtype}, бхангра ${Math.round(r.score * 100)}%`);
    for (let i = 0; i < 300; i++) {
      const st = await bg({ type: 'STATUS' });
      if (i % 10 === 0 || !st.upgrade) console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} с: ${st.device}/${st.dtype}${st.upgrade ? ', качаю для видеокарты ' + st.upgrade.pct + '%' : ''}${st.fallback ? ' | ' + st.fallback : ''}`);
      if (!st.upgrade) break;
      await bg({ type: 'CLASSIFY', dataUrl: IMGS[i % 4], threshold: 0.6 });   // frames keep coming during the download
      await p.waitForTimeout(1000);
    }
    const r2 = await bg({ type: 'CLASSIFY', dataUrl: IMGS[0], threshold: 0.6 });
    console.log(`после перехода: ${r2.device}, ${r2.dtype}, ${r2.ms} мс, бхангра ${Math.round(r2.score * 100)}%`);
    await ctx.close(); return;
  }
  for (const mode of MODES) {
    await p.evaluate((c) => chrome.storage.sync.set({ compute: c, hiPrecision: false }), mode);
    const t0 = Date.now();
    await bg({ type: 'WARMUP' });
    let st;
    for (let i = 0; i < 600; i++) { st = await bg({ type: 'STATUS' }); if (st && (st.state === 'ready' || st.state === 'error')) break; await p.waitForTimeout(1000); }
    const load = ((Date.now() - t0) / 1000).toFixed(1);
    if (st.state !== 'ready') { console.log(mode, 'ошибка:', st.error); continue; }
    const ms = [];
    const scores = {};
    for (let i = 0; i < 16; i++) {
      const r = await bg({ type: 'CLASSIFY', dataUrl: IMGS[i % IMGS.length], threshold: 0.6 }); if (r && r.ms) ms.push(r.ms);
      if (i >= 4 && r) scores[NAMES[i % NAMES.length]] = Math.round(r.score * 100) + '%';
    }
    console.log('  оценки кадров:', JSON.stringify(scores));
    st = await bg({ type: 'STATUS' });
    const warm = ms.slice(4).sort((a, b) => a - b);
    console.log(`${mode}: ${st.device}, ${st.dtype}, потоков ${st.threads}${st.gpu ? ', ' + st.gpu : ''}${st.fallback ? ' | ' + st.fallback : ''} | загрузка ${load} с | ` +
      `кадр (с кропами, проходов ${st.passes}): медиана ${warm[warm.length >> 1]} мс, первые ${ms.slice(0, 3).join('/')} мс`);
  }
  await ctx.close();
})();
