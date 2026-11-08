// The Connect free list must come from the UPSTREAM, not from a hand-maintained set.
//
// Measured on a live Pro deployment (2026-10-22, daily quota 0 %, weekly 47 %):
//
//   FREE_REACHABLE_SELECTORS = {swe-1-6-slow}   → absent from the 240-selector live
//                                                 catalog, absent from the account's
//                                                 374 availableModels, 502
//                                                 "Your daily usage quota has been
//                                                 exhausted"
//   GetCascadeModelConfigs FREE rows            → swe-2-medium / -high / -max, promo
//                                                 active to 2026-11-01 (06:59:59Z);
//                                                 six live calls left daily quota at 0
//   account rate table                          → 240 entries, ZERO with rate 0
//
// So neither the static whitelist nor the rate table could see the promotion; only
// `modelCostTier` + `promoStatus` on the account's ClientModelConfig rows can. These
// tests pin that decode, the pool-wide free set built from it, and the documented
// static fallback for the no-live-data cold start.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCloudModels,
  getCloudCostTierInfo,
  getCloudCostTierFreeSelectors,
  hasCloudCostTierData,
  isCostTierFreeNow,
  clearCloudModelCatalogs,
} from '../src/models.js';
import {
  __resetModelCatalogState,
  __setModelCatalogDeps,
  addAccountByKey,
  getAccountInternal,
  getConnectFreeSelectors,
  getConnectSelectorPricing,
  getDroughtSummary,
  isConnectSelectorCurrentlyFree,
  removeAccount,
} from '../src/auth.js';

// A promo end in the wire shape the upstream sent (9 fractional digits), pinned far
// enough in the future that "still active" cases do not depend on the wall clock; the
// same instant as milliseconds keeps the "expired" cases deterministic too.
const PROMO_END = '2099-12-31T23:59:59.999999999Z';
const PROMO_END_MS = Date.parse(PROMO_END);
const AFTER_PROMO = PROMO_END_MS + 1;

/** One ClientModelConfig row, camelCase as Connect's JSON codec emits it. */
function config(uid, { tier = null, promo = undefined, credit = 1 } = {}) {
  return {
    modelUid: uid,
    provider: 'MODEL_PROVIDER_WINDSURF',
    creditMultiplier: credit,
    ...(tier ? { modelCostTier: tier } : {}),
    ...(promo === undefined ? {} : { promoStatus: promo }),
  };
}

const LIVE_CATALOG = [
  config('swe-2-medium', { tier: 'MODEL_COST_TIER_FREE', promo: { isActive: true, endDate: PROMO_END }, credit: 6 }),
  config('swe-2-high', { tier: 'MODEL_COST_TIER_FREE', promo: { isActive: true, endDate: PROMO_END }, credit: 9 }),
  config('swe-2-max', { tier: 'MODEL_COST_TIER_FREE', promo: { isActive: true, endDate: PROMO_END }, credit: 12 }),
  config('swe-2-medium-lightning', {
    tier: 'MODEL_COST_TIER_HIGH',
    promo: { isActive: true, endDate: '2027-01-01T07:59:59.999999999Z', label: '83% off' },
    credit: 12,
  }),
  config('swe-1-7', { tier: 'MODEL_COST_TIER_LOW', credit: 3 }),
];

