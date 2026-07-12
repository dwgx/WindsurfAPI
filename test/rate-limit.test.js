import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  getAccountList,
  getApiKey,
  getRpmStats,
  markRateLimited,
  releaseAccount,
  removeAccount,
  setAccountTier,
} from '../src/auth.js';
import { handleChatCompletions, rateLimitBurstCooldownMs, rateLimitCooldownMs, clientRetryAfterSeconds } from '../src/handlers/chat.js';
import { getExperimental, setExperimental, setBreakerTunables } from '../src/runtime-config.js';

const createdAccountIds = [];
const originalExperimental = getExperimental();

function addTestAccount(label = 'test-account') {
  const account = addAccountByKey(`test-key-${Date.now()}-${Math.random().toString(36).slice(2)}`, label);
  createdAccountIds.push(account.id);
  return account;
}

afterEach(() => {
  setExperimental(originalExperimental);
  while (createdAccountIds.length) {
    removeAccount(createdAccountIds.pop());
  }
});

describe('rate-limit handling', () => {
  it('does not poison local cooldowns when preflight has no retryAfter hint', async () => {
    const account = addTestAccount('preflight-no-hint');
    let checks = 0;
    setExperimental({ preflightRateLimit: true });

    const request = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const context = {
      async checkMessageRateLimit() {
        checks++;
        return { hasCapacity: false, messagesRemaining: 0, maxMessages: 1, retryAfterMs: null };
      },
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
    };

    const first = await handleChatCompletions(request, context);
    const second = await handleChatCompletions(request, context);
    const listed = getAccountList().find(a => a.id === account.id);

    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(checks, 2);
    assert.deepEqual(listed.modelRateLimits, {});
  });

  it('parses explicit retry-after seconds instead of defaulting to five minutes', () => {
    assert.equal(rateLimitCooldownMs('Please retry after 117 seconds'), 117000);
    assert.equal(rateLimitCooldownMs('quota hit'), 60000);
  });

  it('parses Cascade reset windows into real model cooldowns', () => {
    assert.equal(
      rateLimitCooldownMs('Reached message rate limit for this model. Please try again later. Resets in: 2h59m58s (trace ID: abc)'),
      (2 * 60 * 60 * 1000) + (59 * 60 * 1000) + (58 * 1000)
    );
    assert.equal(rateLimitCooldownMs('Resets in: 59s'), 59000);
    assert.equal(rateLimitCooldownMs('resets in 3h'), 3 * 60 * 60 * 1000);
  });

  it('keeps real upstream cooldowns for IP-level burst short-circuiting', () => {
    assert.equal(
      rateLimitBurstCooldownMs({
        message: 'Reached message rate limit for this model. Please try again later. Resets in: 27m12s (trace ID: abc)',
        retryAfterMs: 30000,
      }),
      (27 * 60 * 1000) + (12 * 1000)
    );
    assert.equal(rateLimitBurstCooldownMs({ message: 'rate limit exceeded' }), 30000);
  });

  it('uses real upstream cooldowns in the non-stream IP burst response', async () => {
    const accounts = [
      addTestAccount('ip-burst-a'),
      addTestAccount('ip-burst-b'),
      addTestAccount('ip-burst-c'),
    ];
    for (const account of accounts) setAccountTier(account.id, 'free');

    class RateLimitedClient {
      async cascadeChat() {
        throw new Error('Reached message rate limit for this model. Please try again later. Resets in: 27m12s (trace ID: abc)');
      }
      async rawGetChatMessage() {
        throw new Error('Reached message rate limit for this model. Please try again later. Resets in: 27m12s (trace ID: abc)');
      }
    }

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: `hi ${Date.now()}` }],
    }, {
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return getApiKey(tried, modelKey);
      },
      async ensureLs() {},
      getLsFor() {
        return { port: 12345, csrfToken: 'csrf-test' };
      },
      WindsurfClient: RateLimitedClient,
    });

    assert.equal(result.status, 429);
    assert.equal(result.body.error.type, 'rate_limit_exceeded');
    assert.equal(result.body.error.retry_after_ms, (27 * 60 * 1000) + (12 * 1000));
    assert.equal(result.headers['Retry-After'], '1632');
    assert.match(result.body.error.message, /27m12s/);
  });

  it('does not extend an existing cooldown when a later 429 arrives for the same model', async () => {
    const account = addTestAccount('max-extend');
    const modelKey = 'gemini-2.5-flash';

    markRateLimited(account.apiKey, 2000, modelKey);
    const firstUntil = getAccountList().find(a => a.id === account.id).modelRateLimits[modelKey];
    await new Promise(resolve => setTimeout(resolve, 250));
    markRateLimited(account.apiKey, 1750, modelKey);
    const secondUntil = getAccountList().find(a => a.id === account.id).modelRateLimits[modelKey];

    assert.ok(secondUntil >= firstUntil);
    assert.ok(secondUntil - firstUntil < 120, `expected max-extend semantics, got delta ${secondUntil - firstUntil}ms`);
  });

  it('surfaces real model cooldown expiries in account list state', () => {
    const account = addTestAccount('real-expiry');
    const modelKey = 'gemini-2.5-flash';
    const now = Date.now();

    markRateLimited(account.apiKey, 1200, modelKey);
    const until = getAccountList().find(a => a.id === account.id).modelRateLimits[modelKey];

    assert.ok(until >= now + 1000, `expected near-real expiry, got ${until - now}ms`);
    assert.ok(until <= now + 2500, `expected short cooldown, got ${until - now}ms`);
  });

  it('returns 429 when every eligible account is locally RPM-exhausted', async () => {
    const account = addTestAccount('rpm-full');
    setAccountTier(account.id, 'free');

    for (let i = 0; i < 10; i++) {
      const checkedOut = getApiKey([], 'gemini-2.5-flash');
      assert.equal(checkedOut?.apiKey, account.apiKey);
      releaseAccount(account.apiKey);
    }

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async waitForAccount() {
        return null;
      },
    });

    assert.equal(result.status, 429);
    assert.equal(result.body.error.type, 'rate_limit_exceeded');
    assert.match(result.headers['Retry-After'], /^\d+$/);
  });

  it('refunds RPM reservations when preflight skips the upstream request', async () => {
    const account = addTestAccount('refund-preflight');
    setExperimental({ preflightRateLimit: true });

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async checkMessageRateLimit() {
        return { hasCapacity: false, messagesRemaining: 0, maxMessages: 1, retryAfterMs: null };
      },
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
    });

    assert.equal(result.status, 503);
    assert.equal(getRpmStats()[account.id].used, 0);
  });
});

