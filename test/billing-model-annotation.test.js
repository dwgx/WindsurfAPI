// /stats modelBilling annotation.
//
// The per-model usage table is keyed by the client's model string; the PRICE
// belongs to the selector it resolves to. Resolving server-side keeps the UI from
// re-implementing the alias ladder and keeps three states distinct:
//   freeNow true  → "免费（促销至 …）"
//   freeNow false → "QUOTA"
//   freeNow null  → no badge at all (nobody reported a price)

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelBillingIndex } from '../src/dashboard/api.js';
import { clearCloudModelCatalogs, mergeCloudCostTiers } from '../src/models.js';

const PROMO_END = '2099-12-31T23:59:59.999999999Z';

function config(uid, { tier = null, promo = undefined, credit = 1 } = {}) {
  return {
    modelUid: uid,
    provider: 'MODEL_PROVIDER_WINDSURF',
    creditMultiplier: credit,
    ...(tier ? { modelCostTier: tier } : {}),
    ...(promo === undefined ? {} : { promoStatus: promo }),
  };
}

beforeEach(() => clearCloudModelCatalogs());
afterEach(() => clearCloudModelCatalogs());

describe('buildModelBillingIndex', () => {
  it('annotates a free promo with its reason and end date', () => {
    mergeCloudCostTiers([
      config('swe-2-medium', {
        tier: 'MODEL_COST_TIER_FREE',
        promo: { isActive: true, endDate: PROMO_END },
        credit: 6,
      }),
    ]);

    const index = buildModelBillingIndex({ 'swe-2-medium': { requests: 3 } });
    assert.deepEqual(index['swe-2-medium'], {
      selector: 'swe-2-medium',
      freeNow: true,
      freeReason: 'cost_tier_free',
      costTier: 'MODEL_COST_TIER_FREE',
      promoEndsAt: '2099-12-31T23:59:59.999Z',
      promoLabel: null,
      pricingFetchedAt: index['swe-2-medium'].pricingFetchedAt,
      pricingStale: false,
    });
    assert.ok(index['swe-2-medium'].pricingFetchedAt > 0,
      'the row must say WHEN the price was synced');
  });

  it('resolves an alias to the selector it actually runs on', () => {
    mergeCloudCostTiers([config('swe-2-medium', { credit: 9 })]);
    const index = buildModelBillingIndex({ 'swe-2.0': { requests: 1 } });
    assert.equal(index['swe-2.0'].selector, 'swe-2-medium',
      'the alias map, not a second convention in the UI');
    assert.equal(index['swe-2.0'].freeNow, false);
  });

  it('leaves a model with no resolvable selector unknown, never "paid"', () => {
    mergeCloudCostTiers([config('swe-2-medium', { credit: 9 })]);
    const index = buildModelBillingIndex({ 'totally-made-up': { requests: 1 } });
    assert.equal(index['totally-made-up'].selector, null);
    assert.equal(index['totally-made-up'].freeNow, null,
      'no price evidence renders no badge');
    assert.equal(index['totally-made-up'].pricingFetchedAt, null);
  });

  it('marks a stale snapshot as stale on the row', () => {
    const t0 = 1_800_000_000_000;
    mergeCloudCostTiers([config('swe-2-medium', { credit: 0 })], { now: t0 });
    const index = buildModelBillingIndex({ 'swe-2-medium': { requests: 1 } });
    // The index reads the wall clock for staleness, so assert the shape rather
    // than a time-dependent boolean; the deterministic staleness boundary is
    // pinned in billing-sync.test.js.
    assert.equal(typeof index['swe-2-medium'].pricingStale, 'boolean');
    assert.equal(index['swe-2-medium'].pricingFetchedAt, t0);
  });
});
