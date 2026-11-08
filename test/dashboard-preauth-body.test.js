// S03/G05 regression: `/dashboard/api/*` used to read and JSON-parse the whole
// request body BEFORE handleDashboardApi ran the Host/mutation/lockout/auth
// gate. An unauthenticated caller could therefore force up to MAX_BODY_SIZE
// (10 MiB) of buffering + JSON.parse per request, unauthenticated.
//
// The proof is deliberately end-to-end and body-absence based: the client sends
// a complete set of headers declaring a 10 MiB body and then sends NO body
// bytes at all. A server that reads the body first can never answer (it is
// waiting for an 'end' that never comes), so a 401 arriving while the body is
// still unsent can only come from a gate that ran before readBody(). Removing
// the preflight call in src/server.js makes this test time out — the red-first
// design check recorded in the brief.
//
// Controls keep the other side of the contract honest:
//   - an authenticated mutation still receives its parsed body (the prefs
//     response reflects the JSON that was sent);
//   - `/auth/login` (server.js, outside /dashboard/api/*) still reads and
//     parses its body, so the unauthenticated auth flows were not collateral.

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import { getAccountCount, _resetLockoutForTests } from '../src/auth.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { MAX_BODY_SIZE, startServer } from '../src/server.js';

const DASHBOARD_PASSWORD = 'preauth-body-test-password';

const saved = {
  host: config.host,
  port: config.port,
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
};
const savedEnv = {};
for (const key of ['WINDSURFAPI_ALLOW_UNAUTHENTICATED', 'DASHBOARD_ALLOW_NO_AUTH']) {
  savedEnv[key] = process.env[key];
}

function restoreEnv(key) {
  const value = savedEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function resetAuthState() {
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  config.apiKey = '';
  config.dashboardPassword = '';
}

let server = null;
let port = 0;

before(async () => {
  resetAuthState();
  config.host = '127.0.0.1';
  config.port = 0;
  server = startServer();
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  port = server.address().port;
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  config.host = saved.host;
  config.port = saved.port;
  config.apiKey = saved.apiKey;
  config.dashboardPassword = saved.dashboardPassword;
  for (const key of Object.keys(savedEnv)) restoreEnv(key);
});

beforeEach(resetAuthState);

afterEach(() => {
  for (const key of Object.keys(savedEnv)) restoreEnv(key);
});

function parseJson(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return raw; }
}

// Ordinary request helper for the two positive controls.
function request(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: {
        ...(payload == null ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode, body: parseJson(raw), raw });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Sends the request line + headers (declaring a full MAX_BODY_SIZE body) and
// then never writes a body byte. Resolves with the response the server sent
// while the request was still incomplete.
function requestWithoutBody(path, { headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(
        'no response before the request body was sent — the server read the body first',
      ));
    }, timeoutMs);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Length': String(MAX_BODY_SIZE),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => finish(resolve, { status: res.statusCode, body: parseJson(raw), raw }));
      res.on('error', err => finish(reject, err));
    });
    // The server rejects before the body arrives and then closes the socket;
    // an error AFTER the response was received is the expected teardown.
    req.on('error', err => finish(reject, err));
    req.flushHeaders();
  });
}

describe('S03/G05: /dashboard/api/* body is not read before the auth gate', () => {
  it('rejects an unauthenticated mutation while its 10 MiB body is still unsent', async () => {
    const before = getAccountCount().total;
    const r = await requestWithoutBody('/dashboard/api/self-update', {
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
    });

    assert.equal(r.status, 401, r.raw);
    assert.equal(r.body?.error, 'Unauthorized. Set X-Dashboard-Password header.');
    // Same #257 error envelope handleDashboardApi produced before the move.
    assert.equal(r.body?.success, false);
    assert.equal(getAccountCount().total, before, 'a rejected mutation must have no side effect');
  });

  it('still hands an authenticated mutation its parsed body', async () => {
    config.dashboardPassword = DASHBOARD_PASSWORD;
    const r = await request('PUT', '/dashboard/api/settings/prefs', {
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'x-dashboard-password': DASHBOARD_PASSWORD,
      },
      body: { oauthSkipChooser: true },
    });

    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body?.success, true);
    assert.equal(r.body?.prefs?.oauthSkipChooser, true, 'the handler must see the JSON body');
  });

  it('still answers the dashboard /auth credential probe', async () => {
    // Regression for the extraction: the probe's success/failure counters use
    // the resolved client IP, which the extracted gate no longer exposes to
    // handleDashboardApi. A missing binding throws a ReferenceError here.
    config.dashboardPassword = DASHBOARD_PASSWORD;
    const headers = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' };

    const wrong = await request('POST', '/dashboard/api/auth', {
      headers: { ...headers, 'x-dashboard-password': 'wrong-password' },
      body: {},
    });
    assert.equal(wrong.status, 200, wrong.raw);
    assert.deepEqual(wrong.body, { required: true, valid: false });

    const right = await request('POST', '/dashboard/api/auth', {
      headers: { ...headers, 'x-dashboard-password': DASHBOARD_PASSWORD },
      body: {},
    });
    assert.equal(right.status, 200, right.raw);
    assert.deepEqual(right.body, { required: true, valid: true });
  });

  it('still reads the body of the unauthenticated /auth/login flow', async () => {
    process.env.WINDSURFAPI_ALLOW_UNAUTHENTICATED = '1';
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
    const before = getAccountCount().total;
    // An empty `accounts` array only produces {results: []} if the body was
    // parsed; an unread body would fall into the 400 "Provide api_key, token,
    // or email+password" branch.
    const r = await request('POST', '/auth/login', {
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: { accounts: [] },
    });

    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body?.results, []);
    assert.equal(getAccountCount().total, before);
  });
});
