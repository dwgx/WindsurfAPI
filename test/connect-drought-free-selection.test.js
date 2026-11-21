// B1 — drought free-selection: the FREE-ONLY admission reason must survive to the
// account that actually executes.
//
// The drought gate (isConnectSelectorBlockedByDrought) admits a request when the
// SELECTOR is free on at least one pooled account, i.e. the deployment as a whole
// can run it without debiting quota. That is a statement about ONE account, but
// the gate is pool-wide, so the scheduler could hand the request to a different
// account that bills HIGH for the same selector — the exact quota burn the gate
// exists to prevent.
//
// Positive case (derived from the reported repro): A is MODEL_COST_TIER_FREE with
// an active promo, B is MODEL_COST_TIER_HIGH, A already carries one in-flight
// request so the idle account sorts first. The request must execute on A: status
// 200, the adapter must see A's session token, and B must be invoked ZERO times.
// `selectedPaid=false` alone is not evidence — an account can be "selected" and
// never called.
//
// Preservation cases pin the surrounding contract: operator blocklist still
// wins, an all-HIGH pool is still blocked with no upstream call, a free account
// that is not admissible right now never falls through to the paid peer, the
// ordinary paid path outside a drought still routes to the paid account, the
// DROUGHT_SAFE_SELECTORS still bypass the free-only constraint, and missing
// pricing still fails closed.
//
// Offline only: fake adapter (__setConnectDeps), synthetic accounts, no real
// upstream. Priced rows are injected per account (mergeCloudModels accountId), so
// "free" is per-account evidence rather than a pool-wide assumption.
//
// STICKY_SESSION_ENABLED is read into a module-load const by sticky-session.js, so
// it must be set before the first product import. node:test gives each file its
// own process; the dynamic imports below are what make the sticky cases possible.

process.env.STICKY_SESSION_ENABLED = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  __setModelCatalogDeps, __resetModelCatalogState, __waitForModelCatalogSync,
  addAccountByKey, getAccountInternal, removeAccount,
  getConnectSelectorPricing, isConnectSelectorBlockedByDrought,
  isConnectFreeOnlyDroughtAdmission, getDroughtSummary,
} = await import('../src/auth.js');
const { MODELS, mergeCloudModels, clearCloudModelCatalogs } = await import('../src/models.js');
const { clearLiveCatalogSelectors } = await import('../src/devin-connect-models.js');
const { handleChatCompletions, __setConnectDeps, __resetConnectDeps } = await import('../src/handlers/chat.js');
const { __setStreamChatForTest } = await import('../src/devin-connect-openai.js');
const sticky = await import('../src/account/sticky-session.js');

const ids = [];
const selector = 'swe-2-medium';
const end = new Date(Date.now() + 86_400_000).toISOString();
const config = (free) => ({
  modelUid: selector,
  provider: 'MODEL_PROVIDER_WINDSURF',
  modelCostTier: free ? 'MODEL_COST_TIER_FREE' : 'MODEL_COST_TIER_HIGH',
  promoStatus: { isActive: free, endDate: end },
  creditMultiplier: 6,
});
const originalEnv = { ...process.env };

// A realistic full catalog snapshot per account: the quarantined one-row fixture
// shape is not what a synced deployment holds, and the pool-wide pricing answer
// depends on the selector row being the only priced one.
function priceSnapshot(acct, row) {
  const uids = [...new Set(Object.values(MODELS).map((m) => m.modelUid).filter(Boolean))];
  mergeCloudModels([
    ...uids.filter((x) => x !== selector).map((modelUid) => ({ modelUid })),
    row,
  ], { accountId: acct.id });
}

function seed(label, weeklyPercent = 1) {
  const a = addAccountByKey(`offline-b1-${label}`, `${label}@example.invalid`);
  ids.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = 'pro';
  acct.credits = { weeklyPercent, dailyPercent: weeklyPercent, rateTable: { [selector]: 6 } };
  return acct;
}

