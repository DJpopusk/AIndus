const DEFAULTS = { enabled: true, autoLike: false, effects: true, sound: true, volume: 0.7, threshold: 0.6, dancers: 18, interval: 500, autoScroll: false, skipAfter: 4, dwell: 15, fx: 1, cows: true, gods: true, hiPrecision: false, compute: 'auto', graphics: 'auto', fall: 'theme', collectDataset: true, backdrop: true, animals: true, traffic: true, personalOn: true, personalWeight: 0.4 };
const $ = (id) => document.getElementById(id);
// text with bold parts without innerHTML (AMO review rejects innerHTML with interpolated values); arrays are bold
function rich(el, ...parts) {
  el.replaceChildren(...parts.map((p) => {
    if (!Array.isArray(p)) return document.createTextNode(String(p));
    const b = document.createElement('b'); b.textContent = p.join(''); return b;
  }));
}
const bg = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg }).catch((e) => ({ error: String(e) }));

function fmt(id, v) {
  const el = $(id + 'Val');
  if (!el) return;
  el.textContent = id === 'dancers' ? String(v) : id === 'interval' ? v + ' мс' : id === 'fx' ? '×' + v : (id === 'skipAfter' || id === 'dwell') ? v + ' с' : Math.round(v * 100) + '%';
}

async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  for (const k of ['enabled', 'autoLike', 'effects', 'sound', 'autoScroll', 'cows', 'gods', 'hiPrecision', 'personalOn', 'collectDataset', 'backdrop', 'animals', 'traffic']) $(k).checked = !!s[k];
  for (const k of ['volume', 'threshold', 'dancers', 'interval', 'skipAfter', 'dwell', 'fx', 'personalWeight']) { $(k).value = s[k]; fmt(k, s[k]); }
  for (const k of ['compute', 'graphics', 'fall']) $(k).value = s[k];
}
// the compute backend changed: reload the model right away so the status line shows the result
$('compute').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ compute: e.target.value });
  $('modelText').textContent = 'переключаю…';
  bg({ type: 'WARMUP' });
});
$('graphics').addEventListener('change', (e) => chrome.storage.sync.set({ graphics: e.target.value }));
$('fall').addEventListener('change', (e) => chrome.storage.sync.set({ fall: e.target.value }));
// "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)" -> "Apple M2"
function shortGpu(name = '') {
  if (/swiftshader|llvmpipe|software/i.test(name)) return 'программная графика';
  const m = /Renderer: ([^,)]+)/.exec(name) || /^[^,]+, ([^,(]+)/.exec(name);
  return (m ? m[1] : name).trim().slice(0, 32);
}
async function loadGfx() {
  const { gfx } = await chrome.storage.local.get('gfx');         // what the overlay picked last time
  if (gfx) $('gfxInfo').textContent = `сейчас: ${({ high: 'высокая', medium: 'средняя', low: 'экономная' })[gfx.level] || gfx.level}` +
    (gfx.fps ? `, ${gfx.fps} к/с` : '') + (gfx.gpu ? ` · ${shortGpu(gfx.gpu)}` : '');
}
for (const k of ['enabled', 'autoLike', 'effects', 'sound', 'autoScroll', 'cows', 'gods', 'hiPrecision', 'personalOn', 'collectDataset', 'backdrop', 'animals', 'traffic']) {
  $(k).addEventListener('change', (e) => chrome.storage.sync.set({ [k]: e.target.checked }));
}
for (const k of ['volume', 'threshold', 'dancers', 'interval', 'skipAfter', 'dwell', 'fx', 'personalWeight']) {
  $(k).addEventListener('input', (e) => { const v = +e.target.value; fmt(k, v); chrome.storage.sync.set({ [k]: v }); });
}

async function loadStats() {
  const { stats = {} } = await chrome.storage.local.get('stats');
  $('sScanned').textContent = stats.scanned || 0;
  $('sIndian').textContent = stats.indian || 0;
  $('sLiked').textContent = stats.liked || 0;
}

