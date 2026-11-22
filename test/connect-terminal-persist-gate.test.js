// B2 (Astra backend review) — "upstream billed us" and "the answer is reusable"
// are different verdicts. A Connect turn that ends finish_reason 'error' (or
// never names a terminal) still spends quota, but it must not be cached, must
// not pin the caller→account affinity, and must not commit into the session
// chain — a byte-identical retry has to reach the upstream again instead of
// replaying the failed half-answer.
//
// C1 — Cascade caches entries carry the real terminal: a turn capped at
// finish_reason 'length' must replay AS 'length', not as a fabricated 'stop'.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.STICKY_SESSION_ENABLED = '1';
process.env.DEVIN_CONNECT = '1';
process.env.RESPONSE_CACHE_ENABLED = '1';
process.env.DEVIN_CONNECT_FAILOVER_MAX = '0';

const sticky = await import('../src/account/sticky-session.js');
const { addAccountByKey, removeAccount, getAccountInternal, getApiKey,
  __setModelCatalogDeps, __waitForModelCatalogSync } = await import('../src/auth.js');
const { handleChatCompletions, __setConnectDeps, __resetConnectDeps } = await import('../src/handlers/chat.js');
const { __setStreamChatForTest } = await import('../src/devin-connect-openai.js');
const { cacheClear, cacheStats } = await import('../src/cache.js');

const caller = 'api:00112233445566778899aabbccddeeff:user:b2-fixture';
const selector = 'swe-2-medium';
const request = () => ({ model: selector, messages: [{ role: 'user', content: 'b2 gate' }] });

function fakeRes() {
  const listeners = new Map();
  return {
    body: '', writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb(); },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
    once(event, cb) { this.on(event, cb); return this; },
    removeListener() {}, setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}

