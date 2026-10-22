// Shared dataset server (Cloudflare Worker + D1).
//   POST   /v1/labels                    accept labels {install, items: [...]} (up to 50 per request)
//   DELETE /v1/labels/:install/:id       undo one label (Undo in the popup)
//   DELETE /v1/install/:install          delete everything an install sent (Delete my data)
//   GET    /v1/stats                     total number of labels (for the popup)
//   GET    /v1/export?after=N&limit=M    export for training, only with Authorization: Bearer EXPORT_TOKEN
// IPs and headers are not stored. Everything that comes in is validated: format, vector size and its norm.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SITES = new Set(['instagram', 'youtube', 'other']);
const DTYPES = new Set(['q8', 'fp16', 'fp32']);
const VER = /^[\w.\-/]{1,40}$/;
const EMB_BYTES = 1024;               // 512 × float16
const MAX_BODY = 128 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const bad = (msg, status = 400) => json({ error: msg }, status);

function half(h) {                    // float16 -> number
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}
function decodeEmb(b64) {
  if (typeof b64 !== 'string' || b64.length > 1400) return null;
  let bin;
  try { bin = atob(b64); } catch { return null; }
  if (bin.length !== EMB_BYTES) return null;
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  let n2 = 0;
  for (let i = 0; i < EMB_BYTES; i += 2) {
    const v = half(bytes[i] | (bytes[i + 1] << 8));
    if (!Number.isFinite(v)) return null;
    n2 += v * v;
  }
  // CLIP embeddings are normalised: length close to 1 (allowing for float16 and 4 decimal places)
  return Math.abs(Math.sqrt(n2) - 1) < 0.05 ? bytes : null;
}
const today = () => new Date().toISOString().slice(0, 10);

async function postLabels(req, env) {
  const len = +req.headers.get('Content-Length') || 0;
  if (len > MAX_BODY) return bad('слишком большой запрос', 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return bad('слишком большой запрос', 413);
  let body;
  try { body = JSON.parse(text); } catch { return bad('не JSON'); }
  const { install, items } = body || {};
  if (!UUID.test(install || '')) return bad('install');
  if (!Array.isArray(items) || !items.length || items.length > 50) return bad('items');
  const day = today();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM labels WHERE install = ? AND day = ?').bind(install, day).first();
  const room = Math.max(0, (+env.DAILY_CAP || 300) - n);
  const rows = [];
  for (const it of items) {
    if (!it || !UUID.test(it.id || '') || (it.y !== 0 && it.y !== 1)) continue;
    if (!SITES.has(it.site) || !DTYPES.has(it.dtype) || !VER.test(it.model || '') || !VER.test(it.ext || '')) continue;
    const score = typeof it.score === 'number' && it.score >= 0 && it.score <= 1 ? it.score : null;
    const emb = decodeEmb(it.emb);
    if (!emb) continue;
    rows.push(env.DB.prepare('INSERT OR IGNORE INTO labels (id, install, y, score, site, dtype, model, ext, day, emb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(it.id, install, it.y, score, it.site, it.dtype, it.model, it.ext, day, emb));
    if (rows.length >= room) break;
  }
  // INSERT OR IGNORE: a repeated label (the response got lost and the extension resent it) is not duplicated
  const res = rows.length ? await env.DB.batch(rows) : [];
  const stored = res.reduce((a, r) => a + (r.meta?.changes || 0), 0);
  // the extension drops both accepted and rejected labels; it resends only after a network failure
  return json({ ok: true, stored, capped: rows.length >= room && room < items.length });
}

async function exportRows(url, req, env) {
  if (!env.EXPORT_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.EXPORT_TOKEN}`) return bad('нет доступа', 401);
  const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
  const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit') || '2000', 10) || 2000));
  const { results } = await env.DB.prepare('SELECT rowid, id, install, y, score, site, dtype, model, ext, day, emb FROM labels WHERE rowid > ? ORDER BY rowid LIMIT ?')
    .bind(after, limit).all();
  const items = results.map((r) => ({ ...r, emb: btoa(String.fromCharCode(...new Uint8Array(r.emb))) }));
  return json({ items, next: items.length ? items[items.length - 1].rowid : null });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (req.method === 'POST' && p.join('/') === 'v1/labels') return await postLabels(req, env);
      if (req.method === 'DELETE' && p[0] === 'v1' && p[1] === 'labels' && p.length === 4) {
        if (!UUID.test(p[2]) || !UUID.test(p[3])) return bad('id');
        const r = await env.DB.prepare('DELETE FROM labels WHERE install = ? AND id = ?').bind(p[2], p[3]).run();
        return json({ ok: true, deleted: r.meta.changes });
      }
      if (req.method === 'DELETE' && p[0] === 'v1' && p[1] === 'install' && p.length === 3) {
        if (!UUID.test(p[2])) return bad('install');
        const r = await env.DB.prepare('DELETE FROM labels WHERE install = ?').bind(p[2]).run();
        return json({ ok: true, deleted: r.meta.changes });
      }
      if (req.method === 'GET' && p.join('/') === 'v1/stats') {
        const s = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(y), 0) AS pos FROM labels').first();
        return new Response(JSON.stringify({ n: s.n, pos: s.pos }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...CORS } });
      }
      if (req.method === 'GET' && p.join('/') === 'v1/export') return await exportRows(url, req, env);
      return bad('нет такого адреса', 404);
    } catch (e) {
      return bad('ошибка сервера', 500);
    }
  },
};
