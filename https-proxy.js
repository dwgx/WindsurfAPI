import http2 from 'http2';
import http from 'http';
import { readFileSync } from 'fs';
import { redactUrlForLog } from './src/log-safety.js';

const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '3003', 10);

function proxy(req, res) {
  const ts = new Date().toISOString().slice(11, 19);
  const method = req.method || req.headers[':method'] || 'GET';
  const url = req.url || req.headers[':path'] || '/';
  // ?key= is a documented Gemini credential carrier; never log it raw (S2-F2).
  console.log(`[${ts}] ${method} ${redactUrlForLog(url)} (${req.httpVersion})`);

  // Build headers for the HTTP/1.1 backend
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // Skip HTTP/2 pseudo-headers and hop-by-hop
    if (k.startsWith(':') || k === 'connection' || k === 'transfer-encoding') continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders['host'] = `127.0.0.1:${TARGET_PORT}`;
  // Append the peer this helper actually accepted the connection from. The backend
  // counts X-Forwarded-For from the RIGHT (src/net-safety.js trustedClientIp, one hop
  // per trusted proxy), so appending preserves an existing trusted chain while a
  // caller-supplied leftmost value can no longer claim the client's identity. With
  // the header absent the peer becomes the whole value.
  const peer = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  if (peer) {
    const prior = req.headers['x-forwarded-for'];
    fwdHeaders['x-forwarded-for'] = prior ? `${prior}, ${peer}` : peer;
  }

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: fwdHeaders,
  }, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || '';
    const isSSE = ct.includes('text/event-stream');
    console.log(`[${ts}] ← ${proxyRes.statusCode} ${ct.split(';')[0]}${isSSE ? ' (SSE)' : ''}`);

    const respHeaders = {};
    const hop = new Set(['connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization']);
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (hop.has(k)) continue;
      respHeaders[k] = v;
    }
    if (isSSE) {
      respHeaders['cache-control'] = 'no-cache';
      respHeaders['x-accel-buffering'] = 'no';
    }
    // The backend owns its CORS policy: its allowlist, Vary and status pass through
    // untouched. Overlaying a wildcard here would silently widen an operator-restricted
    // origin for every client that reaches the dashboard through this helper.
    res.writeHead(proxyRes.statusCode, respHeaders);

    proxyRes.on('data', (chunk) => {
      res.write(chunk);
    });
    proxyRes.on('end', () => res.end());
  });

  proxyReq.on('error', (e) => {
    console.error(`[${ts}] Proxy error: ${e.message} (${req.method} ${redactUrlForLog(req.url)})`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Bad Gateway', type: 'proxy_error' } }));
    }
  });

  req.on('error', () => proxyReq.destroy());
  req.on('close', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });
  req.pipe(proxyReq);
}

// HTTP/2 secure server with HTTP/1.1 fallback
const server = http2.createSecureServer({
  key: readFileSync('./localhost+3-key.pem'),
  cert: readFileSync('./localhost+3.pem'),
  allowHTTP1: true,
}, proxy);

server.timeout = 300_000;

server.on('error', (e) => console.error('Server error:', e.message));

server.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`HTTPS proxy (HTTP/2 + HTTP/1.1) on https://0.0.0.0:${HTTPS_PORT} → http://127.0.0.1:${TARGET_PORT}`);
  console.log(`  Local:   https://localhost:${HTTPS_PORT}`);
  console.log(`  LAN:     https://192.168.50.7:${HTTPS_PORT}`);
});
