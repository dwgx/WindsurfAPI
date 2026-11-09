// Q2 T10 — a model-scoped 429 with an upstream reset window must bench the
// account for THAT model only, never for the rest of the pool.
//
// The auth layer already writes `_modelRateLimits[modelKey]` when markRateLimited
// is given a model key; the defect this file pins is the POOL-LEVEL view:
// `isAllRateLimited(null, selector)` ignored the selector dimension entirely, so a
// connect preflight reported "available" for a pool whose every account was
// cooled for that selector — spending the full queue wait and then failing with a
// generic pool error instead of the real Retry-After. (The call site that decides
// account-wide vs model-scoped for an upstream 429 lives in chat.js
// finalizeConnectAccount; this file covers the auth-side invariant it relies on.)
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, markRateLimited, releaseAccount,
  getAccountInternal, getApiKey, isAllRateLimited, isAllTemporarilyUnavailable,
  __isRateLimitedForModel,
} from '../src/auth.js';
import { setBreakerTunables } from '../src/runtime-config.js';

// Both are in the default (unknown-tier) catalog, so the eligibility filter in
// isAllRateLimited does not skip the account for an unrelated reason.
const MODEL_A = 'claude-4-sonnet';
const MODEL_B = 'claude-4.5-haiku';
const SELECTOR_A = 'swe-1-6-slow';
const SELECTOR_B = 'gpt-5-5-sol';
const RESET_MS = 3 * 60 * 60 * 1000;

const created = [];
function add(label) {
  const account = addAccountByKey(
    `t10-key-${Date.now()}-${created.length}-${Math.random().toString(36).slice(2)}`,
    label,
  );
  created.push(account.id);
  return account;
}

afterEach(() => {
  // The fully-throttled fallback is ON by default and would hand back a cooled
  // account as an explicit `_degraded` serve; these assertions are about hard
  // exclusion, so pin the opt-out.
  setBreakerTunables({ degradedServe: null });
  while (created.length) removeAccount(created.pop());
});

describe('T10 — a model-scoped 429 does not evict the account for other models', () => {
  it('writes only the model dimension, never the account-wide one', () => {
    const account = add('model-scope');
    markRateLimited(account.apiKey, RESET_MS, MODEL_A, 'r');

    const live = getAccountInternal(account.id);
    assert.equal(live.rateLimitedUntil || 0, 0, 'the account-wide latch must stay clear');
    assert.equal(live.quotaResetAt || 0, 0, 'a rate limit is not a quota dry-well');
    assert.ok(live._modelRateLimits?.[MODEL_A] > Date.now(), 'the reset window is stored per model');
    assert.equal(live._modelRateLimits?.[MODEL_B], undefined, 'no cooldown is invented for other models');
  });

  it('isAllRateLimited reports the cooled model only', () => {
    const account = add('all-limited');
    markRateLimited(account.apiKey, RESET_MS, MODEL_A, 'r');

    const cooled = isAllRateLimited(MODEL_A);
    assert.equal(cooled.allLimited, true, 'the only account is cooled for MODEL_A');
    assert.ok(cooled.retryAfterMs > RESET_MS - 60_000 && cooled.retryAfterMs <= RESET_MS,
      `Retry-After must carry the upstream reset, got ${cooled.retryAfterMs}`);

    assert.equal(isAllRateLimited(MODEL_B).allLimited, false,
      'a cooldown for MODEL_A must not black out MODEL_B');
  });

  it('the selection gate still hands the account to other models', () => {
    setBreakerTunables({ degradedServe: false });
    const account = add('select');
    markRateLimited(account.apiKey, RESET_MS, MODEL_A, 'r');

    const other = getApiKey([], MODEL_B, 't10-other');
    assert.ok(other, 'MODEL_B must remain routable');
    assert.equal(other.apiKey, account.apiKey);
    releaseAccount(other.apiKey);

    assert.equal(getApiKey([], MODEL_A, 't10-cooled'), null,
      'MODEL_A must not be handed to a new request on the cooled account');
  });

  it('the connect preflight sees a selector-scoped cooldown (isAllRateLimited null + selector)', () => {
    const account = add('selector-scope');
    // The connect path selects with modelKey=null and stores the cooldown under
    // the resolved selector. Before the fix this lookup was blind to it.
    markRateLimited(account.apiKey, RESET_MS, SELECTOR_A, 'c');

    const cooled = isAllRateLimited(null, SELECTOR_A);
    assert.equal(cooled.allLimited, true, 'a selector-scoped cooldown must gate the connect preflight');
    assert.ok(cooled.retryAfterMs > RESET_MS - 60_000 && cooled.retryAfterMs <= RESET_MS,
      'and its Retry-After must be the upstream window, not the 60s default');

    assert.equal(isAllRateLimited(null, SELECTOR_B).allLimited, false,
      'other selectors on the same account stay available');
    assert.equal(isAllRateLimited(null).allLimited, false,
      'the account is not benched pool-wide');
  });

  it('isAllTemporarilyUnavailable sees the same selector dimension', () => {
    // The chat fast-429 preflight ORs rl and tu and treats `rl && !tu` as
    // degradable. A selector-cooled pool must report BOTH true, or the preflight
    // skips the fast 429 and spends the queue wait before failing.
    const account = add('tu-selector');
    markRateLimited(account.apiKey, RESET_MS, SELECTOR_A, 'c');

    const cooled = isAllTemporarilyUnavailable(null, SELECTOR_A);
    assert.equal(cooled.allUnavailable, true, 'a selector-scoped cooldown is temporary unavailability');
    assert.ok(cooled.retryAfterMs > RESET_MS - 60_000 && cooled.retryAfterMs <= RESET_MS,
      `Retry-After must be the upstream window, got ${cooled.retryAfterMs}`);

    assert.equal(isAllTemporarilyUnavailable(null, SELECTOR_B).allUnavailable, false,
      'other selectors remain available');
    assert.equal(isAllTemporarilyUnavailable(null).allUnavailable, false,
      'and the account is not globally unavailable');
  });

  it('the connect lookup honours the selector dimension (control: other selector served)', () => {
    setBreakerTunables({ degradedServe: false });
    const account = add('selector-select');
    markRateLimited(account.apiKey, RESET_MS, SELECTOR_A, 'c');

    const other = getApiKey([], null, 't10-selector-other', SELECTOR_B);
    assert.ok(other, 'SELECTOR_B must remain routable');
    assert.equal(other.apiKey, account.apiKey);
    releaseAccount(other.apiKey);

    assert.equal(getApiKey([], null, 't10-selector-cooled', SELECTOR_A), null,
      'SELECTOR_A must not be handed out while its cooldown is live');
    assert.equal(__isRateLimitedForModel(getAccountInternal(account.id), SELECTOR_A), true);
    assert.equal(__isRateLimitedForModel(getAccountInternal(account.id), SELECTOR_B), false);
  });
});
