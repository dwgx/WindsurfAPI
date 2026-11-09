// P2-7 (evidence/ReviewChatCore.md §P2-7): the DEVIN_CONNECT fast-fail
// preflight only asked the cooldown/RPM questions
// (isAllRateLimited / isAllTemporarilyUnavailable). It was blind to the
// dimensions the scheduler's own admission predicate adds — account
// maintenance (held for a background / language-server swap; live by default)
// and the per-account in-flight cap — and to the selector latch.
//
// So a pool that was unselectable for one of those reasons passed the
// preflight, spent the full queue wait in acquireConnectAccount, and then
// acquired null — which the connect path cannot tell apart from "no pool at
// all" and answers with the un-accounted env token. That is the P0-2
// conflation the preflight exists to prevent (chat.js's own comment: those two
// cases "must NOT be conflated").
//
// The fix reuses the scheduler's admission conjunction read-only in preflight.
// These exercise the real handler, so the assertion is the client-visible
// outcome: a fast 429 and ZERO upstream calls, never an env-token turn.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { createRequestBudget } from '../src/request-budget.js';
import {
  addAccountByKey, removeAccount, getAccountInternal, setAccountTier, markSelectorIneligible,
  markRateLimited,
} from '../src/auth.js';

const FREE_SELECTOR = 'swe-1-6-slow';

const SAVED = {};
const ENV_KEYS = [
  'DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY',
  'WINDSURFAPI_STRICT_MODEL', 'DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT',
  'WINDSURFAPI_ERROR_RECOVERY_MS',
];
for (const k of ENV_KEYS) SAVED[k] = process.env[k];

const created = [];

