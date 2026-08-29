import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  __resetModelCatalogState,
  __setModelCatalogDeps,
  __waitForModelCatalogSync,
  addAccountByKey,
  configureBindHost,
  getAvailableModelsForAccount,
  getDroughtSummary,
  isDroughtMode,
  isModelBlockedByDrought,
  isModelAllowedForAccount,
  removeAccount,
  setAccountStatus,
  trySyncModelCatalog,
} from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { handleModels } from '../src/handlers/models.js';
import {
  MODELS,
  MODEL_TIER_ACCESS,
  filterModelKeysByCloudCatalog,
  listModels,
  mergeCloudCatalogSnapshot,
  mergeCloudModels,
  setActiveCloudCatalogAccounts,
} from '../src/models.js';

const ALLOWED_KEY = 'gemini-2.5-flash';
const SECOND_ALLOWED_KEY = 'claude-4-sonnet';
const ACCOUNT_A = 'catalog-account-a';
const ACCOUNT_B = 'catalog-account-b';
const ORIGINAL_ALLOW_NO_AUTH = process.env.DASHBOARD_ALLOW_NO_AUTH;
const ORIGINAL_IGNORE_FILTER = process.env.WINDSURFAPI_IGNORE_CLOUD_FILTER;
const ORIGINAL_SPECIAL_BACKEND = process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
const ORIGINAL_CLI_ENABLED = process.env.DEVIN_CLI_ENABLED;
const ORIGINAL_DASHBOARD_PASSWORD = config.dashboardPassword;
const ORIGINAL_API_KEY = config.apiKey;
const createdAccountIds = [];

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
  return {
    url: `/dashboard/api${path}`,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function syncAllowed(keys = [ALLOWED_KEY], accountId = ACCOUNT_A) {
  setActiveCloudCatalogAccounts([accountId]);
  const configs = keys.map((key) => ({ modelUid: MODELS[key].modelUid }));
  confirmCloudCatalog(configs, accountId);
}

function cascadeKeys(keys) {
  // Exclude backends the Cascade cloud catalog does not govern: special-agent
  // models and third-party gateway models (orcarouter/*) are served by their
  // own upstreams, so the account-pool catalog neither controls nor should
  // hide them.
  return keys.filter((key) => {
    const backend = MODELS[key]?.backend;
    return backend !== 'special_agent' && backend !== 'orcarouter';
  });
}

function fullStaticCloudConfigs() {
  const seen = new Set();
  const configs = [];
  for (const model of Object.values(MODELS)) {
    if (model?.deprecated || model?.backend === 'special_agent' || model?.backend === 'orcarouter' || typeof model?.modelUid !== 'string') continue;
    const normalized = model.modelUid.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    configs.push({ modelUid: model.modelUid });
  }
  return configs;
}

function confirmCloudCatalog(configs, accountId) {
  // Direct model-layer calls represent two separate sync rounds. Production
  // schedules the second round after the confirmation delay.
  mergeCloudModels(configs, { accountId });
  mergeCloudModels(configs, { accountId });
}

beforeEach(() => {
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  delete process.env.WINDSURFAPI_IGNORE_CLOUD_FILTER;
  delete process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
  delete process.env.DEVIN_CLI_ENABLED;
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
  config.dashboardPassword = '';
  config.apiKey = '';
  configureBindHost('127.0.0.1');
});

afterEach(async () => {
  for (const accountId of createdAccountIds.splice(0)) removeAccount(accountId);
  await __waitForModelCatalogSync();
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  if (ORIGINAL_ALLOW_NO_AUTH === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = ORIGINAL_ALLOW_NO_AUTH;
  if (ORIGINAL_IGNORE_FILTER === undefined) delete process.env.WINDSURFAPI_IGNORE_CLOUD_FILTER;
  else process.env.WINDSURFAPI_IGNORE_CLOUD_FILTER = ORIGINAL_IGNORE_FILTER;
  if (ORIGINAL_SPECIAL_BACKEND === undefined) delete process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
  else process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = ORIGINAL_SPECIAL_BACKEND;
  if (ORIGINAL_CLI_ENABLED === undefined) delete process.env.DEVIN_CLI_ENABLED;
  else process.env.DEVIN_CLI_ENABLED = ORIGINAL_CLI_ENABLED;
  config.dashboardPassword = ORIGINAL_DASHBOARD_PASSWORD;
  config.apiKey = ORIGINAL_API_KEY;
  configureBindHost('0.0.0.0');
});

describe('upstream account cloud catalog filtering', () => {
  it('limits GET /v1/models and tier routing to catalog-approved Cascade models', () => {
    syncAllowed();

    const apiKeys = handleModels({}).data.map((model) => model._windsurf_id);
    assert.deepEqual(cascadeKeys(apiKeys), [ALLOWED_KEY]);
    assert.deepEqual(cascadeKeys(MODEL_TIER_ACCESS.pro), [ALLOWED_KEY]);
    assert.deepEqual(cascadeKeys(MODEL_TIER_ACCESS.unknown), [ALLOWED_KEY]);
    assert.deepEqual(cascadeKeys(MODEL_TIER_ACCESS.free), [ALLOWED_KEY]);
  });

  it('makes the upstream account catalog win over entitlement and manual tier overrides', () => {
    syncAllowed();
    const disallowedKey = 'claude-4-sonnet';
    const statusAccount = {
      id: ACCOUNT_A,
      tier: 'pro',
      userStatusLastFetched: Date.now(),
      capabilities: {
        [ALLOWED_KEY]: { ok: true, reason: 'user_status' },
        [disallowedKey]: { ok: true, reason: 'user_status' },
      },
    };
    const manualAccount = { ...statusAccount, tierManual: true };

    assert.equal(isModelAllowedForAccount(statusAccount, ALLOWED_KEY), true);
    assert.equal(
      isModelAllowedForAccount(statusAccount, disallowedKey),
      false,
      'per-account entitlement must not bypass the upstream account catalog',
    );
    assert.equal(
      isModelAllowedForAccount(manualAccount, disallowedKey),
      false,
      'manual tier override must not bypass the upstream account catalog',
    );
    assert.ok(!getAvailableModelsForAccount(statusAccount).includes(disallowedKey));
  });

  it('uses the same approved catalog for both Dashboard model endpoints', async () => {
    syncAllowed();

    const modelsRes = fakeRes();
    await handleDashboardApi('GET', '/models', {}, localReq('/models'), modelsRes);
    assert.equal(modelsRes.statusCode, 200);
    assert.deepEqual(
      cascadeKeys(modelsRes.json().models.map((model) => model.id)),
      [ALLOWED_KEY],
      '/dashboard/api/models must not expose models outside the active account catalogs',
    );

    const tierRes = fakeRes();
    await handleDashboardApi('GET', '/tier-access', {}, localReq('/tier-access'), tierRes);
    assert.equal(tierRes.statusCode, 200);
    assert.deepEqual(cascadeKeys(tierRes.json().allModels), [ALLOWED_KEY]);
  });

  it('does not expose mutable cloud-catalog state', () => {
    syncAllowed();

    const snapshot = filterModelKeysByCloudCatalog();
    snapshot.length = 0;

    assert.deepEqual(
      cascadeKeys(listModels().map((model) => model._windsurf_id)),
      [ALLOWED_KEY],
      'mutating a returned snapshot must not disable the active filter',
    );
  });

  it('fails open before a usable catalog arrives and supports an explicit opt-out', () => {
    const baseline = handleModels({}).data.map((model) => model.id);
    assert.ok(baseline.length > 100);

    setActiveCloudCatalogAccounts([ACCOUNT_A]);
    mergeCloudModels([null, {}, { modelUid: 123 }], { accountId: ACCOUNT_A });
    assert.deepEqual(handleModels({}).data.map((model) => model.id), baseline);

    syncAllowed();
    process.env.WINDSURFAPI_IGNORE_CLOUD_FILTER = '1';
    assert.deepEqual(handleModels({}).data.map((model) => model.id), baseline);
  });

  it('keeps the accepted catalog when mergeCloudModels receives a non-array', () => {
    // This test used to assert the opposite — that a non-array response CLEARS the
    // catalog back to the unfiltered baseline — and its name said "clears a stale
    // catalog". That was the defect, not the contract: a malformed body is NO DATA,
    // and applying it deleted the account's snapshot so every model the filter
    // existed to hide was re-advertised (#231's own symptom) with no confirmation
    // round. A truncated / throttled / auth-blipped upstream response is the most
    // likely degenerate shape there is, so it was the one unguarded path that got
    // taken most. See test/cloud-catalog-degenerate-response.test.js.
    const unfiltered = handleModels({}).data.map((model) => model.id);
    syncAllowed();
    const filtered = handleModels({}).data.map((model) => model.id);
    assert.notDeepEqual(filtered, unfiltered, 'precondition: the sync must narrow the view');

    mergeCloudModels({ malformed: true }, { accountId: ACCOUNT_A });

    assert.deepEqual(
      handleModels({}).data.map((model) => model.id), filtered,
      'a malformed response must preserve the last-known-good catalog, not widen it back out',
    );
  });

  it('matches cloud model UIDs case-insensitively', () => {
    setActiveCloudCatalogAccounts([ACCOUNT_A]);
    const configs = [{ modelUid: MODELS[ALLOWED_KEY].modelUid.toLowerCase() }];
    confirmCloudCatalog(configs, ACCOUNT_A);

    assert.deepEqual(
      cascadeKeys(handleModels({}).data.map((model) => model._windsurf_id)),
      [ALLOWED_KEY],
    );
  });

  it('keeps enabled special-agent models because Cascade catalog policy does not govern them', () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    syncAllowed();

    const models = listModels();
    assert.deepEqual(cascadeKeys(models.map((model) => model._windsurf_id)), [ALLOWED_KEY]);
    assert.ok(models.some((model) => model._backend === 'special_agent' && model._available));
  });

  it('keeps a newly discovered cloud model when that same catalog allows it', () => {
    const uid = 'MODEL_CLOUD_CATALOG_TEST';
    const key = 'model-cloud-catalog-test';
    setActiveCloudCatalogAccounts([ACCOUNT_A]);
    const configs = [{
      modelUid: uid,
      provider: 'MODEL_PROVIDER_ANTHROPIC',
      creditMultiplier: 2,
    }];
    confirmCloudCatalog(configs, ACCOUNT_A);

    const models = handleModels({}).data;
    assert.deepEqual(cascadeKeys(models.map((model) => model._windsurf_id)), [key]);
    // The discovered model is the only Cascade-catalog entry; index into the
    // filtered view rather than the raw list (which may lead with third-party
    // gateway models like orcarouter/* that precede it in MODELS order).
    const catalogModel = models.find((m) => m._windsurf_id === key);
    assert.equal(catalogModel.owned_by, 'anthropic');
  });

  it('unions model listings while enforcing each account catalog during routing', () => {
    setActiveCloudCatalogAccounts([ACCOUNT_A, ACCOUNT_B]);
    const configsA = [{ modelUid: MODELS[ALLOWED_KEY].modelUid }];
    const configsB = [{ modelUid: MODELS[SECOND_ALLOWED_KEY].modelUid }];
    confirmCloudCatalog(configsA, ACCOUNT_A);
    confirmCloudCatalog(configsB, ACCOUNT_B);

    assert.deepEqual(
      cascadeKeys(handleModels({}).data.map((model) => model._windsurf_id)).sort(),
      [ALLOWED_KEY, SECOND_ALLOWED_KEY].sort(),
      'the pool catalog should be the union of active account catalogs',
    );

    const baseAccount = {
      tier: 'pro',
      tierManual: true,
      capabilities: {},
    };
    const accountA = { ...baseAccount, id: ACCOUNT_A };
    const accountB = { ...baseAccount, id: ACCOUNT_B };

    assert.equal(isModelAllowedForAccount(accountA, ALLOWED_KEY), true);
    assert.equal(isModelAllowedForAccount(accountA, SECOND_ALLOWED_KEY), false);
    assert.equal(isModelAllowedForAccount(accountB, ALLOWED_KEY), false);
    assert.equal(isModelAllowedForAccount(accountB, SECOND_ALLOWED_KEY), true);
  });

  it('fails global listings open until every active account has a usable catalog', () => {
    const baseline = handleModels({}).data.map((model) => model.id);
    setActiveCloudCatalogAccounts([ACCOUNT_A, ACCOUNT_B]);
    const configs = [{ modelUid: MODELS[ALLOWED_KEY].modelUid }];
    mergeCloudModels(configs, { accountId: ACCOUNT_A });

    assert.deepEqual(handleModels({}).data.map((model) => model.id), baseline);
  });

  it('synchronizes every active account instead of reusing the first catalog', async () => {
    const runId = Date.now().toString(36);
    const apiKeyA = `catalog-sync-${runId}-a`;
    const apiKeyB = `catalog-sync-${runId}-b`;
    const requestedKeys = [];
    const scheduledRetries = [];
    __setModelCatalogDeps({
      disableConnectSync: true,
      scheduleCatalogRetry: (retry) => {
        scheduledRetries.push(retry);
        return () => {};
      },
      getCascadeModelConfigs: async (apiKey) => {
        requestedKeys.push(apiKey);
        const modelKey = apiKey === apiKeyA ? ALLOWED_KEY : SECOND_ALLOWED_KEY;
        return { configs: [{ modelUid: MODELS[modelKey].modelUid }] };
      },
    });

    const accountA = addAccountByKey(apiKeyA, 'catalog-a');
    const accountB = addAccountByKey(apiKeyB, 'catalog-b');
    createdAccountIds.push(accountA.id, accountB.id);
    accountA.tier = 'pro';
    accountA.tierManual = true;
    accountB.tier = 'pro';
    accountB.tierManual = true;
    await __waitForModelCatalogSync();
    assert.equal(scheduledRetries.length, 2);
    for (const retry of scheduledRetries.splice(0)) retry();
    await __waitForModelCatalogSync();

    assert.deepEqual(new Set(requestedKeys), new Set([apiKeyA, apiKeyB]));
    assert.equal(isModelAllowedForAccount(accountA, ALLOWED_KEY), true);
    assert.equal(isModelAllowedForAccount(accountA, SECOND_ALLOWED_KEY), false);
    assert.equal(isModelAllowedForAccount(accountB, ALLOWED_KEY), false);
    assert.equal(isModelAllowedForAccount(accountB, SECOND_ALLOWED_KEY), true);

    setAccountStatus(accountB.id, 'disabled');
    assert.deepEqual(
      cascadeKeys(handleModels({}).data.map((model) => model._windsurf_id)),
      [ALLOWED_KEY],
      'inactive account catalogs must not remain in the pool listing',
    );
  });

  it('confirms an anomalously small first snapshot only after a delayed sync round', async () => {
    const runId = Date.now().toString(36);
    const apiKey = `catalog-partial-${runId}`;
    let requests = 0;
    let scheduledRetry;
    let retryDelay;
    const partial = [{ modelUid: MODELS[SECOND_ALLOWED_KEY].modelUid }];
    __setModelCatalogDeps({
      disableConnectSync: true,
      scheduleCatalogRetry: (retry, delay) => {
        scheduledRetry = retry;
        retryDelay = delay;
        return () => {};
      },
      getCascadeModelConfigs: async () => {
        requests += 1;
        return { configs: partial };
      },
    });

    const account = addAccountByKey(apiKey, 'catalog-partial');
    createdAccountIds.push(account.id);
    account.tier = 'pro';
    account.tierManual = true;
    await __waitForModelCatalogSync();

    assert.equal(requests, 1, 'one sync round must issue only one catalog request');
    assert.equal(retryDelay, 30_000);
    assert.equal(typeof scheduledRetry, 'function');
    assert.equal(isModelAllowedForAccount(account, ALLOWED_KEY), true);

    trySyncModelCatalog();
    await __waitForModelCatalogSync();
    assert.equal(
      requests,
      1,
      'ordinary sync triggers must not bypass the delayed confirmation round',
    );

    scheduledRetry();
    await __waitForModelCatalogSync();

    assert.equal(requests, 2);
    assert.equal(isModelAllowedForAccount(account, ALLOWED_KEY), false);
    assert.equal(isModelAllowedForAccount(account, SECOND_ALLOWED_KEY), true);
  });

  it('keeps re-checking a differing candidate, bounded, instead of polling forever', async () => {
    // This test used to assert that a differing confirmation schedules NOTHING
    // further. That is what wedged the catalog: an upstream returning a small set
    // that varies each round never satisfies the identical-repeat check, so the
    // candidate was re-quarantined indefinitely while a stale LARGER snapshot
    // stayed authoritative — and there is no periodic catalog refresh to recover
    // it, only account-lifecycle events. Measured: after a downgrade plus four
    // sync cycles the proxy still allowed a model the account had lost.
    //
    // The re-check is now armed every quarantined round, and models.js bounds the
    // quarantine (CLOUD_CATALOG_CONFIRM_MAX_ROUNDS) so it converges on the newest
    // snapshot instead of polling forever. Both halves matter: "keeps re-checking"
    // AND "is bounded". See test/cloud-catalog-degenerate-response.test.js.
    const runId = Date.now().toString(36);
    const apiKey = `catalog-changing-${runId}`;
    const scheduledRetries = [];
    let requests = 0;
    __setModelCatalogDeps({
      disableConnectSync: true,
      scheduleCatalogRetry: (retry) => {
        scheduledRetries.push(retry);
        return () => {};
      },
      getCascadeModelConfigs: async () => {
        requests += 1;
        const modelKey = requests === 1 ? ALLOWED_KEY : SECOND_ALLOWED_KEY;
        return { configs: [{ modelUid: MODELS[modelKey].modelUid }] };
      },
    });

    const account = addAccountByKey(apiKey, 'catalog-changing');
    createdAccountIds.push(account.id);
    account.tier = 'pro';
    account.tierManual = true;
    await __waitForModelCatalogSync();

    assert.equal(scheduledRetries.length, 1);
    scheduledRetries.shift()();
    await __waitForModelCatalogSync();

    assert.equal(requests, 2);
    assert.equal(
      scheduledRetries.length, 1,
      'a differing confirmation must arm the NEXT re-check — dropping it here is what let a '
      + 'small-and-varying upstream wedge the stale snapshot in place permanently',
    );
    assert.equal(isModelAllowedForAccount(account, ALLOWED_KEY), true);
    assert.equal(isModelAllowedForAccount(account, SECOND_ALLOWED_KEY), true);

    // Bounded: the re-checks converge rather than continuing indefinitely. Drain
    // them and assert the loop terminates well inside a small budget.
    let rounds = 2;
    while (scheduledRetries.length && rounds < 8) {
      scheduledRetries.shift()();
      await __waitForModelCatalogSync();
      rounds = requests;
    }
    assert.ok(
      scheduledRetries.length === 0,
      `the re-check loop did not converge within ${rounds} rounds — it must be bounded, not perpetual`,
    );
    assert.ok(rounds <= 4, `expected convergence in a few rounds, took ${rounds}`);

    setAccountStatus(account.id, 'disabled');
    setAccountStatus(account.id, 'active');
    await __waitForModelCatalogSync();

    assert.equal(requests, rounds + 1);
    assert.equal(
      scheduledRetries.length,
      1,
      'reactivation must start a new delayed confirmation after stale pending state is cleared',
    );
    assert.equal(isModelAllowedForAccount(account, ALLOWED_KEY), true);
    assert.equal(isModelAllowedForAccount(account, SECOND_ALLOWED_KEY), true);
  });

  it('keeps the last accepted snapshot until a large shrink is confirmed', () => {
    setActiveCloudCatalogAccounts([ACCOUNT_A]);
    mergeCloudModels(fullStaticCloudConfigs(), { accountId: ACCOUNT_A });

    const partial = [{ modelUid: MODELS[SECOND_ALLOWED_KEY].modelUid }];
    // The first shrink is quarantined and preserves the last-known-good catalog.
    const firstAdded = mergeCloudModels(partial, { accountId: ACCOUNT_A });

    assert.equal(firstAdded, 0);
    assert.ok(
      handleModels({}).data.some((model) => model._windsurf_id === ALLOWED_KEY),
      'an unconfirmed shrink must preserve the last accepted snapshot',
    );

    // A matching snapshot from a later sync round confirms the smaller catalog.
    mergeCloudModels(partial, { accountId: ACCOUNT_A });
    assert.deepEqual(
      cascadeKeys(handleModels({}).data.map((model) => model._windsurf_id)),
      [SECOND_ALLOWED_KEY],
    );
  });

  it('accepts a confirmed small allowlist and fails drought restriction open when no free model remains', async () => {
    const runId = Date.now().toString(36);
    const apiKey = `catalog-stable-small-${runId}`;
    let requests = 0;
    let scheduledRetry;
    __setModelCatalogDeps({
      disableConnectSync: true,
      scheduleCatalogRetry: (retry) => {
        scheduledRetry = retry;
        return () => {};
      },
      getCascadeModelConfigs: async () => {
        requests += 1;
        return { configs: [{ modelUid: MODELS[SECOND_ALLOWED_KEY].modelUid }] };
      },
    });

    const account = addAccountByKey(apiKey, 'catalog-stable-small');
    createdAccountIds.push(account.id);
    account.tier = 'pro';
    account.tierManual = true;
    account.credits = { weeklyPercent: 0, dailyPercent: 0 };
    await __waitForModelCatalogSync();
    scheduledRetry();
    await __waitForModelCatalogSync();

    assert.equal(requests, 2);
    assert.equal(isModelAllowedForAccount(account, SECOND_ALLOWED_KEY), true);
    assert.equal(isModelAllowedForAccount(account, ALLOWED_KEY), false);
    assert.equal(isDroughtMode(), true);
    assert.equal(isModelBlockedByDrought(SECOND_ALLOWED_KEY), false);
    const summary = getDroughtSummary();
    assert.deepEqual(summary.freeTierModels, []);
    assert.equal(summary.restrictionFailOpen, true);
  });

  it('leaves a malformed catalog response retryable and accepts the next valid response', async () => {
    const runId = Date.now().toString(36);
    const apiKey = `catalog-retry-${runId}`;
    let requests = 0;
    __setModelCatalogDeps({
      disableConnectSync: true,
      getCascadeModelConfigs: async () => {
        requests += 1;
        if (requests === 1) return {};
        return { configs: fullStaticCloudConfigs() };
      },
    });

    const account = addAccountByKey(apiKey, 'catalog-retry');
    createdAccountIds.push(account.id);
    await __waitForModelCatalogSync();
    trySyncModelCatalog();
    await __waitForModelCatalogSync();

    assert.equal(requests, 2);
    assert.equal(isModelAllowedForAccount(account, ALLOWED_KEY), true);
  });

  it('treats a valid empty catalog as synchronized instead of retrying it', async () => {
    const runId = Date.now().toString(36);
    const apiKey = `catalog-empty-${runId}`;
    let requests = 0;
    __setModelCatalogDeps({
      disableConnectSync: true,
      getCascadeModelConfigs: async () => {
        requests += 1;
        return { configs: [] };
      },
    });

    const account = addAccountByKey(apiKey, 'catalog-empty');
    createdAccountIds.push(account.id);
    await __waitForModelCatalogSync();
    trySyncModelCatalog();
    await __waitForModelCatalogSync();

    assert.equal(requests, 1);
  });

  it('labels a valid empty catalog as no_filter', () => {
    const snapshot = mergeCloudCatalogSnapshot([], { accountId: ACCOUNT_A });

    assert.equal(snapshot.accepted, true);
    assert.equal(snapshot.reason, 'no_filter');
  });
});
