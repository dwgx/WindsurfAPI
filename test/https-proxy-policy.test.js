// F4-PROXY: the optional HTTPS helper must not widen the backend's own CORS
// policy, and the backend must be able to see the real client.
//
// The old handler answered every OPTIONS locally with `access-control-allow-origin: *`
// and overwrote whatever allowlist the backend sent, and it forwarded a
// caller-supplied X-Forwarded-For verbatim without appending its own socket peer
// (evidence: .agent/audit-20260922/evidence/probes/f4-https-proxy-policy/).
//
// The real https-proxy.js source runs here with its three imports (http2, http, fs)
// installed onto the REAL builtin modules as capture-only fakes — the same seam
// test/wire-*.test.js use (patch the builtin export, then syncBuiltinESMExports) — so
// no certificate is read from disk and no port is bound; the registered handler is
// driven with tiny fake request/response objects and the module body runs unchanged.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const deps = await import('./helpers/fake-proxy-deps.mjs');

const require = createRequire(import.meta.url);
const http2 = require('node:http2');
const http = require('node:http');
const fs = require('node:fs');
http2.createSecureServer = deps.createSecureServer;
http.request = deps.request;
// fs needs care: Node's own ESM loader reads module sources through the public
// fs.readFileSync, so a blanket replacement makes every later import fail. Only the
// certificate reads are intercepted, and the patch is removed again right after the
// helper module has been loaded (it reads the certs once, at import time).
const realReadFileSync = fs.readFileSync;
const fakeCertReadFileSync = function readFileSyncWithFakeCerts(path, ...rest) {
  if (typeof path === 'string' && path.endsWith('.pem')) return deps.readFileSync(path);
  return realReadFileSync.call(this, path, ...rest);
};
fs.readFileSync = fakeCertReadFileSync;
syncBuiltinESMExports();

// The helper logs a line per request; keep the TAP stream readable.
const realLog = console.log;
console.log = () => {};
after(() => { console.log = realLog; });
try {
  await import('../https-proxy.js');
} finally {
  fs.readFileSync = realReadFileSync;
  syncBuiltinESMExports();
}

const { trustedClientIp } = await import('../src/net-safety.js');
const { captured, deliverBackend, reset } = deps;
const proxyHandler = captured.handler;
assert.equal(typeof proxyHandler, 'function', 'the helper must register a request handler');

const PEER = '203.0.113.77';
const SPAWNED = '127.0.0.1';

