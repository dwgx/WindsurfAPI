// #258 residual — the unmapped-model degrade target must be CALLABLE.
//
// Live evidence 2026-10-22 (Pro account): `swe-1-6-slow` is absent from the
// 240-selector Connect catalog AND from the account's 374 availableModels, and
// the upstream answers it with "Your daily usage quota has been exhausted".
// It was still the hardcoded degrade target, so every unmapped name — a typo, a
// stale alias, a client that spells a model slightly wrong — came back as a
// QUOTA error that pointed at the account instead of at the model name.
//
// The fix has two halves and both are pinned here:
//   1. the degrade target is derived from live pricing (cost tier → rate table)
//      and restricted to selectors the live catalog actually exposes;
//   2. when nothing qualifies, the request is answered `model_not_found` rather
//      than routed to a name the catalog proved absent.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetModelCatalogState,
  __setModelCatalogDeps,
  __waitForModelCatalogSync,
  addAccountByKey,
  getAccountInternal,
  getConnectFreeFallbackSelectors,
  removeAccount,
  trySyncModelCatalog,
} from '../src/auth.js';
import { clearCloudModelCatalogs, mergeCloudModels } from '../src/models.js';
import { clearLiveCatalogSelectors, resolveConnectSelector } from '../src/devin-connect-models.js';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { log } from '../src/config.js';

const PROMO_END = '2099-12-31T23:59:59.999999999Z';

function costRow(uid, { tier = 'MODEL_COST_TIER_FREE', promo = { isActive: true, endDate: PROMO_END } } = {}) {
  return {
    modelUid: uid,
    provider: 'MODEL_PROVIDER_WINDSURF',
    creditMultiplier: 1,
    modelCostTier: tier,
    ...(promo === undefined ? {} : { promoStatus: promo }),
  };
}

const created = [];
let rowsByToken = {};

function seedAccount(apiKey, credits = null) {
  const a = addAccountByKey(apiKey, 'free-fallback');
  created.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = 'pro';
  if (credits) acct.credits = credits;
  return acct;
}

/** Sync the pool's live Connect catalog from the scripted rows. */
async function syncCatalog() {
  trySyncModelCatalog();
  await __waitForModelCatalogSync();
}

beforeEach(() => {
  rowsByToken = {};
  process.env.DEVIN_CONNECT = '1';
  __setModelCatalogDeps({
    getCascadeModelConfigs: async () => ({ configs: [] }),
    scheduleCatalogRetry: () => () => {},
    fetchConnectCatalog: async ({ token }) => rowsByToken[token] || [],
    connectCatalogRetryJitterBasisPoints: () => 10_000,
  });
});

afterEach(() => {
  for (const id of created.splice(0)) {
    try { removeAccount(id); } catch { /* already gone */ }
  }
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  clearCloudModelCatalogs();
  clearLiveCatalogSelectors();
  delete process.env.DEVIN_CONNECT;
  delete process.env.WINDSURFAPI_STRICT_MODEL;
});

describe('#258 residual — getConnectFreeFallbackSelectors', () => {
  it('is empty on a cold start, where the resolver keeps its own documented floor', () => {
    seedAccount('sk-cold');
    assert.deepEqual(getConnectFreeFallbackSelectors(), [],
      'no live pricing data means no live-derived target to offer');
  });

  it('returns a cost-tier-free selector the live catalog exposes', async () => {
    rowsByToken['sk-live'] = [{ selector: 'swe-2-medium' }, { selector: 'swe-1-7' }];
    seedAccount('sk-live');
    await syncCatalog();
    mergeCloudModels([costRow('swe-2-medium')]);

    assert.deepEqual(getConnectFreeFallbackSelectors(), ['swe-2-medium']);
  });

  it('drops a free selector the live catalog does not expose', async () => {
    // The catalog lists swe-1-7 only; the promo prices swe-2-medium free. Routing
    // to swe-2-medium here is the same dead-target defect one name over.
    rowsByToken['sk-partial'] = [{ selector: 'swe-1-7' }];
    seedAccount('sk-partial');
    await syncCatalog();
    mergeCloudModels([costRow('swe-2-medium')]);

    assert.deepEqual(getConnectFreeFallbackSelectors(), []);
  });

  it('prefers an unpaid-entitlement selector when both are live and free', async () => {
    rowsByToken['sk-order'] = [{ selector: 'swe-2-medium' }, { selector: 'swe-1-6-slow' }];
    seedAccount('sk-order', { weeklyPercent: 40, rateTable: { 'swe-1-6-slow': 0 } });
    await syncCatalog();
    mergeCloudModels([costRow('swe-2-medium')]);

    assert.deepEqual(getConnectFreeFallbackSelectors(), ['swe-1-6-slow', 'swe-2-medium'],
      'a selector any account may run comes first; the rest are alphabetical for determinism');
  });
});

describe('#258 residual — the chat path', () => {
  it('answers model_not_found instead of routing to a dead selector', async () => {
    rowsByToken['sk-dead'] = [{ selector: 'swe-1-7' }];
    seedAccount('sk-dead');
    await syncCatalog();
    process.env.WINDSURFAPI_STRICT_MODEL = '0';

    const result = await handleChatCompletions({
      model: 'totally-made-up-model-xyz',
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'model_not_found');
    assert.equal(result.body.error.param, 'model');
    assert.match(result.body.error.message, /no free-tier fallback is currently callable/i,
      'the caller must be told there is nothing to degrade to, not handed a quota error later');
  });

  it('degrades to the live free selector, not the frozen one', async () => {
    rowsByToken['sk-degrade'] = [{ selector: 'swe-1-7' }, { selector: 'swe-1-6-slow' }];
    // A rate-table zero is the second live free source (#235). It keeps the case
    // offline: no cost-tier body needed.
    seedAccount('sk-degrade', { weeklyPercent: 40, rateTable: { 'swe-1-7': 0 } });
    await syncCatalog();
    process.env.WINDSURFAPI_STRICT_MODEL = '0';

    const warnings = [];
    const realWarn = log.warn;
    log.warn = (...args) => warnings.push(args.join(' '));
    let result;
    try {
      result = await handleChatCompletions({
        model: 'totally-made-up-model-xyz',
        messages: [{ role: 'user', content: 'hi' }],
      });
    } finally {
      log.warn = realWarn;
    }

    assert.notEqual(
      result.status === 400 && result.body?.error?.code === 'model_not_found',
      true,
      'a callable free selector exists, so the opt-out must degrade rather than reject',
    );
    assert.ok(
      warnings.some((line) => line.includes('degrading to swe-1-7')),
      `the downgrade must name the selector actually used; got ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      !warnings.some((line) => line.includes('degrading to swe-1-6-slow')),
      'the frozen selector is dead on this deployment and must not be chosen',
    );
  });
});

describe('#258 residual — resolver contract', () => {
  it('never returns the frozen selector when the live catalog is authoritative', async () => {
    rowsByToken['sk-contract'] = [{ selector: 'swe-1-7' }];
    seedAccount('sk-contract');
    await syncCatalog();

    assert.deepEqual(
      resolveConnectSelector('totally-made-up-model-xyz', {
        warnOnFallback: false,
        freeFallback: getConnectFreeFallbackSelectors(),
      }),
      { selector: null, mapped: false },
    );
  });
});
