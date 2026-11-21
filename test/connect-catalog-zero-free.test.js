// B1 residual — a per-account CATALOG zero rate is free evidence.
//
// GetCascadeModelConfigs carries `creditMultiplier` on the same rows as
// `modelCostTier`/`promoStatus`, and the catalog/billing sync already stores it in
// models.js `_cloudRatesByAccount` (keyed by account). The pool-wide gate reads
// that map (`getCloudCreditRate`), so `getConnectSelectorPricing` correctly says
// `freeNow: true, freeReason: 'rate_zero'` for a catalog-only zero. But the
// per-account free-only admission (`isConnectSelectorFreeForAccount`) only asked
// the account's `credits.rateTable` and its cost-tier row, so the SAME evidence
// that admitted the request at the gate was lost at account selection: a valid
// free account was rejected and the request answered 429.
//
// The repair adds an account-scoped reader for that map and consults it after the
// existing rateTable-zero and cost-tier-free arms. These tests are behavioral on
// purpose: status codes and the exact session tokens the adapter was handed. A
// predicate assertion alone cannot show that B never executed.
//
// Offline only: fake adapter, synthetic accounts, no real upstream.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  __setModelCatalogDeps, __resetModelCatalogState, __waitForModelCatalogSync,
  addAccountByKey, getAccountInternal, removeAccount,
  getConnectSelectorPricing, isConnectSelectorBlockedByDrought, getDroughtSummary,
  isConnectSelectorFreeForAccount,
} = await import('../src/auth.js');
const models = await import('../src/models.js');
const { MODELS, mergeCloudModels, clearCloudModelCatalogs, removeCloudModelCatalog } = models;
const { clearLiveCatalogSelectors } = await import('../src/devin-connect-models.js');
const { handleChatCompletions, __setConnectDeps, __resetConnectDeps } = await import('../src/handlers/chat.js');
const { __setStreamChatForTest } = await import('../src/devin-connect-openai.js');

const ids = [];
const selector = 'swe-2-medium';
const otherSelector = 'swe-2-small';
const end = new Date(Date.now() + 86_400_000).toISOString();
const originalEnv = { ...process.env };

const catalogZero = { modelUid: selector, provider: 'MODEL_PROVIDER_WINDSURF', creditMultiplier: 0 };
const catalogPaid = { modelUid: selector, provider: 'MODEL_PROVIDER_WINDSURF', creditMultiplier: 6 };
const tierFree = {
  modelUid: selector,
  provider: 'MODEL_PROVIDER_WINDSURF',
  modelCostTier: 'MODEL_COST_TIER_FREE',
  promoStatus: { isActive: true, endDate: end },
  creditMultiplier: 6,
};

// Full realistic snapshot per account: the pool pricing answer depends on the
// selector row being the only priced row for that selector.
function priceSnapshot(acct, row) {
  const uids = [...new Set(Object.values(MODELS).map((m) => m.modelUid).filter(Boolean))];
  mergeCloudModels([
    ...uids.filter((x) => x !== selector).map((modelUid) => ({ modelUid, creditMultiplier: 2 })),
    row,
  ], { accountId: acct.id });
}

// Catalog-only seed: Pro account in drought with NO GetUserStatus rate table, so
// the only possible free evidence is the catalog row the caller injects.
function seed(label, { weeklyPercent = 1, rateTable } = {}) {
  const a = addAccountByKey(`offline-zero-${label}`, `${label}@example.invalid`);
  ids.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = 'pro';
  acct.credits = { weeklyPercent, dailyPercent: weeklyPercent, ...(rateTable ? { rateTable } : {}) };
  return acct;
}

function success() {
  return {
    status: 200,
    body: {
      id: 'offline-zero',
      model: selector,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  };
}

// Records the session token handed to the adapter — the only observable that
// says WHICH account executed.
function recordingAdapter(calls = []) {
  return {
    calls,
    toChatCompletion: async (params) => {
      calls.push(params.token ?? null);
      return success();
    },
  };
}

function chat(callerKey = 'zero-caller', tag = 'zero') {
  return handleChatCompletions(
    { model: selector, messages: [{ role: 'user', content: `offline B1 zero ${tag}` }], stream: false },
    { callerKey },
  );
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DROUGHT_RESTRICT_PREMIUM = '1';
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  delete process.env.DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT;
  delete process.env.DEVIN_CONNECT_BILLING_TAGS;
  __setModelCatalogDeps({
    getCascadeModelConfigs: async () => ({ configs: [] }),
    fetchConnectCatalog: async () => [
      { selector },
      { selector: 'swe-1-7' },
      { selector: 'swe-1-7-medium' },
      { selector: 'glm-5-2' },
    ],
    scheduleCatalogRetry: () => () => {},
  });
});

