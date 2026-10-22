// Background service worker.
// It captures frames of the active tab, keeps the offscreen document with the model alive,
// routes messages between the content script, the model and the popup, and counts stats.

const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);

let creating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS', 'BLOBS'],
        justification: 'Локальный запуск модели ИИндус (CLIP на ONNX Runtime WASM) для классификации кадров рилсов',
      })
      .catch((e) => {
        // race: another call has already created the document
        if (!/single offscreen|already exists/i.test(String(e))) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

// Firefox has no offscreen documents, but its background page is a normal document with a DOM,
// so the model Worker is created right here. In Chrome the background is a service worker and the
// offscreen document is required: a service worker has neither DOM nor OffscreenCanvas for frame preprocessing.
const HAS_OFFSCREEN = typeof chrome.offscreen !== 'undefined';
let worker = null, workerSeq = 0;
const workerPending = new Map();

// Firefox suspends the event page after ~30 s without API calls and kills the Worker with it,
// while the first download of the CLIP weights takes minutes. While the model is busy we ping an API to keep the page alive.
let keepAliveTimer = null, inflight = 0;
function holdAlive(on) {
  if (HAS_OFFSCREEN) return;                       // in Chrome the model lives in the offscreen document
  inflight = Math.max(0, inflight + (on ? 1 : -1));
  if (inflight > 0 && !keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  if (inflight === 0 && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

function localWorkerCall(type, payload) {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('iindus.worker.js'), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = workerPending.get(data.id);
      if (!p) return;
      workerPending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
    };
    worker.onerror = (e) => {
      console.error('[ИИндус] worker:', e.message);
      for (const p of workerPending.values()) p.reject(new Error('worker упал: ' + e.message));
      workerPending.clear();
      worker = null;
    };
    worker.postMessage({ id: ++workerSeq, type: 'init', base: chrome.runtime.getURL('') });
  }
  holdAlive(true);
  return new Promise((resolve, reject) => {
    const id = ++workerSeq;
    workerPending.set(id, { resolve, reject });
    worker.postMessage({ ...payload, id, type });
  }).finally(() => holdAlive(false));
}

// Single entry point to the model: the offscreen document in Chrome, a local worker in Firefox.
function model(type, payload = {}) {
  if (HAS_OFFSCREEN) return sendToOffscreen({ type, ...payload });
  return localWorkerCall(type.toLowerCase(), payload);
}

async function modelStatus() {
  if (!HAS_OFFSCREEN) return worker ? localWorkerCall('status', {}) : { state: 'idle' };
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctx.length) return { state: 'idle' };
  return sendToOffscreen({ type: 'STATUS' }, 3);
}

// Message to the offscreen document. Right after creation its listener may not be ready yet, so retry.
async function sendToOffscreen(msg, tries = 15) {
  await ensureOffscreen();
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
      if (res !== undefined) return res;
    } catch (e) {
      if (!/Receiving end does not exist/i.test(String(e))) throw e;
    }
    await sleep(200);
  }
  throw new Error('модель ИИндус не отвечает');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// captureVisibleTab allows about 2 calls per second per tab, so calls are queued.
let lastCapture = 0;
let captureChain = Promise.resolve();
function capture(windowId) {
  const job = captureChain.then(async () => {
    const wait = 650 - (Date.now() - lastCapture);
    if (wait > 0) await sleep(wait);
    lastCapture = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 82 });
  });
  captureChain = job.catch(() => {});
  return job;
}

// dataUrl is a frame prepared by the content script; without it we capture the visible tab
// (Chromium wants <all_urls> or activeTab for captureVisibleTab; activeTab is granted by clicking the icon).
async function classify({ dataUrl = null, rect = null, dpr = 1, threshold = 0.5 }, windowId) {
  if (!dataUrl) dataUrl = await capture(windowId);
  const { hiPrecision, compute } = await chrome.storage.sync.get({ hiPrecision: false, compute: 'auto' });
  return model('RUN', { dataUrl, rect, dpr, threshold, personal: await personalModel(), hiPrecision, compute });
}

// ---------- fine-tuning on the user's own feed ----------
// We keep embeddings (512 numbers) and a tiny preview instead of frames. Everything stays local.
const MAX_SAMPLES = 400;
let personalCache = null, personalLoaded = false;

async function personalModel() {
  if (!personalLoaded) {
    const { personal } = await chrome.storage.local.get('personal');
    const { personalWeight, personalOn } = await chrome.storage.sync.get({ personalWeight: 0.4, personalOn: true });
    personalCache = personal && personalOn && personalWeight > 0 ? { W: personal.W, b: personal.b, weight: personalWeight } : null;
    personalLoaded = true;
  }
  return personalCache;
}
chrome.storage.onChanged.addListener(() => { personalLoaded = false; });

