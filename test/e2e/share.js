// Shared dataset end to end: consent -> labels from the popup -> queue -> server -> Undo -> Delete my data.
//   cd server && npx wrangler d1 execute iindu-dataset --local --file=schema.sql && npx wrangler dev --local --port 8787
//   node test/e2e/share.js
// The extension is copied to a temp folder with SHARE_URL pointing at the local server (heavy assets and vendor are symlinked).
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const SRC = path.resolve(HERE, '../../extension');
const SERVER = process.env.SHARE_URL || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
setTimeout(() => fail('тест висит больше 20 минут'), 20 * 60 * 1000).unref();

(async () => {
  const stats = () => fetch(SERVER + '/v1/stats').then((r) => r.json()).catch(() => null);
  if (!(await stats())) fail(`сервер ${SERVER} не отвечает — запусти wrangler dev (см. шапку файла)`);

  const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'iindu-share-'));
  for (const f of fs.readdirSync(SRC)) {
    const from = path.join(SRC, f), to = path.join(EXT, f);
    if (['assets', 'vendor'].includes(f)) fs.symlinkSync(from, to);
    else fs.cpSync(from, to, { recursive: true });
  }
  const bgPath = path.join(EXT, 'background.js');
  const bgSrc = fs.readFileSync(bgPath, 'utf8');
  if (!bgSrc.includes("const SHARE_URL = '';")) fail('в background.js не найден SHARE_URL');
  fs.writeFileSync(bgPath, bgSrc.replace("const SHARE_URL = '';", `const SHARE_URL = '${SERVER}';`));

  const ctx = await chromium.launchPersistentContext(path.join(HERE, '.profile-share'), {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--mute-audio', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  await ctx.route('https://www.instagram.com/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/test/')) return route.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(path.join(HERE, 'media', path.basename(u.pathname))) });
    return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(HERE, 'reels.html')) });
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  // reels page first: in headless Chromium a video started after the model loads may never play
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/ИИндус|rror/.test(m.text())) console.log('  [page]', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('https://www.instagram.com/reels/test/');
  for (let i = 0; i < 30 && !(await page.evaluate(() => document.querySelector('video').readyState >= 2)); i++) await sleep(500);
  const popup = await ctx.newPage();
  popup.on('pageerror', (e) => console.log('  [popup error]', e.message));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const bg = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage({ target: 'background', ...m }), msg);

  // 1) without consent nothing is sent, the sharing block is visible and the checkbox is off
  await popup.evaluate(() => chrome.storage.sync.set({ compute: 'cpu', autoLike: false }));
  let st = await bg({ type: 'SHARE_STATUS' });
  console.log('  до согласия:', JSON.stringify(st));
  if (!st.configured || st.on) fail('общий датасет должен быть настроен и выключен по умолчанию');
  await popup.locator('#learn summary').click();                  // the block sits inside the fine-tuning section
  await popup.waitForSelector('#share:not([hidden])', { timeout: 5000 }).catch(() => fail('блок «Делиться разметкой» не показан'));

  // model and a frame
  await bg({ type: 'WARMUP' });
  for (const t0 = Date.now(); ; await sleep(1500)) {
    const s = await bg({ type: 'STATUS' });
    process.stdout.write(`\r  модель: ${s.state}   (${Math.round((Date.now() - t0) / 1000)} с)   `);
    if (s.state === 'ready') break;
    if (s.state === 'error') fail(s.error);
  }
  console.log();
  await page.bringToFront();
  await sleep(9000);
  console.log('  видео:', await page.evaluate(() => [...document.querySelectorAll('video')].slice(0, 2).map((v) => `${v.src.split('/').pop()} rs=${v.readyState} paused=${v.paused} t=${v.currentTime.toFixed(1)}`).join(' | ')));

  const before = (await stats()).n;
  for (let i = 0; i < 40; i++) {                                // wait until the model has analysed at least one frame
    const r = await bg({ type: 'LABEL', indian: true });
    if (r && !r.error) break;
    if (i === 39) fail('ИИндус так и не посмотрел кадр: ' + r?.error);
    await sleep(1500);
  }
  await sleep(1500);
  if ((await stats()).n !== before) fail('метка ушла на сервер без согласия');
  console.log('  без согласия: на сервер ничего не ушло ✓');

  // 2) consent through the popup: checkbox -> consent dialog -> agree
  await popup.bringToFront();
  await popup.locator('#shareDataset').click();
  if (await popup.locator('#shConsent').isHidden()) fail('окно согласия не показалось');
  if (await popup.locator('#shareDataset').isChecked()) fail('галочка включилась до согласия');
  await popup.locator('#shConsent').scrollIntoViewIfNeeded();
  await popup.locator('#share').screenshot({ path: path.join(HERE, 'out', 'share-consent.png') });
  await popup.locator('#shAgree').click();
  await sleep(500);
  st = await bg({ type: 'SHARE_STATUS' });
  if (!st.on) fail('после «Согласен» обмен не включился');
  console.log('  согласие дано ✓');

  await page.bringToFront(); await sleep(3000);
  for (const indian of [true, false]) {
    const r = await bg({ type: 'LABEL', indian });
    if (!r || r.error) fail('LABEL: ' + (r?.error || 'нет ответа'));
  }
  for (let i = 0; i < 20 && (st = await bg({ type: 'SHARE_STATUS' })).sent < 2; i++) await sleep(500);
  console.log('  после двух меток:', JSON.stringify(st));
  if (st.sent !== 2 || st.queued) fail('две метки не дошли до сервера');
  if ((await stats()).n !== before + 2) fail('на сервере не две новые метки');

  // 3) Undo the last label: it disappears on the server too
  await bg({ type: 'FORGET' });
  await sleep(800);
  if ((await stats()).n !== before + 1) fail('«Отменить» не удалил метку на сервере');
  console.log('  «Отменить» удалил метку на сервере ✓');

  // 4) consent withdrawn: labels are not sent
  await popup.locator('#shareDataset').click();
  await sleep(300);
  await bg({ type: 'LABEL', indian: true });
  await sleep(1500);
  if ((await stats()).n !== before + 1) fail('после отзыва согласия метка всё равно ушла');
  console.log('  после отзыва согласия ничего не уходит ✓');

  // 5) Delete my data
  const del = await bg({ type: 'SHARE_DELETE' });
  console.log('  удаление:', JSON.stringify(del));
  if (del.deleted !== 1 || (await stats()).n !== before) fail('«Удалить мои данные» стёр не всё');
  console.log('  «Удалить мои данные» стёр всё ✓');

  await popup.screenshot({ path: path.join(HERE, 'out', 'share-popup.png'), fullPage: true });
  await ctx.close();
  fs.rmSync(EXT, { recursive: true, force: true });
  console.log('\nOK: общий датасет работает');
})().catch((e) => fail(e.stack || e));
