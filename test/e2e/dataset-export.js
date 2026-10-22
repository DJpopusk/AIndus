// Dataset export: put two frames into IndexedDB, build the zip with the popup's code and check the zip from outside.
//   node test/e2e/dataset-export.js   -> test/e2e/out/dataset-test.zip
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '../../extension');
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.profile-costume'), { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  const b64 = await p.evaluate(async () => {
    const jpeg = await new Promise((ok) => { const c = new OffscreenCanvas(64, 48); const g = c.getContext('2d'); g.fillStyle = '#f93'; g.fillRect(0, 0, 64, 48); c.convertToBlob({ type: 'image/jpeg' }).then(ok); });
    const db = await dsOpen();
    await new Promise((ok) => { const tx = db.transaction('frames', 'readwrite'); const st = tx.objectStore('frames'); st.clear();
      st.add({ t: Date.now(), y: 1, score: 0.81, url: 'https://www.instagram.com/reels/X/', site: 'instagram', w: 64, h: 48, emb: [0.1, 0.2], jpeg });
      st.add({ t: Date.now(), y: 0, score: 0.12, url: 'https://www.instagram.com/reels/Y/', site: 'instagram', w: 64, h: 48, emb: [0.3, 0.4], jpeg });
      tx.oncomplete = ok; });
    db.close();
    const rows = await dsAll(), enc = new TextEncoder(), files = [];
    for (const r of rows) files.push({ name: `images/${r.id}_${r.y ? 'indian' : 'not'}.jpg`, data: new Uint8Array(await r.jpeg.arrayBuffer()) });
    files.push({ name: 'labels.csv', data: enc.encode('file,label\n' + rows.map((r) => `images/${r.id},${r.y}`).join('\n') + '\n') });
    const buf = new Uint8Array(await makeZip(files).arrayBuffer());
    let bin = ''; for (const x of buf) bin += String.fromCharCode(x); return btoa(bin);
  });
  const out = path.join(__dirname, 'out', 'dataset-test.zip'); fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('zip', fs.statSync(out).size, 'байт →', out);
  await ctx.close();
})();
