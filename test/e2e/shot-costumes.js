// Costume screenshots: open the overlay page directly (no model, no Instagram) and spawn dancers
// in one costume, to check by eye how the props sit.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const NAMES = process.argv.slice(2).length ? process.argv.slice(2) : ['turban', 'military', 'modi', 'bride', 'dholi', 'guru', 'fan', 'civil'];
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), {
    channel: 'chromium', headless: true, viewport: { width: 1000, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('console', (m) => { if (/ИИндус|костюм/.test(m.text())) console.log('  [overlay]', m.text()); });
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.evaluate(() => window.postMessage({ type: 'IINDU_START', id: 1, score: 0.9, rect: { x: 380, y: 30, w: 240, h: 840 },
    settings: { sound: false, volume: 0, dancers: 3, fx: 1 } }, '*'));
  await p.waitForFunction(() => window.__iindu && window.__iindu.dancers > 0, null, { timeout: 60000 });
  for (const name of NAMES) {
    const got = name.startsWith('god:')
      ? await p.evaluate(async (f) => { window.__iindu.spawnCostume('civil', 0); return ['богов: ' + await window.__iindu.spawnGods(1, f)]; }, name.slice(4))
      : name.startsWith('chore:')
      ? await p.evaluate((a) => window.__iindu.spawnChore(a[1], 8), name.split(':'))
      : name === 'cows'
      ? await p.evaluate(() => window.__iindu.spawnCows(3))
      : name.endsWith('.glb')
        ? await p.evaluate((f) => (f.includes('cow') ? window.__iindu.spawnCows(2, f) : window.__iindu.spawnPerson(f, 3)), name)
        : await p.evaluate((n) => window.__iindu.spawnCostume(n, 3), name);
    await p.waitForTimeout(900);
    await p.screenshot({ path: path.join(OUT, `costume_${name.replace('.glb','').replace(/:/g,'_')}.png`) });
    console.log(`  ${name}: ${Array.isArray(got) ? got.join(', ') : JSON.stringify(got)}`);
  }
  await ctx.close();
})();
