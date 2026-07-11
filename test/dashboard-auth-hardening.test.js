// AUTH-1 + XFF-1 regression coverage for src/dashboard/api.js.
//
// FINDING #1 (privileged-endpoint cluster):
//   - localhost no-secret must FAIL CLOSED by default; DASHBOARD_ALLOW_NO_AUTH=1
//     restores the legacy open-local behavior.
//   - CORS must never answer a blanket `*`; only an allowlisted origin
//     (DASHBOARD_CORS_ORIGINS) is reflected, default none.
//   - reveal-key requires an explicit in-request re-auth even with ambient
//     dashboard auth already passed.
// FINDING #2 (brute-force lockout XFF evasion):
//   - dashboardClientIp counts TRUST_PROXY_HOPS from the RIGHT, so a spoofed
//     left-most X-Forwarded-For token cannot land in a fresh lockout bucket.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import {
  configureBindHost, addAccountByKey, removeAccount,
  checkLockout, failedAuthAttempt, _resetLockoutForTests,
} from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';

const original = {
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
  allowNoAuth: process.env.DASHBOARD_ALLOW_NO_AUTH,
  corsOrigins: process.env.DASHBOARD_CORS_ORIGINS,
  trustXff: process.env.TRUST_PROXY_X_FORWARDED_FOR,
  hops: process.env.TRUST_PROXY_HOPS,
};

function restoreEnv(key, val) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

const createdAccounts = new Set();

beforeEach(() => {
  _resetLockoutForTests();
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  delete process.env.DASHBOARD_CORS_ORIGINS;
  delete process.env.TRUST_PROXY_X_FORWARDED_FOR;
  delete process.env.TRUST_PROXY_HOPS;
});

afterEach(() => {
  for (const id of createdAccounts) removeAccount(id);
  createdAccounts.clear();
  _resetLockoutForTests();
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  config.apiKey = original.apiKey;
  config.dashboardPassword = original.dashboardPassword;
  restoreEnv('DASHBOARD_ALLOW_NO_AUTH', original.allowNoAuth);
  restoreEnv('DASHBOARD_CORS_ORIGINS', original.corsOrigins);
  restoreEnv('TRUST_PROXY_X_FORWARDED_FOR', original.trustXff);
  restoreEnv('TRUST_PROXY_HOPS', original.hops);
  configureBindHost('0.0.0.0');
});

function mkRes() {
  const captured = { status: null, body: null, headers: {} };
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      res.headersSent = true;
      return res;
    },
    end(p) { try { captured.body = JSON.parse(p); } catch { captured.body = p; } },
    setHeader(k, v) { captured.headers[k] = v; },
    on() {},
    write() {},
  };
  return { res, captured };
}

function mkReq(headers = {}, ip = '203.0.113.5') {
  return { headers, socket: { remoteAddress: ip } };
}