async function getSamples() {
  const { samples = [] } = await chrome.storage.local.get('samples');
  return samples;
}

function summarize(samples, extra = {}) {
  const pos = samples.reduce((a, x) => a + x.y, 0);
  return { n: samples.length, pos, neg: samples.length - pos, ...extra };
}

async function addSample(y) {
  const { collectDataset } = await chrome.storage.sync.get({ collectDataset: true });
  const s = await model('SAMPLE', { withFrame: collectDataset });
  if (!s || !s.emb) throw new Error('ИИндус ещё не смотрел ни одного кадра — открой рилсы');
  const shareId = await shareEnqueue(s, y).catch((e) => { console.warn('[ИИндус] общий датасет:', e); return null; });
  const samples = await getSamples();
  samples.push({ emb: s.emb, y: y ? 1 : 0, thumb: s.thumb, at: s.at, score: s.score, ...(shareId ? { shareId } : {}) });
  while (samples.length > MAX_SAMPLES) samples.shift();
  await chrome.storage.local.set({ samples });
  if (collectDataset && s.frame) await datasetAdd(s, y).catch((e) => console.warn('[ИИндус] датасет:', e));
  return summarize(samples, { thumb: s.thumb, score: s.score });
}

// ---------- reel dataset ----------
// The personal model remembers the last 400 examples, as numbers only. For retraining the base model we
// separately keep everything the user labelled: the frame (JPEG up to 448 px), the label, the model score at
// that moment, the reel URL and the embedding. It lives in the extension's IndexedDB with no size limit
// (unlimitedStorage) and leaves the browser only through the popup's dataset download button
// (a zip; then training/import_user_dataset.py).
function datasetDb() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open('iindu-dataset', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('frames', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
  });
}
let lastReelUrl = '';

// ---------- shared dataset (consent only) ----------
// If the user turned on label sharing and agreed, each label goes to the project server (server/).
// What is sent is not the frame and not the URL but the CLIP embedding of the full frame (512 numbers, the frame
// cannot be rebuilt from it), the label, the model score, the site, versions and a random install id.
// Without consent nothing is sent. Details: the privacy section of README.md.
// SHARE_URL is the deployed server; an empty string turns the shared dataset off and hides it in the popup.
const SHARE_URL = '';
const SHARE_MODEL = 'clip-b32';
// consent text version: bump it when the set of sent fields changes and the popup will ask again
const SHARE_CONSENT_V = 1;
const SHARE_MAX_QUEUE = 500;
const IS_GECKO = typeof chrome.runtime.getBrowserInfo === 'function';
const siteOf = (url) => (/instagram\.com/.test(url) ? 'instagram' : /youtube\.com/.test(url) ? 'youtube' : 'other');

// both labelling and sending edit the queue in storage; run them one at a time or a label can get lost between read and write
let shareLock = Promise.resolve();
const withShareLock = (fn) => (shareLock = shareLock.then(fn, fn));

