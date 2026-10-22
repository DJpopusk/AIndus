// Offscreen document: a thin layer between the service worker and the Web Worker that runs the model.
// The model itself lives in iindus.worker.js, on its own thread so inference does not slow the overlay down.

const worker = new Worker(chrome.runtime.getURL('iindus.worker.js'), { type: 'module' });
const pending = new Map();
let seq = 0;

function call(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...payload, id, type });
  });
}

worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.error) p.reject(new Error(data.error));
  else p.resolve(data.result);
};
worker.onerror = (e) => {
  console.error('[ИИндус] worker:', e.message);
  for (const p of pending.values()) p.reject(new Error('worker упал: ' + e.message));
  pending.clear();
};

// extension base URL; the worker has no chrome.runtime
call('init', { base: chrome.runtime.getURL('') }).catch((e) => console.warn('[ИИндус] init:', e));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'RUN':
        return call('run', msg);
      case 'WARMUP':
        return call('warmup', { compute: msg.compute, hiPrecision: msg.hiPrecision });
      case 'STATUS':
        return call('status');
      case 'SAMPLE':
        return call('sample', { withFrame: msg.withFrame });
      case 'TRAIN':
        return call('train', { samples: msg.samples });
      default:
        return { error: 'неизвестное сообщение ' + msg.type };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
