// Pooled DEVIN_CONNECT admission: a request admitted while the account pool
// existed must hold an account lease before dispatch.
//
// The preflight (chat.js, poolAtAdmission) promises that a real pool serves the
// request through the scheduler. `acquireConnectAccount` can still resolve null
// after its async wait — queue timeout, client abort, or the pool stopped
// admitting the selector. That state is NOT the operator's standalone env-token
// deployment (which has no pool at admission) and must not fall through to an
// un-accounted dispatch.
//
// Offline only: fake adapter (__setConnectDeps), synthetic accounts, no socket.
// setup-env/mutation-network-deny are preloaded by the runner command.

process.env.DEVIN_CONNECT = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  __setModelCatalogDeps, __resetModelCatalogState, __waitForModelCatalogSync,
  addAccountByKey, getAccountInternal, removeAccount, markRateLimited,
} = await import('../src/auth.js');
const { cacheClear, cacheKey, cacheSet } = await import('../src/cache.js');
const { handleChatCompletions, __setConnectDeps, __resetConnectDeps } = await import('../src/handlers/chat.js');
const { createRequestBudget } = await import('../src/request-budget.js');

const CALLER = 'api:0123456789abcdef0123456789abcdef:user:pooled-admission';
const MODEL = 'swe-1-6-slow';
const ids = [];
const savedEnv = {
  DEVIN_CONNECT: process.env.DEVIN_CONNECT,
  DEVIN_CONNECT_TOKEN: process.env.DEVIN_CONNECT_TOKEN,
  WINDSURF_API_KEY: process.env.WINDSURF_API_KEY,
};

function body(extra = {}) {
  return { model: MODEL, messages: [{ role: 'user', content: 'offline pooled admission' }], ...extra };
}

function seedPoolAccount(label) {
  const a = addAccountByKey(
    `offline-pooled-${label}-${Math.random().toString(36).slice(2)}`,
    `${label}@example.invalid`,
  );
  ids.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = 'pro';
  return acct;
}

function ok() {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-offline-pooled',
      object: 'chat.completion',
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    },
  };
}

// Records adapter invocations. The assertion for every unacquired case is on
// this array: no call means no provider, no credential, and no wire.
function recordProvider(calls) {
  __setConnectDeps({
    toChatCompletion: async (params) => { calls.push(params); return ok(); },
  });
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  cacheClear();
  __setModelCatalogDeps({
    getCascadeModelConfigs: async () => ({ configs: [] }),
    fetchConnectCatalog: async () => [{ selector: MODEL }],
    scheduleCatalogRetry: () => () => {},
  });
});

afterEach(async () => {
  __resetConnectDeps();
  cacheClear();
  while (ids.length) removeAccount(ids.pop());
  await __waitForModelCatalogSync();
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
});

describe('DEVIN_CONNECT pooled acquisition contract', () => {
  it('rejects a buffered request whose pooled queue wait ends empty', async () => {
    // The env token is present on purpose: an operator who also holds a pool is
    // still not allowed to serve an unacquired pooled request on it.
    process.env.DEVIN_CONNECT_TOKEN = 'offline-env-token-not-a-lease';
    seedPoolAccount('buffered');
    const calls = [];
    recordProvider(calls);

    const result = await handleChatCompletions(body(), {
      callerKey: CALLER,
      waitForAccount: async () => null,
    });

    assert.equal(result.status, 429);
    assert.equal(result.body.error.type, 'rate_limit_exceeded');
    assert.match(result.body.error.message, /within the queue window/);
    assert.equal(
      result.headers['Retry-After'],
      String(result.body.error.retry_after_ms / 1000),
      'header and body advertise the same clamped seconds',
    );
    assert.equal(calls.length, 0, 'an unacquired pooled request must not reach an adapter');
  });

  it('rejects a streaming request before a stream adapter exists', async () => {
    process.env.DEVIN_CONNECT_TOKEN = 'offline-env-token-not-a-lease';
    seedPoolAccount('streaming');
    const calls = [];
    recordProvider(calls);

    const result = await handleChatCompletions(body({ stream: true }), {
      callerKey: CALLER,
      waitForAccount: async () => null,
    });

    assert.equal(result.status, 429);
    assert.equal(result.stream, undefined, 'the failure must not be shaped as a stream');
    assert.equal(typeof result.handler, 'undefined');
    assert.equal(calls.length, 0);
  });

  it('maps an expired request budget to the established deadline response', async () => {
    seedPoolAccount('budget');
    const calls = [];
    recordProvider(calls);
    // Deterministic clock: create the budget, then move time past its deadline.
    // A constant `now` offset would leave the 1ms window open.
    let clock = 0;
    const budget = createRequestBudget({ deadlineMs: 1, now: () => clock });
    clock = 10;

    const result = await handleChatCompletions(body(), {
      callerKey: CALLER,
      budget,
      waitForAccount: async () => null,
    });

    assert.equal(result.status, 504);
    assert.equal(result.body.error.type, 'timeout_error');
    assert.equal(result.body.error.code, 'DEADLINE_EXCEEDED');
    assert.match(result.body.error.message, /request budget exhausted/);
    assert.equal(calls.length, 0);
  });

  it('returns 499 when the client disconnects during the wait', async () => {
    seedPoolAccount('cancelled');
    const calls = [];
    recordProvider(calls);
    const controller = new AbortController();
    controller.abort();

    const result = await handleChatCompletions(body({ stream: true }), {
      callerKey: CALLER,
      signal: controller.signal,
      waitForAccount: async () => null,
    });

    assert.equal(result.status, 499);
    assert.equal(result.body.error.type, 'client_disconnect');
    assert.equal(result.body.error.code, 'client_disconnect');
    assert.equal(calls.length, 0);
  });

  it('preserves a cache hit even when the pool cannot lease', async () => {
    const acct = seedPoolAccount('cache');
    markRateLimited(acct.apiKey, 60_000);
    cacheSet(cacheKey(body(), CALLER), {
      text: 'cached pooled answer',
      thinking: '',
      finishReason: 'stop',
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    });
    const calls = [];
    recordProvider(calls);

    const result = await handleChatCompletions(body(), {
      callerKey: CALLER,
      waitForAccount: async () => { throw new Error('a cache hit must not wait for a lease'); },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'cached pooled answer');
    assert.equal(calls.length, 0, 'a replayed answer must not acquire or call an account');
  });

  it('preserves the standalone env-token deployment when no pool existed at admission', async () => {
    process.env.DEVIN_CONNECT_TOKEN = 'offline-standalone-token';
    const calls = [];
    recordProvider(calls);

    const result = await handleChatCompletions(body(), { callerKey: CALLER });

    assert.equal(result.status, 200);
    assert.equal(calls.length, 1, 'an empty pool still serves through the env token');
    assert.equal(calls[0].token, undefined, 'the env-token fallback is not a pooled lease');
  });
});
