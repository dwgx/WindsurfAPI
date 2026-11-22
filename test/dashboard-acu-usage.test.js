// Org-scoped ACU & usage reader (Q3 / REPORT C1).
//
// Pins the truth rules that matter for this surface:
//   - accounts in one org are read ONCE and rendered once (no double count),
//   - `max_acu_limit: null` is unlimited, never zero,
//   - an absent cycle total is unknown, never a fabricated zero,
//   - a per-org 403 stays a per-org error while other orgs still render,
//   - raw org ids, tokens and emails never reach the browser payload.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import {
  __resetReadCache,
  __setFetchImplForTest,
  __setNowForTest,
} from '../src/dashboard/devin-read.js';
import {
  deriveAcuCells,
  latestDayOf,
  orgRefOf,
  readAcuUsageByOrg,
} from '../src/dashboard/acu-usage.js';

const createdAccounts = new Set();
const NOW = Date.parse('2026-10-22T12:00:00Z');

function addDevinAccount(token, label) {
  const account = addAccountByKey(token, label);
  createdAccounts.add(account.id);
  return account;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return JSON.stringify(body); },
  };
}

function usageFixture(overrides = {}) {
  return {
    cycle_start: '2026-10-16T20:11:50+00:00',
    cycle_end: '2026-11-16T20:11:50+00:00',
    previous_cycle_available: false,
    total: 12.5,
    days: [
      { date: '2026-10-20', amount: 2, cumulative: 10 },
      { date: '2026-10-21', amount: 2.5, cumulative: 12.5 },
    ],
    products: [
      { view: 'sessions', total: 10, days: [{ date: '2026-10-21', amount: 2.5, cumulative: 10 }] },
      { view: 'code-scans', total: 2.5, days: [] },
    ],
    ...overrides,
  };
}

function installFetch({
  orgForToken = () => 'org-aaa',
  dailyStatus = 200,
  dailyBody = usageFixture(),
  limitsBody = { max_acu_limit: 20, max_total_session_acu_limit: null },
  statusBody = {
    plan_slug: 'pro',
    is_subscription_valid: true,
    billing_method: 'stripe',
    available_credits: 0,
    overage_credits: 0,
  },
} = {}) {
  const calls = [];
  __setFetchImplForTest(async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const token = String(init?.headers?.Authorization || '').replace(/^Bearer\s+/, '');
    calls.push({ url, path, method: init?.method, token });

    if (parsed.pathname === '/api/users/current-membership') {
      return jsonResponse({ org: { org_id: orgForToken(token) } });
    }
    if (/^\/api\/org-[A-Za-z0-9-]+\/billing\/quota\/usage$/.test(parsed.pathname)) {
      return jsonResponse({
        is_quota_plan: true,
        has_quota_allocation: true,
        daily_percentage: 70,
        weekly_percentage: 80,
        daily_reset_at: '2026-10-23T00:00:00-08:00',
        weekly_reset_at: '2026-10-26T00:00:00-08:00',
        overage_balance: 0,
        hide_daily_quota: false,
      });
    }
    if (/^\/api\/org-[A-Za-z0-9-]+\/billing\/status$/.test(parsed.pathname)) {
      return jsonResponse(statusBody);
    }
    if (/^\/api\/org-[A-Za-z0-9-]+\/billing\/usage\/limits$/.test(parsed.pathname)) {
      return jsonResponse(limitsBody);
    }
    if (/^\/api\/org-[A-Za-z0-9-]+\/billing\/usage\/daily-usage$/.test(parsed.pathname)) {
      return jsonResponse(dailyStatus === 200 ? dailyBody : { detail: 'Forbidden' }, dailyStatus);
    }
    throw new Error(`unexpected ${path}`);
  });
  return calls;
}

function count(calls, fragment) {
  return calls.filter((call) => call.path.includes(fragment)).length;
}

afterEach(() => {
  __setFetchImplForTest(null);
  __setNowForTest(null);
  __resetReadCache();
  for (const id of createdAccounts) removeAccount(id);
  createdAccounts.clear();
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.DEVIN_BACKEND_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  delete process.env.DEVIN_BACKEND_ORG_ID;
});