function success() {
  return {
    status: 200,
    body: {
      id: 'offline-b1',
      model: selector,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  };
}

// Records every adapter invocation by the session token it was handed. The token
// is the only observable that says WHICH account executed — a "selected" account
// that the adapter never sees is not evidence of anything.
function recordingAdapter(calls = []) {
  return {
    calls,
    toChatCompletion: async (params) => {
      calls.push(params.token ?? null);
      return success();
    },
  };
}

async function chat(model = selector, callerKey = 'b1-caller', tag = 'b1') {
  return handleChatCompletions(
    { model, messages: [{ role: 'user', content: `offline B1 ${tag}` }], stream: false },
    { callerKey },
  );
}

const STICKY_CALLER = 'api:0123456789abcdef0123456789abcdef:user:offline-b1';

beforeEach(() => {
  sticky.resetAllBindings();
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
  sticky.resetAllBindings();
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

describe('connect drought free-only admission stays on the free account', () => {
  it('executes the free account when only it is free for the selector', async () => {
    const free = seed('free-A');
    const paid = seed('paid-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));
    // The reported precondition: the free account is already serving one request,
    // so the idle paid account sorts first on in-flight count.
    free._inflight = 1;
    free._inflightAt = Date.now();

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    assert.equal(getDroughtSummary().drought, true);
    assert.equal(getConnectSelectorPricing(selector).freeNow, true);
    assert.equal(isConnectSelectorBlockedByDrought(selector), false);

    const result = await chat(selector, 'b1-caller', 'positive');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [free.apiKey],
      'the adapter must be handed the FREE account token — the paid account must not execute');
    assert.equal(adapter.calls.filter((t) => t === paid.apiKey).length, 0,
      'the HIGH-tier account must be invoked zero times for a free-only admission');
  });

  it('preserves the operator blocklist: blocked paid peer → free account', async () => {
    const free = seed('control-A');
    const paid = seed('control-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));
    paid.blockedModels = [selector];

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    const result = await chat(selector, 'b1-caller', 'blocklist');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [free.apiKey]);
  });

  it('still blocks an all-paid pool at the gate with zero adapter calls', async () => {
    const a = seed('allpaid-A');
    const b = seed('allpaid-B');
    await __waitForModelCatalogSync();
    priceSnapshot(a, config(false));
    priceSnapshot(b, config(false));

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    assert.equal(getConnectSelectorPricing(selector).freeNow, false);
    assert.equal(isConnectSelectorBlockedByDrought(selector), true);
    const result = await chat(selector, 'b1-caller', 'allpaid');
    assert.equal(result.status, 503);
    assert.equal(result.body?.error?.type, 'drought_mode');
    assert.equal(adapter.calls.length, 0);
  });

  it('does not fall through to the paid peer when the free account is not admissible', async () => {
    const free = seed('unavail-A');
    const paid = seed('unavail-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));
    // A is free but the upstream already refused THIS selector for it; the latch
    // makes it unselectable without changing its pricing.
    free._selectorIneligible = { [selector]: Date.now() + 30 * 60 * 1000 };

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    assert.equal(getConnectSelectorPricing(selector).freeNow, true);
    assert.equal(isConnectSelectorBlockedByDrought(selector), false);
    const result = await chat(selector, 'b1-caller', 'unavail');
    // Existing pool-exhausted contract: the connect preflight answers 429 without
    // spending the 30s queue wait, and without routing the request to the paid peer.
    assert.equal(result.status, 429);
    assert.equal(result.body?.error?.type, 'rate_limit_exceeded');
    assert.equal(adapter.calls.filter((t) => t === paid.apiKey).length, 0,
      'a free-only admission must never be served by the paid account');
    assert.equal(adapter.calls.length, 0);
  });

  it('keeps ordinary paid routing outside a drought', async () => {
    const free = seed('paid-A', 100);
    const paid = seed('paid-B', 100);
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));
    // No drought: the free-only constraint must not exist at all.
    free._inflight = 1;
    free._inflightAt = Date.now();

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    assert.equal(getDroughtSummary().drought, false);
    const result = await chat(selector, 'b1-caller', 'paidpath');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [paid.apiKey],
      'outside a drought the scheduler keeps routing to the least-busy paid account');
  });

  it('leaves DROUGHT_SAFE_SELECTORS routing unchanged', async () => {
    for (const safe of ['swe-1-7', 'swe-1-7-medium', 'glm-5-2']) {
      const free = seed(`safe-A-${safe}`);
      const paid = seed(`safe-B-${safe}`);
      await __waitForModelCatalogSync();
      priceSnapshot(free, { ...config(true), modelUid: safe });
      priceSnapshot(paid, { ...config(false), modelUid: safe });
      free._inflight = 1;
      free._inflightAt = Date.now();

      const adapter = recordingAdapter();
      __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

      assert.equal(isConnectSelectorBlockedByDrought(safe), false, `${safe} is drought-safe`);
      const result = await chat(safe, 'b1-caller', `safe-${safe}`);
      assert.equal(result.status, 200, `${safe} must keep serving`);
      assert.deepEqual(adapter.calls, [paid.apiKey],
        `${safe} is weekly-quota-exempt, so the free-only constraint must not be applied`);
      while (ids.length) removeAccount(ids.pop());
    }
  });

  it('fails closed when the selector has no live pricing anywhere', async () => {
    seed('nodata-A');
    seed('nodata-B');
    // Deliberately NO priceSnapshot: no account says this selector is free. The
    // static FREE_REACHABLE floor must not be widened to swe-2-medium.
    await __waitForModelCatalogSync();

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    assert.equal(getConnectSelectorPricing(selector).freeNow, false);
    assert.equal(isConnectSelectorBlockedByDrought(selector), true);
    const result = await chat(selector, 'b1-caller', 'nodata');
    assert.equal(result.status, 503);
    assert.equal(adapter.calls.length, 0);
  });

  it('does not route to the paid peer after the free promotion ends', async () => {
    const free = seed('flip-A');
    const paid = seed('flip-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    const first = await chat(selector, 'b1-caller', 'flip-first');
    assert.equal(first.status, 200);
    assert.deepEqual(adapter.calls, [free.apiKey]);

    // Price refresh: the promotion is over for the only free account. The gate
    // must re-read that fact and block, not silently fall through to B.
    priceSnapshot(free, config(false));
    assert.equal(getConnectSelectorPricing(selector).freeNow, false);
    const second = await chat(selector, 'b1-caller', 'flip-second');
    assert.equal(second.status, 503);
    assert.equal(adapter.calls.filter((t) => t === paid.apiKey).length, 0);
    assert.deepEqual(adapter.calls, [free.apiKey], 'no new adapter call after the promotion ended');
  });

  it('honors a sticky pin that is still free for the selector', async () => {
    const free = seed('sticky-A');
    const paid = seed('sticky-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));
    sticky.setStickyBinding(STICKY_CALLER, null, free.id, free.apiKey, selector);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    const result = await chat(selector, STICKY_CALLER, 'sticky-free');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [free.apiKey],
      'the prompt-cache pin is kept when — and only when — it still satisfies the free-only admission');
    assert.equal(sticky.getStickyBinding(STICKY_CALLER, null, selector)?.accountId, free.id);
  });

  it('discards a sticky pin to the paid account for a free-only admission', async () => {
    const free = seed('sticky-paid-A');
    const paid = seed('sticky-paid-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));
    // The caller's cache affinity points at the HIGH-tier account: keeping it would
    // drill exactly the quota hole this repair closes, so the pin must lose to the
    // free-only admission and be cleared, not retried every turn.
    sticky.setStickyBinding(STICKY_CALLER, null, paid.id, paid.apiKey, selector);

    const adapter = recordingAdapter();
    __setConnectDeps({ toChatCompletion: adapter.toChatCompletion });

    const result = await chat(selector, STICKY_CALLER, 'sticky-paid');
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.calls, [free.apiKey]);
    assert.equal(adapter.calls.filter((t) => t === paid.apiKey).length, 0);
    assert.equal(sticky.getStickyBinding(STICKY_CALLER, null, selector)?.accountId, free.id,
      'the success path re-pins to the account that actually served');
  });
});

// ── Retry cost class ────────────────────────────────────────────────────────
// The drought gate decides ONCE, at request entry, whether the request is a
// free-only admission (`isConnectFreeOnlyDroughtAdmission`). That reason is
// threaded through the initial acquire, the queue/pin wait and every failover
// hop, so a pool measurement arriving WHILE the first attempt is in flight must
// not silently re-price the retry:
//   - a free-only request that hits an account dry-well keeps that cost limit,
//     even if the drought lifted mid-attempt (the paid peer must stay unused);
//   - a pre-output streaming failover is the same decision on the same wire;
//   - an INDEPENDENT request started after the change is admitted afresh, so the
//     ordinary paid route is legal again once the pool is no longer in drought.
// All adapters are fake and record the account CLASS actually dispatched to.

function rateLimited(resetMs = 42_000) {
  return Object.assign(
    new Error('Reached message rate limit for this model. Please try again later.'),
    { code: 'RATE_LIMITED', resetMs },
  );
}

// The pool's last measured quota recovers: the weekly percentage is what
// isDroughtMode() reads, so this flips the gate to "wet" for every caller that
// enters the handler AFTER this point.
function setPoolWet(...accounts) {
  for (const acct of accounts) {
    acct.credits.weeklyPercent = 60;
    acct.credits.dailyPercent = 60;
  }
}

function accountClass(free, paid, token) {
  if (token === free.apiKey) return 'free';
  if (token === paid.apiKey) return 'paid';
  return 'unmatched';
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '', writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; for (const cb of listeners.get('close') || []) cb(); },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
  };
}

