// Live run on the real Instagram Reels feed (or YouTube Shorts).
// Opens a Chrome for Testing window with the extension and a persistent profile in test/e2e/.profile-real.
// Log in to Instagram once in that window; the session stays local (the folder is in .gitignore).
// The model log goes to the terminal and to test/e2e/out/real.log, screenshots to out/real_*.png.
//
//   node test/e2e/real.js                 # Instagram Reels
//   node test/e2e/real.js youtube         # YouTube Shorts
//   AUTO=12 node test/e2e/real.js         # scroll on by itself every 12 s
//   node test/e2e/real.js --stop-after=300  # close after 300 s
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const EXT = path.resolve(HERE, '../../extension');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const site = args.includes('youtube') ? 'https://www.youtube.com/shorts/' : 'https://www.instagram.com/reels/';
const stopAfter = +(args.find((a) => a.startsWith('--stop-after='))?.split('=')[1] || 0);
const auto = +(process.env.AUTO || 0);

// Chrome for Testing has H.264 (which Instagram serves) and accepts --load-extension.
// Install: npx @puppeteer/browsers install chrome@stable --path ./.cache/browsers
const cftDir = path.resolve(HERE, '../../.cache/browsers/chrome');
const exe = fs.existsSync(cftDir)
  ? fs.readdirSync(cftDir).map((d) => path.join(cftDir, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync)
  : null;
if (!exe) { console.error('Нет Chrome for Testing. Поставь: npx @puppeteer/browsers install chrome@stable --path ./.cache/browsers'); process.exit(1); }

const log = fs.createWriteStream(path.join(OUT, 'real.log'), { flags: 'a' });
const say = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(line); log.write(line + '\n'); };

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(HERE, '.profile-real'), {
    executablePath: exe,
    headless: false,
    viewport: null,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required'],
    ignoreDefaultArgs: ['--mute-audio'],
  });
  say('=== старт', site);
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => { const t = m.text(); if (t.includes('ИИндус')) say(`[${m.type()}]`, t); });
  page.on('pageerror', (e) => say('[pageerror]', e.message));
  await page.goto(site, { waitUntil: 'domcontentloaded' }).catch((e) => say('goto:', e.message));

  let shots = 0;
  const shot = async (tag) => {
    const f = path.join(OUT, `real_${String(++shots).padStart(2, '0')}_${tag}.png`);
    await page.screenshot({ path: f }).catch(() => {});
  };
  // screenshot at the moment the effects turned on
  await ctx.exposeBinding('__iinduShot', async (_src, tag) => shot(tag)).catch(() => {});

  const t0 = Date.now();
  let lastStatus = '', lastLine = '', lastAuto = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    if (ctx.pages().length === 0) break;
    const status = await page.evaluate(() => {
      const login = !!document.querySelector('input[name="username"], input[name="password"]');
      const videos = [...document.querySelectorAll('video')].filter((v) => v.getBoundingClientRect().height > 150).length;
      const fr = [...document.querySelectorAll('iframe')].find((f) => f.src.startsWith('chrome-extension://'));
      return `${login ? 'СТРАНИЦА ЛОГИНА — залогинься в этом окне' : 'лента'} | видео на экране: ${videos} | оверлей: ${fr ? 'есть' : 'нет'} | ${location.pathname}`;
    }).catch(() => 'страница перезагружается');
    if (status !== lastStatus) { say('status:', status); lastStatus = status; }
    const fr = page.frames().find((f) => f.url().startsWith('chrome-extension://'));
    if (fr) {
      const st = await fr.evaluate(() => window.__iindu && ({ on: window.__iindu.running, pct: document.getElementById('mPct').textContent, song: document.getElementById('song').textContent })).catch(() => null);
      if (st) {
        const line = `ИИндус ${st.pct} ${st.on ? 'ЭФФЕКТЫ ' + st.song : ''}`;
        if (line !== lastLine) { say(line); if (st.on && !lastLine.includes('ЭФФЕКТЫ')) await shot('on'); lastLine = line; }
      }
    }
    if (auto && Date.now() - lastAuto > auto * 1000) {
      lastAuto = Date.now();
      await page.mouse.move(640, 450).catch(() => {});
      await page.mouse.wheel(0, 900).catch(() => {});
      await page.keyboard.press('ArrowDown').catch(() => {});
    }
    if (stopAfter && Date.now() - t0 > stopAfter * 1000) break;
  }
  await shot('end');
  say('=== стоп');
  await ctx.close().catch(() => {});
  log.end();
})().catch((e) => { say('FAIL', e.message); process.exit(1); });
