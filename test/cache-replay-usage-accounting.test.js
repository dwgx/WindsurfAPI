// D4 / V-27 — a cache-served Connect turn must not be booked as upstream
// consumption.
//
// MEASURED on the audited baseline (evidence/audit/FIX-QUEUE.md row 27, plus the
// source-confirmed replay calls at chat.js:4519-4522 and :4913-4916): both
// Connect cache-replay arms called recordTokenUsage() with the cached usage and
// recordRequest() as a successful turn. No upstream request ran, yet every hit
// re-added the whole prompt+completion token block to the dashboard ledger and
// charged the model's credit cost again. A client that retried the same request
// N times reported N upstream turns.
//
// The contract pinned here:
//   * a cache HIT adds ZERO upstream usage and ZERO credits, and leaves the
//     per-account spend untouched — the client still receives the cached usage
//     block, which is its answer's metadata, not a second upstream turn;
//   * the hit is still counted as served traffic, and its row says
//     `cacheServed: true` so the two cannot be confused;
//   * the forced-miss control (same body, different caller scope) bills exactly
//     one upstream turn.
//
// Both Connect arms are covered: stream and non-stream share one cache slot.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleChatCompletions,
  __resetConnectDeps,
  __setConnectDeps,
} from '../src/handlers/chat.js';
import { addAccountByKey, getAccountInternal, removeAccount } from '../src/auth.js';
import { cacheClear, cacheStats } from '../src/cache.js';
import { getRequestLog, getStats, recordRequest, resetStats } from '../src/dashboard/stats.js';

const CALLER = 'api:d4:user:u1';
const OTHER_CALLER = 'api:d4:user:u2';
// A mapped connect selector that carries a non-zero credit card (4), so a
// duplicated charge is visible in the ledger instead of hiding in a free tier.
const MODEL = 'claude-sonnet-4-6';
const USAGE = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };

const created = [];
let savedDevinConnect = null;