function parseFrames(raw) {
  return raw.split('\n\n').filter(Boolean).filter(f => !f.startsWith(':')).map(f => {
    const d = f.split('\n').find(l => l.startsWith('data: '))?.slice(6) || '';
    return d === '[DONE]' ? '[DONE]' : JSON.parse(d);
  });
}

describe('connect drought free-only admission survives request retries', () => {
  it('keeps the retry on the free admission after the drought lifts mid-attempt', async () => {
    const free = seed('retry-A');
    const paid = seed('retry-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));

    const calls = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        calls.push(accountClass(free, paid, params.token));
        if (params.token === free.apiKey) {
          // The quota snapshot recovers while THIS attempt is on the wire.
          setPoolWet(free, paid);
          throw rateLimited();
        }
        return success();
      },
    });

    assert.equal(getDroughtSummary().drought, true, 'precondition: the request enters during a drought');
    assert.equal(isConnectFreeOnlyDroughtAdmission(selector), true);

    const result = await chat(selector, 'retry-caller', 'retry');
    assert.equal(getDroughtSummary().drought, false, 'precondition: the pool became wet during the attempt');
    assert.equal(result.status, 429);
    assert.equal(result.body?.error?.type, 'rate_limit_error');
    assert.equal(result.body?.error?.code, 'RATE_LIMITED');
    assert.deepEqual(calls, ['free'],
      'the retry hop keeps the admission cost limit: the paid peer must not execute even though a fresh request would be allowed to');

    // Independent request AFTER the change: the gate and the admission reason
    // are re-derived from the now-wet pool, so the ordinary paid route is legal
    // again. Evidence is the account the fake adapter was actually handed.
    assert.equal(isConnectFreeOnlyDroughtAdmission(selector), false);
    assert.equal(getConnectSelectorPricing(selector).freeNow, true,
      'the free pricing row is still live — the fresh request is ordinary routing, not a forced paid fallback');
    const fresh = await chat(selector, 'retry-caller-fresh', 'after-change');
    assert.equal(fresh.status, 200);
    assert.deepEqual(calls, ['free', 'paid'],
      'a new request admitted after the change legitimately executes the paid account');
  });

  it('does not fail a free-only stream over to the paid peer when the drought lifts mid-attempt', async () => {
    const free = seed('stream-retry-A');
    const paid = seed('stream-retry-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));

    const calls = [];
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        calls.push(accountClass(free, paid, params.token));
        if (params.token === free.apiKey) {
          setPoolWet(free, paid);
          throw rateLimited();
        }
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      },
    });

    assert.equal(getDroughtSummary().drought, true);
    assert.equal(isConnectFreeOnlyDroughtAdmission(selector), true);
    const result = await handleChatCompletions(
      { model: selector, stream: true, messages: [{ role: 'user', content: 'offline stream retry' }] },
      { callerKey: 'b1-stream-retry' },
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(getDroughtSummary().drought, false, 'precondition: the pool became wet during the attempt');
    assert.equal(result.status, 200, 'the SSE response was committed before the upstream attempt');
    assert.equal(res.writableEnded, true);
    assert.deepEqual(calls, ['free'], 'the pre-output failover hop must stay on the free admission');
    const frames = parseFrames(res.body);
    const err = frames.find(f => f !== '[DONE]' && f.error);
    assert.equal(err?.error?.type, 'rate_limit_error');
    assert.equal(err?.error?.code, 'RATE_LIMITED');
    assert.equal(err?.error?.retry_after_ms, 42_000,
      'the upstream reset window rides the terminal frame');
    assert.equal(frames.includes('[DONE]'), false, 'a pre-content error is not a completed turn');
  });

  it('surfaces a post-content stream error without replaying on the paid peer', async () => {
    const free = seed('stream-mid-A');
    const paid = seed('stream-mid-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));

    const calls = [];
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        calls.push(accountClass(free, paid, params.token));
        // One real chunk is on the wire, THEN the account hits its limit.
        // A failover would duplicate content, so the terminal must be the
        // error frame on this same 200 SSE response — never a second account.
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] });
        throw rateLimited();
      },
    });

    assert.equal(getDroughtSummary().drought, true);
    const result = await handleChatCompletions(
      { model: selector, stream: true, messages: [{ role: 'user', content: 'offline stream mid error' }] },
      { callerKey: 'b1-stream-mid' },
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(result.status, 200);
    assert.equal(res.writableEnded, true);
    assert.deepEqual(calls, ['free'], 'no replay after a byte is on the wire');
    const frames = parseFrames(res.body);
    const partials = frames.filter(f => f !== '[DONE]' && f.choices?.[0]?.delta?.content === 'partial');
    assert.equal(partials.length, 1, 'the delivered partial must not be replayed');
    const err = frames.find(f => f !== '[DONE]' && f.error);
    assert.equal(err?.error?.type, 'rate_limit_error');
    assert.equal(err?.error?.retry_after_ms, 42_000);
    assert.equal(frames.includes('[DONE]'), true,
      'content already on the wire keeps the historical clean close');
  });

  it('releases the free lease on cancel and never spends the paid peer', async () => {
    const free = seed('cancel-A');
    const paid = seed('cancel-B');
    await __waitForModelCatalogSync();
    priceSnapshot(free, config(true));
    priceSnapshot(paid, config(false));

    const controller = new AbortController();
    const calls = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        calls.push(accountClass(free, paid, params.token));
        // The caller cancels while this account owns the in-flight slot.
        controller.abort();
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      },
    });

    const result = await handleChatCompletions(
      { model: selector, messages: [{ role: 'user', content: 'offline cancel' }] },
      { callerKey: 'b1-cancel', signal: controller.signal },
    );
    assert.equal(result.status, 499);
    assert.equal(result.body?.error?.code, 'client_disconnect');
    assert.deepEqual(calls, ['free']);

    const released = getAccountInternal(free.id);
    assert.equal(released._inflight || 0, 0, 'the cancel must return the in-flight lease to the pool');
    assert.equal(released.errorCount || 0, 0, 'a client cancel is not an account fault');
    assert.equal(released.status, 'active');
    assert.equal(getAccountInternal(paid.id)._inflight || 0, 0);

    // The freed lease is reusable by the next request, and the free-only
    // admission still selects the free account rather than the paid peer.
    __setConnectDeps({
      toChatCompletion: async (params) => {
        calls.push(accountClass(free, paid, params.token));
        return success();
      },
    });
    const next = await chat(selector, 'b1-cancel-next', 'after-cancel');
    assert.equal(next.status, 200);
    assert.deepEqual(calls, ['free', 'free'], 'the released account is immediately selectable again');
  });
});