function seed(label) {
  const a = addAccountByKey(`devin-session-token$p27-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  setAccountTier(a.id, 'pro');
  return getAccountInternal(a.id);
}

/** Stub the connect client so an env-token fallback is observable: the handler
 *  only puts a token on `params` for a POOLED account. */
function stubUpstream() {
  const state = { hits: 0, pooledToken: undefined };
  __setConnectDeps({
    toChatCompletion: async (params) => {
      state.hits++;
      state.pooledToken = params.token;
      return {
        status: 200,
        body: {
          id: 'x', object: 'chat.completion', created: 0,
          choices: [{ index: 0, message: { role: 'assistant', content: 'SERVED' }, finish_reason: 'stop' }],
        },
      };
    },
  });
  return state;
}

function ask() {
  return handleChatCompletions(
    { model: FREE_SELECTOR, stream: false, messages: [{ role: 'user', content: 'hi' }] },
    { callerKey: '' },
  );
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  // An env token is present on purpose: before the fix it is exactly what a
  // blocked pool silently falls through to (devin-connect.js `token || env`).
  process.env.DEVIN_CONNECT_TOKEN = 'env-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  delete process.env.WINDSURFAPI_STRICT_MODEL;
  delete process.env.DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT;
});

afterEach(() => {
  __resetConnectDeps();
  while (created.length) removeAccount(created.pop());
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('P2-7: preflight applies the scheduler admission conjunction', () => {
  it('fails fast with 429 when every entitled account is in maintenance', async () => {
    const a = seed('maint-a');
    const b = seed('maint-b');
    a._maintenance = 1; // background / language-server swap in progress
    b._maintenance = 1;
    const up = stubUpstream();

    const result = await ask();

    assert.equal(result.status, 429,
      'a pool that cannot be selected must fail fast, not queue for 30s and then use the env token');
    assert.equal(result.body.error.type, 'rate_limit_exceeded');
    assert.ok(result.body.error.retry_after_ms > 0, 'carries a retry_after hint');
    assert.ok(result.headers['Retry-After'], 'sets the Retry-After header');
    assert.equal(up.hits, 0, 'never touched upstream (the env token must not serve a pool request)');
  });

  it('fails fast when the selector is latched on A and the only peer is in maintenance', async () => {
    const a = seed('lat-a');
    const b = seed('lat-b');
    assert.equal(markSelectorIneligible(a.apiKey, FREE_SELECTOR), true,
      'precondition: B is admitted, so the latch is written');
    b._maintenance = 1;
    const up = stubUpstream();

    const result = await ask();

    assert.equal(result.status, 429, 'latch(A) + maintenance(B) must not degrade into an env-token turn');
    assert.equal(up.hits, 0);
  });

  it('fails fast when every entitled account is at its in-flight cap', async () => {
    process.env.DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT = '1';
    const a = seed('cap-a');
    a._inflight = 1;
    a._inflightAt = Date.now();
    const up = stubUpstream();

    const result = await ask();

    assert.equal(result.status, 429, 'the in-flight cap is an admission dimension, not a queue hint');
    assert.equal(up.hits, 0);
  });

  it('still serves normally when one peer is in maintenance (no over-trigger)', async () => {
    const a = seed('ok-a');
    seed('ok-b')._maintenance = 1;
    const up = stubUpstream();

    const result = await ask();

    assert.equal(result.status, 200, 'a selectable account must still serve');
    assert.equal(result.body.choices[0].message.content, 'SERVED');
    assert.equal(up.hits, 1);
    assert.equal(up.pooledToken, a.apiKey, 'served by the pooled account, not the env token');
  });

  // getApiKey half-opens an 'error' account whose recovery TTL elapsed BEFORE it
  // applies the admission predicate. The preflight must model that step, or a
  // pool whose only remaining candidate is due for the trial would be 429'd
  // forever — the recovery runs inside getApiKey, so the 429 would never let it.
  it('does not fast-fail when the remaining peer is DUE for half-open recovery', async () => {
    process.env.WINDSURFAPI_ERROR_RECOVERY_MS = '60000';
    seed('maint-a')._maintenance = 1;
    const b = seed('recover-b');
    b.status = 'error';
    b._errorAt = Date.now() - 120_000; // past the 60s TTL → the next selection recovers it
    const up = stubUpstream();

    const result = await ask();

    assert.equal(result.status, 200, 'the next getApiKey would recover B — do not 429 the trial away');
    assert.equal(up.pooledToken, b.apiKey, 'served by the recovered account');
    assert.equal(getAccountInternal(b.id).status, 'active', 'the trial really ran');
  });

  it('fast-fails while the errored peer is still inside its recovery TTL', async () => {
    process.env.WINDSURFAPI_ERROR_RECOVERY_MS = '60000';
    seed('maint-a')._maintenance = 1;
    const b = seed('recover-b');
    b.status = 'error';
    b._errorAt = Date.now() - 1_000; // not due yet
    const up = stubUpstream();

    const result = await ask();

    assert.equal(result.status, 429, 'no account is selectable and none is due for a trial');
    assert.equal(up.hits, 0);
  });

  it('still falls back to the env token when the pool is genuinely EMPTY', async () => {
    const up = stubUpstream();

    const result = await ask();

    assert.equal(result.status, 200, 'an empty pool is the env-token deploy shape, not exhaustion');
    assert.equal(result.body.choices[0].message.content, 'SERVED');
    assert.equal(up.hits, 1);
    assert.equal(up.pooledToken, undefined, 'the empty-pool shape hands no pooled token to the client');
  });

  it('still fails fast for a fully rate-limited pool (existing arm unchanged)', async () => {
    const a = seed('rl-a');
    const b = seed('rl-b');
    markRateLimited(a.apiKey, 5 * 60 * 1000);
    markRateLimited(b.apiKey, 5 * 60 * 1000);
    const up = stubUpstream();

    const result = await ask();

    assert.equal(result.status, 429);
    assert.ok(result.body.error.retry_after_ms >= 60 * 1000, 'the precise cooldown is still advertised');
    assert.equal(up.hits, 0);
  });

  it('fast-fails 429 when the only account is cooled for the requested selector', async () => {
    // A model-scoped 429 with an upstream reset — the shape finalizeConnectAccount
    // writes for "Reached message rate limit for this model ... Resets in: 3h".
    // It benches the account for THIS selector only, so the preflight must read
    // BOTH dimensions: rl.allLimited and tu.allUnavailable true. If tu stayed
    // selector-blind, `degradable` would be true and the request would spend the
    // queue wait (and fall through to the env token) instead of a fast 429.
    const a = seed('sel-rl');
    markRateLimited(a.apiKey, 3 * 60 * 60 * 1000, FREE_SELECTOR, 'r');
    const up = stubUpstream();

    const result = await handleChatCompletions(
      { model: FREE_SELECTOR, stream: false, messages: [{ role: 'user', content: 'hi' }] },
      // Bound the regression path: without the fix this test would wait the full
      // 30s queue before answering.
      { callerKey: '', budget: createRequestBudget({ deadlineMs: 2_000 }) },
    );

    assert.equal(result.status, 429, 'a selector-cooled pool must fast-fail, not queue');
    assert.equal(result.body.error.type, 'rate_limit_exceeded');
    assert.ok(result.body.error.retry_after_ms >= 60 * 1000, 'the upstream reset is advertised');
    assert.ok(result.headers['Retry-After'], 'sets the Retry-After header');
    assert.equal(up.hits, 0, 'no upstream turn and no env-token fallback');
  });
});
