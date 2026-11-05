// Same-origin proxy for Nasdaq's free public quote API (browsers can't call it directly: no CORS).
// Only api.nasdaq.com/api/quote/* is allowed, so this is not an open proxy.
const HOST = 'api.nasdaq.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nasdaq.com',
  'Referer': 'https://www.nasdaq.com/',
};
const CACHE = new Map(); // url -> { at, body }
const TTL_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, body, at) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Read-At', String(at));
  res.end(body);
}

module.exports = async (req, res) => {
  let target;
  try {
    target = new URL(new URL(req.url, 'http://local').searchParams.get('url'));
  } catch {
    res.statusCode = 400; return res.end('bad url');
  }
  if (target.protocol !== 'https:' || target.hostname !== HOST || !target.pathname.startsWith('/api/quote/')) {
    res.statusCode = 403; return res.end('host not allowed');
  }
  const key = target.toString();
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return send(res, hit.body, hit.at);
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(target.toString(), { headers: HEADERS, signal: AbortSignal.timeout(9000) });
      const body = await r.text();
      if (r.ok && body && body.trimStart().startsWith('{')) {
        let j; try { j = JSON.parse(body); } catch { j = null; }
        if (j && j.data) {
          const at = Date.now();
          CACHE.set(key, { at, body });
          if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);
          return send(res, body, at);
        }
        lastErr = 'no data in response';
      } else lastErr = 'upstream ' + r.status;
    } catch (e) { lastErr = String(e && e.message || e); }
    await sleep(300 * (attempt + 1));
  }
  if (hit) return send(res, hit.body, hit.at); // serve last good read rather than an error
  res.statusCode = 502;
  res.setHeader('Cache-Control', 'no-store');
  res.end('upstream failed: ' + lastErr);
};