afterEach(async () => {
  __resetConnectDeps();
  __setStreamChatForTest(null);
  while (ids.length) removeAccount(ids.pop());
  await __waitForModelCatalogSync();
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  clearCloudModelCatalogs();
  clearLiveCatalogSelectors();
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('catalog-only zero rate is free evidence for its own account', () => {
  it('admits and executes the catalog-zero account with no rate table', async () => {
    const acct = seed('only-zero');
    await __waitForModelCatalogSync();
    priceSnapshot(acct, catalogZero);

    assert.equal(getDroughtSummary().drought, true);
    const pricing = getConnectSelectorPricing(selector);
    assert.equal(pricing.freeNow, true);
    assert.equal(pricing.freeReason, 'rate_zero');
    assert.equal(isConnectSelectorFreeForAccount(acct, selector), true,
      'the account\'s own catalog zero must satisfy the free-only admission');
    assert.equal(isConnectSelectorBlockedByDrought(selector), false);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    const result = await chat('zero-caller', 'positive');
    assert.equal(result.status, 200, 'a known zero creditMultiplier is existing free evidence');
    assert.deepEqual(adapter.calls, [acct.apiKey], 'the catalog-zero account must actually execute');
  });

  it('keeps the mixed pool on the catalog-zero account (idle paid peer sorts first)', async () => {
    const zero = seed('mixed-zero');
    const paid = seed('mixed-paid');
    await __waitForModelCatalogSync();
    priceSnapshot(zero, catalogZero);
    priceSnapshot(paid, catalogPaid);
    // The free account is already serving one request, so the idle paid account
    // sorts first on in-flight count; the admission must still keep it on A.
    zero._inflight = 1;
    zero._inflightAt = Date.now();

    assert.equal(getConnectSelectorPricing(selector).freeNow, true);
    assert.equal(isConnectSelectorFreeForAccount(paid, selector), false,
      'the paid peer\'s own catalog rate is nonzero');

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    const result = await chat('zero-caller', 'mixed');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [zero.apiKey],
      'the adapter must be handed the catalog-zero token, not the idle paid peer');
    assert.equal(adapter.calls.filter((t) => t === paid.apiKey).length, 0);
  });

  it('answers 429 pool-exhausted when the catalog-zero account is ineligible', async () => {
    const zero = seed('ineligible-zero');
    const paid = seed('ineligible-paid');
    await __waitForModelCatalogSync();
    priceSnapshot(zero, catalogZero);
    priceSnapshot(paid, catalogPaid);
    // Free by price, but the upstream already refused THIS selector for it.
    zero._selectorIneligible = { [selector]: Date.now() + 30 * 60 * 1000 };

    assert.equal(getConnectSelectorPricing(selector).freeNow, true);
    assert.equal(isConnectSelectorBlockedByDrought(selector), false);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    const result = await chat('zero-caller', 'ineligible');
    // Existing pool-exhausted contract: 429 without falling through to the paid
    // peer and without spending the 30s queue wait.
    assert.equal(result.status, 429);
    assert.equal(result.body?.error?.type, 'rate_limit_exceeded');
    assert.equal(adapter.calls.length, 0, 'no account may execute a free-only admission here');
    assert.equal(adapter.calls.filter((t) => t === paid.apiKey).length, 0);
  });
});

describe('catalog rates stay account-scoped and nonzero/absent stay not-free', () => {
  it('does not treat a nonzero catalog rate as free', async () => {
    const acct = seed('nonzero-only');
    await __waitForModelCatalogSync();
    priceSnapshot(acct, catalogPaid);

    assert.equal(models.getCloudCreditRateForAccount?.(selector, acct.id)?.credit, 6);
    assert.equal(isConnectSelectorFreeForAccount(acct, selector), false);
    assert.equal(getConnectSelectorPricing(selector).freeNow, false);
    assert.equal(isConnectSelectorBlockedByDrought(selector), true);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });
    const result = await chat('zero-caller', 'nonzero');
    assert.equal(result.status, 503);
    assert.equal(adapter.calls.length, 0);
  });

  it('does not treat an absent catalog row as free', async () => {
    const acct = seed('absent-rate');
    await __waitForModelCatalogSync();
    // Live rate data exists for OTHER selectors only; this account said nothing
    // about the requested one.
    priceSnapshot(acct, { modelUid: otherSelector, creditMultiplier: 0 });

    assert.equal(models.getCloudCreditRateForAccount?.(selector, acct.id), null);
    assert.equal(isConnectSelectorFreeForAccount(acct, selector), false);
    assert.equal(isConnectSelectorBlockedByDrought(selector), true);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });
    const result = await chat('zero-caller', 'absent');
    assert.equal(result.status, 503);
    assert.equal(adapter.calls.length, 0);
  });

  it('never borrows another account\'s zero', async () => {
    const zero = seed('borrow-zero');
    const paid = seed('borrow-paid');
    await __waitForModelCatalogSync();
    priceSnapshot(zero, catalogZero);
    priceSnapshot(paid, catalogPaid);

    // Pool pricing says freeNow (some account can run it free) — that must not
    // make the PAID account admissible.
    assert.equal(getConnectSelectorPricing(selector).freeNow, true);
    assert.equal(isConnectSelectorFreeForAccount(paid, selector), false);
    assert.equal(models.getCloudCreditRateForAccount?.(selector, paid.id)?.credit, 6);
    assert.equal(models.getCloudCreditRateForAccount?.(selector, zero.id)?.credit, 0);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });
    const result = await chat('zero-caller', 'borrow');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [zero.apiKey]);
    assert.equal(adapter.calls.filter((t) => t === paid.apiKey).length, 0);
  });

  it('reads only the selected account\'s row, never the pooled one', async () => {
    const zero = seed('scope-zero');
    const paid = seed('scope-paid');
    await __waitForModelCatalogSync();
    priceSnapshot(zero, catalogZero);
    priceSnapshot(paid, catalogPaid);

    const read = models.getCloudCreditRateForAccount;
    assert.equal(typeof read, 'function', 'models.js must expose an account-scoped rate reader');
    assert.equal(read(selector, zero.id)?.credit, 0);
    assert.equal(read(selector, paid.id)?.credit, 6);
    assert.equal(read(selector, 'no-such-account'), null);
    assert.equal(read('unknown-selector', zero.id), null);
    assert.equal(typeof read(selector, zero.id)?.fetchedAt, 'number');
  });
});