describe('deriveAcuCells', () => {
  it('derives remaining from a reported limit and usage', () => {
    const cells = deriveAcuCells({ limits: { maxAcuLimit: 20 }, cycle: { total: 5 } });
    assert.deepEqual(cells.acuLimit, { value: 20, known: true, unlimited: false, reason: 'reported' });
    assert.deepEqual(cells.used, { value: 5, known: true, reason: 'reported' });
    assert.equal(cells.remaining.value, 15);
    assert.equal(cells.remaining.known, true);
    assert.equal(cells.remaining.derived, true);
    assert.equal(cells.remaining.over, false);
  });

  it('renders a null limit as unlimited, never as zero', () => {
    const cells = deriveAcuCells({ limits: { maxAcuLimit: null }, cycle: { total: 5 } });
    assert.equal(cells.acuLimit.value, null);
    assert.equal(cells.acuLimit.known, false);
    assert.equal(cells.acuLimit.unlimited, true);
    assert.equal(cells.remaining.unlimited, true);
    assert.equal(cells.remaining.value, null);
  });

  it('keeps an absent total unknown instead of fabricating zero', () => {
    const cells = deriveAcuCells({ limits: { maxAcuLimit: 20 }, cycle: {} });
    assert.equal(cells.used.value, null);
    assert.equal(cells.used.known, false);
    assert.equal(cells.remaining.value, null);
    assert.equal(cells.remaining.known, false);
    assert.equal(cells.remaining.reason, 'usage_absent');
  });

  it('keeps a real zero zero and clamps an over-limit derivation', () => {
    const zero = deriveAcuCells({ limits: { maxAcuLimit: 0 }, cycle: { total: 0 } });
    assert.equal(zero.remaining.value, 0);
    assert.equal(zero.remaining.known, true);

    const over = deriveAcuCells({ limits: { maxAcuLimit: 10 }, cycle: { total: 12 } });
    assert.equal(over.remaining.value, 0);
    assert.equal(over.remaining.over, true);
  });

  it('does not coerce strings or NaN', () => {
    const cells = deriveAcuCells({ limits: { maxAcuLimit: '20' }, cycle: { total: NaN } });
    assert.equal(cells.acuLimit.known, false);
    assert.equal(cells.used.known, false);
    assert.equal(cells.remaining.reason, 'limit_absent');
  });
});

describe('latestDayOf', () => {
  it('excludes future dates in a cycle from the latest observed day', () => {
    const day = latestDayOf([
      { date: '2026-11-22', amount: 1.5 },
      { date: '2026-11-23', amount: 0 },
      { date: '2026-12-18', amount: 0 },
    ], Date.parse('2026-11-23T12:00:00Z'));
    assert.equal(day.date, '2026-11-23');
    assert.equal(day.amount, 0);
  });

  it('picks the latest date, not the last array slot', () => {
    const day = latestDayOf([
      { date: '2026-10-21', amount: 1 },
      { date: '2026-10-19', amount: 2 },
    ]);
    assert.equal(day.date, '2026-10-21');
    assert.equal(day.amount, 1);
  });

  it('preserves an absent amount as null and returns null with no rows', () => {
    assert.deepEqual(latestDayOf([{ date: '2026-10-21' }]), {
      date: '2026-10-21', amount: null, cumulative: null,
    });
    assert.equal(latestDayOf([]), null);
    assert.equal(latestDayOf(null), null);
  });
});