async function refreshModel() {
  const st = await bg({ type: 'STATUS' });
  const dot = $('dot'), text = $('modelText');
  dot.className = 'dot';
  if (!st || st.error) { dot.classList.add('error'); text.textContent = 'ошибка: ' + (st?.error || 'нет ответа'); return; }
  if (st.state === 'ready') {
    dot.classList.add('ready');
    const where = st.device === 'webgpu' ? 'видеокарта' : `процессор, ${st.threads || 1} ${(st.threads || 1) > 1 ? 'потока' : 'поток'}`;
    text.textContent = `ИИндус готов · ${where} (${st.dtype || 'q8'}) · ${st.runs} кадров · ${st.lastMs} мс/кадр` +
      (st.upgrade ? ` · качаю версию для видеокарты ${st.upgrade.pct}%` : '');
    $('computeInfo').textContent = st.fallback || (st.device === 'webgpu' ? `считает на видеокарте${st.gpu ? ': ' + shortGpu(st.gpu) : ''}` : 'считает на процессоре (WASM)');
    $('warm').disabled = true;
  }
  else if (st.state === 'loading') {
    dot.classList.add('loading');
    const files = Object.entries(st.progress || {}), big = files.filter(([f]) => /\.onnx$/.test(f)).map(([, p]) => p);
    const pct = big.length ? Math.min(...big) : files.length ? Math.min(...files.map(([, p]) => p)) : 0;   // by the largest file
    text.textContent = `загрузка модели… ${pct}%`;
  } else if (st.state === 'error') { dot.classList.add('error'); text.textContent = 'ошибка: ' + st.error; }
  else text.textContent = 'модель не загружена (~150 МБ, один раз)';
}

$('warm').addEventListener('click', async () => {
  $('warm').disabled = true;
  $('modelText').textContent = 'запускаю…';
  bg({ type: 'WARMUP' });
});

$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  $('result').textContent = 'ИИндус смотрит на вкладку…';
  const win = await chrome.windows.getCurrent();
  const res = await bg({ type: 'CLASSIFY_ACTIVE', windowId: win.id });
  $('test').disabled = false;
  if (!res || res.error) { $('result').textContent = 'ошибка: ' + (res?.error || 'нет ответа'); return; }
  const pct = Math.round(res.score * 100);
  rich($('result'), [`${res.indian ? 'ИНДУС! ' : 'Не индус. '}${pct}%`], ` (${res.ms} мс)\n` +
    (res.parts ? `сцена ${Math.round(res.parts.scene * 100)}% · лицо ${Math.round(res.parts.face * 100)}% (${res.parts.guess}, вес ${res.parts.faceWeight})\n` : '') +
    res.top.map((t) => `${t.indian ? '🇮🇳' : '·'} ${t.label} — ${Math.round(t.p * 100)}%`).join('\n'));
});

