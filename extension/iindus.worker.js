// The model's compute side. Runs in a Web Worker inside the offscreen document, so WASM inference
// does not block the extension's main thread (the overlay with the dancers lives there too).
//
// How it works:
//  1. CLIP ViT-B/32 embeds the frame plus 1-2 crops (top-centre and centre, where faces usually are).
//  2. Zero-shot scene score: similarity to prompt embeddings baked into assets/model/prompts.json
//     ("Bollywood dancing", "saree", "Hindu temple", "Hindi sign" ... against "Russian people", "Arab man", "cat" ...).
//     No text model is needed: prompt embeddings are computed in advance (training/text_embed.mjs).
//  3. Scene head (head.json: Wscene/bscene): logistic regression on CLIP embeddings of a few thousand scenes,
//     Indian dances, weddings and streets against Georgian, Caucasian, Slavic, Turkish, Latin and other dances.
//     Scene = 0.15 * zero-shot + 0.85 * scene head (tuned on a holdout, training/sweep_blend.py).
//  4. Face head (head.json: Wbin/bbin): logistic regression on FairFace embeddings (7 groups, Indian and
//     Middle Eastern among them) -> P(Indian | person in frame). Maximum over the crops.
//  5. Final score is a blend: the bigger the face in the frame, the more the face head weighs; with no face the scene decides.

import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from './vendor/transformers/transformers.min.js';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const LOGIT_SCALE = 100; // exp(4.6052) in CLIP
const W0 = 0.3, W1 = 0.5; // face head weight: W0 without a face, W0 + W1 with a large face
const SCENE_HEAD_W = 0.85; // share of the scene head in the scene score (the rest is prompt zero-shot)
const CROPS = { top: [0.2, 0, 0.8, 0.6], center: [0.15, 0.15, 0.85, 0.85] }; // fractions of the frame

const status = { state: 'idle', progress: {}, error: null, loadedAt: null, runs: 0, lastMs: 0, passes: 0, head: null, dtype: 'q8',
  device: 'wasm', threads: 1, gpu: null, fallback: null };
// Personal head: logistic regression on the same CLIP embedding, trained on examples the user labelled
// in their own feed (popup -> fine-tuning). weight is how much to trust it.
let personal = null;          // { W: number[512], b: number, weight: number }
let lastSample = null;        // embedding and preview of the last analysed frame, for labelling
let lastFull = null;          // the last full frame (up to 448 px), saved to the dataset when labelled
let base = null; // chrome-extension://id/
let ready = null;
let currentDtype = 'q8';        // q8: 89 MB and ~200 ms per frame; fp32: 351 MB, twice as slow, slightly more accurate
// Where to compute. On the CPU (WASM): 8-bit weights and as many threads as the browser allows. Threads need
// SharedArrayBuffer, which exists only on isolated pages (manifest: cross_origin_*_policy).
// On the GPU (WebGPU): fp16 if the card supports half precision, otherwise fp32. The ONNX WebGPU backend
// runs 8-bit matrices slower than fp16.
let compute = 'auto';           // requested in settings: auto | gpu | cpu
let hiPrecision = false;
let currentDevice = 'wasm';
let perImageMs = 0;             // cost of one pass; it decides how many crops fit in time
// Is graphics software-rendered here (blocklisted GPU, headless)? Then WebGPU must not even be queried.
// Requesting an adapter starts software Vulkan in the GPU process, after which the page's video decoder
// fails (PIPELINE_ERROR_DECODE) and reels stop playing. Checked through the WebGL renderer string.
function softwareGraphics() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl');
    if (!gl) return 'WebGL недоступен';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|lavapipe|software|basic render/i.test(name) ? name.replace(/^ANGLE \((.*)\)$/, '$1').slice(0, 60) : null;
  } catch { return null; }
}
async function gpuInfo() {
  if (!self.navigator || !navigator.gpu) return null;
  const soft = softwareGraphics();
  if (soft) return { software: true, name: soft };
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return null;
    const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {}) || {};
    const name = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU';
    // a software adapter (SwiftShader, llvmpipe) is a GPU emulated on the CPU: the model runs slower than WASM
    // and eats so much CPU that the page stops decoding video
    const software = !!(info.isFallbackAdapter || a.isFallbackAdapter) || /swiftshader|llvmpipe|lavapipe|software|basic render/i.test(name);
    return { f16: a.features.has('shader-f16'), name, software };
  } catch { return null; }
}
async function pickBackend() {
  let gpu = compute === 'cpu' ? null : await gpuInfo();
  if (gpu && gpu.software) {
    status.fallback = `видеокарта программная (${gpu.name}) — считаю на процессоре`;
    gpu = null;
  }
  status.gpu = gpu ? gpu.name : null;
  if (gpu) return { device: 'webgpu', dtype: hiPrecision || !gpu.f16 ? 'fp32' : 'fp16' };
  if (compute === 'gpu' && !status.fallback) status.fallback = 'WebGPU недоступен в этом браузере — считаю на процессоре';
  return { device: 'wasm', dtype: hiPrecision ? 'fp32' : 'q8' };
}