const created = [];
function seedAccount(credits = null) {
  const a = addAccountByKey(`sk-cost-tier-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cost-tier');
  created.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = 'pro';
  acct.credits = credits;
  return acct;
}

beforeEach(() => {
  // Offline + deterministic: an account add must not launch real catalog RPCs.
  __setModelCatalogDeps({
    disableConnectSync: true,
    getCascadeModelConfigs: async () => ({ configs: [] }),
  });
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    try { removeAccount(id); } catch {}
  }
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  clearCloudModelCatalogs();
});

describe('cost tier + promotion decode (GetCascadeModelConfigs)', () => {
  it('has no data before any account reports a catalog', () => {
    assert.equal(hasCloudCostTierData(), false);
    assert.equal(getCloudCostTierFreeSelectors(), null,
      'null is "no data" and must stay distinguishable from an empty free set');
    assert.equal(getCloudCostTierInfo('swe-2-medium'), null);
  });

  it('derives the live free list from MODEL_COST_TIER_FREE, not from the rate table', () => {
    mergeCloudModels(LIVE_CATALOG);

    assert.deepEqual([...getCloudCostTierFreeSelectors()].sort(),
      ['swe-2-high', 'swe-2-max', 'swe-2-medium']);

    const medium = getCloudCostTierInfo('swe-2-medium');
    assert.equal(medium.costTier, 'MODEL_COST_TIER_FREE');
    assert.equal(medium.promoEndsAt, '2099-12-31T23:59:59.999Z',
      'the promo end is normalized to an ISO instant the dashboard can render');
    assert.equal(medium.promoLabel, null);
  });

  it('keeps a discounted-but-paid row out of the free set and exposes its promo label', () => {
    mergeCloudModels(LIVE_CATALOG);

    const lightning = getCloudCostTierInfo('swe-2-medium-lightning');
    assert.equal(lightning.costTier, 'MODEL_COST_TIER_HIGH');
    assert.equal(lightning.promoLabel, '83% off');
    assert.equal(isCostTierFreeNow(lightning), false,
      'a discount is not free — the cost tier is the discriminator');
    assert.ok(!getCloudCostTierFreeSelectors().has('swe-2-medium-lightning'));
  });

  it('treats an expired or inactive promotion as billable', () => {
    mergeCloudModels([
      config('expired-promo', { tier: 'MODEL_COST_TIER_FREE', promo: { isActive: true, endDate: PROMO_END } }),
      config('inactive-promo', { tier: 'MODEL_COST_TIER_FREE', promo: { isActive: false, endDate: '2027-01-01T00:00:00Z' } }),
      config('no-promo', { tier: 'MODEL_COST_TIER_FREE' }),
    ]);

    const free = getCloudCostTierFreeSelectors(AFTER_PROMO);
    assert.deepEqual([...free], ['no-promo'],
      'an ended promo must not keep a model free; a FREE tier with no promo metadata does');
    assert.equal(isCostTierFreeNow(getCloudCostTierInfo('inactive-promo'), AFTER_PROMO), false);
  });

  it('does not overwrite known cost tiers with a response that omits the fields', () => {
    mergeCloudModels(LIVE_CATALOG);
    // A later accepted snapshot with rows but no costTier/promoStatus (older server
    // or a partial body) must not relabel the promotion as unknown.
    mergeCloudModels([{ modelUid: 'swe-2-medium', creditMultiplier: 6 }]);

    assert.deepEqual([...getCloudCostTierFreeSelectors()].sort(),
      ['swe-2-high', 'swe-2-max', 'swe-2-medium']);
  });
});

describe('pricing resolution (auth.js)', () => {
  it('uses the static whitelist ONLY while no live pricing data exists', () => {
    seedAccount({ weeklyPercent: 47, dailyPercent: 0 });

    const cold = getConnectSelectorPricing('swe-1-6-slow');
    assert.equal(cold.freeNow, true);
    assert.equal(cold.freeReason, 'fallback_whitelist');
    assert.equal(cold.costTier, null);
    assert.deepEqual(getConnectFreeSelectors(), ['swe-1-6-slow'],
      'cold start: the documented static fallback is the whole free list');
  });

  it('stops claiming the phantom is free once a live catalog is in hand', () => {
    seedAccount({ weeklyPercent: 47, dailyPercent: 0 });
    mergeCloudModels(LIVE_CATALOG);

    const phantom = getConnectSelectorPricing('swe-1-6-slow');
    assert.equal(phantom.freeNow, false,
      'the live catalog omits swe-1-6-slow and it 502s with quota exhausted — '
      + 'a stale static whitelist must not outrank live data');
    assert.equal(phantom.freeReason, null);
    assert.equal(isConnectSelectorCurrentlyFree('swe-1-6-slow'), false);
    // One live source is enough: cost-tier data exists (rate table is absent), so the
    // static whitelist must NOT be unioned back in. This is the one-null case a
    // `costFree === null || rateFree === null` fallback would silently reintroduce.
    assert.ok(!getConnectFreeSelectors().includes('swe-1-6-slow'),
      'the whitelist must not return when only one live source is present');
  });

  it('reports the three swe-2 selectors as free with the promo end', () => {
    seedAccount({ weeklyPercent: 47, dailyPercent: 0 });
    mergeCloudModels(LIVE_CATALOG);

    const medium = getConnectSelectorPricing('swe-2-medium');
    assert.equal(medium.freeNow, true);
    assert.equal(medium.freeReason, 'cost_tier_free');
    assert.equal(medium.costTier, 'MODEL_COST_TIER_FREE');
    assert.equal(medium.promoEndsAt, '2099-12-31T23:59:59.999Z');

    assert.equal(getConnectSelectorPricing('swe-2-medium-lightning').freeNow, false);
    assert.deepEqual(getConnectFreeSelectors().sort(), ['swe-2-high', 'swe-2-max', 'swe-2-medium']);
  });

  it('still honours a rate-table zero for a selector the catalog prices as paid', () => {
    seedAccount({ weeklyPercent: 47, dailyPercent: 0, rateTable: { 'glm-5-2': 0 } });
    mergeCloudModels(LIVE_CATALOG);

    const promo = getConnectSelectorPricing('glm-5-2');
    assert.equal(promo.freeNow, true);
    assert.equal(promo.freeReason, 'rate_zero',
      'a rolling rate-table promotion is a second, independent free source (#235)');
    assert.equal(getConnectSelectorPricing('swe-1-7').freeNow, false);
  });

  it('feeds the same set to the drought banner', () => {
    seedAccount({ weeklyPercent: 47, dailyPercent: 0 });
    mergeCloudModels(LIVE_CATALOG);

    const summary = getDroughtSummary({ env: { DEVIN_CONNECT: '1' } });
    assert.deepEqual(summary.freeTierModels.sort(), ['swe-2-high', 'swe-2-max', 'swe-2-medium'],
      'the banner used to report swe-1-6-slow while the three actually-free selectors '
      + 'were invisible — and the drought gate then blocked them');
  });
});
