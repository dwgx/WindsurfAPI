// Dashboard /models and /v1/models must answer the SAME question about the Connect
// namespace (#234's last acceptance criterion).
//
// They did not. With DEVIN_CONNECT=1 on a free-only pool, measured before the fix:
//
//   /v1/models          1 row   (swe-1-6-slow)
//   dashboard /models   163 rows, ZERO overlap — every model the account cannot call,
//                       and the one it CAN was absent entirely
//
// The dashboard resolved through the Cascade namespace (filterModelKeysByCloudCatalog,
// which early-returns unfiltered when devinConnect is on — correct as a namespace
// boundary) while /v1/models resolved through the Connect one. Two views deriving one
// rule from two namespaces: this repo's most frequent defect shape.
//
// The fix is one exported predicate (buildConnectReachability) that both call, so these
// tests are written to fail if a future change lands on one side only.
//
// Two properties beyond parity, both load-bearing:
//
//  1. rows are ANNOTATED, not dropped. The panel renders the allow/deny chips from this
//     list alone, so narrowing it would make an existing allow-list entry invisible and
//     therefore unremovable — the operator cannot click a chip that is not rendered.
//  2. the free-reachable selector is SYNTHESIZED. `swe-1-6-slow` is in neither the frozen
//     snapshot nor the live catalog nor MODELS, so no Cascade-derived list contains it —
//     yet it is the only selector every account can serve.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  __resetModelCatalogState,
  __setModelCatalogDeps,
  __waitForModelCatalogSync,
  addAccountByKey,
  configureBindHost,
  getAccountInternal,
  removeAccount,
} from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { handleModels, buildConnectReachability } from '../src/handlers/models.js';
import { setLiveCatalogSelectors, clearLiveCatalogSelectors, resolveConnectSelector, __testing as connectModelsTesting } from '../src/devin-connect-models.js';
import { mergeCloudModels } from '../src/models.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

// Written literally rather than imported from FREE_REACHABLE_SELECTORS: importing the set
// the implementation reads would make the assertion pass whatever that set contains — the
// "guard satisfied by its own source" antipattern this repo has been bitten by.
const CONNECT_FREE_SELECTOR = 'swe-1-6-slow';
// A paid Cascade-namespace model. Free accounts must see it listed-but-unreachable.
const PAID_KEY = 'claude-4-sonnet';

const ORIGINAL_ALLOW_NO_AUTH = process.env.DASHBOARD_ALLOW_NO_AUTH;
const ORIGINAL_DEVIN_CONNECT = process.env.DEVIN_CONNECT;
const ORIGINAL_DEVIN_CONNECT_TOKEN = process.env.DEVIN_CONNECT_TOKEN;
const ORIGINAL_WINDSURF_API_KEY = process.env.WINDSURF_API_KEY;
const ORIGINAL_API_KEY = config.apiKey;
const ORIGINAL_DASHBOARD_PASSWORD = config.dashboardPassword;
const created = [];
let liveCatalogDirty = false;

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}
const localReq = (path) => ({
  url: `/dashboard/api${path}`,
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
});

function seed(tier, apiKey = null) {
  const a = addAccountByKey(
    apiKey || `devin-session-token$xk-parity-${Math.random().toString(36).slice(2)}`,
    `parity-${tier}`,
  );
  created.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.tier = tier;
  acct.status = 'active';
  return acct;
}

async function dashboardModels() {
  const res = fakeRes();
  await handleDashboardApi('GET', '/models', {}, localReq('/models'), res);
  // Guard the measurement itself: a 401 yields zero rows, and "every row agrees" is
  // vacuously true over zero rows. The first draft of this probe reported success off a
  // 401 for exactly that reason.
  assert.equal(res.statusCode, 200, `dashboard /models returned ${res.statusCode}`);
  const rows = res.json()?.models || [];
  assert.ok(rows.length > 0, 'dashboard /models returned no rows — nothing was measured');
  return rows;
}