async function shareAllowed() {
  if (!SHARE_URL) return false;
  const { shareDataset, shareConsentV } = await chrome.storage.sync.get({ shareDataset: false, shareConsentV: 0 });
  if (!shareDataset || shareConsentV !== SHARE_CONSENT_V) return false;
  // Firefox 140+ has its own data collection consent; the user can revoke it in about:addons, then we stop sending
  if (IS_GECKO) { try { return await chrome.permissions.contains({ data_collection: ['websiteContent'] }); } catch { return true; } }
  return true;
}
async function shareInstall() {
  let { shareInstall: id } = await chrome.storage.local.get('shareInstall');
  if (!id) { id = crypto.randomUUID(); await chrome.storage.local.set({ shareInstall: id }); }
  return id;
}
function toHalf(v) {                         // float32 -> float16 (bits)
  const i = new Uint32Array(new Float32Array([v]).buffer)[0];
  const sign = (i >>> 16) & 0x8000, e = ((i >>> 23) & 0xff) - 112, m = i & 0x7fffff;
  if (e <= 0) return sign;                   // below 6e-5 becomes zero, which does not matter for an embedding
  if (e >= 31) return sign | 0x7c00;
  return sign | ((e << 10) + ((m + 0x1000) >> 13));
}
function embToB64(emb) {
  const b = new Uint8Array(emb.length * 2);
  emb.forEach((v, i) => { const h = toHalf(v); b[2 * i] = h & 0xff; b[2 * i + 1] = h >> 8; });
  return btoa(String.fromCharCode(...b));
}
async function shareEnqueue(s, y) {
  if (!(await shareAllowed()) || !s.emb || s.emb.length !== 512) return null;
  const item = { id: crypto.randomUUID(), y: y ? 1 : 0, score: s.score, site: siteOf(lastReelUrl), dtype: s.dtype || 'q8',
    model: SHARE_MODEL, ext: chrome.runtime.getManifest().version, emb: embToB64(s.emb) };
  await withShareLock(async () => {
    const { shareQueue = [] } = await chrome.storage.local.get('shareQueue');
    shareQueue.push(item);
    while (shareQueue.length > SHARE_MAX_QUEUE) shareQueue.shift();
    await chrome.storage.local.set({ shareQueue });
  });
  shareFlush();
  return item.id;
}
let flushing = null;
function shareFlush() {
  if (!flushing) flushing = doShareFlush().catch((e) => console.warn('[ИИндус] общий датасет:', e)).finally(() => { flushing = null; });
  return flushing;
}
async function doShareFlush() {
  if (!(await shareAllowed())) return;
  const install = await shareInstall();
  for (let round = 0; round < 10; round++) {
    const { shareQueue = [] } = await chrome.storage.local.get('shareQueue');
    if (!shareQueue.length) return;
    const batch = shareQueue.slice(0, 50);
    let r;
    try {
      r = await fetch(SHARE_URL + '/v1/labels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ install, items: batch }) });
    } catch { return; }                      // no network: retry on the next label or on startup
    if (r.status >= 500 || r.status === 429) return;
    const res = r.ok ? await r.json().catch(() => ({})) : {};   // 4xx: the server will never accept this batch, drop it
    const done = new Set(batch.map((x) => x.id));
    await withShareLock(async () => {
      const { shareQueue: q = [], shareStats = { sent: 0 } } = await chrome.storage.local.get(['shareQueue', 'shareStats']);
      shareStats.sent += res.stored || 0; shareStats.at = Date.now();
      await chrome.storage.local.set({ shareQueue: q.filter((x) => !done.has(x.id)), shareStats });
    });
  }
}
// Undo in the popup: a label still in the queue is just removed; a sent one is deleted on the server
async function shareCancel(id) {
  let queued = false;
  await withShareLock(async () => {
    const { shareQueue = [] } = await chrome.storage.local.get('shareQueue');
    const q = shareQueue.filter((x) => x.id !== id);
    queued = q.length !== shareQueue.length;
    if (queued) await chrome.storage.local.set({ shareQueue: q });
  });
  if (queued || !SHARE_URL) return;
  const install = await shareInstall();
  const r = await fetch(`${SHARE_URL}/v1/labels/${install}/${id}`, { method: 'DELETE' }).catch(() => null);
  if (r && r.ok) {
    const { deleted } = await r.json().catch(() => ({}));
    if (deleted) {
      const { shareStats = { sent: 0 } } = await chrome.storage.local.get('shareStats');
      shareStats.sent = Math.max(0, shareStats.sent - deleted);
      await chrome.storage.local.set({ shareStats });
    }
  }
}
// Delete my data: wipe everything with this install id on the server and start a new id, so old and new labels cannot be linked
async function shareDeleteAll() {
  if (!SHARE_URL) return { deleted: 0 };
  const { shareInstall: install } = await chrome.storage.local.get('shareInstall');
  let deleted = 0;
  if (install) {
    const r = await fetch(`${SHARE_URL}/v1/install/${install}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('сервер не ответил, попробуй позже');
    deleted = (await r.json()).deleted || 0;
  }
  await withShareLock(() => chrome.storage.local.remove(['shareQueue', 'shareStats', 'shareInstall']));
  return { deleted };
}
async function shareStatus() {
  const { shareDataset, shareConsentV } = await chrome.storage.sync.get({ shareDataset: false, shareConsentV: 0 });
  const { shareQueue = [], shareStats = { sent: 0 } } = await chrome.storage.local.get(['shareQueue', 'shareStats']);
  let total = null;
  if (SHARE_URL) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
    total = await fetch(SHARE_URL + '/v1/stats', { signal: ctl.signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    clearTimeout(t);
  }
  return { configured: !!SHARE_URL, on: shareDataset && shareConsentV === SHARE_CONSENT_V, consentV: SHARE_CONSENT_V, gecko: IS_GECKO, queued: shareQueue.length, sent: shareStats.sent, total };
}
shareFlush();                                // send what was left unsent last time
async function datasetAdd(s, y) {
  const url = lastReelUrl;
  const site = /instagram\.com/.test(url) ? 'instagram' : /youtube\.com/.test(url) ? 'youtube' : 'other';
  const jpeg = await (await fetch(s.frame.jpeg)).blob();
  const db = await datasetDb();
  await new Promise((ok, fail) => {
    const tx = db.transaction('frames', 'readwrite');
    tx.objectStore('frames').add({ t: s.at || Date.now(), y: y ? 1 : 0, score: s.score, url, site, dtype: s.dtype, device: s.device, w: s.frame.w, h: s.frame.h, emb: s.emb, jpeg });
    tx.oncomplete = ok; tx.onerror = () => fail(tx.error);
  });
  db.close();
}

async function trainPersonal() {
  const samples = await getSamples();
  const res = await model('TRAIN', { samples: samples.map(({ emb, y }) => ({ emb, y })) });
  await chrome.storage.local.set({ personal: { W: res.W, b: res.b, acc: res.acc, n: res.n, at: Date.now() } });
  personalLoaded = false;
  return { acc: res.acc, n: res.n, pos: res.pos, neg: res.neg };
}

async function bumpStats(patch) {
  const { stats = {} } = await chrome.storage.local.get('stats');
  for (const [k, v] of Object.entries(patch)) stats[k] = (stats[k] || 0) + v;
  await chrome.storage.local.set({ stats });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return false;
  (async () => {
    switch (msg.type) {
      case 'CLASSIFY': {
        if (sender.tab?.url) lastReelUrl = sender.tab.url;     // for the dataset: which reel the frame came from
        const windowId = sender.tab?.windowId;
        if (windowId == null) throw new Error('нет вкладки для снимка');
        return classify(msg, windowId); // the content script sends stats once per reel, not per frame
      }
      case 'CLASSIFY_ACTIVE': {
        // from the popup: check the whole visible area of the active tab
        return classify({ threshold: msg.threshold }, msg.windowId);
      }
      case 'WARMUP':
        return model('WARMUP', await chrome.storage.sync.get({ hiPrecision: false, compute: 'auto' }));
      case 'STATUS':
        return modelStatus();
      case 'EVENT':
        await bumpStats(msg.patch || {});
        return { ok: true };
      case 'LABEL':                       // label the last frame as an example
        return addSample(msg.indian);
      case 'SAMPLES': {
        const samples = await getSamples();
        const { personal } = await chrome.storage.local.get('personal');
        return { ...summarize(samples), last: samples.slice(-8).reverse().map(({ thumb, y, score }) => ({ thumb, y, score })),
          personal: personal ? { acc: personal.acc, n: personal.n, at: personal.at } : null };
      }
      case 'TRAIN':
        return trainPersonal();
      case 'FORGET': {                    // forget either the last example or all of them
        const samples = await getSamples();
        if (msg.all) {
          await chrome.storage.local.remove(['samples', 'personal']);
          personalLoaded = false;
          return { n: 0, pos: 0, neg: 0 };
        }
        const last = samples.pop();
        await chrome.storage.local.set({ samples });
        if (last?.shareId) await shareCancel(last.shareId).catch(() => {});
        return summarize(samples);
      }
      case 'SHARE_STATUS':
        return shareStatus();
      case 'SHARE_OFF':                   // consent withdrawn: do not send the queued labels
        await withShareLock(() => chrome.storage.local.remove('shareQueue'));
        return shareStatus();
      case 'SHARE_FLUSH':
        await shareFlush();
        return shareStatus();
      case 'SHARE_DELETE':
        return shareDeleteAll();
      default:
        return { error: 'неизвестное сообщение ' + msg.type };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get(null).then((s) => {
    // on update: raise the old default threshold 0.5 to the new 0.6 if the user never changed it
    if (details.reason === 'update' && s.threshold === 0.5) chrome.storage.sync.set({ threshold: 0.6 });
    if (s.enabled === undefined) {
      chrome.storage.sync.set({
        enabled: true,
        autoLike: false,          // off by default: it automates someone else's site
        effects: true,
        sound: true,
        volume: 0.7,
        threshold: 0.6,
        dancers: 18,
        interval: 500,
        autoScroll: false,
        skipAfter: 4,
        dwell: 15,
        fx: 1,
        personalOn: true,
        personalWeight: 0.4,
        cows: true,
        gods: true,
        hiPrecision: false,
        compute: 'auto',        // where the model runs: auto | gpu | cpu
        graphics: 'auto',       // overlay graphics quality: auto | high | medium | low
        fall: 'theme',          // what falls from the sky: theme | confetti | petals | gulal | sparks | rupees | emoji | none
        backdrop: true,         // city photo behind the dancers
        animals: true,          // animals in the background
        traffic: true,          // tuk-tuks, scooters, dogs
        collectDataset: true,   // keep labelled frames in the local dataset
        shareDataset: false,    // share labels with the shared dataset, only after explicit consent in the popup
      });
    }
  });
});