// F3 (2026-07-10): client-replay mitigation — clamp the Retry-After we advertise
// to an agent client's auto-retry into [floor, ceil]. Uses runtime-config
// overrides (not env) so the tests are hermetic and self-clean via afterEach.
describe('F3 — clientRetryAfterSeconds (client-replay backoff clamp)', () => {
  afterEach(() => {
    // clear both overrides back to null (env/default fallback)
    setBreakerTunables({ rlClientBackoffFloorMs: null, rlClientBackoffCeilMs: null });
  });

  it('floor=0 (opt-out) is byte-identical to plain ceil(ms/1000) — no floor applied', () => {
    // The default floor is now 30000 (429 mitigation on); set 0 to disable it and
    // get the original no-floor behaviour. ceil=600000 → only clamps absurd values.
    setBreakerTunables({ rlClientBackoffFloorMs: 0 });
    assert.equal(clientRetryAfterSeconds(1000), 1, '1s hint stays 1s when floor disabled');
    assert.equal(clientRetryAfterSeconds(4500), 5, 'rounds up to whole seconds (ceil)');
    assert.equal(clientRetryAfterSeconds(0), 1, 'zero floored to the 1s header minimum');
  });

  it('floor raises a too-short hint so the client actually backs off', () => {
    setBreakerTunables({ rlClientBackoffFloorMs: 30000 });
    assert.equal(clientRetryAfterSeconds(1000), 30, '1s residual cooldown lifted to the 30s floor');
    assert.equal(clientRetryAfterSeconds(45000), 45, 'a hint already above the floor is untouched');
  });

  it('ceil clamps an over-long upstream window so the client is not frozen', () => {
    setBreakerTunables({ rlClientBackoffCeilMs: 600000 });
    assert.equal(clientRetryAfterSeconds(3 * 60 * 60 * 1000), 600, '3h window clamped to the 10min ceil');
    assert.equal(clientRetryAfterSeconds(120000), 120, 'a 2min window under the ceil is untouched');
  });

  it('floor and ceil compose; non-finite/negative input is treated as zero', () => {
    setBreakerTunables({ rlClientBackoffFloorMs: 30000, rlClientBackoffCeilMs: 600000 });
    assert.equal(clientRetryAfterSeconds(NaN), 30, 'NaN → 0 → lifted to floor');
    assert.equal(clientRetryAfterSeconds(-5000), 30, 'negative → 0 → lifted to floor');
    assert.equal(clientRetryAfterSeconds(9_999_999), 600, 'huge value clamped to ceil');
  });
});