function inboundReq({ method = 'GET', url = '/v1/models', headers = {}, remoteAddress = PEER, socket = true } = {}) {
  const req = {
    method,
    url,
    headers,
    httpVersion: '2.0',
    piped: null,
    listeners: new Map(),
    on(event, fn) {
      const list = this.listeners.get(event) || [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    },
    pipe(dest) {
      this.piped = dest;
      dest.end();
      return dest;
    },
  };
  if (socket) req.socket = { remoteAddress };
  else req.connection = { remoteAddress };
  return req;
}

function outboundRes() {
  const res = {
    headersSent: false,
    status: null,
    headers: null,
    chunks: [],
    body: null,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(body) {
      this.ended = true;
      if (body) this.body = Buffer.from(body);
    },
  };
  return res;
}

// One full request/response cycle against the real handler.
function proxyOnce(requestOptions, backendAnswer) {
  reset();
  const req = inboundReq(requestOptions);
  const res = outboundRes();
  const before = captured.backendRequests.length;
  proxyHandler(req, res);
  const forwarded = captured.backendRequests[before] || null;
  if (backendAnswer && forwarded) deliverBackend(before, backendAnswer);
  return { req, res, forwarded };
}

describe('F4-PROXY: backend CORS policy and client identity', () => {
  it('relays the backend dashboard allowlist instead of overwriting it', () => {
    const { res } = proxyOnce({ url: '/dashboard/api/logs' }, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://dashboard.example',
        vary: 'Origin',
      },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'https://dashboard.example', 'the helper replaced the backend allowlist');
    assert.equal(res.headers.vary, 'Origin');
    assert.equal(res.headers['access-control-allow-headers'], undefined, 'the wildcard overlay added headers the backend never sent');
    assert.equal(res.headers['access-control-allow-methods'], undefined);
  });

  it('adds no ACAO when the backend sends none', () => {
    const { res } = proxyOnce({ url: '/dashboard/api/logs' }, {
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal('access-control-allow-origin' in res.headers, false, 'a wildcard ACAO was invented for a backend that sends none');
  });

  it('keeps a wildcard backend API ACAO (control)', () => {
    const { res } = proxyOnce({ url: '/v1/models' }, {
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: '{}',
    });
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });

  it('forwards OPTIONS to the backend and relays its status and headers', () => {
    const { res, forwarded } = proxyOnce({ method: 'OPTIONS', url: '/dashboard/api/logs' }, {
      status: 204,
      headers: {
        'access-control-allow-origin': 'https://dashboard.example',
        'access-control-allow-methods': 'POST, GET',
        'access-control-max-age': '600',
      },
    });
    assert.ok(forwarded, 'the OPTIONS preflight never reached the backend');
    assert.equal(forwarded.options.method, 'OPTIONS');
    assert.equal(forwarded.options.path, '/dashboard/api/logs');
    assert.equal(res.status, 204, 'the backend status must be relayed, not a local 204');
    assert.equal(res.headers['access-control-allow-origin'], 'https://dashboard.example');
    assert.equal(res.headers['access-control-allow-methods'], 'POST, GET');
    assert.equal(res.headers['access-control-max-age'], '600');
  });

  it('appends the actual socket peer to a caller-supplied XFF', () => {
    const { forwarded } = proxyOnce({ headers: { 'x-forwarded-for': SPAWNED } });
    assert.ok(forwarded, 'the request never reached the backend');
    const xff = forwarded.options.headers['x-forwarded-for'];
    assert.equal(xff, `${SPAWNED}, ${PEER}`, 'the peer must be appended, not dropped or prepended');
    // What the backend's own trust configuration then derives from that header:
    const backendView = trustedClientIp(
      { headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: PEER } },
      { TRUST_PROXY_X_FORWARDED_FOR: '1', TRUST_PROXY_HOPS: '1' },
    );
    assert.equal(backendView, PEER, 'a spoofed leftmost XFF still decided the client identity');
  });

  it('appends the peer when the caller sends no XFF', () => {
    const { forwarded } = proxyOnce({});
    assert.equal(forwarded.options.headers['x-forwarded-for'], PEER);
  });

  it('falls back to the connection peer when the request has no socket', () => {
    const { forwarded } = proxyOnce({ socket: false });
    assert.equal(forwarded.options.headers['x-forwarded-for'], PEER);
  });

  it('leaves the documented trust-off socket choice to the backend (control)', () => {
    const { forwarded } = proxyOnce({ headers: { 'x-forwarded-for': SPAWNED } });
    const untrusted = trustedClientIp(
      { headers: { 'x-forwarded-for': forwarded.options.headers['x-forwarded-for'] }, socket: { remoteAddress: PEER } },
      {},
    );
    assert.equal(untrusted, PEER);
  });

  it('forwards request properties for HTTP/1.1 and skips HTTP/2 pseudo-headers', () => {
    const h2 = proxyOnce({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        ':method': 'POST',
        ':path': '/v1/chat/completions',
        ':authority': 'proxy.example',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'content-type': 'application/json',
      },
    });
    assert.equal(h2.forwarded.options.method, 'POST');
    assert.equal(h2.forwarded.options.path, '/v1/chat/completions');
    assert.equal(h2.forwarded.options.headers.host, '127.0.0.1:3003');
    assert.equal(h2.forwarded.options.headers.connection, undefined);
    assert.equal(h2.forwarded.options.headers['transfer-encoding'], undefined);
    assert.equal(h2.forwarded.options.headers['content-type'], 'application/json');
    for (const key of Object.keys(h2.forwarded.options.headers)) {
      assert.equal(key.startsWith(':'), false, `pseudo-header ${key} must not be forwarded`);
    }

    const h1 = proxyOnce({ method: 'GET', url: '/v1/models' });
    assert.equal(h1.forwarded.options.method, 'GET');
    assert.equal(h1.forwarded.options.path, '/v1/models');
    assert.equal(h1.forwarded.options.hostname, '127.0.0.1');
    assert.equal(h1.forwarded.options.port, 3003);
  });

  it('keeps the response hop-header handling and SSE behavior', () => {
    const { res } = proxyOnce({ url: '/v1/chat/completions' }, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
      },
      body: 'data: {}\n\n',
    });
    assert.equal(res.headers.connection, undefined, 'hop-by-hop response headers must stay stripped');
    assert.equal(res.headers['transfer-encoding'], undefined);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.equal(Buffer.concat(res.chunks).toString(), 'data: {}\n\n');
    assert.equal(res.ended, true);
  });

  it('does not change bind host, ports or certificates (control)', () => {
    assert.deepEqual(captured.certPaths, ['./localhost+3-key.pem', './localhost+3.pem']);
    assert.deepEqual(Object.keys(captured.serverOptions).sort(), ['allowHTTP1', 'cert', 'key']);
    assert.equal(captured.listen.port, 3443);
    assert.equal(captured.listen.host, '0.0.0.0');
  });

  // G-7 (second half): "refuses to start without a TLS key". Today that refusal is a
  // raw ENOENT thrown while the module body builds its options — real, but pinned by
  // nothing, so a future change that swallows the error would leave an unauthenticated
  // helper listening. The control below is what makes the refusal meaningful.
  it('G-7: refuses to start when the TLS key is missing, and does start when it is present', async () => {
    const listenBefore = captured.listen;
    fs.readFileSync = function readFileSyncWithoutCerts(path, ...rest) {
      if (typeof path === 'string' && path.endsWith('.pem')) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return realReadFileSync.call(fs, path, ...rest);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => import('../https-proxy.js?g7-missing-tls-key'),
        /ENOENT/,
        'a helper with no certificate must not start',
      );
    } finally {
      fs.readFileSync = fakeCertReadFileSync;
      syncBuiltinESMExports();
    }
    assert.equal(captured.listen, listenBefore, 'the refused start must not have reached listen()');

    await import('../https-proxy.js?g7-present-tls-key');
    assert.notEqual(captured.listen, listenBefore, 'control: the same body does listen once the key is readable');
  });
});

describe('S2-F2: request URLs carrying ?key= are redacted in the access log', () => {
  it('logs the path with the key value replaced, not the raw credential', () => {
    const lines = [];
    const prev = console.log;
    console.log = (s) => lines.push(String(s));
    try {
      proxyOnce({ url: '/v1beta/models/gemini-2.5-pro:generateContent?key=sk-live-secret-9x7' });
    } finally {
      console.log = prev;
    }
    const access = lines.find((l) => l.includes('generateContent'));
    assert.ok(access, 'an access-log line for the request must exist');
    assert.match(access, /\?key=\[redacted\]/, 'the credential value must be replaced');
    assert.doesNotMatch(access, /sk-live-secret-9x7/, 'the raw key must never reach the log');
  });
});
