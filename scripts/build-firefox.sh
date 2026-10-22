#!/usr/bin/env bash
# Builds the Firefox variant of the extension into dist/firefox/ (and dist/aindus-<ver>-firefox.zip).
#
#   scripts/build-firefox.sh              build only
#   scripts/build-firefox.sh --lint       build and run web-ext lint
#   scripts/build-firefox.sh --run        build and start Firefox with the extension (temporary install)
#   scripts/build-firefox.sh --selftest   build with a model self-test and run headless Firefox
#
# Differences from the Chrome version:
#   * the background is an event page (background.scripts), not a service worker: Firefox MV3 has no service worker;
#   * there is no chrome.offscreen, so the model runs in a Worker right on the background page (see background.js);
#   * chrome.* in Gecko takes callbacks, so compat.js (chrome = browser) is injected into every context;
#   * browser_specific_settings.gecko.id is required (GECKO_ID=... when building for AMO), and so is the data collection declaration.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/extension"
OUT="$ROOT/dist/firefox"
MODE="${1:-}"

python3 "$ROOT/scripts/make-credits.py" >/dev/null
rm -rf "$OUT"; mkdir -p "$OUT"
( cd "$SRC" && tar cf - --exclude='.DS_Store' . ) | ( cd "$OUT" && tar xf - )

python3 - "$OUT" "$MODE" <<'PY'
import json, os, re, sys
out, mode = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(out, 'manifest.json'), encoding='utf-8'))

scripts = ['compat.js', 'background.js']
if mode == '--selftest':
    scripts.append('selftest.js')
m['background'] = {'scripts': scripts}                 # event page: it has a DOM and Worker
m['permissions'] = [p for p in m['permissions'] if p != 'offscreen']
m.pop('minimum_chrome_version', None)
# page isolation (for multithreaded WASM) is Chrome-only; in Firefox the model runs single-threaded or on WebGPU
m.pop('cross_origin_embedder_policy', None)
m.pop('cross_origin_opener_policy', None)
# a stable, unique id (GECKO_ID=...), AMO links versions by it. 140 is the first version with built-in
# data collection consent: since November 2025 AMO rejects new extensions without data_collection_permissions.
# Nothing is collected by default; optional collection is embeddings of labelled frames for the shared dataset (websiteContent).
m['browser_specific_settings'] = {'gecko': {
    'id': os.environ.get('GECKO_ID', 'aindus@aindus.local'), 'strict_min_version': '140.0',
    'data_collection_permissions': {'required': ['none'], 'optional': ['websiteContent']}},
    'gecko_android': {'strict_min_version': '142.0'}}           # on Android data collection consent starts at 142
if mode == '--selftest':
    m['host_permissions'] = m.get('host_permissions', []) + ['http://127.0.0.1:8931/*']   # self-test only
for cs in m.get('content_scripts', []):
    cs['js'] = ['compat.js'] + [j for j in cs['js'] if j != 'compat.js']
for war in m.get('web_accessible_resources', []):
    if 'compat.js' not in war['resources']:
        war['resources'].append('compat.js')
