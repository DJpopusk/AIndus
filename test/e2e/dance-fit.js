// Picks dances for a model with fragile skinning. Each dance is played on the model frame by frame and the mesh
// stretch is measured (__iindu.stretchScan). Dances that stay within normal stretch are written to the model in
// people.json (field dances), and the overlay gives it only those.
//   node test/e2e/dance-fit.js modi2.glb            show the measurement
//   node test/e2e/dance-fit.js modi2.glb --write    and write the list to people.json
// Thresholds (defaults; a model can set its own in people.json, field fit; or MAX_CM=... MAX_FLAP=... MAX_REACH=... MAX_KICK=...):
//   maxCm 11    largest edge stretch in centimetres; a normal model has a median of about 9 across dances;
//   maxFlap 130 number of edges stretched by more than 3 cm at the worst moment; about 80 for a normal model;
//   maxReach    limit on the dance's arm reach (dances.json: reach, hand distance from the body axis in arm lengths);
//   maxKick     limit on leg lift (dances.json: kick, thigh angle from vertical in degrees): long clothes split
//               open on high steps;
//   skip        dances never to give (record names).
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
const PEOPLE = path.join(EXT, 'assets/models/people/people.json');
const envNum = (k) => (process.env[k] ? { [({ MAX_CM: 'maxCm', MAX_FLAP: 'maxFlap', MAX_REACH: 'maxReach', MAX_KICK: 'maxKick' })[k]]: +process.env[k] } : {});
(async () => {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--')), write = process.argv.includes('--write');
  if (!files.length) { console.log('какую модель? например: node test/e2e/dance-fit.js modi2.glb --write'); process.exit(1); }
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/overlay.html`);
  await p.waitForFunction(() => !!window.__iindu);
  const people = JSON.parse(fs.readFileSync(PEOPLE, 'utf8'));
  for (const file of files) {
    const rec = people.find((x) => x.file === file);
    if (!rec) { console.log('нет такой модели:', file); continue; }
    const res = await p.evaluate((f) => window.__iindu.stretchScan(f), file);
    const meta = await p.evaluate(() => window.__iindu.danceMeta);
    const ok = [];
    const fit = { maxCm: 11, maxFlap: 130, ...(rec.fit || {}), ...envNum('MAX_CM'), ...envNum('MAX_FLAP'), ...envNum('MAX_REACH'), ...envNum('MAX_KICK') };
    console.log(`\n== ${file}: порог ${fit.maxCm} см, ${fit.maxFlap} рёбер${fit.maxReach ? `, размах до ${fit.maxReach}` : ''}${fit.maxKick ? `, подъём ноги до ${fit.maxKick}°` : ''}${fit.skip ? `, без ${fit.skip.join(', ')}` : ''}`);
    for (const r of [...res].sort((a, b) => a.maxCm - b.maxCm)) {
      const m = meta[r.name] || {};
      const good = r.maxCm <= fit.maxCm && r.flap <= fit.maxFlap && (!fit.maxReach || (m.reach ?? 0) <= fit.maxReach) && (!fit.maxKick || (m.kick ?? 0) <= fit.maxKick) && !(fit.skip || []).includes(r.name);
      if (good) ok.push(r.name);
      console.log(`  ${good ? '✓' : '·'} ${(m.title || r.name).padEnd(26)} ${(m.tags || [''])[0].padEnd(7)} ${String(r.maxCm).padStart(5)} см ${String(r.flap).padStart(4)} рёбер  размах ${m.reach ?? '?'}  нога ${m.kick ?? '?'}°`);
    }
    console.log(`  подходит ${ok.length} из ${res.length}`);
    if (write) {
      if (ok.length < 4) { console.log('  слишком мало подходящих танцев — в people.json не пишу'); continue; }
      rec.dances = res.map((r) => r.name).filter((n) => ok.includes(n));       // in library order
      rec.fit = fit;                                                            // the thresholds used, so the result can be reproduced
    }
  }
  if (write) { fs.writeFileSync(PEOPLE, JSON.stringify(people, null, 1) + '\n'); console.log('\nзаписано в people.json'); }
  await ctx.close();
})();
