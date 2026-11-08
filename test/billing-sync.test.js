// Billing sync: cost tier + promo + credit rate from GetCascadeModelConfigs.
//
// The cost-tier half was already decoded, but three things were missing and each
// one is pinned below:
//
//   1. The RATE (`creditMultiplier`) on the same rows was thrown away, so
//      "free by a zero rate" could only come from GetUserStatus — which a free
//      account may never receive.
//   2. Nothing refreshed the billing snapshot after the first catalog sync
//      (`_modelCatalogSyncedKeys` latches per API key), so a promotion that
//      STARTED later was invisible forever.
//   3. No freshness stamp existed, so a FREE badge built from a stopped sync was
//      indistinguishable from one refreshed a minute ago.
//
// The clock is always injected: a promo end and a staleness budget are both
// time-dependent, and a test that reads the wall clock is a flake waiting for a
// calendar boundary.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCloudModelCatalogs,
  getCloudBillingSyncState,
  getCloudCostTierInfo,
  getCloudCreditRate,
  getCloudSelectorPricing,
  getCloudZeroRateSelectors,
  mergeCloudCostTiers,
} from '../src/models.js';
import {
  __resetBillingSyncState,
  __resetModelCatalogState,
  __setModelCatalogDeps,
  addAccountByKey,
  getAccountInternal,
  getConnectFreeSelectors,
  getConnectPricingMap,
  getConnectSelectorPricing,
  getCurrentlyFreeConnectSelectors,
  refreshAccountBilling,
  refreshAllBilling,
  removeAccount,
  trySyncModelCatalog,
  __waitForModelCatalogSync,
} from '../src/auth.js';

const PROMO_END = '2099-12-31T23:59:59.999999999Z';
const PROMO_END_MS = Date.parse(PROMO_END);

function config(uid, { tier = null, promo = undefined, credit = 1 } = {}) {
  return {
    modelUid: uid,
    provider: 'MODEL_PROVIDER_WINDSURF',
    creditMultiplier: credit,
    ...(tier ? { modelCostTier: tier } : {}),
    ...(promo === undefined ? {} : { promoStatus: promo }),
  };
}

