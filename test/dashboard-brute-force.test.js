// v2.0.56 — brute-force lockout for dashboard auth (CLIProxyAPI-style).
// Covers checkLockout / failedAuthAttempt / successfulAuthAttempt and the
// integration into handleDashboardApi (5 failures → 30 min ban → 429).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLockout, failedAuthAttempt, successfulAuthAttempt,
  _resetLockoutForTests,
  configureBindHost,
} from '../src/auth.js';
import { config } from '../src/config.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';

const original = {
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
};

beforeEach(() => {
  _resetLockoutForTests();
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
});

afterEach(() => {
  _resetLockoutForTests();
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  config.apiKey = original.apiKey;
  config.dashboardPassword = original.dashboardPassword;
  configureBindHost('0.0.0.0');
});

function mkRes() {
  const captured = { status: null, body: null, headers: {} };
  const res = {
    headersSent: false,
    writeHead(status) { captured.status = status; res.headersSent = true; return res; },
    end(p) { try { captured.body = JSON.parse(p); } catch { captured.body = p; } },
    setHeader(k, v) { captured.headers[k] = v; },
    on() {},
  };
  return { res, captured };
}

function mkReq(headers = {}, ip = '203.0.113.5') {
  return { headers, socket: { remoteAddress: ip } };
}

describe('lockout state machine (audit M-bf)', () => {
  it('initial state is unblocked', () => {
    assert.deepEqual(checkLockout('1.2.3.4'), { blocked: false, retryAfterMs: 0, count: 0 });
  });

  it('5 failures triggers a ban', () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 4; i++) {
      const r = failedAuthAttempt(ip);
      assert.equal(r.blocked, false, `attempt ${i + 1} should not yet be blocked`);
    }
    const r5 = failedAuthAttempt(ip);
    assert.equal(r5.blocked, true, '5th failure must trigger ban');
    assert.ok(r5.retryAfterMs > 0, 'retryAfterMs must be positive when blocked');
  });

  it('checkLockout reports the active ban', () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 5; i++) failedAuthAttempt(ip);
    const c = checkLockout(ip);
    assert.equal(c.blocked, true);
    assert.ok(c.retryAfterMs > 0);
  });

  it('successfulAuthAttempt clears the entry', () => {
    const ip = '1.2.3.4';
    failedAuthAttempt(ip);
    failedAuthAttempt(ip);
    successfulAuthAttempt(ip);
    assert.equal(checkLockout(ip).count, 0);
    assert.equal(checkLockout(ip).blocked, false);
  });

  it('different IPs are tracked independently', () => {
    for (let i = 0; i < 5; i++) failedAuthAttempt('1.1.1.1');
    assert.equal(checkLockout('1.1.1.1').blocked, true);
    assert.equal(checkLockout('2.2.2.2').blocked, false);
  });
});

describe('handleDashboardApi: brute-force integration', () => {
  it('5 failed dashboard auths from same IP returns 429 on the 6th', async () => {
    config.apiKey = '';
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');

    for (let i = 0; i < 5; i++) {
      const { res, captured } = mkRes();
      await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'wrong' }), res);
      assert.equal(captured.status, 401, `attempt ${i + 1}: expected 401`);
    }
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'wrong' }), res);
    assert.equal(captured.status, 429, '6th attempt must be banned with 429');
    assert.ok(captured.body?.retryAfterMs > 0, 'response must include retryAfterMs');
  });

  it('successful auth resets the failure counter', async () => {
    config.apiKey = '';
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');

    // 4 failures + 1 success → counter cleared
    for (let i = 0; i < 4; i++) {
      const { res } = mkRes();
      await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'wrong' }), res);
    }
    {
      const { res, captured } = mkRes();
      await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'admin-pw' }), res);
      assert.equal(captured.status, 200);
    }
    // After success, IP should still allow attempts (no instant ban)
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'wrong' }), res);
    assert.equal(captured.status, 401, 'post-success failure should be 401, not 429');
  });
});