// ---------- fine-tuning ----------
function renderSamples(d) {
  $('lnCount').textContent = d.n ? `${d.n} (${d.pos}/${d.neg})` : '0';
  const box = $('lnShots');
  box.replaceChildren();
  if (!d.last || !d.last.length) {
    const e = document.createElement('span'); e.className = 'empty'; e.textContent = 'примеров пока нет'; box.appendChild(e);
  } else {
    for (const s of d.last) {
      const img = document.createElement('img');
      img.src = s.thumb; img.className = s.y ? 'yes' : 'no';
      img.title = `${s.y ? 'индус' : 'не индус'} · ИИндус давал ${Math.round((s.score || 0) * 100)}%`;
      box.appendChild(img);
    }
  }
  // do not disable the button silently: say what is missing
  const need = [];
  if (d.pos < 3) need.push(`индусов ${d.pos}/3`);
  if (d.neg < 3) need.push(`не индусов ${d.neg}/3`);
  if (d.n < 8) need.push(`всего ${d.n}/8`);
  $('lnTrain').dataset.need = need.join(', ');
  $('lnTrain').textContent = need.length ? 'Обучить (мало примеров)' : 'Обучить';
  if (d.personal) {
    const when = new Date(d.personal.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    $('lnModel').textContent = `обучена ${when} на ${d.personal.n}${d.personal.acc != null ? `, точность ${Math.round(d.personal.acc * 100)}%` : ''}`;
  } else {
    $('lnModel').textContent = 'не обучена';
  }
}

async function loadSamples() {
  const d = await bg({ type: 'SAMPLES' });
  if (!d || d.error) return;
  renderSamples(d);
}

async function label(indian) {
  $('lnResult').textContent = 'запоминаю…';
  const d = await bg({ type: 'LABEL', indian });
  if (!d || d.error) { $('lnResult').textContent = 'не вышло: ' + (d?.error || '?'); return; }
  rich($('lnResult'), 'запомнил как ', [indian ? 'индуса' : 'не индуса'], `, ИИндус давал ${Math.round((d.score || 0) * 100)}%`);
  loadSamples();
  dsRefresh();
}

$('lnYes').addEventListener('click', () => label(true).then(() => setTimeout(loadShare, 1500)));
$('lnNo').addEventListener('click', () => label(false).then(() => setTimeout(loadShare, 1500)));
$('lnUndo').addEventListener('click', async () => { await bg({ type: 'FORGET' }); $('lnResult').textContent = 'последний пример забыт'; loadSamples(); loadShare(); });
$('lnReset').addEventListener('click', async () => {
  if (!confirm('Забыть все примеры и личную модель?')) return;
  await bg({ type: 'FORGET', all: true }); $('lnResult').textContent = 'всё забыто'; loadSamples();
});
$('lnTrain').addEventListener('click', async () => {
  const need = $('lnTrain').dataset.need;
  if (need) { rich($('lnResult'), 'не хватает примеров: ', [need]); return; }
  $('lnTrain').disabled = true; $('lnResult').textContent = 'учусь…';
  const r = await bg({ type: 'TRAIN' });
  if (!r || r.error) { $('lnResult').textContent = 'не вышло: ' + (r?.error || '?'); }
  else rich($('lnResult'), 'готово: ', [r.n], ' примеров', ...(r.acc != null ? [', точность на отложенных ', [Math.round(r.acc * 100) + '%']] : []));
  loadSamples();
});
$('learn').addEventListener('toggle', () => { if ($('learn').open) loadSamples(); });

loadSettings();
loadStats();
loadGfx();
loadSamples();
refreshModel();
setInterval(() => { refreshModel(); loadStats(); }, 1000);

// ---------- reel dataset: counter, zip export, clear ----------
function dsOpen() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open('iindu-dataset', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('frames', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
  });
}
async function dsAll() {
  const db = await dsOpen();
  const rows = await new Promise((ok, fail) => { const q = db.transaction('frames').objectStore('frames').getAll(); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
  db.close();
  return rows;
}
async function dsRefresh() {
  try {
    const rows = await dsAll(), pos = rows.filter((r) => r.y).length, mb = rows.reduce((a, r) => a + (r.jpeg?.size || 0), 0) / 1048576;
    $('dsInfo').textContent = rows.length ? `в датасете ${rows.length} кадров (${pos} индусов, ${rows.length - pos} нет) · ${mb.toFixed(1)} МБ` : 'кадры с разметкой — для переобучения базовой модели';
    $('dsExport').disabled = $('dsClear').disabled = !rows.length;
  } catch (e) { $('dsInfo').textContent = 'датасет недоступен: ' + e.message; }
}
// uncompressed zip (JPEG is compressed already): local headers + central directory, table-based CRC32
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], dir = []; let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);   // UTF-8 file names
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    dir.push(c.buffer, name);
    off += 30 + name.length + data.length;
  }
  const dirSize = dir.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, dirSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...dir, e.buffer], { type: 'application/zip' });
}
$('dsExport').addEventListener('click', async () => {
  $('dsExport').disabled = true; $('dsInfo').textContent = 'собираю архив…';
  try {
    const rows = await dsAll(), enc = new TextEncoder(), files = [];
    const csv = ['file,label,score,site,url,time,dtype,device'];
    const meta = [];
    for (const r of rows) {
      const name = `images/${String(r.id).padStart(6, '0')}_${r.y ? 'indian' : 'not'}.jpg`;
      files.push({ name, data: new Uint8Array(await r.jpeg.arrayBuffer()) });
      csv.push([name, r.y, r.score, r.site, JSON.stringify(r.url || ''), new Date(r.t).toISOString(), r.dtype || '', r.device || ''].join(','));
      meta.push(JSON.stringify({ file: name, label: r.y, score: r.score, site: r.site, url: r.url, time: r.t, dtype: r.dtype, device: r.device, emb: r.emb }));
    }
    files.push({ name: 'labels.csv', data: enc.encode(csv.join('\n') + '\n') });
    files.push({ name: 'meta.jsonl', data: enc.encode(meta.join('\n') + '\n') });
    files.push({ name: 'README.txt', data: enc.encode(
      'Датасет AIndus: кадры рилсов с разметкой пользователя (1 — индус, 0 — нет).\n' +
      'images/ — кадры до 448 px; labels.csv — метки, оценка ИИндуса в момент разметки, ссылка на рилс;\n' +
      'meta.jsonl — то же плюс эмбеддинг CLIP B/32 (512 чисел, точность — в dtype).\n' +
      'Переобучить базовую модель: python3 training/import_user_dataset.py <этот zip> && python3 training/train_scene.py\n' +
      'Кадры — из чужих рилсов: для своего обучения, не для публикации.\n') });
    const url = URL.createObjectURL(makeZip(files));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    await chrome.downloads.download({ url, filename: `aindus-dataset-${stamp}.zip`, saveAs: false });
    $('dsInfo').textContent = `скачано: ${rows.length} кадров`;
  } catch (e) { $('dsInfo').textContent = 'не вышло: ' + e.message; }
  $('dsExport').disabled = false;
});
$('dsClear').addEventListener('click', async () => {
  if (!confirm('Удалить все кадры из датасета? Личная модель останется.')) return;
  const db = await dsOpen();
  await new Promise((ok) => { const tx = db.transaction('frames', 'readwrite'); tx.objectStore('frames').clear(); tx.oncomplete = ok; });
  db.close(); dsRefresh();
});
$('learn').addEventListener('toggle', () => { if ($('learn').open) dsRefresh(); });

