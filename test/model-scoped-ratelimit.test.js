// T10 — a model-scoped 429 must not evict the account for another model.
//
// `finalizeConnectAccount`'s RATE_LIMITED arm used to call
// `markRateLimited(apiKey, err.resetMs, null, 'r')`, writing the upstream reset
// window into the ACCOUNT-WIDE `rateLimitedUntil`. One throttled model then
// benched a healthy account for every other model it could still serve. The
// cooldown is now keyed on the connect selector (`selector || model`), the same
// dimension `isCooledForRequest` consults during selection, so:
//
//   * the throttled selector is skipped (and reports `model_rate_limited`);
//   * every other model stays available on the same account;
//   * the account-wide `rateLimitedUntil` stays clear.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  getAccountAvailability,
  getAccountInternal,
  removeAccount,
  __isRateLimitedForModel,
} from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';

const RESET_MS = 3 * 60 * 60 * 1000;

describe('model-scoped RATE_LIMITED cooldown', () => {
  const ids = [];

  function account() {
    const created = addAccountByKey(
      `devin-session-token$model-scope-${Math.random().toString(36).slice(2)}`,
      'model-scope-test',
    );
    ids.push(created.id);
    return created;
  }

  afterEach(() => {
    for (const id of ids.splice(0)) removeAccount(id);
  });

  it('cools only the selector that was throttled', () => {
    const created = account();
    const live = getAccountInternal(created.id);
    finalizeConnectAccount(live, {
      model: 'gpt-5.5',
      selector: 'gpt-5-5-sol',
      startTime: Date.now(),
      err: { code: 'RATE_LIMITED', resetMs: RESET_MS, message: 'message rate limit; Resets in: 3h0m0s' },
    });

    const after = getAccountInternal(created.id);
    assert.equal(__isRateLimitedForModel(after, 'gpt-5-5-sol'), true, 'the throttled selector is cooled');
    assert.equal(__isRateLimitedForModel(after, 'claude-opus-4-8-high'), false, 'another model stays eligible');
    assert.ok(!(after.rateLimitedUntil > Date.now()), 'the account-wide dimension must stay clear');

    const throttled = getAccountAvailability(after.apiKey, 'gpt-5-5-sol');
    assert.equal(throttled.available, false);
    assert.equal(throttled.reason, 'model_rate_limited');
    assert.ok(throttled.retryAfterMs > 0);

    const other = getAccountAvailability(after.apiKey, 'claude-opus-4-8-high');
    assert.equal(other.available, true, 'the account still serves other models');
  });

  it('falls back to the client model name when no selector was resolved', () => {
    const created = account();
    const live = getAccountInternal(created.id);
    finalizeConnectAccount(live, {
      model: 'gpt-5.5',
      startTime: Date.now(),
      err: { code: 'RATE_LIMITED', resetMs: RESET_MS, message: 'message rate limit' },
    });

    const after = getAccountInternal(created.id);
    assert.equal(__isRateLimitedForModel(after, 'gpt-5.5'), true);
    assert.equal(__isRateLimitedForModel(after, 'gpt-5.5-high'), false);
    assert.ok(!(after.rateLimitedUntil > Date.now()));
  });
});