async function loadJson(path) {
  const r = await fetch(new URL(path, base));
  if (!r.ok) throw new Error(`нет ${path}`);
  return r.json();
}

// are weights of this precision in the transformers.js cache (Cache API)? File name is vision_model + precision suffix
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized' };
async function isCached(dtype) {
  try {
    const c = await caches.open('transformers-cache');
    return !!(await c.match(`https://huggingface.co/${MODEL_ID}/resolve/main/onnx/vision_model${SUFFIX[dtype] ?? ''}.onnx`));
  } catch { return true; }            // cache unavailable: behave as before
}
// background download of the GPU weights; until it finishes, the CPU classifies frames
let loadGen = 0;
async function upgrade(m, target, gen) {
  status.upgrade = { device: target.device, pct: 0 };
  try {
    const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { device: target.device, dtype: target.dtype,
      progress_callback: (p) => { if (p.status === 'progress' && /\.onnx$/.test(p.file || '') && status.upgrade) status.upgrade.pct = Math.round(p.progress || 0); } });
    if (gen !== loadGen) { vision.dispose?.(); return; }          // settings changed during the download
    const old = m.vision;
    m.vision = vision;
    currentDevice = target.device; currentDtype = target.dtype; perImageMs = 0;
    status.device = target.device; status.dtype = target.dtype;
    console.log(`[ИИндус] перешёл на видеокарту: ${target.dtype}`);
    setTimeout(() => old.dispose?.(), 5000);                  // the old session may be classifying a frame right now, release it a bit later
  } catch (e) {
    if (gen === loadGen) status.fallback = 'видеокарта не завелась (' + String(e?.message || e).slice(0, 80) + ') — считаю на процессоре';
  } finally {
    if (gen === loadGen) status.upgrade = null;
  }
}

function loadModel() {
  if (ready) return ready;
  status.state = 'loading';
  status.error = null;
  ready = (async () => {
    const t0 = performance.now();
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = new URL('vendor/transformers/', base).href;
    // WASM threads only with isolation (no SharedArrayBuffer otherwise); half the cores, at most 4, since the overlay needs CPU too
    const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;
    env.backends.onnx.wasm.numThreads = threads;
    env.backends.onnx.wasm.proxy = false;
    status.threads = threads;
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.file) status.progress[p.file] = Math.round(p.progress || 0);
      if (p.status === 'done' && p.file) status.progress[p.file] = 100;
    };
    const [prompts, head] = await Promise.all([loadJson('assets/model/prompts.json'), loadJson('assets/model/head.json')]);
    if (prompts.id !== MODEL_ID || head.backbone !== prompts.backbone) throw new Error('prompts.json/head.json не от этой модели');
    const S = prompts.sets;
    const zs = {
      labels: [...S.context.labels, ...S.person.labels, ...S.negative.labels],
      emb: [...S.context.emb, ...S.person.emb, ...S.negative.emb],
      npos: S.context.labels.length + S.person.labels.length,
    };
    status.head = { classes: head.classes, val: head.val };
    const processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
    let { device, dtype } = await pickBackend(), vision, upgradeTo = null;
    // The GPU weights (fp16, ~170 MB) are not downloaded yet. Do not make the user wait: run on the CPU right away
    // (the 8-bit weights are usually cached) and swap in the GPU version once it has downloaded in the background.
    // Before this, the model stayed silent for a minute after an update, and it looked as if the extension did not start.
    if (device === 'webgpu' && !(await isCached(dtype))) {
      upgradeTo = { device, dtype };
      device = 'wasm'; dtype = hiPrecision ? 'fp32' : 'q8';
    }
    try {
      vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { device, dtype, progress_callback });
    } catch (e) {
      if (device !== 'webgpu') throw e;
      // the GPU did not start (old driver, missing op): fall back to the CPU silently
      status.fallback = 'WebGPU не завёлся (' + String(e?.message || e).slice(0, 80) + ') — считаю на процессоре';
      device = 'wasm'; dtype = hiPrecision ? 'fp32' : 'q8';
      vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { device, dtype, progress_callback });
    }
    currentDevice = device; currentDtype = dtype; perImageMs = 0;
    status.state = 'ready';
    status.dtype = dtype;
    status.device = device;
    status.loadedAt = Date.now();
    console.log(`[ИИндус] модель готова за ${((performance.now() - t0) / 1000).toFixed(1)}с: ${device}, ${dtype}, потоков ${status.threads}${status.gpu ? ', ' + status.gpu : ''}`);
    const m = { processor, vision, zs, gate: S.gate, head };
    if (upgradeTo) upgrade(m, upgradeTo, loadGen);
    return m;
  })().catch((e) => {
    status.state = 'error';
    status.error = String(e?.message || e);
    ready = null;
    throw e;
  });
  return ready;
}

