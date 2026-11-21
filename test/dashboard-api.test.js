import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addAccountByKey, configureBindHost, getAccountInternal, removeAccount, _resetLockoutForTests } from '../src/auth.js';
import { buildBatchProxyBinding, handleDashboardApi } from '../src/dashboard/api.js';
import {
  recordNativeBridgeDecision,
  resetNativeBridgeStats,
} from '../src/native-bridge-stats.js';
import { getSnapshotSelectors } from '../src/devin-connect-models.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { detachedRegistry } from '../src/detached-registry.js';
import { __resetReadCache, __setFetchImplForTest, __setNowForTest } from '../src/dashboard/devin-read.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const originalNativeBridgeApiKeys = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS;
const originalNativeBridgeAccounts = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS;
const originalAllowNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
const createdAccounts = new Set();

afterEach(() => {
  __setFetchImplForTest(null);
  __setNowForTest(null);
  __resetReadCache();
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
  if (originalAllowNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = originalAllowNoAuth;
  resetNativeBridgeStats();
  configureBindHost('0.0.0.0');
});

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
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

  it('fails closed on localhost binds with no secret by default; opens only with DASHBOARD_ALLOW_NO_AUTH=1', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    // AUTH-1: localhost + nothing configured is now fail-closed by default.
    delete process.env.DASHBOARD_ALLOW_NO_AUTH;
    const closed = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, closed);
    assert.equal(closed.statusCode, 401);
    assert.match(closed.json().error, /Unauthorized/);

    // Operators who relied on the old open-local convenience must opt in.
    // audit #1: open-local requires a loopback PEER, not just a loopback bind.
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
    const open = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, open);
    assert.equal(open.statusCode, 200);
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

  it('does NOT lock out on empty-password preloads (page-load 401s are not brute-force)', async () => {
    _resetRuntimeConfigForTests();
    _resetLockoutForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const ip = '203.0.113.7';
    const req = (hdrs) => ({ url: '/dashboard/api/overview', headers: hdrs, socket: { remoteAddress: ip } });

    // Simulate the dashboard firing many authed calls with NO password on load.
    for (let i = 0; i < 12; i++) {
      const r = fakeRes();
      await handleDashboardApi('GET', '/overview', {}, req({}), r);
      assert.equal(r.statusCode, 401, 'empty-password call should 401');
    }
    // The IP must NOT be banned — the correct password should still work.
    const ok = fakeRes();
    await handleDashboardApi('GET', '/overview', {}, req({ 'x-dashboard-password': 'dash-secret' }), ok);
    assert.equal(ok.statusCode, 200, 'correct password must still work after empty-password preloads');
  });

  it('DOES lock out after repeated WRONG-password guesses', async () => {
    _resetRuntimeConfigForTests();
    _resetLockoutForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const ip = '203.0.113.8';
    const req = () => ({ url: '/dashboard/api/overview', headers: { 'x-dashboard-password': 'wrong-guess' }, socket: { remoteAddress: ip } });

    let banned = false;
    for (let i = 0; i < 10; i++) {
      const r = fakeRes();
      await handleDashboardApi('GET', '/overview', {}, req(), r);
      if (r.statusCode === 429) { banned = true; break; }
    }
    assert.equal(banned, true, 'repeated wrong-password guesses must eventually ban the IP');
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

  it('exposes detach admit/serve counters for the gate-1 measurement', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const previousTurn = process.env.WINDSURFAPI_CASCADE_TURN;
    const previousDetach = process.env.WINDSURFAPI_CASCADE_DETACH;
    process.env.WINDSURFAPI_CASCADE_TURN = '1';
    process.env.WINDSURFAPI_CASCADE_DETACH = '1';
    detachedRegistry.reset();
    try {
      const admitted = detachedRegistry.admit({
        key: 'gate1-key',
        callerKey: 'session:gate1',
        snapshot: { version: 2, chunks: [{ text: 'gate1' }], consumedThrough: 0, stepOffset: 0 },
        pin: { deadline: Date.now() + 60_000 },
      });
      assert.ok(admitted.token, 'precondition: the registry admitted the sample entry');

      const first = fakeRes();
      await handleDashboardApi('GET', '/overview', {}, { headers: { 'x-dashboard-password': 'dash-secret' } }, first);
      const firstBody = first.json();
      assert.equal(first.statusCode, 200);
      assert.equal(firstBody.detach.enabled, true, 'gate 1 must be able to prove the switch is on');
      assert.equal(firstBody.detach.admit, 1);
      assert.equal(firstBody.detach.serve, 0);
      assert.equal(typeof firstBody.detach.refuse.no_scope, 'number', 'refusal reasons are part of the measurement surface');

      const claim = detachedRegistry.claim('gate1-key', 'session:gate1');
      assert.ok(claim.entry, 'precondition: the entry is claimable');
      detachedRegistry.release('gate1-key', claim.token, { state: 'served' });

      const second = fakeRes();
      await handleDashboardApi('GET', '/overview', {}, { headers: { 'x-dashboard-password': 'dash-secret' } }, second);
      const secondBody = second.json();
      assert.equal(secondBody.detach.admit, 1);
      assert.equal(secondBody.detach.serve, 1, 'serve/admit is the gate-1 ratio');
      assert.equal(secondBody.detach.entries, 0);
    } finally {
      detachedRegistry.reset();
      if (previousTurn === undefined) delete process.env.WINDSURFAPI_CASCADE_TURN;
      else process.env.WINDSURFAPI_CASCADE_TURN = previousTurn;
      if (previousDetach === undefined) delete process.env.WINDSURFAPI_CASCADE_DETACH;
      else process.env.WINDSURFAPI_CASCADE_DETACH = previousDetach;
    }
  });

  it('exposes DEVIN_CONNECT recovery counters at /connect-metrics and resets on DELETE', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1'; // convenience: exercise metrics, not auth

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
    // Sticky affinity counters ride the same endpoint so an operator can see
    // whether STICKY_SESSION_ENABLED is actually binding.
    assert.equal(typeof body.sticky, 'object');
    assert.equal(typeof body.sticky.enabled, 'boolean');
    for (const k of ['hits', 'misses', 'creates', 'fallbacks', 'size']) {
      assert.equal(typeof body.sticky[k], 'number', `sticky.${k} must be a number`);
    }

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
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1'; // convenience: exercise paging, not auth
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

// B2: /pool-events exposes the cooldown projection the dashboard's transition
// notifier diffs. cooldownReason is a precedence chain (quota > rate_limit >
// capacity > null) and cooldownUntil is max(rateLimitedUntil, quotaResetAt),
// normalized to null (not 0) when neither deadline is set. This route had zero
// test references before this block.
describe('GET /pool-events cooldown projection', () => {
  it('reports the precedence chain and the max deadline per account state', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1'; // convenience: exercise projection, not auth

    const now = Date.now();
    const healthy = addTestAccount('pool-events-healthy');
    const quota = addTestAccount('pool-events-quota');
    const rate = addTestAccount('pool-events-rate');
    const capacity = addTestAccount('pool-events-capacity');
    const disabled = addTestAccount('pool-events-disabled');

    const h = getAccountInternal(healthy.id);
    h.tier = 'pro';
    h.credits = { balance: 12.5 };
    h.errorCount = 3;

    getAccountInternal(disabled.id).status = 'disabled';

    // quota outranks the transient and capacity dimensions; the deadline is the
    // LATER of the two real deadlines (max, not the reason's own deadline).
    const q = getAccountInternal(quota.id);
    q.rateLimitedUntil = now + 60_000;
    q.quotaResetAt = now + 120_000;
    q._modelRateLimits = { 'claude-sonnet-4.6': now + 30_000 };

    // rate_limit outranks capacity.
    const r = getAccountInternal(rate.id);
    r.rateLimitedUntil = now + 90_000;
    r.quotaResetAt = 0;
    r._modelRateLimits = { 'claude-sonnet-4.6': now + 30_000 };

    // capacity alone has no account-wide deadline: cooldownUntil must stay null.
    const c = getAccountInternal(capacity.id);
    c.rateLimitedUntil = 0;
    c.quotaResetAt = 0;
    c._modelRateLimits = { 'claude-sonnet-4.6': now + 30_000 };

    const res = fakeRes();
    await handleDashboardApi('GET', '/pool-events', {}, localReq('/pool-events'), res);

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.ts, 'number', 'the payload must carry a snapshot timestamp');
    const byId = new Map(body.accounts.map(a => [a.id, a]));
    assert.match(byId.get(healthy.id).ref, /^acct-[0-9a-f]{8}$/);
    assert.equal('keyPrefix' in byId.get(healthy.id), false);

    assert.deepEqual(
      {
        status: byId.get(healthy.id).status,
        tier: byId.get(healthy.id).tier,
        balance: byId.get(healthy.id).balance,
        errorCount: byId.get(healthy.id).errorCount,
        cooldownReason: byId.get(healthy.id).cooldownReason,
        cooldownUntil: byId.get(healthy.id).cooldownUntil,
      },
      { status: 'active', tier: 'pro', balance: 12.5, errorCount: 3, cooldownReason: null, cooldownUntil: null },
      'a healthy account must project null (not 0) cooldown fields',
    );

    assert.equal(byId.get(quota.id).cooldownReason, 'quota');
    assert.equal(byId.get(quota.id).cooldownUntil, now + 120_000,
      'cooldownUntil must be max(rateLimitedUntil, quotaResetAt)');

    assert.equal(byId.get(rate.id).cooldownReason, 'rate_limit');
    assert.equal(byId.get(rate.id).cooldownUntil, now + 90_000);

    assert.equal(byId.get(capacity.id).cooldownReason, 'capacity');
    assert.equal(byId.get(capacity.id).cooldownUntil, null,
      'a capacity-only account has no account-wide deadline');

    assert.equal(byId.get(healthy.id).state, 'active');
    assert.equal(byId.get(healthy.id).cooldownRemainingMs, 0);
    assert.equal(byId.get(healthy.id).upstream, null, 'no cache primed: the overlay must be null, not an error');

    assert.equal(byId.get(quota.id).state, 'quota');
    assert.ok(byId.get(quota.id).cooldownRemainingMs > 0);
    assert.ok(byId.get(quota.id).cooldownRemainingMs <= 120_000);

    assert.equal(byId.get(rate.id).state, 'rate_limited');
    assert.ok(byId.get(rate.id).cooldownRemainingMs > 0);

    assert.equal(byId.get(capacity.id).state, 'capacity');
    assert.equal(byId.get(capacity.id).cooldownRemainingMs, 0);

    assert.equal(byId.get(disabled.id).state, 'disabled');

    const serialized = res.body;
    for (const secret of ['keyPrefix', 'apiKey', 'refreshToken', 'totalBalance', '@']) {
      assert.equal(serialized.includes(secret), false, `pool payload must not contain ${secret}`);
    }
    assert.equal(res.headers['Cache-Control'], 'no-store',
      'authed pool snapshots must not be browser-cached');
  });
});