function addTestAccount(label) {
  const account = addAccountByKey(`reveal-test-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, label);
  createdAccounts.add(account.id);
  return account;
}

describe('audit #1: apiKey/no-auth dashboard fallback requires a verified-LOCAL client IP, not just a loopback bind', () => {
  // Behind a reverse proxy (openresty → app on 127.0.0.1) isLocalBindHost() is
  // always true — and so is the raw socket peer (the proxy connects from
  // 127.0.0.1). So the fallback gates on the TRUSTED client IP (dashboardClientIp:
  // honors X-Forwarded-For when TRUST_PROXY_X_FORWARDED_FOR=1), not the socket peer.
  const withXff = () => { process.env.TRUST_PROXY_X_FORWARDED_FOR = '1'; };

  it('loopback bind + remote socket peer + chat apiKey → 401 (no proxy trust)', async () => {
    config.apiKey = 'sk-chat-shared-key';
    config.dashboardPassword = '';
    configureBindHost('127.0.0.1'); // app bound to loopback (proxy fronts it)
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'sk-chat-shared-key' }, '203.0.113.9'), res);
    assert.equal(captured.status, 401, 'remote peer must NOT auth via the chat apiKey fallback');
  });

  it('SAME-HOST PROXY: loopback socket peer BUT remote real client (XFF) + chat apiKey → 401', async () => {
    // The reviewer-caught hole: behind a same-host proxy the socket peer is
    // 127.0.0.1 for everyone. With XFF trust on, dashboardClientIp resolves the
    // real client from X-Forwarded-For — a remote client must be rejected even
    // though the socket peer is loopback.
    withXff();
    config.apiKey = 'sk-chat-shared-key';
    config.dashboardPassword = '';
    configureBindHost('127.0.0.1');
    const { res, captured } = mkRes();
    // socket peer = 127.0.0.1 (the proxy), XFF carries the real remote client
    const req = { headers: { 'x-dashboard-password': 'sk-chat-shared-key', 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
    await handleDashboardApi('GET', '/config', {}, req, res);
    assert.equal(captured.status, 401, 'proxied remote client (via XFF) must NOT auth via the apiKey fallback despite a loopback socket peer');
  });

  it('SAME-HOST PROXY: loopback socket peer + loopback real client (XFF) + chat apiKey → 200', async () => {
    // A genuinely local client whose real IP (via XFF) is loopback still works.
    withXff();
    config.apiKey = 'sk-chat-shared-key';
    config.dashboardPassword = '';
    configureBindHost('127.0.0.1');
    const { res, captured } = mkRes();
    const req = { headers: { 'x-dashboard-password': 'sk-chat-shared-key', 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    await handleDashboardApi('GET', '/config', {}, req, res);
    assert.equal(captured.status, 200, 'verified-local client (XFF loopback) keeps the convenience');
  });

  it('loopback bind + loopback peer + chat apiKey as password → 200 (genuine local convenience)', async () => {
    config.apiKey = 'sk-chat-shared-key';
    config.dashboardPassword = '';
    configureBindHost('127.0.0.1');
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'sk-chat-shared-key' }, '127.0.0.1'), res);
    assert.equal(captured.status, 200, 'loopback peer with the correct apiKey is still accepted');
  });

  it('a configured DASHBOARD_PASSWORD is unaffected (remote peer with correct password still works)', async () => {
    config.apiKey = 'sk-chat-shared-key';
    config.dashboardPassword = 'real-admin-pw';
    configureBindHost('127.0.0.1');
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'real-admin-pw' }, '203.0.113.9'), res);
    assert.equal(captured.status, 200, 'explicit dashboard password auths regardless of peer');
  });
});

describe('AUTH-1: localhost no-secret fail-closed by default', () => {
  it('localhost + no secret + no opt-in → 401 (fail closed)', async () => {
    config.apiKey = '';
    config.dashboardPassword = '';
    configureBindHost('127.0.0.1');
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({}, '127.0.0.1'), res);
    assert.equal(captured.status, 401, 'default localhost-no-secret must fail closed');
  });

  it('localhost + no secret + DASHBOARD_ALLOW_NO_AUTH=1 → 200 (legacy open-local opt-in)', async () => {
    config.apiKey = '';
    config.dashboardPassword = '';
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
    configureBindHost('127.0.0.1');
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({}, '127.0.0.1'), res);
    assert.equal(captured.status, 200, 'opt-in must restore open-local behavior');
  });

  it('/auth probe reports required:true when open-local not opted in', async () => {
    config.apiKey = '';
    config.dashboardPassword = '';
    configureBindHost('127.0.0.1');
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/auth', {}, mkReq({}, '127.0.0.1'), res);
    assert.equal(captured.status, 200);
    assert.equal(captured.body.required, true, 'probe must not advertise an open dashboard when fail-closed');
  });

  it('/auth probe reports required:false only with the opt-in', async () => {
    config.apiKey = '';
    config.dashboardPassword = '';
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
    configureBindHost('127.0.0.1');
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/auth', {}, mkReq({}, '127.0.0.1'), res);
    assert.equal(captured.body.required, false);
  });
});

describe('AUTH-1: CORS is not a blanket wildcard', () => {
  it('default (no DASHBOARD_CORS_ORIGINS) → no Access-Control-Allow-Origin header', async () => {
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'admin-pw', origin: 'https://evil.example' }), res);
    assert.equal(captured.status, 200);
    assert.equal(captured.headers['Access-Control-Allow-Origin'], undefined, 'no ACAO by default');
  });

  it('OPTIONS preflight from a disallowed origin gets no ACAO', async () => {
    process.env.DASHBOARD_CORS_ORIGINS = 'https://ok.example';
    const { res, captured } = mkRes();
    await handleDashboardApi('OPTIONS', '/config', {}, mkReq({ origin: 'https://evil.example' }), res);
    assert.equal(captured.status, 204);
    assert.equal(captured.headers['Access-Control-Allow-Origin'], undefined);
  });

  it('OPTIONS preflight from an allowlisted origin echoes it (not `*`)', async () => {
    process.env.DASHBOARD_CORS_ORIGINS = 'https://ok.example';
    const { res, captured } = mkRes();
    await handleDashboardApi('OPTIONS', '/config', {}, mkReq({ origin: 'https://ok.example' }), res);
    assert.equal(captured.status, 204);
    assert.equal(captured.headers['Access-Control-Allow-Origin'], 'https://ok.example');
    assert.notEqual(captured.headers['Access-Control-Allow-Origin'], '*');
  });

  // #9: the dashboard OPTIONS handler above is only REACHED if the global
  // OPTIONS short-circuit in server.js excludes /dashboard/api/. Without the
  // exclusion, every dashboard preflight is answered with a blanket ACAO:* by
  // server.js:route and the allowlist handler is dead code. Pin the routing
  // invariant at the source level (route() is not exported / no full-route
  // harness — same source-assertion convention as http-cache-control.test.js).
  it('server.js global OPTIONS short-circuit excludes /dashboard/api/ so the allowlist handler is reachable', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/server.js'), 'utf-8');
    assert.match(
      src,
      /if \(method === 'OPTIONS' && !path\.startsWith\('\/dashboard\/api\/'\)\)/,
      'global OPTIONS handler must exclude /dashboard/api/ (else dashboard preflight is a blanket `*`)',
    );
  });

  it('allowlisted origin is echoed (not `*`) with Vary: Origin', async () => {
    process.env.DASHBOARD_CORS_ORIGINS = 'https://ok.example, https://also.example';
    config.dashboardPassword = 'admin-pw';
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'admin-pw', origin: 'https://ok.example' }), res);
    assert.equal(captured.headers['Access-Control-Allow-Origin'], 'https://ok.example');
    assert.notEqual(captured.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(captured.headers['Vary'], 'Origin');
  });
});

describe('AUTH-1: reveal-key requires explicit re-auth', () => {
  it('ambient auth alone (no password in body) → 401', async () => {
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');
    const acct = addTestAccount('noreauth');
    const { res, captured } = mkRes();
    await handleDashboardApi('POST', `/account/${acct.id}/reveal-key`, {}, mkReq({ 'x-dashboard-password': 'admin-pw' }), res);
    assert.equal(captured.status, 401, 'reveal-key must demand in-request re-auth even when ambient auth passed');
    assert.equal(captured.body.error, 'ERR_REVEAL_REAUTH_REQUIRED');
  });

  it('correct re-auth password in body → 200 with cleartext key', async () => {
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');
    const acct = addTestAccount('reauth-ok');
    const { res, captured } = mkRes();
    await handleDashboardApi('POST', `/account/${acct.id}/reveal-key`, { password: 'admin-pw' }, mkReq({ 'x-dashboard-password': 'admin-pw' }), res);
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    assert.equal(typeof captured.body.apiKey, 'string');
    assert.ok(captured.body.apiKey.length > 0);
  });

  it('wrong re-auth password → 401', async () => {
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');
    const acct = addTestAccount('reauth-wrong');
    const { res, captured } = mkRes();
    await handleDashboardApi('POST', `/account/${acct.id}/reveal-key`, { password: 'not-the-pw' }, mkReq({ 'x-dashboard-password': 'admin-pw' }), res);
    assert.equal(captured.status, 401);
  });

  it('re-auth accepted via X-Dashboard-Password-Confirm header', async () => {
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');
    const acct = addTestAccount('reauth-header');
    const { res, captured } = mkRes();
    await handleDashboardApi('POST', `/account/${acct.id}/reveal-key`, {},
      mkReq({ 'x-dashboard-password': 'admin-pw', 'x-dashboard-password-confirm': 'admin-pw' }), res);
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
  });
});

describe('XFF-1: dashboard lockout counts client IP from the right', () => {
  it('spoofed left-most XFF token cannot dodge the 5-strike ban (single trusted hop)', async () => {
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    // TRUST_PROXY_HOPS defaults to 1. A single trusted proxy appends the peer
    // it received the connection from (the real client) to the RIGHT of the
    // header, so the trustworthy client IP is the last token. The attacker
    // rotates the LEFT-most token every request to try to land in a fresh
    // lockout bucket; the right-counted resolution defeats it.
    const realClient = '198.51.100.9';
    for (let i = 0; i < 5; i++) {
      const { res, captured } = mkRes();
      const spoof = `9.9.9.${i}`; // fresh left-most token each request
      await handleDashboardApi('GET', '/config', {},
        mkReq({ 'x-dashboard-password': 'wrong', 'x-forwarded-for': `${spoof}, ${realClient}` }, '10.0.0.1'), res);
      assert.equal(captured.status, 401, `attempt ${i + 1} expected 401`);
    }
    // 6th attempt — despite a brand-new left-most token — must be banned,
    // because all six resolved to the same right-counted real client IP.
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {},
      mkReq({ 'x-dashboard-password': 'wrong', 'x-forwarded-for': `9.9.9.99, ${realClient}` }, '10.0.0.1'), res);
    assert.equal(captured.status, 429, 'spoofing the left-most XFF token must NOT reset the lockout bucket');
  });

  it('the banned bucket is the right-counted client IP, not the spoofed left token', async () => {
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    const realClient = '198.51.100.20';
    for (let i = 0; i < 5; i++) {
      const { res } = mkRes();
      await handleDashboardApi('GET', '/config', {},
        mkReq({ 'x-dashboard-password': 'wrong', 'x-forwarded-for': `1.2.3.${i}, ${realClient}` }, '10.0.0.1'), res);
    }
    assert.equal(checkLockout(realClient).blocked, true, 'lockout must key on the real right-counted client IP');
    assert.equal(checkLockout('1.2.3.0').blocked, false, 'spoofed left-most token must never be the banned key');
  });

  it('honours TRUST_PROXY_HOPS=2 (two trusted proxies) — client is third-from-... i.e. len-2', async () => {
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    process.env.TRUST_PROXY_HOPS = '2';
    // Two trusted proxies append two entries on the right; real client is the
    // token just before them: parts[len-2]. Header: spoof, realClient, proxyB.
    const realClient = '198.51.100.30';
    for (let i = 0; i < 5; i++) {
      const { res } = mkRes();
      await handleDashboardApi('GET', '/config', {},
        mkReq({ 'x-dashboard-password': 'wrong', 'x-forwarded-for': `7.7.7.${i}, ${realClient}, 10.0.0.2` }, '10.0.0.1'), res);
    }
    assert.equal(checkLockout(realClient).blocked, true, 'with 2 hops the client IP is parts[len-2]');
    assert.equal(checkLockout('7.7.7.0').blocked, false);
  });
});