// ---------- shared dataset: enabled only after explicit consent ----------
const PRIVACY_URL = 'https://github.com/DJpopusk/AIndus#приватность';
$('shPolicy').href = PRIVACY_URL;
async function loadShare() {
  const st = await bg({ type: 'SHARE_STATUS' });
  if (!st || st.error || !st.configured) { $('share').hidden = true; return; }
  $('share').hidden = false;
  $('shareDataset').checked = !!st.on;
  const total = st.total ? ` · в общем датасете ${st.total.n}` : '';
  $('shInfo').textContent = st.on
    ? `отправлено ${st.sent}${st.queued ? `, ждут отправки ${st.queued}` : ''}${total}`
    : `в общий датасет: только числа и метка, без кадров и ссылок${total}`;
  $('shDelete').disabled = !st.on && !st.sent;
}
$('shareDataset').addEventListener('change', async (e) => {
  if (e.target.checked) { e.target.checked = false; $('shConsent').hidden = false; return; }   // ask for consent first
  await chrome.storage.sync.set({ shareDataset: false });
  await bg({ type: 'SHARE_OFF' });
  loadShare();
});
$('shAgree').addEventListener('click', async () => {
  // Firefox 140+ shows its own consent prompt; it has to be called straight from the click, before any await
  const gecko = typeof chrome.runtime.getBrowserInfo === 'function';
  const asked = gecko && chrome.permissions?.request ? chrome.permissions.request({ data_collection: ['websiteContent'] }).catch(() => true) : Promise.resolve(true);
  if (!(await asked)) { $('shConsent').hidden = true; $('lnResult').textContent = 'без разрешения Firefox делиться нельзя'; return; }
  const { consentV } = await bg({ type: 'SHARE_STATUS' });
  await chrome.storage.sync.set({ shareDataset: true, shareConsentV: consentV, shareConsentAt: Date.now() });
  $('shConsent').hidden = true;
  await bg({ type: 'SHARE_FLUSH' });
  loadShare();
});
$('shCancel').addEventListener('click', () => { $('shConsent').hidden = true; });
$('shDelete').addEventListener('click', async () => {
  if (!confirm('Удалить с сервера всё, что ты отправил в общий датасет?')) return;
  $('shDelete').disabled = true;
  const r = await bg({ type: 'SHARE_DELETE' });
  $('lnResult').textContent = r && !r.error ? `удалено с сервера: ${r.deleted}` : 'не вышло: ' + (r?.error || '?');
  loadShare();
});
$('learn').addEventListener('toggle', () => { if ($('learn').open) loadShare(); });
loadShare();