describe('existing free sources and routing are preserved', () => {
  it('still admits an active promotional FREE cost tier without a rate table', async () => {
    const acct = seed('tier-free');
    await __waitForModelCatalogSync();
    priceSnapshot(acct, tierFree);

    const pricing = getConnectSelectorPricing(selector);
    assert.equal(pricing.freeNow, true);
    assert.equal(pricing.freeReason, 'cost_tier_free');
    assert.equal(isConnectSelectorFreeForAccount(acct, selector), true);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });
    const result = await chat('zero-caller', 'tier');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [acct.apiKey]);
  });

  it('still admits a rate-table zero with no catalog data', async () => {
    const acct = seed('table-zero', { rateTable: { [selector]: 0 } });
    await __waitForModelCatalogSync();

    const pricing = getConnectSelectorPricing(selector);
    assert.equal(pricing.freeNow, true);
    assert.equal(pricing.freeReason, 'rate_zero');
    assert.equal(isConnectSelectorFreeForAccount(acct, selector), true);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });
    const result = await chat('zero-caller', 'table');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [acct.apiKey]);
  });

  it('keeps the rate-table zero winning over a nonzero catalog rate on the same account', async () => {
    const acct = seed('table-vs-catalog', { rateTable: { [selector]: 0 } });
    await __waitForModelCatalogSync();
    priceSnapshot(acct, catalogPaid);

    assert.equal(isConnectSelectorFreeForAccount(acct, selector), true,
      'the existing rate-table arm keeps its precedence');
  });

  it('keeps ordinary paid routing outside a drought', async () => {
    const zero = seed('paidroute-zero', { weeklyPercent: 100 });
    const paid = seed('paidroute-paid', { weeklyPercent: 100 });
    await __waitForModelCatalogSync();
    priceSnapshot(zero, catalogZero);
    priceSnapshot(paid, catalogPaid);
    zero._inflight = 1;
    zero._inflightAt = Date.now();

    assert.equal(getDroughtSummary().drought, false);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });
    const result = await chat('zero-caller', 'paidroute');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [paid.apiKey],
      'outside a drought the scheduler keeps routing to the least-busy account');
  });
});

describe('catalog rate lifecycle', () => {
  it('stops treating the account as free once re-priced nonzero', async () => {
    const acct = seed('reprice');
    await __waitForModelCatalogSync();
    priceSnapshot(acct, catalogZero);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });
    const first = await chat('zero-caller', 'reprice-first');
    assert.equal(first.status, 200);
    assert.deepEqual(adapter.calls, [acct.apiKey]);

    // Next accepted snapshot prices the selector at 6: the replace-whole-map rule
    // must drop the stale zero.
    priceSnapshot(acct, catalogPaid);
    assert.equal(models.getCloudCreditRateForAccount?.(selector, acct.id)?.credit, 6);
    assert.equal(isConnectSelectorFreeForAccount(acct, selector), false);
    assert.equal(isConnectSelectorBlockedByDrought(selector), true);

    const second = await chat('zero-caller', 'reprice-second');
    assert.equal(second.status, 503);
    assert.deepEqual(adapter.calls, [acct.apiKey], 'no new adapter call after re-pricing');
  });

  it('stops treating the account as free when its catalog is removed', async () => {
    const acct = seed('removal');
    await __waitForModelCatalogSync();
    priceSnapshot(acct, catalogZero);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });
    const first = await chat('zero-caller', 'removal-first');
    assert.equal(first.status, 200);
    assert.deepEqual(adapter.calls, [acct.apiKey]);

    removeCloudModelCatalog(acct.id);
    assert.equal(models.getCloudCreditRateForAccount?.(selector, acct.id), null);
    assert.equal(isConnectSelectorFreeForAccount(acct, selector), false);
    assert.equal(isConnectSelectorBlockedByDrought(selector), true);

    const second = await chat('zero-caller', 'removal-second');
    assert.equal(second.status, 503);
    assert.deepEqual(adapter.calls, [acct.apiKey], 'no new adapter call after catalog removal');
  });
});
