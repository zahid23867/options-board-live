// Serves the Options Board app with its broken third-party data feed replaced by /api/feed
// (same-origin Nasdaq proxy) and faster refresh intervals for a live feel.
const UPSTREAM = 'https://options-board-0fjx.vercel.app';

const CACHE = new Map(); // key -> { at, status, headers, body }
const TTL_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getUpstream(path) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(UPSTREAM + path, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
      if (r.ok) return r;
      err = 'upstream ' + r.status;
      if (r.status === 404) break;
    } catch (e) { err = String(e && e.message || e); }
    await sleep(250 * (i + 1));
  }
  throw new Error(err);
}

const HELPER =
  'var __obFeed=async(u,sig)=>{let q=await fetch("/api/feed?url="+encodeURIComponent(u),{signal:sig,cache:"no-store"});' +
  'if(!q.ok)throw new Error("feed "+q.status);let b=await q.text();' +
  'return{body:b,readAt:Number(q.headers.get("x-read-at"))||Date.now(),stale:false}};\n';

// [from, to] pairs; each must match exactly once or it is skipped (and reported in X-Patch).
const JS_PATCHES = [
  ['let r=await YT("feed",t?{url:e,body:t}:{url:e},{signal:a.signal}),n=String(r?.body??"");',
   'let r=await __obFeed(e,a.signal),n=String(r?.body??"");'],
  ['{every:600,pick:a}', '{every:60,pick:a}'],      // option chain: 10 min -> 1 min
  ['{every:900,pick:s4}', '{every:300,pick:s4}'],   // daily closes: 15 min -> 5 min
  ['{every:60,pick:v4}', '{every:15,pick:v4}'],     // index/ticker quotes: 60 s -> 15 s
  ['GB=20,WB=12e3', 'GB=10,WB=15e3'],               // min poll 20 s -> 10 s, timeout 12 s -> 15 s
  ['$B=25e3', '$B=8e3'],                            // cache freshness 25 s -> 8 s
];

function patchJs(src) {
  let out = src, ok = 0;
  for (const [a, b] of JS_PATCHES) {
    if (out.split(a).length === 2) { out = out.replace(a, () => b); ok++; }
  }
  if (ok && out.includes('__obFeed(e,a.signal)')) out = HELPER + out;
  return { text: out, applied: ok };
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://local');
  let path = u.searchParams.get('path') || '/';
  if (!path.startsWith('/')) path = '/' + path;
  const isAsset = path.startsWith('/assets/');
  try {
    // Unknown client-side routes (/alerts, /journal ...) all serve the app shell.
    const r = await getUpstream(isAsset ? path : '/');
    const type = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    if (type.includes('javascript')) {
      const { text, applied } = patchJs(await r.text());
      res.setHeader('X-Patch', applied + '/' + JS_PATCHES.length);
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
      return res.end(text);
    }
    if (type.includes('text/html')) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const html = (await r.text()).split(UPSTREAM).join('https://' + host);
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
      return res.end(html);
    }
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    res.end('Could not load the app: ' + String(e && e.message || e));
  }
}

// Buffer the response of handle() so successful pages can be cached in memory.
module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://local');
  const path = u.searchParams.get('path') || '/';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const key = host + '|' + (path.startsWith('/assets/') ? path : '/');
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return replay(res, hit);
  const chunks = [], headers = {};
  const fake = {
    statusCode: 200,
    setHeader(k, v) { headers[k] = v; },
    end(b) { if (b != null) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b))); },
  };
  await handle(req, fake);
  const entry = { at: Date.now(), status: fake.statusCode, headers, body: Buffer.concat(chunks) };
  if (entry.status === 200) {
    CACHE.set(key, entry);
    if (CACHE.size > 40) CACHE.delete(CACHE.keys().next().value);
  } else if (hit) {
    return replay(res, hit); // upstream down: serve the last good copy
  }
  replay(res, entry);
};

function replay(res, e) {
  res.statusCode = e.status;
  for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
  res.end(e.body);
}
