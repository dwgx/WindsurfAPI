// Request cost must follow the LIVE billing sync, not the static rate card.
//
// swe-2-medium's card says 6 credits while the upstream marked it
// MODEL_COST_TIER_FREE with a promo ending 2026-11-01. Metering the card reported
// spend the account never incurred, and made the row's FREE badge contradict the
// number next to it. Precedence under test: live free → 0; live credit rate →
// that rate; nothing live → the static card (unchanged behaviour).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStats, recordRequest, resetStats } from '../src/dashboard/stats.js';
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

beforeEach(() => resetStats());
afterEach(() => {
  resetStats();
  clearCloudModelCatalogs();
});

describe('request cost (recordRequest)', () => {
  it('charges nothing for a model the upstream marks free with an active promo', () => {
    mergeCloudCostTiers([
      config('swe-2-medium', {
        tier: 'MODEL_COST_TIER_FREE',
        promo: { isActive: true, endDate: PROMO_END },
        credit: 6,
      }),
    ]);

    recordRequest('swe-2-medium', true, 120, null);

    const stats = getStats();
    assert.equal(stats.creditsTotal, 0,
      'a free promo must not accrue spend — the static card still says 6 credits');
    assert.equal(stats.creditsByModel['swe-2-medium'], undefined);
    assert.equal(stats.modelCounts['swe-2-medium'].requests, 1, 'the request itself is still counted');
  });

  it('charges the live credit rate when the catalog prices the model', () => {
    mergeCloudCostTiers([config('swe-2-medium', { credit: 9 })]);
    recordRequest('swe-2-medium', true, 120, null);
    assert.equal(getStats().creditsByModel['swe-2-medium'], 9,
      'the synced multiplier outranks the card');
  });

  it('charges the synced zero rate as free too', () => {
    mergeCloudCostTiers([config('swe-2-medium', { credit: 0 })]);
    recordRequest('swe-2-medium', true, 120, null);
    assert.equal(getStats().creditsTotal, 0);
  });

  it('falls back to the static card when no live data names the model', () => {
    recordRequest('swe-2-medium', true, 120, null);
    assert.equal(getStats().creditsByModel['swe-2-medium'], 6,
      'cold start keeps the documented rate-card behaviour');
  });

  it('does not bill a failed request even when the model is priced', () => {
    mergeCloudCostTiers([config('swe-2-medium', { credit: 9 })]);
    recordRequest('swe-2-medium', false, 120, null);
    assert.equal(getStats().creditsTotal, 0);
  });
});