function v1Ids() {
  const data = handleModels(process.env)?.data || [];
  assert.ok(data.length > 0, '/v1/models returned no rows — nothing to compare against');
  return new Set(data.map((m) => m.id));
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
  // The suite must not inherit the operator's real env/file-backed dashboard
  // credentials. A configured API key or runtime dashboard-password hash makes
  // the deliberately open-local fixture return 401 before /models is measured.
  _resetRuntimeConfigForTests();
  config.apiKey = '';
  config.dashboardPassword = '';
  configureBindHost('127.0.0.1');
  // These are namespace/view tests. Keep them deterministic and offline: account
  // additions must not launch real catalog RPCs with fixture tokens.
  __setModelCatalogDeps({
    disableConnectSync: true,
    getCascadeModelConfigs: async () => ({ configs: [] }),
  });
});

afterEach(async () => {
  // Only ids this file created. NEVER map removeAccount over the account list — a cleanup
  // written that way once deleted a user's real accounts, unrecoverably.
  for (const id of created.splice(0)) { try { removeAccount(id); } catch {} }
  await __waitForModelCatalogSync();
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  if (liveCatalogDirty) {
    clearLiveCatalogSelectors();
    liveCatalogDirty = false;
  }
  _resetRuntimeConfigForTests();
  if (ORIGINAL_DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = ORIGINAL_DEVIN_CONNECT;
  if (ORIGINAL_DEVIN_CONNECT_TOKEN === undefined) delete process.env.DEVIN_CONNECT_TOKEN;
  else process.env.DEVIN_CONNECT_TOKEN = ORIGINAL_DEVIN_CONNECT_TOKEN;
  if (ORIGINAL_WINDSURF_API_KEY === undefined) delete process.env.WINDSURF_API_KEY;
  else process.env.WINDSURF_API_KEY = ORIGINAL_WINDSURF_API_KEY;
  if (ORIGINAL_ALLOW_NO_AUTH === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = ORIGINAL_ALLOW_NO_AUTH;
  config.apiKey = ORIGINAL_API_KEY;
  config.dashboardPassword = ORIGINAL_DASHBOARD_PASSWORD;
  configureBindHost('0.0.0.0');
});

describe('dashboard /models agrees with /v1/models on the Connect namespace (#234)', () => {
  it('every row\'s reachable flag matches whether /v1/models lists it', async () => {
    seed('free');
    const ids = v1Ids();
    const rows = await dashboardModels();

    const disagree = rows.filter((r) => r.reachable !== ids.has(r.id));
    assert.deepEqual(
      disagree.map((r) => `${r.id}:dash=${r.reachable},v1=${ids.has(r.id)}`),
      [],
      'a row disagrees with /v1/models. Before the fix EVERY row disagreed: the dashboard '
      + 'listed 163 unreachable models and omitted the one reachable selector',
    );
    // Pin that the comparison had teeth in BOTH directions — an all-true or all-false
    // answer would satisfy the equality above while measuring nothing.
    assert.ok(rows.some((r) => r.reachable), 'no row was reachable — the filter is stuck closed');
    assert.ok(rows.some((r) => !r.reachable), 'every row was reachable — the filter is stuck open');
  });

  it('lists paid models as unreachable rather than dropping them', async () => {
    seed('free');
    const rows = await dashboardModels();
    const paid = rows.find((r) => r.id === PAID_KEY);
    assert.ok(paid, `${PAID_KEY} must still be LISTED — the allow/deny panel renders only `
      + 'this list, so dropping a row makes an existing allow-list entry unclickable');
    assert.equal(paid.reachable, false, `${PAID_KEY} is not callable by a free account`);
  });

  it('synthesizes the free-reachable selector, which no Cascade-derived list contains', async () => {
    seed('free');
    const rows = await dashboardModels();
    const free = rows.find((r) => r.id === CONNECT_FREE_SELECTOR);
    assert.ok(free, `${CONNECT_FREE_SELECTOR} absent. It is in neither the snapshot, the `
      + 'live catalog, nor MODELS, so it has to be synthesized — and it is the only '
      + 'selector every account can serve');
    assert.equal(free.reachable, true);
  });

  it('reports the resolved selector so "unreachable" and "unmapped" are distinguishable', async () => {
    seed('free');
    const rows = await dashboardModels();
    const free = rows.find((r) => r.id === CONNECT_FREE_SELECTOR);
    assert.equal(free.connectSelector, CONNECT_FREE_SELECTOR);
    // Every row carries the key, present-but-null included: a missing key would make the
    // UI unable to tell "resolves but you lack entitlement" from "maps to nothing here".
    for (const r of rows) {
      assert.ok('connectSelector' in r, `${r.id} is missing connectSelector`);
    }
  });

  it('includes live-only selectors that /v1/models synthesizes', async () => {
    seed('pro');
    const liveOnly = 'grok-4-5-medium-dashboard-parity';
    const aliasBacked = 'claude-opus-4-6';
    setLiveCatalogSelectors([
      { selector: `  ${liveOnly}  `, provider: 'xai', label: 'Grok live only' },
      { selector: aliasBacked, provider: 'anthropic', label: 'Claude Opus 4.8 Medium' },
    ]);
    liveCatalogDirty = true;

    const ids = v1Ids();
    assert.ok(ids.has(liveOnly), 'precondition: /v1/models synthesized the live-only selector');
    const rows = await dashboardModels();
    const row = rows.find((r) => r.id === liveOnly);
    assert.ok(row, 'Dashboard omitted a selector that /v1/models advertises');
    assert.equal(row.reachable, true);
    assert.equal(row.connectSelector, liveOnly);
    assert.ok('freeNow' in row,
      'the live-only Dashboard producer must carry the pricing field too');
    assert.equal(row.freeNow, null,
      'a live-only selector without a rate-table entry has unknown pricing');
    assert.equal(row.freeReason, null);
    assert.equal(row.quotaState, 'unknown');
    assert.equal(rows.filter((r) => r.reachable && r.connectSelector === aliasBacked).length, 1,
      'Dashboard must not append a canonical row when a visible alias already represents it');
  });

  it('keeps a restricted live-only row visible but unreachable to a free pool', async () => {
    seed('free');
    const paidLiveOnly = 'gpt-5-6-sol-max-dashboard-parity';
    setLiveCatalogSelectors([
      { selector: paidLiveOnly, provider: 'openai', label: 'Paid live only' },
    ]);
    liveCatalogDirty = true;

    const rows = await dashboardModels();
    const row = rows.find((candidate) => candidate.id === paidLiveOnly);
    assert.ok(row, 'the Dashboard must retain a live-only row so operators can inspect it');
    assert.equal(row.reachable, false,
      'a free-only pool must annotate the paid live-only row as unreachable');
    assert.equal(row.connectSelector, paidLiveOnly);
    assert.ok('freeNow' in row,
      'an unreachable live-only row must still carry the pricing field');
    assert.equal(row.freeNow, null,
      'reachability does not turn absent pricing data into a billable claim');
    assert.equal(row.quotaState, 'unknown');
  });

  it('keeps snapshot rows reachable for an env token beside a restricted live pool', async () => {
    seed('free');
    setLiveCatalogSelectors([
      { selector: 'claude-opus-4-8-medium', provider: 'anthropic' },
    ]);
    liveCatalogDirty = true;
    process.env.DEVIN_CONNECT_TOKEN = 'dashboard-parity-env-token';

    const rows = await dashboardModels();
    const snapshot = rows.find((row) => row.id === 'gpt-5.5');
    assert.ok(snapshot, 'precondition: the snapshot-backed public row must remain listed');
    assert.equal(snapshot.reachable, true,
      'an env token is outside per-account live restrictions and retains snapshot fallback');
  });

  it('fails open on an empty pool even when a restricted live catalog is present', async () => {
    setLiveCatalogSelectors([
      { selector: 'claude-opus-4-8-medium', provider: 'anthropic' },
    ]);
    liveCatalogDirty = true;

    const rows = await dashboardModels();
    const snapshot = rows.find((row) => row.id === 'gpt-5.5');
    assert.ok(snapshot, 'precondition: the snapshot-backed row must remain listed');
    assert.equal(snapshot.reachable, true,
      'without accounts there is no per-account authority to narrow discovery');
  });

  it('drops snapshot reachability when the final no-LKG contributor is removed', async () => {
    __setModelCatalogDeps({
      getCascadeModelConfigs: async () => ({ configs: [] }),
      scheduleCatalogRetry: () => () => {},
      fetchConnectCatalog: async ({ token }) => (
        token === 'devin-session-token$xk-dashboard-live-fixture'
          ? [{ selector: 'claude-opus-4-8-medium', provider: 'anthropic' }]
          : []
      ),
    });

    seed('pro', 'devin-session-token$xk-dashboard-live-fixture');
    await __waitForModelCatalogSync();
    const incomplete = seed('pro', 'devin-session-token$xk-dashboard-incomplete-fixture');
    await __waitForModelCatalogSync();

    const before = await dashboardModels();
    assert.equal(before.find((row) => row.id === 'gpt-5.5')?.reachable, true,
      'a contributor without LKG rows keeps the controlled snapshot fallback active');

    removeAccount(incomplete.id);
    const after = await dashboardModels();
    assert.equal(after.find((row) => row.id === 'gpt-5.5')?.reachable, false,
      'removing the final incomplete contributor makes the remaining live union authoritative');
  });

  it('widens when a paid account joins — the flag is computed, not baked in', async () => {
    seed('free');
    const before = await dashboardModels();
    const reachableBefore = before.filter((r) => r.reachable).length;

    seed('pro');
    const after = await dashboardModels();
    const reachableAfter = after.filter((r) => r.reachable).length;

    assert.ok(
      reachableAfter > reachableBefore,
      `reachable count did not grow when a pro account joined (${reachableBefore} -> `
      + `${reachableAfter}). A hardcoded answer would pass every assertion above`,
    );
  });

  // #235: the panel must say whether a model COSTS QUOTA, and must not guess when it cannot
  // tell. The reporter had a pro account, set GLM-5-2 believing it was free on that plan, and
  // burned the whole weekly allowance. The rate-table wiring that answers this shipped in
  // v3.9.8 but had one production caller, inside the drought decision — the data existed and
  // no surface showed it.
  //
  // The load-bearing case is UNKNOWN. `isConnectSelectorCurrentlyFree` returns a plain
  // `false` both when a model costs money and when no account has a rate table at all, so
  // reporting its result directly would render "we have no idea" as "billable" — and the
  // mirror of that mistake, rendering unknown as free, is the reporter's exact loss.
  describe('#235: whether a model costs quota', () => {
    it('reports null (unknown), not false, when no account has a rate table', async () => {
      // A seeded account has no credits.rateTable, so the pool-wide answer is "no data".
      seed('free');
      const rows = await dashboardModels();
      const withSelector = rows.filter((r) => r.connectSelector);
      assert.ok(withSelector.length > 0, 'precondition: some row must resolve to a selector');

      // BOTH directions. A first draft asserted only "nothing is wrongly false" and a
      // mutation that flattened unknown to TRUE survived it — the dangerous direction, since
      // "free" on an unpriced model is precisely the reporter's loss. Assert the exact value.
      const nonFree = withSelector.filter((r) => r.connectSelector !== CONNECT_FREE_SELECTOR);
      assert.ok(nonFree.length > 0, 'precondition: need a resolving non-free selector');
      const wrong = nonFree.filter((r) => r.freeNow !== null);
      assert.deepEqual(wrong.map((r) => `${r.id}=${r.freeNow}`), [],
        'with no rate table anywhere, a resolving non-free selector must read null (unknown). '
        + '`false` presents a guess as a fact; `true` is the exact claim that burned the '
        + 'reporter\'s weekly allowance. isConnectSelectorCurrentlyFree returns plain false '
        + 'for both "billable" and "no data", so the route must consult the pool-wide '
        + 'free-set to tell them apart');
    });

    it('reports the static-fallback selector as free only while there is no live data', async () => {
      seed('free');
      const rows = await dashboardModels();
      const free = rows.find((r) => r.id === CONNECT_FREE_SELECTOR);
      assert.equal(free.freeNow, true,
        'with no live cost tier and no rate table, the documented static fallback is the '
        + 'only free source — the cold-start case it exists for');
      assert.equal(free.freeReason, 'fallback_whitelist');
    });

    it('carries the full pricing/quota shape on every row so the UI never infers it', async () => {
      seed('free');
      const rows = await dashboardModels();
      for (const r of rows) {
        for (const key of ['costTier', 'promoEndsAt', 'freeNow', 'freeReason', 'quotaState']) {
          assert.ok(key in r, `${r.id} is missing ${key}`);
        }
        assert.ok(
          r.freeNow === true || r.freeNow === false || r.freeNow === null,
          `${r.id} has a non-tri-state freeNow: ${JSON.stringify(r.freeNow)}`,
        );
        assert.ok(
          r.quotaState === null || ['free', 'blocked_daily', 'blocked_weekly', 'not_in_catalog', 'unknown'].includes(r.quotaState),
          `${r.id} has an unknown quotaState: ${JSON.stringify(r.quotaState)}`,
        );
      }
    });

    it('reports false — not unknown — once a rate table says the selector is billable', async () => {
      // Without this, "always null" would satisfy every assertion above.
      const acct = seed('free');
      const rows0 = await dashboardModels();
      const target = rows0.find((r) => r.connectSelector && r.connectSelector !== CONNECT_FREE_SELECTOR);
      assert.ok(target, 'precondition: need a resolving non-free selector to price');

      acct.credits = { rateTable: { [target.connectSelector]: 4 } };
      const rows1 = await dashboardModels();
      const priced = rows1.find((r) => r.id === target.id);
      assert.equal(priced.freeNow, false,
        `${target.id} resolves to ${target.connectSelector} which the rate table prices at 4, `
        + 'so it must read as billable rather than unknown');

      acct.credits = { rateTable: { [target.connectSelector]: 0 } };
      const rows2 = await dashboardModels();
      const free = rows2.find((r) => r.id === target.id);
      assert.equal(free.freeNow, true,
        'rate === 0 must read as free — otherwise the field is stuck and tells the operator '
        + 'nothing that changes');
      assert.equal(free.freeReason, 'rate_zero');
    });
  });

  // The live Pro account (2026-10-22) is the fixture: its catalog marks exactly three
  // selectors MODEL_COST_TIER_FREE with a promo ending 2026-11-01, its rate table has
  // zero zero-rate entries, its daily bucket is at 0 %, and the selector the static
  // whitelist called free (`swe-1-6-slow`) is absent from the catalog and 502s.
  // Before the fix the panel showed the inverse of all of that.
  describe('rows carry upstream cost tier, promo and account quota state', () => {
    const PROMO_END = '2099-12-31T23:59:59.999999999Z';
    const CONNECT_ROWS = [
      { selector: 'swe-2-medium', provider: 'windsurf', label: 'SWE-2 Medium' },
      { selector: 'swe-2-high', provider: 'windsurf', label: 'SWE-2 High' },
      { selector: 'swe-2-max', provider: 'windsurf', label: 'SWE-2 Max' },
      { selector: 'swe-2-medium-lightning', provider: 'windsurf', label: 'SWE-2 Medium Lightning' },
    ];
    const COST_CONFIGS = [
      { modelUid: 'swe-2-medium', creditMultiplier: 6, modelCostTier: 'MODEL_COST_TIER_FREE', promoStatus: { isActive: true, endDate: PROMO_END } },
      { modelUid: 'swe-2-high', creditMultiplier: 9, modelCostTier: 'MODEL_COST_TIER_FREE', promoStatus: { isActive: true, endDate: PROMO_END } },
      { modelUid: 'swe-2-max', creditMultiplier: 12, modelCostTier: 'MODEL_COST_TIER_FREE', promoStatus: { isActive: true, endDate: PROMO_END } },
      {
        modelUid: 'swe-2-medium-lightning',
        creditMultiplier: 12,
        modelCostTier: 'MODEL_COST_TIER_HIGH',
        promoStatus: { isActive: true, endDate: '2027-01-01T07:59:59.999999999Z', label: '83% off' },
      },
    ];

    async function seedLiveProAccount() {
      __setModelCatalogDeps({
        getCascadeModelConfigs: async () => ({ configs: [] }),
        scheduleCatalogRetry: () => () => {},
        fetchConnectCatalog: async () => CONNECT_ROWS,
      });
      const acct = seed('pro');
      acct.credits = { dailyPercent: 0, weeklyPercent: 47 };
      await __waitForModelCatalogSync();
      // The Cascade cost-tier map is account-scoped in models.js; mergeCloudModels
      // (the legacy entry point) records it for the default catalog key, which the
      // pool-wide lookup unions. Bypasses the shrink-confirmation guard so the
      // fixture stays the five rows the upstream actually sent.
      mergeCloudModels(COST_CONFIGS);
      return acct;
    }

    it('marks the three cost-tier-FREE selectors free, with the promo end', async () => {
      await seedLiveProAccount();
      const rows = await dashboardModels();

      for (const id of ['swe-2-medium', 'swe-2-high', 'swe-2-max']) {
        const row = rows.find((r) => r.id === id);
        assert.ok(row, `${id} missing from the panel`);
        assert.equal(row.reachable, true, `${id} is in the live catalog and the tier is paid`);
        assert.equal(row.costTier, 'MODEL_COST_TIER_FREE', id);
        assert.equal(row.freeNow, true, id);
        assert.equal(row.freeReason, 'cost_tier_free', id);
        assert.equal(row.promoEndsAt, '2099-12-31T23:59:59.999Z', id);
        assert.equal(row.quotaState, 'free', id);
      }
    });

    it('marks a discounted paid selector blocked_daily instead of a bare QUOTA chip', async () => {
      await seedLiveProAccount();
      const rows = await dashboardModels();

      const row = rows.find((r) => r.id === 'swe-2-medium-lightning');
      assert.ok(row);
      assert.equal(row.costTier, 'MODEL_COST_TIER_HIGH');
      assert.equal(row.freeNow, false);
      assert.equal(row.freeReason, null);
      assert.equal(row.promoEndsAt, '2027-01-01T07:59:59.999Z',
        'a discount is not free, but the operator still needs to see when it ends');
      assert.equal(row.quotaState, 'blocked_daily',
        'the account is daily-dry, which is why this selector cannot run right now');
    });

    it('marks the absent phantom not_in_catalog instead of FREE', async () => {
      await seedLiveProAccount();
      const rows = await dashboardModels();

      const phantom = rows.find((r) => r.id === CONNECT_FREE_SELECTOR);
      assert.ok(phantom, 'the row stays visible so an allow-list entry remains removable');
      assert.equal(phantom.reachable, false,
        'the account live catalog omits it, and it 502s with quota exhausted when called');
      assert.equal(phantom.costTier, null);
      assert.equal(phantom.freeNow, false,
        'live pricing data exists and does not name it free — the static floor is not a claim');
      assert.equal(phantom.freeReason, null);
      assert.equal(phantom.quotaState, 'not_in_catalog');
    });
  });

  it('treats every model as reachable when the Connect backend is off', async () => {
    delete process.env.DEVIN_CONNECT;
    _resetRuntimeConfigForTests();
    seed('free');
    const rows = await dashboardModels();
    assert.ok(
      rows.every((r) => r.reachable),
      'on a Cascade deployment the Connect namespace does not apply, so nothing may be '
      + 'reported unreachable — reporting otherwise would grey out the whole panel',
    );
    assert.ok(
      rows.every((r) => r.connectSelector === null),
      'connectSelector must be null off the Connect transport, not a stale resolution',
    );
  });
});

describe('read-only discovery does not consume the one-time degrade warning', () => {
  it('discovery is silent; the next real request warns exactly once', () => {
    const name = 'zzscale-parity-discovery-ghost';
    const warns = [];
    const originalWarn = console.warn;
    connectModelsTesting.degradeWarned.clear();
    console.warn = (...args) => { warns.push(args.join(' ')); };
    try {
      const reach = buildConnectReachability({ ...process.env, DEVIN_CONNECT: '1' });
      reach(name);
      assert.equal(warns.filter((l) => l.includes(name)).length, 0,
        'catalog discovery is not a paid request and must not spend the warning');
      resolveConnectSelector(name);
      assert.equal(warns.filter((l) => l.includes(name)).length, 1,
        'the first real request after discovery must still warn');
    } finally {
      console.warn = originalWarn;
      connectModelsTesting.degradeWarned.clear();
    }
  });
});
