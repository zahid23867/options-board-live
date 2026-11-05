// Minimal Node server for Render: /api/feed (Nasdaq proxy) + the patched Options Board app.
const http = require('http');
const feed = require('./api/feed.js');
const site = require('./api/site.js');

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname === '/healthz') { res.statusCode = 200; return res.end('ok'); }
  if (u.pathname === '/api/feed') return feed(req, res);
  req.url = '/api/site?path=' + encodeURIComponent(u.pathname);
  return site(req, res);
}).listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('options-board-live listening'));