json.dump(m, open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

# extension pages: compat.js has to run before the other scripts
for page in ('popup.html', 'overlay.html', 'offscreen.html'):
    p = os.path.join(out, page)
    if not os.path.exists(p):
        continue
    html = open(p, encoding='utf-8').read()
    if 'compat.js' in html:
        continue
    html = re.sub(r'(\s*)(<script\b)', r'\1<script src="compat.js"></script>\1\2', html, count=1)
    open(p, 'w', encoding='utf-8').write(html)

if mode == '--selftest':
    open(os.path.join(out, 'selftest.js'), 'w', encoding='utf-8').write("""
// Firefox build self-test: starts the model right on the background page (Gecko has no offscreen documents)
// and sends the result to a local server, since extension logs from Firefox do not reach stdout.
(async () => {
  const log = (...a) => { const s = a.join(' '); console.log('[SELFTEST]', s);
    fetch('http://127.0.0.1:8931/?' + encodeURIComponent(s)).catch(() => {}); };
  const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('таймаут ' + what)), ms))]);
  try {
    log('offscreen api:', typeof chrome.offscreen, '| worker:', typeof Worker, '| promises:', typeof chrome.storage.sync.get({}).then === 'function');
    const perms = await chrome.permissions.getAll();
    log('host permissions выданы:', JSON.stringify(perms.origins || []));
    log('hf fetch:', await fetch('https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/config.json')
      .then((r) => r.status).catch((e) => 'ОШИБКА ' + e.message));

    // raw worker: shows whether the module starts at all
    const w = new Worker(chrome.runtime.getURL('iindus.worker.js'), { type: 'module' });
    w.onerror = (e) => log('worker onerror:', e.message || '?', e.filename || '', e.lineno || '');
    w.onmessage = (e) => log('worker →', JSON.stringify(e.data).slice(0, 200));
    w.postMessage({ id: 1, type: 'init', base: chrome.runtime.getURL('') });
    await new Promise((r) => setTimeout(r, 2000));
    w.postMessage({ id: 2, type: 'status' });
    await new Promise((r) => setTimeout(r, 2000));
    w.terminate();

    // the full path, as in real use
    const t0 = Date.now();
    const warm = await timeout(model('WARMUP'), 240000, 'warmup').catch((e) => ({ error: String(e) }));
    log('warmup:', JSON.stringify(warm).slice(0, 200), ((Date.now() - t0) / 1000).toFixed(1) + 's');
    const c = new OffscreenCanvas(448, 448), g = c.getContext('2d');
    g.fillStyle = '#ff9933'; g.fillRect(0, 0, 448, 150);
    g.fillStyle = '#ffffff'; g.fillRect(0, 150, 448, 150);
    g.fillStyle = '#138808'; g.fillRect(0, 300, 448, 148);
    const blob = await c.convertToBlob({ type: 'image/jpeg' });
    const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    const t1 = Date.now();
    const res = await timeout(model('RUN', { dataUrl, threshold: 0.6 }), 120000, 'classify').catch((e) => ({ error: String(e) }));
    log('classify:', JSON.stringify(res).slice(0, 260), (Date.now() - t1) + ' ms');
    log(res && !res.error && typeof res.score === 'number' ? 'OK' : 'FAIL');
  } catch (e) {
    log('FAIL', (e && e.message) || e);
  }
})();
""")
print('манифест и страницы адаптированы')
PY

VER=$(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['version'])")
ZIP="$ROOT/dist/aindus-$VER-firefox.zip"
rm -f "$ZIP"; ( cd "$OUT" && zip -qr "$ZIP" . -x "*.DS_Store" )
echo "собрано: $OUT"
echo "архив:   $ZIP ($(du -h "$ZIP" | cut -f1))"

FF="/Applications/Firefox.app/Contents/MacOS/firefox"
case "$MODE" in
  --lint) npx --yes web-ext@8 lint --source-dir "$OUT" --warnings-as-errors=false ;;
  --run)  npx --yes web-ext@8 run --source-dir "$OUT" --firefox "$FF" --start-url "https://www.instagram.com/reels/" \
            --pref devtools.console.stdout.content=true ;;
  --selftest)
    # the background page reports here: extension logs from Firefox do not reach stdout
    LOG="$ROOT/dist/firefox-selftest.log"; : > "$LOG"
    python3 -c "
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        import urllib.parse; msg = urllib.parse.unquote(s.path.lstrip('/?'))
        print(msg, flush=True); s.send_response(204); s.end_headers()
    def log_message(s, *a): pass
http.server.HTTPServer(('127.0.0.1', 8931), H).serve_forever()" >> "$LOG" 2>&1 &
    SRV=$!
    npx --yes web-ext@8 run --source-dir "$OUT" --firefox "$FF" --arg=-headless --no-input >> "$LOG" 2>&1 &
    WEBEXT=$!
    for _ in $(seq 1 90); do grep -qE "^(OK|FAIL)" "$LOG" 2>/dev/null && break; sleep 5; done
    echo "--- самопроверка Firefox:"; grep -vE "web-ext|Installed|extension will reload|^$" "$LOG" | head -20
    kill $SRV $WEBEXT 2>/dev/null || true; pkill -f "web-ext" 2>/dev/null || true
    ;;
esac
