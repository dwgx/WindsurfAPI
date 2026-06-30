import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addAccountByKey, configureBindHost, removeAccount, _resetLockoutForTests } from '../src/auth.js';
import { buildBatchProxyBinding, handleDashboardApi } from '../src/dashboard/api.js';
import {
  recordNativeBridgeDecision,
  resetNativeBridgeStats,
} from '../src/native-bridge-stats.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const originalNativeBridgeApiKeys = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS;
const originalNativeBridgeAccounts = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS;
const createdAccounts = new Set();

afterEach(() => {
  for (const id of createdAccounts) removeAccount(id);
  createdAccounts.clear();
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  if (originalNativeBridgeApiKeys === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS = originalNativeBridgeApiKeys;
  if (originalNativeBridgeAccounts === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS = originalNativeBridgeAccounts;
  resetNativeBridgeStats();
  configureBindHost('0.0.0.0');
});

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function localReq(path) {
  return { url: `/dashboard/api${path}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

function addTestAccount(label) {
  const account = addAccountByKey(`test-key-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, label);
  createdAccounts.add(account.id);
  return account;
}

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

  it('fails closed for dashboard write APIs without auth on non-localhost binds', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('DELETE', '/cache', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /Unauthorized/);
  });

  it('allows unauthenticated dashboard writes only on localhost binds', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const res = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 200);
  });

  it('accepts dashboard auth headers with timing-safe configured secrets', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: { 'x-dashboard-password': 'dash-secret' } }, res);

    assert.equal(res.statusCode, 200);
  });

  it('includes sanitized native bridge telemetry in authenticated overview', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS = 'secret-api-key';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS = 'secret-account';
    recordNativeBridgeDecision({
      enabled: false,
      reason: 'native_bridge_model_not_allowed',
      mode: 'all_mapped',
      modelKey: 'gpt-5.5-medium',
      mappedTools: ['Read'],
      unmappedTools: ['update_plan'],
      callerKey: 'api:secret-caller',
    });

    const res = fakeRes();
    await handleDashboardApi('GET', '/overview', {}, { headers: { 'x-dashboard-password': 'dash-secret' } }, res);
    const body = res.json();
    const raw = JSON.stringify(body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.nativeBridge.decisions, 1);
    assert.equal(body.nativeBridge.decisionReasons.native_bridge_model_not_allowed, 1);
    assert.equal(body.nativeBridgeConfig.hasApiKeyGate, true);
    assert.equal(body.nativeBridgeConfig.hasAccountGate, true);
    assert.equal(raw.includes('secret-api-key'), false);
    assert.equal(raw.includes('secret-account'), false);
    assert.equal(raw.includes('secret-caller'), false);
  });

  it('exposes DEVIN_CONNECT recovery counters at /connect-metrics and resets on DELETE', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const { bumpConnect, resetConnectMetrics } = await import('../src/devin-connect-metrics.js');
    resetConnectMetrics();
    bumpConnect('failover_hops', 2);
    bumpConnect('dead_tokens');

    const res = fakeRes();
    await handleDashboardApi('GET', '/connect-metrics', {}, localReq('/connect-metrics'), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.failover_hops, 2);
    assert.equal(body.dead_tokens, 1);
    assert.equal(typeof body.credDecryptFailures, 'number');
    assert.ok(body.uptimeMs >= 0);

    const del = fakeRes();
    await handleDashboardApi('DELETE', '/connect-metrics', {}, localReq('/connect-metrics'), del);
    assert.equal(del.statusCode, 200);
    const after = fakeRes();
    await handleDashboardApi('GET', '/connect-metrics', {}, localReq('/connect-metrics'), after);
    assert.equal(after.json().failover_hops, 0);
  });

  it('supports paged lightweight account summaries without breaking the legacy full list', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');
    const a1 = addTestAccount('dashboard-summary-a');
    const a2 = addTestAccount('dashboard-summary-b');

    const summaryRes = fakeRes();
    await handleDashboardApi('GET', '/accounts', {}, localReq('/accounts?view=summary&page=1&pageSize=1'), summaryRes);
    const summary = summaryRes.json();
    assert.equal(summaryRes.statusCode, 200);
    assert.equal(summary.page, 1);
    assert.equal(summary.pageSize, 1);
    assert.ok(summary.total >= 2);
    assert.equal(summary.accounts.length, 1);
    assert.ok('tierModelCount' in summary.accounts[0]);
    assert.equal('tierModels' in summary.accounts[0], false);
    assert.equal('availableModels' in summary.accounts[0], false);
    assert.equal('capabilities' in summary.accounts[0], false);
    assert.equal('lsAdmission' in summary.accounts[0], false);

    const detailRes = fakeRes();
    await handleDashboardApi('GET', `/accounts/${a2.id}`, {}, localReq(`/accounts/${a2.id}`), detailRes);
    const detail = detailRes.json();
    assert.equal(detailRes.statusCode, 200);
    assert.equal(detail.account.id, a2.id);
    assert.ok(Array.isArray(detail.account.tierModels));
    assert.ok(Array.isArray(detail.account.availableModels));
    assert.ok('capabilities' in detail.account);

    const legacyRes = fakeRes();
    await handleDashboardApi('GET', '/accounts', {}, localReq('/accounts'), legacyRes);
    const legacy = legacyRes.json();
    const legacyA1 = legacy.accounts.find(a => a.id === a1.id);
    assert.equal(legacyRes.statusCode, 200);
    assert.ok(legacyA1);
    assert.ok(Array.isArray(legacyA1.tierModels));
    assert.ok(Array.isArray(legacyA1.availableModels));
  });
});