describe('readAcuUsageByOrg', () => {
  it('reads each org once and groups its member accounts', async () => {
    addDevinAccount('devin-session-token$tok-a1', 'alpha-one');
    addDevinAccount('devin-session-token$tok-a2', 'alpha-two');
    addDevinAccount('devin-session-token$tok-b1', 'beta-one');
    const calls = installFetch({
      orgForToken: (token) => (token.includes('tok-b') ? 'org-bbb' : 'org-aaa'),
    });

    const result = await readAcuUsageByOrg({ now: NOW });

    assert.equal(result.ok, true);
    assert.equal(result.accountsScanned, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.orgs.length, 2, 'two orgs, three accounts');

    const alpha = result.orgs.find((org) => org.accounts.length === 2);
    const beta = result.orgs.find((org) => org.accounts.length === 1);
    assert.ok(alpha && beta);
    assert.equal(alpha.ok, true);
    assert.equal(alpha.plan, 'pro');
    assert.equal(alpha.cycle.total, 12.5);
    assert.equal(alpha.limits.maxAcuLimit, 20);
    assert.equal(alpha.derived.acuLimit.value, 20);
    assert.equal(alpha.derived.used.value, 12.5);
    assert.equal(alpha.derived.remaining.value, 7.5);
    assert.equal(alpha.derived.latestDay.date, '2026-10-21');
    assert.equal(alpha.derived.latestDay.amount, 2.5);
    assert.equal(alpha.days.length, 2);
    assert.equal(alpha.products.length, 2);
    assert.match(alpha.orgRef, /^orgref-[0-9a-f]{12}$/);

    assert.equal(count(calls, '/billing/usage/daily-usage'), 2, 'one daily read per org, not per account');
    assert.equal(count(calls, '/users/current-membership'), 3);
    assert.ok(calls.every((call) => call.method === 'GET'));

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('org-aaa'), false, 'raw org id must not reach the browser');
    assert.equal(serialized.includes('org-bbb'), false);
    assert.equal(serialized.includes('devin-session-token$'), false);
    assert.equal(serialized.includes('alpha-one'), false);
    assert.equal(serialized.includes('alpha-two'), false);
  });

  it('passes a negative overage balance through to the panel payload', async () => {
    // The overage balance is signed USD: a negative value is an overdraft, so
    // the org reader must not clamp or drop it before the renderer sees it.
    addDevinAccount('devin-session-token$tok-over', 'overdrawn-account');
    installFetch({
      statusBody: {
        plan_slug: 'pro',
        is_subscription_valid: true,
        billing_method: 'stripe',
        available_credits: 0,
        overage_credits: -0.1,
      },
    });

    const result = await readAcuUsageByOrg({ now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.orgs[0].overageCredits, -0.1);
  });

  it('serves a second load from the read cache without new upstream calls', async () => {
    addDevinAccount('devin-session-token$tok-cache', 'cache-account');
    const calls = installFetch();

    const first = await readAcuUsageByOrg({ now: NOW });
    assert.equal(first.ok, true);
    const before = calls.length;

    const second = await readAcuUsageByOrg({ now: NOW + 1000 });
    assert.equal(second.ok, true);
    assert.equal(second.orgs[0].cached, true);
    assert.equal(calls.length, before, 'TTL cache must absorb the second load');
  });

  it('keeps a per-org 403 as that org’s error while other orgs render', async () => {
    addDevinAccount('devin-session-token$tok-denied', 'denied-account');
    addDevinAccount('devin-session-token$tok-ok', 'ok-account');

    // Only the denied org's daily read is forbidden.
    __setFetchImplForTest(async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/users/current-membership') {
        const token = String(init.headers.Authorization).replace(/^Bearer\s+/, '');
        return jsonResponse({ org: { org_id: token.includes('denied') ? 'org-denied' : 'org-ok' } });
      }
      if (parsed.pathname.startsWith('/api/org-denied/billing/')) {
        return jsonResponse({ detail: 'Forbidden' }, 403);
      }
      if (parsed.pathname.endsWith('/billing/quota/usage')) {
        return jsonResponse({ daily_percentage: 90, weekly_percentage: 90 });
      }
      if (parsed.pathname.endsWith('/billing/status')) {
        return jsonResponse({ plan_slug: 'free', is_subscription_valid: true });
      }
      if (parsed.pathname.endsWith('/billing/usage/limits')) {
        return jsonResponse({ max_acu_limit: null, max_total_session_acu_limit: null });
      }
      if (parsed.pathname.endsWith('/billing/usage/daily-usage')) {
        return jsonResponse(usageFixture({ total: 3, days: [], products: [] }));
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    });

    const result = await readAcuUsageByOrg({ now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.orgs.length, 2);
    const denied = result.orgs.find((org) => org.ok === false);
    const ok = result.orgs.find((org) => org.ok === true);
    assert.ok(denied && ok);
    assert.equal(denied.error, 'forbidden');
    assert.equal(denied.httpStatus, 403);
    assert.equal(ok.derived.remaining.unlimited, true, 'null limit stays unlimited');
  });

  it('returns an empty-but-valid org when the cycle has no rows', async () => {
    addDevinAccount('devin-session-token$tok-empty', 'empty-account');
    installFetch({
      dailyBody: usageFixture({ total: null, days: [], products: [] }),
    });

    const result = await readAcuUsageByOrg({ now: NOW });
    assert.equal(result.ok, true);
    const org = result.orgs[0];
    assert.equal(org.ok, true);
    assert.deepEqual(org.days, []);
    assert.deepEqual(org.products, []);
    assert.equal(org.cycle.total, null);
    assert.equal(org.derived.used.known, false);
    assert.equal(org.derived.remaining.known, false);
    assert.equal(org.derived.latestDay, null);
  });

  it('marks a partial source without discarding the sources that answered', async () => {
    addDevinAccount('devin-session-token$tok-partial', 'partial-account');
    __setFetchImplForTest(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/users/current-membership') {
        return jsonResponse({ org: { org_id: 'org-partial' } });
      }
      if (parsed.pathname.endsWith('/billing/usage/daily-usage')) {
        return jsonResponse({ detail: 'boom' }, 500);
      }
      if (parsed.pathname.endsWith('/billing/quota/usage')) {
        return jsonResponse({ daily_percentage: 50, weekly_percentage: 50 });
      }
      if (parsed.pathname.endsWith('/billing/status')) {
        return jsonResponse({ plan_slug: 'pro', is_subscription_valid: true });
      }
      if (parsed.pathname.endsWith('/billing/usage/limits')) {
        return jsonResponse({ max_acu_limit: 10, max_total_session_acu_limit: 5 });
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    });

    const result = await readAcuUsageByOrg({ now: NOW });
    const org = result.orgs[0];
    assert.equal(org.ok, true);
    assert.equal(org.partial, true);
    assert.equal(org.sources.daily.ok, false);
    assert.equal(org.sources.quota.ok, true);
    assert.equal(org.derived.acuLimit.value, 10);
    assert.equal(org.derived.used.known, false, 'daily total is unavailable, not zero');
    assert.deepEqual(org.days, []);
  });

  it('uses the deploy-level token when the pool has no Devin account', async () => {
    process.env.DEVIN_CONNECT_TOKEN = 'devin-session-token$env';
    installFetch({ orgForToken: () => 'org-env' });

    const result = await readAcuUsageByOrg({ now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.orgs.length, 1);
    assert.equal(result.orgs[0].accounts[0].id, 'env-token');
    assert.equal(result.orgs[0].derived.acuLimit.value, 20);
    assert.equal(JSON.stringify(result).includes('devin-session-token$'), false);
  });

  it('returns no_account (and an empty org list) when no Devin token exists', async () => {
    const result = await readAcuUsageByOrg({ now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'no_account');
    assert.equal(result.httpStatus, 503);
    assert.deepEqual(result.orgs, []);
  });

  it('caps the scan and reports truncation', async () => {
    addDevinAccount('devin-session-token$tok-cap1', 'cap-one');
    addDevinAccount('devin-session-token$tok-cap2', 'cap-two');
    installFetch({
      orgForToken: (token) => (token.endsWith('cap1') ? 'org-cap1' : 'org-cap2'),
    });

    const result = await readAcuUsageByOrg({ now: NOW, maxAccounts: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.accountsScanned, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.orgs.length, 1);
  });

  it('derives a stable org ref without exposing the id', () => {
    const ref = orgRefOf('org-secret-value');
    assert.match(ref, /^orgref-[0-9a-f]{12}$/);
    assert.equal(ref, orgRefOf('org-secret-value'));
    assert.notEqual(ref, orgRefOf('org-other-value'));
    assert.equal(ref.includes('secret'), false);
  });
});
