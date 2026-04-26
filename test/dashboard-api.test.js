import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchProxyBinding, checkDashboardAuth, isAdminFeatureEnabled } from '../src/dashboard/api.js';

describe('dashboard batch import proxy binding', () => {
  it('uses nested result.account.id from processWindsurfLogin output', () => {
    const binding = buildBatchProxyBinding(
      { success: true, account: { id: 'acct_123' } },
      'socks5://user:pass@proxy.example.com:1080'
    );
    assert.equal(binding.accountId, 'acct_123');
    assert.deepEqual(binding.proxy, {
      type: 'socks5',
      host: 'proxy.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });
  });
});

describe('dashboard auth policy', () => {
  it('accepts header password when dashboard password is configured', () => {
    const ok = checkDashboardAuth(
      { headers: { 'x-dashboard-password': 'dash-pass' } },
      { dashboardPassword: 'dash-pass', apiKey: '' }
    );
    assert.equal(ok, true);
  });

  it('rejects auth when only query fallback would match', () => {
    const ok = checkDashboardAuth(
      { headers: {}, url: '/dashboard/api/logs/stream?pwd=dash-pass' },
      { dashboardPassword: 'dash-pass', apiKey: '' }
    );
    assert.equal(ok, false);
  });
});

describe('dashboard admin feature flags', () => {
  it('keeps sensitive actions disabled by default when flags are off', () => {
    const flags = {
      enableSelfUpdate: false,
      enableBatchLogin: false,
      enableTokenRefresh: false,
      enableLsRestart: false,
    };
    assert.equal(isAdminFeatureEnabled('self-update', { flags }), false);
    assert.equal(isAdminFeatureEnabled('batch-login', { flags }), false);
    assert.equal(isAdminFeatureEnabled('token-refresh', { flags }), false);
    assert.equal(isAdminFeatureEnabled('ls-restart', { flags }), false);
  });

  it('enables only explicitly configured actions', () => {
    const flags = {
      enableSelfUpdate: true,
      enableBatchLogin: false,
      enableTokenRefresh: true,
      enableLsRestart: true,
    };
    assert.equal(isAdminFeatureEnabled('self-update', { flags }), true);
    assert.equal(isAdminFeatureEnabled('batch-login', { flags }), false);
    assert.equal(isAdminFeatureEnabled('token-refresh', { flags }), true);
    assert.equal(isAdminFeatureEnabled('ls-restart', { flags }), true);
    assert.equal(isAdminFeatureEnabled('unknown-feature', { flags }), false);
  });
});