// Screenshot -> canvas (cropped to the reel rectangle if needed), scaled to ~448 px on the long side.
async function frameToCanvas(dataUrl, rect, dpr) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (rect) {
    sx = Math.max(0, Math.round(rect.x * dpr));
    sy = Math.max(0, Math.round(rect.y * dpr));
    sw = Math.min(bmp.width - sx, Math.round(rect.w * dpr));
    sh = Math.min(bmp.height - sy, Math.round(rect.h * dpr));
  }
  if (sw < 8 || sh < 8) throw new Error('область рилса пустая');
  const scale = Math.min(1, 448 / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close();
  return canvas;
}

// Trim black bars (letterbox/pillarbox). Landscape videos in reels come with black bars, and CLIP then
// sees a black frame with a picture in the middle. Rows and columns with mean brightness below 18 are cut.
function trimBlackBorders(src) {
  const { width: w, height: h } = src;
  const data = src.getContext('2d').getImageData(0, 0, w, h).data;
  const rows = new Float32Array(h), cols = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      rows[y] += lum; cols[x] += lum;
    }
  }
  const T = 18;
  let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
  while (y0 < y1 && rows[y0] / w < T) y0++;
  while (y1 > y0 && rows[y1] / w < T) y1--;
  while (x0 < x1 && cols[x0] / h < T) x0++;
  while (x1 > x0 && cols[x1] / h < T) x1--;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  if (cw < w * 0.3 || ch < h * 0.3 || (cw === w && ch === h)) return src; // almost all black, or no bars
  const c = new OffscreenCanvas(cw, ch);
  c.getContext('2d').drawImage(src, x0, y0, cw, ch, 0, 0, cw, ch);
  return c;
}

