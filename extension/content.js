// Content script. Runs on Instagram Reels and YouTube Shorts.
// Tracks which reel is on screen, asks the background page to grab a frame and classify it,
// and on a positive verdict starts the overlay (and likes the reel if auto-like is on).
(() => {
  if (window.top !== window) return;

  const TAG = '[ИИндус]';
  const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
  const DEFAULTS = { enabled: true, autoLike: false, effects: true, sound: true, volume: 0.7, threshold: 0.6, dancers: 18, interval: 500, autoScroll: false, skipAfter: 4, dwell: 15, fx: 1, cows: true, gods: true, graphics: 'auto', fall: 'theme', backdrop: true, animals: true, traffic: true };
  let settings = { ...DEFAULTS };
  let dead = false; // the extension was reloaded, this context is dead

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    overlaySend({ type: 'IINDU_SETTINGS', settings });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
    if (!settings.enabled || !settings.effects) stopEffects();
    overlaySend({ type: 'IINDU_SETTINGS', settings });
  });

  // ---------- platforms ----------
  const LIKE_LABELS = new Set(['like', 'нравится', 'me gusta', 'gefällt mir', "j’aime", "j'aime", 'curtir', 'beğen', 'mi piace']);
  const UNLIKE_LABELS = new Set(['unlike', 'не нравится', 'ya no me gusta', 'gefällt mir nicht mehr', "je n’aime plus", "je n'aime plus", 'descurtir', 'beğenmekten vazgeç', 'non mi piace più']);

  function visibleArea(r) {
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  // The most prominent video on screen: covers at least 8% of the viewport and is at least 40% visible.
  function mostVisibleVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) continue;
      const a = visibleArea(r);
      if (a > bestArea && a >= 0.4 * r.width * r.height && a >= 0.08 * innerWidth * innerHeight) {
        best = v; bestArea = a;
      }
    }
    return best;
  }

  function dblclickLike(video) {
    const r = video.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const target = document.elementFromPoint(cx, cy) || video;
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }));
    return 'dblclick';
  }

  // nearest scrollable ancestor (the reels feed is a scroll-snap container)
  function scrollContainer(el) {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (/(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 10) return e;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Ways to move the feed forward. None of them works every time: Instagram's scroll-snap pushes
  // programmatic scrolling back, the "next" button exists only in some layouts, and arrow keys work only
  // when focus is outside a text field. So they are tried in turn and the result is checked (see advance).
  function clickNextButton() {
    const labels = ['next', 'следующее', 'следующий', 'вперёд', 'siguiente', 'suivant', 'weiter'];
    const nodes = [...document.querySelectorAll('button[aria-label], [role="button"][aria-label], svg[aria-label]')];
    for (const n of nodes) {
      const l = (n.getAttribute('aria-label') || '').trim().toLowerCase();
      if (!labels.some((x) => l === x || l.startsWith(x + ' '))) continue;
      const r = n.getBoundingClientRect();
      if (r.height < 10 || r.bottom < 0 || r.top > innerHeight) continue;
      (n.closest('button, [role="button"]') || n).click();
      return true;
    }
    return false;
  }

  function pressArrowDown(video) {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : (video.closest('[tabindex], main, body') || document.body);
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true, composed: true }));
    }
    return true;
  }

  function wheelDown(video) {
    const r = video.getBoundingClientRect();
    const opts = { deltaY: Math.max(300, r.height * 0.9), deltaMode: 0, bubbles: true, cancelable: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const el = document.elementFromPoint(opts.clientX, Math.min(innerHeight - 2, opts.clientY)) || video;
    el.dispatchEvent(new WheelEvent('wheel', opts));
    return true;
  }

  // Scroll to the next <video>: instantly first (smooth scrolling fights scroll-snap), then through the container.
  function scrollToNextVideo(video) {
    const r = video.getBoundingClientRect();
    const next = [...document.querySelectorAll('video')]
      .map((v) => ({ v, top: v.getBoundingClientRect().top }))
      .filter((x) => x.v !== video && x.top > r.top + 10)
      .sort((a, b) => a.top - b.top)[0];
    if (next) { next.v.scrollIntoView({ behavior: 'instant', block: 'center' }); return true; }
    const sc = scrollContainer(video);
    if (sc && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 10) { sc.scrollBy({ top: Math.max(r.height, sc.clientHeight * 0.9), behavior: 'instant' }); return true; }
    return false;
  }

  const instagram = {
    name: 'instagram',
    isReelsPage: () => /^\/reels?\//.test(location.pathname) || location.pathname.startsWith('/reels'),
    activeVideo: mostVisibleVideo,
    key: (v) => location.pathname + '|' + (v.currentSrc || v.src || v.poster || ''),
    ways: [['кнопка', clickNextButton], ['клавиша', pressArrowDown], ['колесо', wheelDown], ['прокрутка', scrollToNextVideo]],
    like(video) {
      // walk up from the video to the nearest ancestor that holds this reel's like button;
      // the button has to be on screen and overlap the video vertically, otherwise it belongs to the next reel
      const vr = video.getBoundingClientRect();
      const sameReel = (r) => r.height >= 18 && r.bottom > 0 && r.top < innerHeight && r.bottom > vr.top && r.top < vr.bottom;
      for (let el = video; el && el !== document.body; el = el.parentElement) {
        const svgs = [...el.querySelectorAll('svg[aria-label]')].filter((s) => sameReel(s.getBoundingClientRect()));
        const hit = svgs.find((s) => {
          const l = s.getAttribute('aria-label').trim().toLowerCase();
          return LIKE_LABELS.has(l) || UNLIKE_LABELS.has(l);
        });
        if (!hit) continue;
        const label = hit.getAttribute('aria-label').trim().toLowerCase();
        if (UNLIKE_LABELS.has(label)) return 'already';
        const btn = hit.closest('[role="button"], button') || hit.parentElement;
        btn.click();
        return 'button';
      }
      return dblclickLike(video);
    },
  };

  const youtube = {
    name: 'youtube',
    isReelsPage: () => location.pathname.startsWith('/shorts'),
    activeVideo() {
      const active = document.querySelector('ytd-reel-video-renderer[is-active] video, ytd-shorts [is-active] video');
      return active && visibleArea(active.getBoundingClientRect()) > 0 ? active : mostVisibleVideo();
    },
    key: () => location.pathname,
    ways: [
      ['кнопка', () => { const b = document.querySelector('#navigation-button-down button, button[aria-label="Next video"], button[aria-label="Следующее видео"]'); if (!b) return false; b.click(); return true; }],
      ['клавиша', pressArrowDown],
      ['прокрутка', scrollToNextVideo],
    ],
    like(video) {
      const root = video.closest('ytd-reel-video-renderer') || document.querySelector('ytd-reel-video-renderer[is-active]') || document;
      const btn = root.querySelector('#like-button button, like-button-view-model button, ytd-toggle-button-renderer#like-button button, button[aria-label*="like" i]:not([aria-label*="dislike" i])');
      if (!btn) return dblclickLike(video);
      if (btn.getAttribute('aria-pressed') === 'true') return 'already';
      btn.click();
      return 'button';
    },
  };

  const platform = location.hostname.includes('youtube.com') ? youtube : instagram;

  // ---------- messaging with the background page ----------
  async function bg(msg) {
    if (dead) return { error: 'dead' };
    try {
      return await chrome.runtime.sendMessage({ target: 'background', ...msg });
    } catch (e) {
      if (/Extension context invalidated/i.test(String(e))) { dead = true; stopEffects(); }
      return { error: String(e?.message || e) };
    }
  }

  // ---------- overlay (extension iframe on top of the page, ignores clicks) ----------
  let iframe = null, overlayReady = false;
  const queue = [];
  function ensureOverlay() {
    if (iframe && iframe.isConnected) return iframe;
    iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('overlay.html');
    iframe.allow = 'autoplay';
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('aria-hidden', 'true');
    Object.assign(iframe.style, {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: '0',
      pointerEvents: 'none', zIndex: '2147483647', background: 'transparent', colorScheme: 'normal',
    });
    overlayReady = false;
    document.documentElement.appendChild(iframe);
    return iframe;
  }
  function overlaySend(msg) {
    if (!iframe || !iframe.isConnected) return;
    if (!overlayReady) { queue.push(msg); return; }
    iframe.contentWindow.postMessage(msg, EXT_ORIGIN);
  }
  window.addEventListener('message', (ev) => {
    if (ev.origin !== EXT_ORIGIN || !ev.data?.type) return;
    if (ev.data.type === 'IINDU_READY') {
      overlayReady = true;
      overlaySend({ type: 'IINDU_SETTINGS', settings });
      while (queue.length) overlaySend(queue.shift());
    } else if (ev.data.type === 'IINDU_AUDIO_BLOCKED') {
      // autoplay is blocked inside the iframe, so audio plays from the page context, which has user activation
      playPageAudio(ev.data.src);
    }
  });

  let pageAudio = null;
  function playPageAudio(src) {
    stopPageAudio();
    pageAudio = new Audio(src);
    pageAudio.loop = true;
    pageAudio.volume = settings.volume;
    pageAudio.play().catch((e) => console.warn(TAG, 'звук заблокирован и на странице:', e.message));
  }
  function stopPageAudio() {
    if (pageAudio) { pageAudio.pause(); pageAudio.src = ''; pageAudio = null; }
  }

  // Frame from a <video>. Returns { dataUrl } | { retry: true } (video not ready) | { tainted: true } (cross-origin).
  function grabFrame(video) {
    if (!video.videoWidth || video.readyState < 2) return { retry: true };
    try {
      const scale = Math.min(1, 448 / Math.max(video.videoWidth, video.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(video.videoWidth * scale));
      c.height = Math.max(1, Math.round(video.videoHeight * scale));
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      return { dataUrl: c.toDataURL('image/jpeg', 0.85) };
    } catch (e) {
      console.warn(TAG, 'кадр из <video> не взять (' + e.message + '), прошу снимок вкладки');
      return { tainted: true };
    }
  }

  function rectOf(v) {
    const r = v.getBoundingClientRect();
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    return { x, y, w: Math.min(r.right, innerWidth) - x, h: Math.min(r.bottom, innerHeight) - y };
  }

  let effectsOn = false;
  let celebration = 0;
  function startEffects(video, res) {
    ensureOverlay();
    effectsOn = true;
    overlaySend({ type: 'IINDU_START', id: ++celebration, score: res.score, top: res.top, parts: res.parts, rect: rectOf(video), settings });
  }
  function stopEffects() {
    if (!effectsOn) return;
    effectsOn = false;
    overlaySend({ type: 'IINDU_STOP' });
    stopPageAudio();
  }
  function hud(text, kind = 'info') {
    if (!settings.effects) return;
    ensureOverlay();
    overlaySend({ type: 'IINDU_HUD', text, kind });
  }

  // ---------- main loop, real time ----------
  // While a reel is on screen, the model looks at a frame every settings.interval ms and the score is smoothed (EMA).
  // Effects start once the smoothed score crosses the threshold. They stop when the raw score stays below 60% of the
  // threshold for two frames in a row and the effects have run for at least 2.5 s, so they do not flicker.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let currentKey = null, currentVideo = null, scanGen = 0;
  let ema = 0, belowFrames = 0, triggeredAt = 0, reelScanned = false, reelIndian = false, lastLogged = -1;
  let reelStartedAt = 0, lastUserInput = 0, scrolledFrom = null, scrolledAt = 0, noFrameSince = 0;
  const liked = new Set();

  // the user is scrolling by hand: autopilot stays quiet for 4 s
  for (const ev of ['wheel', 'keydown', 'pointerdown', 'touchstart']) {
    window.addEventListener(ev, () => { lastUserInput = Date.now(); }, { capture: true, passive: true });
  }

  // Move to the next reel and make sure it really changed. Methods are tried one by one because Instagram's
  // scroll-snap can push programmatic scrolling back. That is why scrolling used to work only every other time.
  let advancing = false;
  async function advance(video, reason) {
    if (advancing) return;
    advancing = true;
    const before = currentKey, beforeTop = video.getBoundingClientRect().top;
    const changed = () => currentKey !== before || Math.abs((currentVideo || video).getBoundingClientRect().top - beforeTop) > 40;
    try {
      stopEffects();                       // the celebration must not carry over to the next reel
      hud(`Листаю дальше: ${reason}`);
      for (const [name, way] of platform.ways) {
        let fired = false;
        try { fired = way(video); } catch (e) { console.warn(TAG, `способ «${name}» упал:`, e.message); }
        if (!fired) continue;
        for (let i = 0; i < 9; i++) {      // up to ~1.35 s per attempt; tick() updates currentKey
          await sleep(150);
          if (dead || !settings.autoScroll) return;
          if (changed()) { console.log(TAG, `листаю дальше (${name}): ${reason}`); return; }
        }
        console.debug(TAG, `способ «${name}» не сработал, пробую следующий`);
      }
      console.log(TAG, 'не удалось перелистнуть — жду');
      hud('Не удалось перелистнуть', 'error');
      scrolledAt = Date.now() + 10000;     // back off: next attempt in ~15 s
    } finally {
      advancing = false;
    }
  }

  function autoScrollTick(video) {
    if (!settings.autoScroll || !video || document.hidden || advancing) return;
    if (Date.now() - lastUserInput < 4000) return;
    if (scrolledFrom === currentKey && Date.now() - scrolledAt < 5000) return; // already scrolled, waiting for the reel to change
    const now = Date.now();
    let reason = null;
    if (reelIndian) {
      if (now - triggeredAt > settings.dwell * 1000) reason = 'индус досмотрен';
    } else if (reelScanned && now - reelStartedAt > settings.skipAfter * 1000) {
      reason = `не индус за ${settings.skipAfter} с`;
    } else if (noFrameSince && now - noFrameSince > settings.skipAfter * 1000 + 5000) {
      reason = 'видео не грузится';
    }
    if (!reason) return;
    scrolledFrom = currentKey; scrolledAt = now;
    advance(video, reason);
  }

  function onNewReel(video, key) {
    stopEffects();
    currentKey = key; currentVideo = video;
    ema = 0; belowFrames = 0; triggeredAt = 0; reelScanned = false; reelIndian = false; lastLogged = -1;
    reelStartedAt = Date.now(); noFrameSince = 0;
    scanGen++;
    if (video) scanLoop(video, key, scanGen);
  }

  async function scanLoop(video, key, gen) {
    await sleep(300); // give the video time to start
    while (!dead && gen === scanGen && settings.enabled && video.isConnected) {
      if (document.hidden || advancing) { await sleep(300); continue; } // mid-scroll the frame is a blur of two reels
      const t0 = performance.now();
      const frame = grabFrame(video);
      if (frame.retry) noFrameSince = noFrameSince || Date.now(); else noFrameSince = 0;
      if (frame.dataUrl) {
        const res = await withWakeHud(bg({ type: 'CLASSIFY', dataUrl: frame.dataUrl, threshold: settings.threshold }));
        if (gen !== scanGen) return;
        if (!res || res.error) {
          console.warn(TAG, 'ошибка классификации:', res?.error || 'нет ответа');
          hud('ИИндус: ' + (res?.error || 'нет ответа'), 'error');
          await sleep(1500);
          continue;
        }
        onScore(video, key, res);
      } else if (frame.tainted) {
        hud('ИИндус не видит видео (чужой origin)', 'error');
        return;
      }
      await sleep(Math.max(60, settings.interval - (performance.now() - t0)));
    }
  }

  // The model is loading for the first time (or after an update), so a frame takes long to classify.
  // The page shows a wake-up message with the download progress, otherwise it looks as if nothing happens.
  async function withWakeHud(p) {
    let done = false, shown = false;
    (async () => {
      await sleep(1200);
      while (!done && !dead) {
        const st = await bg({ type: 'STATUS' });
        if (done) break;
        if (st && st.state === 'loading') {
          const files = Object.entries(st.progress || {});
          const big = files.filter(([f]) => /\.onnx$/.test(f)).map(([, v]) => v);
          const pct = big.length ? Math.min(...big) : files.length ? Math.min(...files.map(([, v]) => v)) : 0;
          hud(pct < 100 ? `ИИндус просыпается: качаю модель ${pct}% (только в первый раз)` : 'ИИндус просыпается…', 'info');
          shown = true;
        }
        await sleep(1000);
      }
    })();
    try { return await p; } finally { done = true; if (shown) hud('ИИндус проснулся и смотрит 👀', 'info'); }
  }

  function onScore(video, key, res) {
    ema = reelScanned ? 0.6 * res.score + 0.4 * ema : res.score;
    if (!reelScanned) { reelScanned = true; bg({ type: 'EVENT', patch: { scanned: 1 } }); }
    const pct = Math.round(ema * 100);
    overlayLive({ type: 'IINDU_SCORE', score: ema, raw: res.score, threshold: settings.threshold, top: res.top, parts: res.parts, running: effectsOn });
    if (Math.abs(pct - lastLogged) >= 10) { lastLogged = pct; console.debug(TAG, `${pct}%`, res.parts ? `сцена ${Math.round(res.parts.scene * 100)}% лицо ${Math.round(res.parts.face * 100)}% (${res.parts.guess}, вес ${res.parts.faceWeight})` : '', res.top.slice(0, 2).map((t) => `${t.label} ${t.p}`).join(' | '), `${res.ms}ms`); }

    if (!effectsOn) {
      // start on the smoothed score, or right away on a very confident frame
      if (ema >= settings.threshold || res.score >= Math.min(0.95, settings.threshold + 0.25)) trigger(video, key, res);
    } else if (res.score < settings.threshold * 0.6) {
      // stop when two raw frames in a row are clearly negative (about 1 s) and the effects have run for at least 2.5 s
      belowFrames++;
      if (belowFrames >= 2 && Date.now() - triggeredAt > 2500) {
        console.log(TAG, `индус ушёл из кадра (${pct}%)`);
        stopEffects();
        hud('Индус ушёл из кадра', 'no');
      }
    } else belowFrames = 0;
  }

  function trigger(video, key, res) {
    const pct = Math.round(ema * 100);
    belowFrames = 0; triggeredAt = Date.now();
    let likeResult = 'off';
    // without an Instagram login, clicking like opens a login dialog over the feed, so leave it alone
    if (settings.autoLike && platform === instagram && !/(^|; )ds_user_id=/.test(document.cookie)) likeResult = 'not-logged-in';
    else if (settings.autoLike && !liked.has(key)) {
      try { likeResult = platform.like(video); } catch (e) { likeResult = 'error'; console.warn(TAG, e); }
      liked.add(key);
      if (likeResult === 'button' || likeResult === 'dblclick') { bg({ type: 'EVENT', patch: { liked: 1 } }); if (settings.effects) { ensureOverlay(); overlaySend({ type: 'IINDU_LIKE' }); } }
    }
    if (!reelIndian) { reelIndian = true; bg({ type: 'EVENT', patch: { indian: 1 } }); }
    console.log(TAG, `ИНДУС! ${pct}%, лайк: ${likeResult}`);
    if (settings.effects) startEffects(video, { ...res, score: ema });
    else hud(`ИНДУС! ${pct}% · лайк: ${likeResult}`, 'yes');
  }

  // send the live indicator only if the overlay exists or effects are on, so no iframe is created for nothing
  function overlayLive(msg) {
    if (!settings.effects) return;
    ensureOverlay();
    overlaySend(msg);
  }

  function tick() {
    if (dead) return;
    if (!settings.enabled) { if (currentKey) onNewReel(null, null); return; }
    const video = platform.activeVideo();
    const key = video ? platform.key(video) : null;
    if (key !== currentKey) onNewReel(video, key);
    else {
      if (effectsOn && video) overlaySend({ type: 'IINDU_RECT', rect: rectOf(video) });
      autoScrollTick(video);
    }
    if (document.hidden && effectsOn) stopEffects();
  }
  setInterval(tick, 300);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('pagehide', stopEffects);

  console.log(TAG, `AIndus подключён (${platform.name})`);
})();
