// v2.0.55 audit H3 regression — /dashboard/api/proxy/global PUT and
// /dashboard/api/proxy/accounts/:id PUT must run the same private-host
// gate the add-account path uses. Without it, a dashboard-authenticated
// caller (chat-API key on pre-v2.0.55) can pin the proxy at 127.0.0.1 /
// 169.254.169.254 / any internal socket and force LS/proxy egress
// toward internal services (cloud metadata, SMTP relays, etc.).

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';

const original = {
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
  allowPrivateProxyHosts: config.allowPrivateProxyHosts,
};

function mkRes() {
  const captured = { status: null, body: null };
  const res = {
    headersSent: false,
    writeHead(status) { captured.status = status; res.headersSent = true; return res; },
    end(p) { try { captured.body = JSON.parse(p); } catch { captured.body = p; } },
    setHeader() {}, on() {},
  };
  return { res, captured };
}

function mkAuthedReq() {
  return { headers: { 'x-dashboard-password': 'admin-pw' }, socket: { remoteAddress: '203.0.113.5' } };
}

afterEach(() => {
  config.apiKey = original.apiKey;
  config.dashboardPassword = original.dashboardPassword;
  config.allowPrivateProxyHosts = original.allowPrivateProxyHosts;
  configureBindHost('0.0.0.0');
});

describe('dashboard /proxy setter routes — private-host gate (audit H3)', () => {
  it('PUT /proxy/global with host=127.0.0.1 returns 400 when ALLOW_PRIVATE_PROXY_HOSTS unset', async () => {
    config.apiKey = '';
    config.dashboardPassword = 'admin-pw';
    config.allowPrivateProxyHosts = false;
    configureBindHost('0.0.0.0');

    const { res, captured } = mkRes();
    await handleDashboardApi(
      'PUT', '/proxy/global',
      { type: 'http', host: '127.0.0.1', port: 8080 },
      mkAuthedReq(), res,
    );
    assert.equal(captured.status, 400, 'private host must be rejected at /proxy/global');
    assert.ok(/PROXY_PRIVATE/i.test(JSON.stringify(captured.body) || ''), 'error code mentions private-host gate');
  });

  it('PUT /proxy/global with host=169.254.169.254 (cloud metadata) returns 400', async () => {
    config.apiKey = '';
    config.dashboardPassword = 'admin-pw';
    config.allowPrivateProxyHosts = false;
    configureBindHost('0.0.0.0');

    const { res, captured } = mkRes();
    await handleDashboardApi(
      'PUT', '/proxy/global',
      { type: 'http', host: '169.254.169.254', port: 80 },
      mkAuthedReq(), res,
    );
    assert.equal(captured.status, 400, 'cloud-metadata IP must be rejected');
  });

  it('PUT /proxy/accounts/:id with host=10.0.0.1 returns 400 (RFC1918 private)', async () => {
    config.apiKey = '';
    config.dashboardPassword = 'admin-pw';
    config.allowPrivateProxyHosts = false;
    configureBindHost('0.0.0.0');

    const { res, captured } = mkRes();
    await handleDashboardApi(
      'PUT', '/proxy/accounts/some-id',
      { type: 'http', host: '10.0.0.1', port: 3128 },
      mkAuthedReq(), res,
    );
    assert.equal(captured.status, 400, 'RFC1918 must be rejected at per-account proxy');
  });

  it('ALLOW_PRIVATE_PROXY_HOSTS=1 disables the gate (operator escape hatch)', async () => {
    config.apiKey = '';
    config.dashboardPassword = 'admin-pw';
    config.allowPrivateProxyHosts = true;
    configureBindHost('0.0.0.0');

    const { res, captured } = mkRes();
    await handleDashboardApi(
      'PUT', '/proxy/global',
      { type: 'http', host: '127.0.0.1', port: 8080 },
      mkAuthedReq(), res,
    );
    assert.equal(captured.status, 200, 'opt-in env should let operators set private hosts');
  });
});
