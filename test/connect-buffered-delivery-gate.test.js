// P2 — the DEVIN_CONNECT buffered (non-stream) success arm has no post-await
// delivery check. `attempt()` resolves `{ kind: 'ok' }` when the upstream turn
// completed — even when the caller aborted while the adapter call was pending
// and the transport settled the success instead of throwing AbortError. The ok
// arm then binds prompt-cache affinity, commits the session-continuity pair and
// stores the response cache — all for a turn the client never received — and
// answers 200 to a gone socket.
//
// The streaming arm rechecks `abortController.signal.aborted` before exactly
// these writes (test/connect-success-delivery-gate.test.js pins that contract).
// This suite pins the same contract for the buffered arm:
//
//   control:  a delivered buffered turn commits, caches and binds — once;
//   gate:     a late success after the caller aborted reaches the existing
//             client-closed outcome with ZERO delivery writes;
//   accounting: the upstream turn really ran — usage attribution stays.
//
// Account-side finalization (finalizeConnectAccount) runs inside attempt() in
// every branch and is NOT part of the gate — same rule as the stream arm.

process.env.DEVIN_CONNECT = '1';
process.env.STICKY_SESSION_ENABLED = '1';
process.env.DEVIN_CONNECT_SESSION_REUSE = '1';
process.env.RESPONSE_CACHE_ENABLED = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { handleChatCompletions, __setConnectDeps, __resetConnectDeps } =
  await import('../src/handlers/chat.js');
const auth = await import('../src/auth.js');
const cache = await import('../src/cache.js');
const sticky = await import('../src/account/sticky-session.js');
const continuity = await import('../src/session-continuity.js');
const stats = await import('../src/dashboard/stats.js');

const CALLER = 'session:connect-buffered-gate';
const MODEL = 'swe-1-6-slow';
const created = [];

function seedAccount(label) {
  const a = auth.addAccountByKey(
    `devin-session-token$dg-buffered-${label}-${Math.random().toString(36).slice(2)}`, label,
  );
  created.push(a.id);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

function bufferedBody() {
  return {
    model: MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'deliver this buffered turn' }],
  };
}

// Ordinary buffered adapter success. `usage` rides the body so the accounting
// control can observe that the completed upstream work is still attributed.
function okBody(content = 'the answer') {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-buffered',
      object: 'chat.completion',
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  };
}

beforeEach(() => {
  __resetConnectDeps();
  cache.cacheClear();
  sticky.resetAllBindings();
  continuity._resetForTests();
  stats.resetStats();
});

afterEach(() => {
  __resetConnectDeps();
  while (created.length) {
    try { auth.removeAccount(created.pop()); } catch {}
  }
});

describe('DEVIN_CONNECT buffered success writes only for a delivered turn', () => {
  it('control: a delivered buffered turn commits the pair, caches and binds — once', async () => {
    seedAccount('control');
    __setConnectDeps({
      toChatCompletion: async () => okBody('delivered answer'),
    });

    const result = await handleChatCompletions(bufferedBody(), { callerKey: CALLER });
    assert.equal(result.status, 200, JSON.stringify(result?.body));
    assert.equal(result.body.choices[0].message.content, 'delivered answer');

    assert.equal(continuity._getIndexStats().commitKeys, 1,
      'control: a delivered turn must commit its session-continuity pair exactly once');
    assert.equal(cache.cacheStats().stores, 1,
      'control: a delivered turn must populate the response cache exactly once');
    assert.ok(sticky.getStickyStats().size >= 1,
      'control: a delivered turn must bind prompt-cache affinity');
  });

  it('a late success after the caller aborted reaches client-closed with zero delivery writes', async () => {
    seedAccount('gate');
    const controller = new AbortController();
    __setConnectDeps({
      toChatCompletion: async () => {
        // The route signal fires while the handler is suspended awaiting the
        // adapter; the transport settles the success anyway (deferred stub).
        controller.abort();
        return okBody('answer nobody received');
      },
    });

    const result = await handleChatCompletions(bufferedBody(), {
      callerKey: CALLER,
      signal: controller.signal,
    });

    assert.equal(result.status, 499,
      'a canceled late success must surface the existing client_disconnect outcome, not a 200');
    assert.equal(result.body?.error?.code, 'client_disconnect');
    assert.equal(result.body?.error?.type, 'client_disconnect');

    assert.equal(continuity._getIndexStats().commitKeys, 0,
      'an undelivered turn must not commit the pair-chain — the next turn would assume the answer was delivered');
    assert.equal(cache.cacheStats().stores, 0,
      'an undelivered turn must not seed the response cache');
    assert.equal(sticky.getStickyStats().size, 0,
      'an undelivered turn must not move prompt-cache affinity to the account');
  });

  it('the canceled turn still attributes the upstream usage it really consumed', async () => {
    seedAccount('accounting');
    const controller = new AbortController();
    __setConnectDeps({
      toChatCompletion: async () => {
        controller.abort();
        return okBody('answer nobody received');
      },
    });

    const result = await handleChatCompletions(bufferedBody(), {
      callerKey: CALLER,
      signal: controller.signal,
    });
    assert.equal(result.status, 499);

    const tokens = stats.getStats().tokensByModel[MODEL];
    assert.ok(tokens, 'the completed upstream turn must still be attributed to its model');
    assert.equal(tokens.total, 8,
      'usage accounting is delivery-independent: the upstream turn cost quota regardless of the abort');
  });
});