// ─── P0 read cards ──────────────────────────────────────────────────────────
// /usage, /billing/health and /models/reconcile are GET-only projections of
// app.devin.ai billing/model reads. The fake fetch below is the only transport:
// these tests assert the exact paths, the shared cache, the redaction allowlist
// and Cache-Control: no-store.

const CARD_TOGGLEABLE = [
  'devin-gpt-6-1-sol',
  'devin-gpt-6-sol',
  'devin-gpt-6-astra',
  'devin-fable-5-1',
  'devin-opus-5-5',
  'devin-swe-2-high',
  'devin-swe-2-max',
  'devin-swe-2-lightning-high',
  'devin-swe-2-lightning-max',
  'devin-2-5',
  'devin-auto',
  'devin-fast-opus',
  'devin_lite',
  'devin-ultra',
  'devin-swe-2-low',
  'devin-swe-2-priority-low',
  'devin-swe-2-priority-high',
  'devin-swe-2-priority-max',
  'devin-swe-2-lightning-low',
];

function cardJson(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(value),
  };
}

function cardReq(path) {
  return {
    url: `/dashboard/api${path}`,
    headers: { 'x-dashboard-password': 'card-secret' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function installCardFetch({ status = 200, quotaStatus = 200 } = {}) {
  const calls = [];
  __setFetchImplForTest(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const path = url.replace('https://app.devin.ai/api', '');
    if (path === '/users/current-membership') {
      return cardJson({ org: { org_id: 'org-test123' }, user: { email: 'operator@example.test' } });
    }
    if (path === '/org-test123/billing/quota/usage') {
      return quotaStatus === 200
        ? cardJson({
          is_quota_plan: true,
          has_quota_allocation: true,
          daily_percentage: 3,
          weekly_percentage: 1,
          daily_reset_at: '2026-10-18T00:00:00-08:00',
          weekly_reset_at: '2026-10-18T00:00:00-08:00',
          overage_balance: 0,
          hide_daily_quota: false,
        })
        : cardJson({ detail: 'Forbidden' }, quotaStatus);
    }
    if (path === '/org-test123/billing/status') {
      return status === 200
        ? cardJson({
          plan_slug: 'pro',
          is_subscription_valid: true,
          uses_quota: true,
          has_subscription_or_credits: true,
          has_failed_auto_recharge: false,
          billing_error: null,
          billing_method: 'stripe',
          available_credits: 0,
          overage_credits: 0,
          billing_waived_agent_versions: [],
        })
        : cardJson({ detail: 'Forbidden' }, status);
    }
    if (path === '/org-test123/billing/usage/limits') {
      return status === 200
        ? cardJson({ max_acu_limit: 20, max_total_session_acu_limit: null })
        : cardJson({ detail: 'Forbidden' }, 403);
    }
    if (path === '/org-test123/billing/usage/daily-usage?cycle=current&view=all') {
      return status === 200 ? cardJson({
        cycle_start: '2026-10-16T20:11:50+00:00',
        cycle_end: '2026-11-16T20:11:50+00:00',
        previous_cycle_available: false,
        total: 0,
        days: [{ date: '2026-10-16', amount: 0, cumulative: 0 }],
        products: [{ view: 'sessions', total: 0, days: [] }],
      }) : cardJson({ detail: 'Forbidden' }, 403);
    }
    if (path === '/users/spending-state') return cardJson({ state: 'active' });
    if (path === '/org-test123/limit-suspended-sessions') return cardJson({ sessions: [], can_restart_now: false });
    if (path === '/billing/subscription/unpaid-invoices') return cardJson({ has_unpaid_invoices: false });
    if (path === '/org-test123/billing/auto-recharge/params') {
      return cardJson({
        account_migrated_to_auto_recharge: true,
        auto_recharge_enabled: false,
        threshold: null,
        amount: null,
        max_monthly_total_spend: null,
      });
    }
    if (path === '/internal-model-catalog') return cardJson({ groups: [], sections: [] });
    if (path === '/org-test123/fed-models') {
      return cardJson({ tiers: {}, helpers: [], models: {}, allowlist: null });
    }
    if (path === '/toggleable-agent-versions') {
      return cardJson({ toggleable_versions: CARD_TOGGLEABLE, swe2_promo_eligible: false, swe2_priority_eligible: false });
    }
    if (path === '/windsurf/org-configs') {
      return cardJson({
        enterpriseTeamConfig: { teamId: 'team-secret-value', allowMcpServers: true },
        enterpriseControlConfig: { extensionModelLabels: ['Base Model'] },
      });
    }
    throw new Error(`unexpected ${path}`);
  });
  return calls;
}

function countPath(calls, suffix) {
  return calls.filter((c) => c.url.endsWith(suffix)).length;
}

describe('dashboard P0 read cards', () => {
  it('serves quota burn-down without orgId/keyPrefix and with a no-store header', async () => {
    config.dashboardPassword = 'card-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const account = addTestAccount('card-usage');
    const calls = installCardFetch();

    const res = fakeRes();
    await handleDashboardApi('GET', '/usage', {}, cardReq(`/usage?account=${account.id}`), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.accountId, account.id);
    assert.match(body.accountRef, /^acct-[0-9a-f]{8}$/);
    assert.equal(body.plan, 'pro');
    assert.equal(body.quota.dailyPercentage, 3);
    assert.equal(body.limits.maxAcuLimit, 20);
    assert.equal(body.limits.maxTotalSessionAcuLimit, null);
    assert.equal(body.products.length, 1);
    assert.equal(body.serverNow > 0, true);
    assert.equal(body.cached, false);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.ok(countPath(calls, '/billing/usage/daily-usage?cycle=current&view=all') === 1);
    assert.equal(countPath(calls, '/users/post-auth'), 0, 'the dashboard read path must never post-auth');
    assert.ok(calls.every((c) => c.method === 'GET'));
    assert.ok(calls.every((c) => c.headers.Authorization === `Bearer ${account.apiKey}`));

    const serialized = res.body;
    assert.equal(serialized.includes('orgId'), false);
    assert.equal(serialized.includes('org_id'), false);
    assert.equal(serialized.includes('account_id'), false);
    assert.equal(serialized.includes('org-test123'), false);
    assert.equal(serialized.includes('keyPrefix'), false);
    assert.equal(serialized.includes('operator@example.test'), false);

    // Second call within the 30 s TTL: cached and zero new source fetches.
    const before = calls.length;
    const second = fakeRes();
    await handleDashboardApi('GET', '/usage', {}, cardReq(`/usage?account=${account.id}`), second);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().cached, true);
    assert.equal(calls.length, before, 'a cache hit must not refetch');

    // The pool card's upstream overlay is cache-only: after /usage primed
    // `status`, it carries the allowlist keys and triggers no new fetch.
    const pool = fakeRes();
    await handleDashboardApi('GET', '/pool-events', {}, cardReq('/pool-events'), pool);
    const row = pool.json().accounts.find((a) => a.id === account.id);
    assert.deepEqual(
      Object.keys(row.upstream).sort(),
      ['billingValid', 'fetchedAt', 'plan', 'spendingState', 'stale'],
    );
    assert.equal(row.upstream.plan, 'pro');
    assert.equal(calls.length, before, 'the pool overlay must never fetch upstream');
  });

  it('shares the quota/status cache with billing health and serves the ok banner', async () => {
    config.dashboardPassword = 'card-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const account = addTestAccount('card-health');
    const calls = installCardFetch();

    const usage = fakeRes();
    await handleDashboardApi('GET', '/usage', {}, cardReq(`/usage?account=${account.id}`), usage);
    assert.equal(usage.statusCode, 200);

    const res = fakeRes();
    await handleDashboardApi('GET', '/billing/health', {}, cardReq(`/billing/health?account=${account.id}`), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.state, 'ok');
    assert.equal(body.severity, 'ok');
    assert.equal(body.bannerKey, 'billing.banner.ok');
    assert.equal(body.details.plan, 'pro');
    assert.equal(body.details.spendingState, 'active');
    assert.equal(body.details.suspendedSessionCount, 0);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.equal(countPath(calls, '/billing/status'), 1, 'status is shared with the usage card');
    assert.equal(countPath(calls, '/billing/quota/usage'), 1, 'quota is shared with the usage card');
    assert.equal(countPath(calls, '/users/spending-state'), 1);
    assert.equal(countPath(calls, '/users/post-auth'), 0);
    assert.equal(res.body.includes('org-test123'), false);
    assert.equal(res.body.includes('keyPrefix'), false);
  });

  it('serves model reconciliation with the committed snapshot and no teamId', async () => {
    config.dashboardPassword = 'card-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const account = addTestAccount('card-models');
    const calls = installCardFetch();

    const res = fakeRes();
    await handleDashboardApi('GET', '/models/reconcile', {}, cardReq(`/models/reconcile?account=${account.id}`), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.snapshotCount, getSnapshotSelectors().length);
    assert.equal(body.synced, false);
    assert.deepEqual(body.added, []);
    assert.deepEqual(body.missing, []);
    assert.equal(body.toggleable.total, 19);
    assert.equal(body.toggleable.mappedCount, 9);
    assert.equal(body.upstreamCatalog.empty, true);
    assert.equal(body.orgConfig.teamIdPresent, true);
    assert.equal(body.localCount > 0, true);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.ok(countPath(calls, '/internal-model-catalog') === 1);
    assert.ok(countPath(calls, '/org-test123/fed-models') === 1);
    assert.ok(countPath(calls, '/toggleable-agent-versions') === 1);
    assert.ok(countPath(calls, '/windsurf/org-configs') === 1);
    assert.equal(countPath(calls, '/users/post-auth'), 0);
    assert.equal(res.body.includes('team-secret-value'), false);
    assert.equal(res.body.includes('org-test123'), false);
    assert.equal(res.body.includes('keyPrefix'), false);
  });

  it('returns 403 (not zeros) when the billing sources forbid access', async () => {
    config.dashboardPassword = 'card-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const account = addTestAccount('card-forbidden');
    installCardFetch({ status: 403, quotaStatus: 403 });

    const res = fakeRes();
    await handleDashboardApi('GET', '/usage', {}, cardReq(`/usage?account=${account.id}`), res);
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'forbidden');
    assert.equal('quota' in body, false, 'a forbidden read must not render zeros');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  it('serves the last good snapshot as stale when the upstream times out', async () => {
    config.dashboardPassword = 'card-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const account = addTestAccount('card-stale');
    installCardFetch();

    const first = fakeRes();
    await handleDashboardApi('GET', '/usage', {}, cardReq(`/usage?account=${account.id}`), first);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().stale, false);

    // Age the cache past the 30 s TTL, then make every upstream read time out.
    const realNow = Date.now();
    __setNowForTest(() => realNow + 31_000);
    __setFetchImplForTest(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });

    const stale = fakeRes();
    await handleDashboardApi('GET', '/usage', {}, cardReq(`/usage?account=${account.id}`), stale);
    assert.equal(stale.statusCode, 200);
    const body = stale.json();
    assert.equal(body.ok, true);
    assert.equal(body.stale, true);
    assert.equal(body.quota.dailyPercentage, 3, 'the last good value is preserved');
    assert.equal(stale.headers['Cache-Control'], 'no-store');
  });

  it('returns 404 for an unknown account id', async () => {
    config.dashboardPassword = 'card-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    installCardFetch();

    const res = fakeRes();
    await handleDashboardApi('GET', '/usage', {}, cardReq('/usage?account=does-not-exist'), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'account_not_found');
  });
});