function cropCanvas(src, [x0, y0, x1, y1]) {
  const sx = Math.round(src.width * x0), sy = Math.round(src.height * y0);
  const sw = Math.round(src.width * (x1 - x0)), sh = Math.round(src.height * (y1 - y0));
  const c = new OffscreenCanvas(sw, sh);
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

// small preview (64 px) so the popup can show which frame was labelled
async function thumbOf(canvas) {
  const k = 64 / Math.max(canvas.width, canvas.height);
  const c = new OffscreenCanvas(Math.max(1, Math.round(canvas.width * k)), Math.max(1, Math.round(canvas.height * k)));
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.5 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
  return 'data:image/jpeg;base64,' + btoa(bin);
}

async function toRawImage(canvas) {
  if (typeof RawImage.fromCanvas === 'function') return RawImage.fromCanvas(canvas);
  return RawImage.fromBlob(await canvas.convertToBlob());
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
function softmax(arr) {
  const m = Math.max(...arr);
  const ex = arr.map((v) => Math.exp(v - m));
  const s = ex.reduce((a, b) => a + b, 0);
  return ex.map((v) => v / s);
}

async function embed(m, canvas) {
  return (await embedMany(m, [canvas]))[0];
}
// several images in one pass (frame and crops): on a GPU it costs about the same as one, on a CPU it saves overhead
async function embedMany(m, canvases) {
  const images = await Promise.all(canvases.map(toRawImage));
  const { image_embeds } = await m.vision(await m.processor(images));
  return image_embeds.normalize(2, -1).tolist();
}

// the compute target or precision changed, so the weights have to be reloaded
function configure({ compute: c, hiPrecision: hp }) {
  const nc = c || compute, nh = hp === undefined ? hiPrecision : !!hp;
  if (nc === compute && nh === hiPrecision) return;
  compute = nc; hiPrecision = nh; status.fallback = null; status.upgrade = null;
  ready = null; loadGen++; status.progress = {}; status.state = 'loading';
}

async function run({ dataUrl, rect, dpr, threshold = 0.6, personal: personalArg, compute: c, hiPrecision: hp }) {
  // the personal head comes with every frame, so it survives a worker restart
  if (personalArg !== undefined) personal = personalArg && personalArg.W ? personalArg : null;
  configure({ compute: c, hiPrecision: hp });
  const m = await loadModel();
  const t0 = performance.now();
  const full = trimBlackBorders(await frameToCanvas(dataUrl, rect, dpr));

  // 1) frame and crops in one pass. Crops (top-centre, where faces usually are, and centre) as many as speed
  // allows: both on a GPU, one on a slow CPU.
  const cropNames = !perImageMs || perImageMs > 70 ? ['top'] : ['top', 'center'];
  const embs = await embedMany(m, [full, ...cropNames.map((n) => cropCanvas(full, CROPS[n]))]);
  const e = embs[0];
  perImageMs = (performance.now() - t0) / embs.length;
  status.passes = embs.length;
  // scene (zero-shot) and the large-face gate use the full frame
  const pz = softmax(m.zs.emb.map((t) => LOGIT_SCALE * dot(t, e)));
  const zs = pz.slice(0, m.zs.npos).reduce((a, b) => a + b, 0);
  const pg = softmax(m.gate.emb.map((t) => LOGIT_SCALE * dot(t, e)));
  const pClose = pg[0];

  // 2) trained face head: maximum over the frame and the crops
  let pInd = 0, best = e;
  for (const x of embs) {
    const p = sigmoid(dot(m.head.Wbin, x) + m.head.bbin);
    if (p > pInd) { pInd = p; best = x; }
  }
  const p7 = softmax(m.head.W.map((w, i) => dot(w, best) + m.head.b[i]));
  const guess = m.head.classes[p7.indexOf(Math.max(...p7))];

  // 2b) scene head, trained on Indian scenes against Georgian, Caucasian, Slavic and other dances
  let scene = zs, pScene = null;
  if (m.head.Wscene) {
    pScene = sigmoid(dot(m.head.Wscene, e) + m.head.bscene);
    scene = (1 - SCENE_HEAD_W) * zs + SCENE_HEAD_W * pScene;
  }

  // 3) blend
  const w = W0 + W1 * pClose;
  let score = (1 - w) * scene + w * pInd;

  // 4) personal correction: what the user taught the model on their own feed
  let pPersonal = null;
  if (personal && personal.weight > 0) {
    pPersonal = sigmoid(dot(personal.W, e) + personal.b);
    score = (1 - personal.weight) * score + personal.weight * pPersonal;
  }

  // keep the frame ready: the popup can label it as a fine-tuning example
  lastSample = { emb: e.map((v) => +v.toFixed(4)), thumb: await thumbOf(full), at: Date.now(), score: +score.toFixed(3) };
  lastFull = full;                                     // the frame itself, for the dataset; encoded to JPEG only once it is labelled

  const top = pz
    .map((p, i) => ({ label: m.zs.labels[i], p: +p.toFixed(3), indian: i < m.zs.npos }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 3);
  status.runs++;
  status.lastMs = Math.round(performance.now() - t0);
  return {
    indian: score >= threshold,
    score: +score.toFixed(3),
    threshold,
    parts: { scene: +scene.toFixed(3), zeroShot: +zs.toFixed(3), sceneHead: pScene === null ? null : +pScene.toFixed(3),
      face: +pInd.toFixed(3), faceWeight: +w.toFixed(2), closeup: +pClose.toFixed(2), guess,
      personal: pPersonal === null ? null : +pPersonal.toFixed(3), personalWeight: personal ? personal.weight : 0 },
    top,
    ms: status.lastMs,
    dtype: currentDtype,
    device: currentDevice,
  };
}

// Logistic regression on embeddings: 512 features, hundreds of examples, trains in a fraction of a second.
// Classes are weighted, otherwise with mostly negative labels the model learns to always say no.
function trainLogreg(X, y, { epochs = 400, lr = 0.6, l2 = 2e-3 } = {}) {
  const n = X.length, d = X[0].length;
  const W = new Float64Array(d); let b = 0;
  const pos = y.reduce((a, v) => a + v, 0), neg = n - pos;
  const wPos = pos ? n / (2 * pos) : 0, wNeg = neg ? n / (2 * neg) : 0;
  for (let e = 0; e < epochs; e++) {
    const gW = new Float64Array(d); let gb = 0;
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let z = b; for (let j = 0; j < d; j++) z += W[j] * xi[j];
      const g = (1 / (1 + Math.exp(-z)) - y[i]) * (y[i] ? wPos : wNeg);
      for (let j = 0; j < d; j++) gW[j] += g * xi[j];
      gb += g;
    }
    for (let j = 0; j < d; j++) W[j] -= lr * (gW[j] / n + l2 * W[j]);
    b -= lr * gb / n;
  }
  return { W: Array.from(W, (v) => +v.toFixed(5)), b: +b.toFixed(5) };
}

function train(samples) {
  const X = samples.map((s) => s.emb), y = samples.map((s) => s.y);
  const pos = y.reduce((a, v) => a + v, 0);
  if (samples.length < 8 || pos < 3 || y.length - pos < 3) throw new Error('нужно хотя бы по 3 примера каждого вида и 8 всего');
  // holdout: every fourth example within each class, so both classes are in it
  const te = new Set();
  for (const cls of [0, 1]) {
    const idx = samples.map((s, i) => (s.y === cls ? i : -1)).filter((i) => i >= 0);
    for (let k = 3; k < idx.length; k += 4) te.add(idx[k]);
    if (!idx.some((i) => te.has(i)) && idx.length >= 4) te.add(idx[idx.length - 1]);
  }
  const trX = [], trY = [], teX = [], teY = [];
  samples.forEach((s, i) => (te.has(i) ? (teX.push(s.emb), teY.push(s.y)) : (trX.push(s.emb), trY.push(s.y))));
  let acc = null;
  if (teY.length >= 2 && new Set(trY).size === 2) {
    const m = trainLogreg(trX, trY);
    const ok = teY.filter((t, i) => (sigmoid(dot(m.W, teX[i]) + m.b) >= 0.5 ? 1 : 0) === t).length;
    acc = +(ok / teY.length).toFixed(2);
  }
  const model = trainLogreg(X, y);                     // the final fit uses all examples
  return { ...model, acc, n: samples.length, pos, neg: samples.length - pos };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    switch (type) {
      case 'init':
        // do not load the model right away: settings (compute target, precision) arrive with the first warmup/run.
        // This used to load in auto mode, which touched the GPU before the user's choice was known.
        base = data.base;
        self.postMessage({ id, result: { ok: true } });
        break;
      case 'run':
        self.postMessage({ id, result: await run(data) });
        break;
      case 'warmup':
        configure(data);
        await loadModel();
        self.postMessage({ id, result: { ...status } });
        break;
      case 'status':
        self.postMessage({ id, result: { ...status, personal: personal ? { weight: personal.weight, trained: true } : null } });
        break;
      case 'sample': {                                 // the last analysed frame, a candidate example
        let frame = null;
        if (data.withFrame && lastFull && lastSample) {
          const blob = await lastFull.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          frame = { jpeg: 'data:image/jpeg;base64,' + btoa(bin), w: lastFull.width, h: lastFull.height };
        }
        self.postMessage({ id, result: lastSample && { ...lastSample, frame, dtype: currentDtype, device: currentDevice } });
        break;
      }
      case 'train':
        self.postMessage({ id, result: train(data.samples) });
        break;
      default:
        self.postMessage({ id, error: 'неизвестное сообщение ' + type });
    }
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