function seedAccount(label) {
  const a = addAccountByKey(`v27-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  const acct = getAccountInternal(a.id);
  if (acct) {
    acct.tier = 'pro';
    acct.status = 'active';
  }
  return a;
}

function body(extra = {}) {
  return {
    model: MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'what is the capital of France?' }],
    ...extra,
  };
}

function completionDeps(text) {
  let calls = 0;
  const deps = {
    toChatCompletion: async () => {
      calls++;
      return {
        status: 200,
        body: {
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { ...USAGE },
        },
      };
    },
    streamChatCompletion: async (_params, send, meta) => {
      calls++;
      const base = { id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.displayModel };
      await send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      await send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      await send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return { content: text, delivered: text, reasoning: '', finish_reason: 'stop', usage: { ...USAGE }, toolCalls: [], stop: null };
    },
  };
  return { deps, upstreamCalls: () => calls };
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
    once(event, cb) { this.on(event, cb); return this; },
    removeListener() {},
    writeHead() { return this; },
  };
}

/** Upstream-consumption ledger: what a completed upstream turn costs. */
function upstreamLedger() {
  const s = getStats();
  return {
    tokens: s.tokenTotals.total,
    fresh: s.tokenTotals.fresh_input,
    output: s.tokenTotals.output,
    usageRequests: s.tokenTotals.requests_with_usage,
    credits: s.creditsTotal,
    requests: s.totalRequests,
  };
}

function accountSpend(id) {
  return getAccountInternal(id)?._totalSpend?.requests || 0;
}

beforeEach(() => {
  savedDevinConnect = process.env.DEVIN_CONNECT;
  process.env.DEVIN_CONNECT = '1';
  cacheClear();
  resetStats();
});

afterEach(() => {
  __resetConnectDeps();
  if (savedDevinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = savedDevinConnect;
  cacheClear();
  resetStats();
  while (created.length) {
    try { removeAccount(created.pop()); } catch {}
  }
});

describe('D4: a Connect cache hit is client traffic, not upstream consumption', () => {
  it('non-stream: the hit adds no tokens, no credits and no account spend; a scoped miss adds exactly one turn', async () => {
    const acct = seedAccount('nonstream');
    const { deps, upstreamCalls } = completionDeps('Paris.');
    __setConnectDeps(deps);

    const miss = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(miss.status, 200);
    const afterMiss = upstreamLedger();
    assert.equal(afterMiss.tokens, USAGE.total_tokens, 'the real turn is billed once');
    assert.equal(afterMiss.credits, 4, 'the real turn charges the model credit card');
    assert.equal(accountSpend(acct.id), 1, 'the account really served one upstream turn');
    assert.equal(upstreamCalls(), 1);

    const hit = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(hit.status, 200);
    assert.equal(hit.body.choices[0].message.content, 'Paris.');
    assert.deepEqual(hit.body.usage.total_tokens, USAGE.total_tokens,
      'the client still receives its answer usage block');
    const afterHit = upstreamLedger();
    assert.equal(upstreamCalls(), 1, 'precondition: the second request was served from cache');
    assert.equal(cacheStats().hits, 1);
    assert.equal(afterHit.tokens, afterMiss.tokens, 'a cache hit consumes no upstream tokens');
    assert.equal(afterHit.usageRequests, afterMiss.usageRequests, 'a cache hit is not a usage-bearing upstream turn');
    assert.equal(afterHit.credits, afterMiss.credits, 'a cache hit charges no credits');
    assert.equal(accountSpend(acct.id), 1, 'a cache hit must not touch the per-account spend ledger');
    assert.equal(afterHit.requests, afterMiss.requests + 1, 'the hit is still counted as served traffic');
    const row = getStats().recentRequests.at(-1);
    assert.equal(row.cacheServed, true, 'the row says it was cache-served');
    assert.equal(row.credit, 0, 'the row charges nothing');
    assert.equal(row.tokensIn, 0, 'the row claims no upstream input tokens');
    assert.equal(getRequestLog().items[0].reportedUsage, null, 'replayed usage is not a new report');

    // Forced-miss control: same body, different caller scope → no shared slot.
    const scoped = await handleChatCompletions(body(), { callerKey: OTHER_CALLER });
    assert.equal(scoped.status, 200);
    const afterScoped = upstreamLedger();
    assert.equal(upstreamCalls(), 2, 'a different caller scope is a real upstream turn');
    assert.equal(afterScoped.tokens, afterMiss.tokens + USAGE.total_tokens, 'exactly one turn of usage');
    assert.equal(afterScoped.credits, afterMiss.credits + 4, 'exactly one turn of credits');
    assert.equal(accountSpend(acct.id), 2, 'exactly one more upstream turn on the account');
  });

  it('stream: the replay adds no tokens, no credits and no account spend', async () => {
    const acct = seedAccount('stream');
    const { deps, upstreamCalls } = completionDeps('Paris.');
    __setConnectDeps(deps);

    const first = await handleChatCompletions(body({ stream: true }), { callerKey: CALLER });
    assert.equal(first.stream, true);
    const res = fakeRes();
    await first.handler(res);
    assert.ok(res.body.includes('data: [DONE]'));
    const afterMiss = upstreamLedger();
    assert.equal(afterMiss.tokens, USAGE.total_tokens);
    assert.equal(afterMiss.credits, 4);
    assert.equal(accountSpend(acct.id), 1);
    assert.equal(upstreamCalls(), 1);

    const second = await handleChatCompletions(body({ stream: true }), { callerKey: CALLER });
    const res2 = fakeRes();
    await second.handler(res2);
    assert.ok(res2.body.includes('Paris.'), 'the cached answer is replayed');
    const afterHit = upstreamLedger();
    assert.equal(upstreamCalls(), 1, 'precondition: the replay did not call upstream');
    assert.equal(cacheStats().hits, 1);
    assert.equal(afterHit.tokens, afterMiss.tokens, 'a cache hit consumes no upstream tokens');
    assert.equal(afterHit.usageRequests, afterMiss.usageRequests);
    assert.equal(afterHit.credits, afterMiss.credits, 'a cache hit charges no credits');
    assert.equal(accountSpend(acct.id), 1, 'the replay must not touch the per-account spend ledger');
    assert.equal(afterHit.requests, afterMiss.requests + 1);
    assert.equal(getStats().recentRequests.at(-1).cacheServed, true);
    assert.equal(getRequestLog().items[0].reportedUsage, null, 'stream replay is not a new report');
  });
});

describe('D4: recordRequest separates a cache-served turn from an upstream one', () => {
  it('charges the credit card only for a turn that ran upstream', () => {
    resetStats();
    recordRequest(MODEL, true, 0, null);
    assert.equal(getStats().creditsTotal, 4, 'a normal successful turn is charged');
    recordRequest(MODEL, true, 0, null, { cacheServed: true });
    assert.equal(getStats().creditsTotal, 4, 'a cache-served turn adds nothing');
    assert.equal(getStats().totalRequests, 2, 'but it is still counted as served traffic');
    assert.equal(getStats().recentRequests.at(-1).cacheServed, true);
    assert.equal(getStats().recentRequests.at(-1).credit, 0);
  });
});