function usage() {
  return { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
}

const created = [];
function seedConnectAccount() {
  const a = addAccountByKey(`devin-session-token$b2-${Math.random().toString(36).slice(2)}`, 'b2');
  created.push(a.id);
  return a;
}

let savedDevinConnect = null;
beforeEach(() => {
  savedDevinConnect = process.env.DEVIN_CONNECT;
  cacheClear();
  sticky.resetAllBindings();
  __setModelCatalogDeps({
    fetchConfig: async () => ({ configs: [] }),
    fetchConnectCatalog: async () => [{ selector }],
    scheduleCatalogRetry: () => () => {},
  });
});
afterEach(() => {
  __resetConnectDeps();
  __setStreamChatForTest(null);
  __setModelCatalogDeps(null);
  if (savedDevinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = savedDevinConnect;
  while (created.length) { try { removeAccount(created.pop()); } catch {} }
});

describe('B2: a failed Connect terminal is never persisted', () => {
  it('non-stream: finish_reason "error" is not cached and binds no affinity', async () => {
    const account = seedConnectAccount();
    await __waitForModelCatalogSync();
    const live = getAccountInternal(account.id);
    live.tier = 'pro'; live.credits = { weeklyPercent: 80, dailyPercent: 80 };
    let requests = 0;
    __setConnectDeps({
      async toChatCompletion() {
        requests++;
        return { status: 200, body: { model: selector,
          choices: [{ index: 0, message: { role: 'assistant', content: 'half an answer' }, finish_reason: 'error' }],
          usage: usage() } };
      },
      async streamChatCompletion() { throw new Error('stream stub unused'); },
    });
    const first = await handleChatCompletions(request(), { callerKey: caller });
    assert.equal(first.status, 200);
    assert.equal(first.body.choices[0].finish_reason, 'error', 'the caller still sees the failed terminal');
    const second = await handleChatCompletions(request(), { callerKey: caller });
    assert.equal(second.status, 200);
    assert.equal(requests, 2, 'an error turn must not be replayed from the response cache');
    assert.equal(sticky.peekStickyBinding(caller, null, selector), null,
      'an error turn must not pin caller→account affinity');
  });

  it('stream: finish_reason "error" is not cached and binds no affinity', async () => {
    const account = seedConnectAccount();
    await __waitForModelCatalogSync();
    const live = getAccountInternal(account.id);
    live.tier = 'pro'; live.credits = { weeklyPercent: 80, dailyPercent: 80 };
    let requests = 0;
    __setStreamChatForTest(async function* () {
      requests++;
      yield { type: 'content', text: 'half' };
      yield { type: 'finish', reason: 'error', usage: usage() };
    });
    for (let i = 0; i < 2; i++) {
      const r = await handleChatCompletions({ ...request(), stream: true }, { callerKey: caller });
      assert.equal(r.status, 200);
      const res = fakeRes();
      await r.handler(res);
      assert.match(res.body, /"finish_reason":"error"/, 'the stream surfaces the failed terminal');
    }
    assert.equal(requests, 2, 'an errored stream must not seed the response cache');
    assert.equal(sticky.peekStickyBinding(caller, null, selector), null,
      'an errored stream must not pin caller→account affinity');
  });

  it('control: finish_reason "stop" still caches and binds affinity', async () => {
    const account = seedConnectAccount();
    await __waitForModelCatalogSync();
    const live = getAccountInternal(account.id);
    live.tier = 'pro'; live.credits = { weeklyPercent: 80, dailyPercent: 80 };
    let requests = 0;
    __setConnectDeps({
      async toChatCompletion() {
        requests++;
        return { status: 200, body: { model: selector,
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: usage() } };
      },
      async streamChatCompletion() { throw new Error('stream stub unused'); },
    });
    await handleChatCompletions(request(), { callerKey: caller });
    await handleChatCompletions(request(), { callerKey: caller });
    assert.equal(requests, 1, 'a clean turn is still served from the response cache');
    assert.equal(sticky.peekStickyBinding(caller, null, selector)?.accountId, account.id,
      'a clean turn still pins affinity');
  });
});

describe('C1: Cascade caches and replays the real terminal', () => {
  const CASCADE_MODEL = 'gemini-2.5-flash';

  function cascadeDeps(text, onDispatch = () => {}) {
    class FakeClient {
      async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
        onDispatch();
        const chunks = opts.onChunk ? [] : [{ text, thinking: '', isError: false }];
        if (opts.onChunk) await opts.onChunk({ text, thinking: '', isError: false });
        chunks.toolCalls = [];
        chunks.totalYielded = text.length;
        chunks.totalThinking = 0;
        return chunks;
      }
    }
    return {
      waitForAccount(tried) { return tried.length === 0 ? getApiKey(tried) : null; },
      ensureLs: async () => {},
      getLsFor: () => ({ port: 17991, csrfToken: 'csrf', generation: 1 }),
      WindsurfClient: FakeClient,
      callerKey: caller,
    };
  }

  it('a length-capped answer replays as finish_reason "length", not "stop"', async () => {
    delete process.env.DEVIN_CONNECT;
    const account = seedConnectAccount();
    const body = { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'long answer' }], max_tokens: 1 };
    const deps = cascadeDeps('x'.repeat(4000));
    const first = await handleChatCompletions(body, deps);
    assert.equal(first.status, 200);
    assert.equal(first.body.choices[0].finish_reason, 'length',
      'the capped turn must report length on first delivery');
    const second = await handleChatCompletions(body, deps);
    assert.equal(second.status, 200);
    assert.equal(second.body.choices[0].finish_reason, 'length',
      'the replayed turn must carry the SAME terminal, not a fabricated stop');
  });

  it('a clean answer still replays as finish_reason "stop"', async () => {
    delete process.env.DEVIN_CONNECT;
    seedConnectAccount();
    const body = { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'short answer' }] };
    const deps = cascadeDeps('done');
    const first = await handleChatCompletions(body, deps);
    assert.equal(first.status, 200);
    assert.equal(first.body.choices[0].finish_reason, 'stop');
    const second = await handleChatCompletions(body, deps);
    assert.equal(second.body.choices[0].finish_reason, 'stop');
  });

  it('a streamed cache hit preserves text and length with one upstream dispatch', async () => {
    delete process.env.DEVIN_CONNECT;
    seedConnectAccount();
    const body = {
      model: CASCADE_MODEL,
      messages: [{ role: 'user', content: 'long streamed answer' }],
      max_tokens: 1,
      stream: true,
    };
    let dispatches = 0;
    const deps = cascadeDeps('x'.repeat(4000), () => { dispatches++; });
    async function capture() {
      const result = await handleChatCompletions(body, deps);
      assert.equal(result.status, 200);
      assert.equal(result.stream, true);
      const res = fakeRes();
      await result.handler(res);
      const data = res.body.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6));
      assert.equal(data.at(-1), '[DONE]');
      const choices = data.slice(0, -1).flatMap(frame => JSON.parse(frame).choices || []);
      return {
        text: choices.map(choice => choice.delta?.content || '').join(''),
        terminals: choices.map(choice => choice.finish_reason).filter(reason => reason != null),
      };
    }

    const first = await capture();
    assert.ok(first.text.length > 0);
    assert.deepEqual(first.terminals, ['length']);
    const hits = cacheStats().hits;
    const replay = await capture();
    assert.deepEqual(replay, first);
    assert.equal(cacheStats().hits, hits + 1);
    assert.equal(dispatches, 1, 'replay must not dispatch again');
  });
});
