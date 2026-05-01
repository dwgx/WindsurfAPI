// v2.0.55 audit H1 regression — dashboard checkAuth must NOT fall back
// to API_KEY on non-local binds. Without this, any chat-API caller
// could escalate to dashboard admin (list accounts / reveal-key /
// change proxy / trigger LS or docker self-update).
//
// Localhost bind keeps the convenience fallback so single-user
// `docker-compose up` doesn't suddenly require an extra env.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';

const original = {
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
};

function mkRes() {
  const captured = { status: null, body: null, ended: false };
  const res = {
    headersSent: false,
    writeHead(status, _headers) { captured.status = status; res.headersSent = true; return res; },
    end(payload) {
      captured.ended = true;
      try { captured.body = JSON.parse(payload); } catch { captured.body = payload; }
    },
    setHeader() {},
    on() {},
  };
  return { res, captured };
}

function mkReq(headers = {}) {
  return { headers, socket: { remoteAddress: '203.0.113.5' } };
}

afterEach(() => {
  config.apiKey = original.apiKey;
  config.dashboardPassword = original.dashboardPassword;
  configureBindHost('0.0.0.0');
});

describe('dashboard checkAuth — fail closed on public bind without password (audit H1)', () => {
  it('public bind + no DASHBOARD_PASSWORD + API_KEY-as-password → 401 (no privilege escalation)', async () => {
    config.apiKey = 'sk-shared-key';
    config.dashboardPassword = '';
    configureBindHost('0.0.0.0');

    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'sk-shared-key' }), res);
    assert.equal(captured.status, 401, 'API_KEY in dashboard header must NOT authenticate on public bind');
  });

  it('public bind + DASHBOARD_PASSWORD set → password authenticates, API_KEY does not', async () => {
    config.apiKey = 'sk-shared-key';
    config.dashboardPassword = 'admin-pw';
    configureBindHost('0.0.0.0');

    const right = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'admin-pw' }), right.res);
    assert.equal(right.captured.status, 200, 'correct DASHBOARD_PASSWORD must authenticate');

    const wrong = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'sk-shared-key' }), wrong.res);
    assert.equal(wrong.captured.status, 401, 'API_KEY must NOT be accepted as DASHBOARD_PASSWORD');
  });

  it('localhost bind + no DASHBOARD_PASSWORD → API_KEY fallback still works (single-user dev)', async () => {
    config.apiKey = 'sk-local-key';
    config.dashboardPassword = '';
    configureBindHost('127.0.0.1');

    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'sk-local-key' }), res);
    assert.equal(captured.status, 200, 'localhost bind keeps the convenience fallback');
  });

  it('localhost bind + nothing configured → open (single-user dev)', async () => {
    config.apiKey = '';
    config.dashboardPassword = '';
    configureBindHost('127.0.0.1');

    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({}), res);
    assert.equal(captured.status, 200, 'localhost dev mode with no creds must remain open');
  });

  it('public bind + nothing configured → fail closed (no API_KEY, no DASHBOARD_PASSWORD)', async () => {
    config.apiKey = '';
    config.dashboardPassword = '';
    configureBindHost('0.0.0.0');

    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({}), res);
    assert.equal(captured.status, 401, 'public bind with no creds must reject all dashboard requests');
  });
});
