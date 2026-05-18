import http2 from 'http2';
import http from 'http';
import { readFileSync } from 'fs';

const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '3003', 10);

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400',
};

function proxy(req, res) {
  const ts = new Date().toISOString().slice(11, 19);
  const method = req.method || req.headers[':method'] || 'GET';
  const url = req.url || req.headers[':path'] || '/';
  console.log(`[${ts}] ${method} ${url} (${req.httpVersion})`);

  // Handle CORS preflight directly — don't forward to backend
  if (method === 'OPTIONS') {
    console.log(`[${ts}] ← 204 CORS preflight`);
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // Build headers for the HTTP/1.1 backend
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // Skip HTTP/2 pseudo-headers and hop-by-hop
    if (k.startsWith(':') || k === 'connection' || k === 'transfer-encoding') continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders['host'] = `127.0.0.1:${TARGET_PORT}`;

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
    // Inject CORS headers into every response
    Object.assign(respHeaders, CORS_HEADERS);
    res.writeHead(proxyRes.statusCode, respHeaders);

    proxyRes.on('data', (chunk) => {
      res.write(chunk);
    });
    proxyRes.on('end', () => res.end());
  });

  proxyReq.on('error', (e) => {
    console.error(`[${ts}] Proxy error: ${e.message} (${req.method} ${req.url})`);
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