const created = [];
function seedAccount(credits = null) {
  const a = addAccountByKey(`sk-billing-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'billing-sync');
  created.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = 'pro';
  acct.credits = credits;
  return acct;
}

let fetchCalls = 0;
let fetchResponse = { configs: [] };

/**
 * Adding an account fires trySyncModelCatalog() (fire-and-forget), which uses the
 * same injected GetCascadeModelConfigs. Wait for it and drop whatever it merged,
 * so a measured refresh below counts only its own RPC.
 */
async function settle() {
  await __waitForModelCatalogSync();
  clearCloudModelCatalogs();
  __resetBillingSyncState();
  fetchCalls = 0;
}

beforeEach(() => {
  fetchCalls = 0;
  fetchResponse = { configs: [] };
  __setModelCatalogDeps({
    disableConnectSync: true,
    getCascadeModelConfigs: async () => {
      fetchCalls++;
      return fetchResponse;
    },
  });
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    try { removeAccount(id); } catch {}
  }
  __resetModelCatalogState();
  __resetBillingSyncState();
  __setModelCatalogDeps(null);
  clearCloudModelCatalogs();
});

describe('credit rate sync (creditMultiplier on the catalog row)', () => {
  it('has no rate data before any snapshot, and null is not "free"', () => {
    assert.equal(getCloudZeroRateSelectors(), null);
    assert.equal(getCloudCreditRate('swe-2-medium'), null);
    const pricing = getCloudSelectorPricing('swe-2-medium');
    assert.equal(pricing.freeNow, null, 'no live evidence must stay unknown');
    assert.equal(pricing.rate, null);
  });

  it('records the numeric rate per selector and treats a strict zero as free', () => {
    mergeCloudCostTiers([
      config('swe-2-medium', { credit: 0 }),
      config('swe-2-high', { credit: 9 }),
      config('swe-2-max', { credit: 0.5 }),
    ]);

    assert.deepEqual([...getCloudZeroRateSelectors()], ['swe-2-medium'],
      'a 0.5-credit row still bills and must not join the free set');
    assert.deepEqual(getCloudCreditRate('swe-2-high'), {
      credit: 9,
      fetchedAt: getCloudBillingSyncState().fetchedAt,
    });

    const free = getCloudSelectorPricing('swe-2-medium');
    assert.equal(free.freeNow, true);
    assert.equal(free.freeReason, 'rate_zero');
    assert.equal(free.rate, 0);

    const paid = getCloudSelectorPricing('swe-2-high');
    assert.equal(paid.freeNow, false, 'a known non-zero rate is a live "bills" answer');
    assert.equal(paid.rate, 9);
  });

  it('keeps the cost tier ahead of the rate as the free reason', () => {
    mergeCloudCostTiers([
      config('swe-2-medium', {
        tier: 'MODEL_COST_TIER_FREE',
        promo: { isActive: true, endDate: PROMO_END },
        credit: 6,
      }),
    ]);
    const pricing = getCloudSelectorPricing('swe-2-medium');
    assert.equal(pricing.freeNow, true);
    assert.equal(pricing.freeReason, 'cost_tier_free',
      'the tier is the upstream\'s own no-charge statement; the 6-credit rate is the list price');
    assert.equal(pricing.rate, 6);
    assert.equal(pricing.promoEndsAt, '2099-12-31T23:59:59.999Z');
  });

  it('does not let a response that omits the fields blank a known rate', () => {
    mergeCloudCostTiers([config('swe-2-medium', { credit: 0 })]);
    const before = getCloudBillingSyncState();
    // A partial body: rows exist, but no creditMultiplier and no cost tier.
    const merged = mergeCloudCostTiers([{ modelUid: 'swe-2-medium' }], { now: before.fetchedAt + 5_000 });
    assert.equal(merged.applied, false);
    assert.deepEqual([...getCloudZeroRateSelectors()], ['swe-2-medium']);
    assert.equal(getCloudBillingSyncState(before.fetchedAt + 5_000).fetchedAt, before.fetchedAt,
      'freshness must describe the rows actually held, not the last attempt');
  });

  it('replaces the map wholesale when the upstream stops marking a model free', () => {
    mergeCloudCostTiers([config('swe-2-medium', { tier: 'MODEL_COST_TIER_FREE', credit: 0 })]);
    assert.equal(getCloudSelectorPricing('swe-2-medium').freeNow, true);

    mergeCloudCostTiers([config('swe-2-medium', { tier: 'MODEL_COST_TIER_HIGH', credit: 6 })]);
    const after = getCloudSelectorPricing('swe-2-medium');
    assert.equal(after.freeNow, false, 'a stale promotion must not survive a fresh snapshot');
    assert.equal(after.costTier, 'MODEL_COST_TIER_HIGH');
  });
});

describe('freshness', () => {
  it('stamps the snapshot and reports staleness only after the budget', () => {
    const t0 = 1_800_000_000_000;
    mergeCloudCostTiers([config('swe-2-medium', { credit: 0 })], { now: t0 });
    const state = getCloudBillingSyncState(t0);
    assert.equal(state.fetchedAt, t0);
    assert.equal(state.stale, false);
    assert.equal(state.costTierRows, 0);
    assert.equal(state.rateRows, 1);

    const later = getCloudBillingSyncState(t0 + state.staleAfterMs + 1);
    assert.equal(later.stale, true, 'a stopped sync must become visible, not silently trusted');
  });

  it('surfaces the stamp on the pricing row the dashboard renders', () => {
    const t0 = 1_800_000_000_000;
    mergeCloudCostTiers([config('swe-2-medium', { credit: 0 })], { now: t0 });
    const pricing = getConnectSelectorPricing('swe-2-medium');
    assert.equal(pricing.pricingFetchedAt, t0);
    assert.equal(pricing.pricingStale, false);
    assert.equal(pricing.freeReason, 'rate_zero');
  });
});

describe('periodic refresh (refreshAccountBilling)', () => {
  it('pulls GetCascadeModelConfigs and applies the billing half', async () => {
    const account = seedAccount();
    await settle();
    fetchResponse = { configs: [config('swe-2-medium', { tier: 'MODEL_COST_TIER_FREE', credit: 6 })] };

    const result = await refreshAccountBilling(account.id, { now: 1_800_000_000_000 });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.costTierRows, 1);
    assert.equal(result.rateRows, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(getCloudCostTierInfo('swe-2-medium').costTier, 'MODEL_COST_TIER_FREE');
  });

  it('honours the cadence and only re-fetches on force or after the interval', async () => {
    const account = seedAccount();
    await settle();
    const t0 = 1_800_000_000_000;
    fetchResponse = { configs: [config('swe-2-medium', { credit: 6 })] };

    await refreshAccountBilling(account.id, { now: t0 });
    assert.equal(fetchCalls, 1);

    const skipped = await refreshAccountBilling(account.id, { now: t0 + 60_000 });
    assert.equal(skipped.skipped, true);
    assert.equal(fetchCalls, 1, 'a second call inside the interval must not spend an RPC');

    await refreshAccountBilling(account.id, { now: t0 + 60_000, force: true });
    assert.equal(fetchCalls, 2);
  });

  it('skips inactive accounts and reports the whole pool', async () => {
    const active = seedAccount();
    const idle = addAccountByKey(`sk-billing-idle-${Date.now()}`, 'billing-idle');
    created.push(idle.id);
    getAccountInternal(idle.id).status = 'disabled';
    await settle();

    const results = await refreshAllBilling({ now: 1_800_000_000_000 });
    const forActive = results.find((r) => r.id === active.id);
    assert.ok(forActive, 'the active account is refreshed');
    assert.equal(results.some((r) => r.id === idle.id), false, 'a disabled account is not polled');
    assert.equal(fetchCalls, 1);
  });

  it('leaves the cadence stamp alone when the upstream call fails', async () => {
    const account = seedAccount();
    await settle();
    __setModelCatalogDeps({
      disableConnectSync: true,
      getCascadeModelConfigs: async () => { throw new Error('upstream 502'); },
    });

    const t0 = 1_800_000_000_000;
    const failed = await refreshAccountBilling(account.id, { now: t0 });
    assert.equal(failed.ok, false);

    // The next round retries immediately instead of waiting a full interval for a
    // one-second outage.
    fetchResponse = { configs: [config('swe-2-medium', { credit: 0 })] };
    __setModelCatalogDeps({
      disableConnectSync: true,
      getCascadeModelConfigs: async () => { fetchCalls++; return fetchResponse; },
    });
    const retried = await refreshAccountBilling(account.id, { now: t0 + 1_000 });
    assert.equal(retried.ok, true);
    assert.equal(fetchCalls, 1);
  });
});

describe('the catalog latch does not gate billing', () => {
  // _modelCatalogSyncedKeys exists so a repeated trySyncModelCatalog does not
  // re-spend the RPC. The billing refresh must NOT ride that latch (that is the
  // bug this feature fixes), and must not SET it either — otherwise a billing
  // refresh would convince the catalog sync it had already run.
  it('a second catalog sync stays latched while the billing refresh still fetches', async () => {
    const account = seedAccount();
    await settle();
    fetchResponse = { configs: [config('swe-2-medium', { credit: 6 })] };

    trySyncModelCatalog();
    await __waitForModelCatalogSync();
    assert.equal(fetchCalls, 0, 'the per-key latch still short-circuits a repeat catalog sync');

    const refreshed = await refreshAccountBilling(account.id, { force: true, now: 1_800_000_000_000 });
    assert.equal(refreshed.ok, true);
    assert.equal(fetchCalls, 1, 'the billing path is independent of the catalog latch');

    // And the billing refresh did not latch the catalog: a fresh key-less account
    // sync still runs (proved by the count going up once the key changes).
    getAccountInternal(account.id).apiKey = `${account.apiKey}-rotated`;
    trySyncModelCatalog();
    await __waitForModelCatalogSync();
    assert.equal(fetchCalls, 2, 'a rotated key is a new catalog identity, not a latched one');
  });
});

describe('pool-wide free list includes the synced rate', () => {
  it('marks a zero-rate selector free without any GetUserStatus rate table', () => {
    const account = seedAccount(null);
    mergeCloudCostTiers([config('swe-2-medium', { credit: 0 })], { accountId: account.id });

    const rateFree = getCurrentlyFreeConnectSelectors();
    assert.deepEqual([...rateFree], ['swe-2-medium']);
    assert.equal(getConnectSelectorPricing('swe-2-medium').freeNow, true);
    assert.equal(getConnectSelectorPricing('swe-2-medium').freeReason, 'rate_zero');
    assert.deepEqual(getConnectFreeSelectors(), ['swe-2-medium']);
  });

  it('bulk pricing agrees with the per-selector answer', () => {
    mergeCloudCostTiers([
      config('swe-2-medium', { tier: 'MODEL_COST_TIER_FREE', credit: 6 }),
      config('swe-2-high', { credit: 9 }),
    ]);
    const selectors = ['swe-2-medium', 'swe-2-high', 'swe-2-unknown'];
    const bulk = getConnectPricingMap(selectors);
    for (const selector of selectors) {
      assert.deepEqual(bulk[selector], getConnectSelectorPricing(selector),
        `${selector}: one snapshot of the inputs must produce one answer`);
    }
    assert.equal(bulk['swe-2-unknown'].freeNow, false,
      'live pricing data exists and is silent about this selector → bills');
  });

  it('a promo end in the past flips the free answer without another sync', () => {
    mergeCloudCostTiers([
      config('swe-2-medium', {
        tier: 'MODEL_COST_TIER_FREE',
        promo: { isActive: true, endDate: PROMO_END },
        credit: 6,
      }),
    ]);
    assert.equal(getCloudSelectorPricing('swe-2-medium', PROMO_END_MS - 1).freeNow, true);
    const expired = getCloudSelectorPricing('swe-2-medium', PROMO_END_MS + 1);
    assert.equal(expired.freeNow, false, 'an ended promo is over even before the next sync lands');
    assert.equal(expired.promoEndsAt, '2099-12-31T23:59:59.999Z',
      'the end date stays visible so the operator can see WHY it stopped');
  });
});
