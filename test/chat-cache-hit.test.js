import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { cacheClear, cacheKey, cacheSet, cacheStats } from '../src/cache.js';
import { handleChatCompletions, cascadeCacheIdentity, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { stopLanguageServerAndWait } from '../src/langserver.js';

const createdAccountIds = [];
const originalResponseCacheEnabled = process.env.RESPONSE_CACHE_ENABLED;
const originalDevinConnect = process.env.DEVIN_CONNECT;

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseChatFrames(raw) {
  return raw
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
      const payload = dataLine?.slice(6) || '';
      return payload === '[DONE]' ? '[DONE]' : JSON.parse(payload);
    });
}

afterEach(async () => {
  // The Cascade test starts a real LS; a surviving child keeps the test runner
  // alive on hosts that have a language_server binary installed (HMC).
  await stopLanguageServerAndWait({ perProcessTimeoutMs: 500 }).catch(() => {});
  cacheClear();
  __resetConnectDeps();
  while (createdAccountIds.length) {
    removeAccount(createdAccountIds.pop());
  }
  if (originalResponseCacheEnabled === undefined) delete process.env.RESPONSE_CACHE_ENABLED;
  else process.env.RESPONSE_CACHE_ENABLED = originalResponseCacheEnabled;
  if (originalDevinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = originalDevinConnect;
});

describe('chat cache-hit stream shape', () => {
  it('matches the live-stream finish chunk plus terminal usage chunk shape (include_usage:true)', async () => {
    const account = addAccountByKey(`cache-key-${Date.now()}`, 'cache-hit');
    createdAccountIds.push(account.id);

    const body = {
      model: 'gemini-2.5-flash',
      stream: true,
      // O1: the trailing usage frame is opt-in; this test asserts its shape, so
      // it explicitly opts in.
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
      // SEC-W2: the response cache only serves cross-request hits for a
      // trustworthy per-user scope. Give this cache-mechanics test a real
      // :user: scope (as a legit single user would) so it exercises the hit path.
      __callerKey: 'api:test:user:cachetester',
    };
    // The handler looks the slot up under the effective routed identity
    // (cascadeCacheIdentity) — seed with the same derivation, not the raw key.
    cacheSet(cacheKey(body, body.__callerKey, cascadeCacheIdentity(body)), { text: 'cached answer', thinking: 'cached thinking' });

    const result = await handleChatCompletions(body);
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    const res = fakeRes();
    await result.handler(res);
    const frames = parseChatFrames(res.body);
    const finishChunk = frames.at(-3);
    const usageChunk = frames.at(-2);

    assert.equal(finishChunk.choices[0].finish_reason, 'stop');
    assert.equal('usage' in finishChunk, false);
    assert.deepEqual(usageChunk.choices, []);
    assert.deepEqual(usageChunk.usage, {
      cached: true,
      prompt_tokens: 1,
      completion_tokens: 4,
      total_tokens: 5,
      input_tokens: 1,
      output_tokens: 4,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    assert.equal(frames.at(-1), '[DONE]');
  });

  it('O1: omits the trailing usage frame by default (no stream_options)', async () => {
    const account = addAccountByKey(`cache-key-${Date.now()}-nou`, 'cache-hit');
    createdAccountIds.push(account.id);

    const body = {
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: 'api:test:user:cachetester',  // SEC-W2: trusted scope for cache-hit path
    };
    // The handler looks the slot up under the effective routed identity
    // (cascadeCacheIdentity) — seed with the same derivation, not the raw key.
    cacheSet(cacheKey(body, body.__callerKey, cascadeCacheIdentity(body)), { text: 'cached answer', thinking: 'cached thinking' });

    const result = await handleChatCompletions(body);
    assert.equal(result.status, 200);

    const res = fakeRes();
    await result.handler(res);
    const frames = parseChatFrames(res.body);

    // No frame carries a usage block, and the last real chunk is the finish
    // chunk (choices[0].finish_reason), immediately followed by [DONE].
    const usageFrames = frames.filter(f => f !== '[DONE]' && 'usage' in f);
    assert.deepEqual(usageFrames, [], 'no usage frame without include_usage');
    assert.equal(frames.at(-1), '[DONE]');
    const finishChunk = frames.at(-2);
    assert.equal(finishChunk.choices[0].finish_reason, 'stop');
  });

  it('O1: include_usage:false explicitly also omits the usage frame', async () => {
    const account = addAccountByKey(`cache-key-${Date.now()}-false`, 'cache-hit');
    createdAccountIds.push(account.id);

    const body = {
      model: 'gemini-2.5-flash',
      stream: true,
      stream_options: { include_usage: false },
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: 'api:test:user:cachetester',  // SEC-W2: trusted scope for cache-hit path
    };
    // The handler looks the slot up under the effective routed identity
    // (cascadeCacheIdentity) — seed with the same derivation, not the raw key.
    cacheSet(cacheKey(body, body.__callerKey, cascadeCacheIdentity(body)), { text: 'cached answer', thinking: 'cached thinking' });

    const result = await handleChatCompletions(body);
    const res = fakeRes();
    await result.handler(res);
    const frames = parseChatFrames(res.body);

    const usageFrames = frames.filter(f => f !== '[DONE]' && 'usage' in f);
    assert.deepEqual(usageFrames, [], 'include_usage:false → no usage frame');
  });
});

// SEC-W2: cross-tenant cache isolation. A guessed `:client:<ip+ua>` bucket
// (shared API key behind a reverse proxy, no per-user signal) must NOT receive
// another caller's cached answer by default. This is the regression guard for
// the cross-tenant session-leak fix.
describe('SEC-W2 cross-tenant cache isolation', () => {
  it('a :client: (guessed) scope does NOT get a cross-request cache hit by default', async () => {
    const account = addAccountByKey(`cache-w2-${Date.now()}`, 'w2');
    createdAccountIds.push(account.id);

    // Pre-seed the cache under a :client: bucket, as if user A had populated it.
    const clientCaller = 'api:sharedkey:client:aabbccdd';
    const body = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: clientCaller,
    };
    cacheSet(cacheKey(body, clientCaller), { text: 'user-A-secret-answer', thinking: '' });

    // User B, same collapsed :client: bucket, same question — must NOT be served
    // A's cached answer; the request proceeds to normal handling instead.
    const result = await handleChatCompletions(body, { callerKey: clientCaller });
    const served = result?.body?.choices?.[0]?.message?.content || '';
    assert.notEqual(served, 'user-A-secret-answer',
      ':client: bucket must not serve a cross-request cached answer by default');
  });
});

// PR #142 / RESPONSE_CACHE_ENABLED switch: the key-site half (s1-p1-cache-gate)
// asserts the chat key sites skip hashing when disabled. This drives the real
// handler with the switch off and proves the observable contract: duplicate
// requests both reach upstream and the cache records neither a store nor a hit.
describe('RESPONSE_CACHE_ENABLED=0', () => {
  it('sends two identical requests upstream and records no stores or hits', async () => {
    process.env.RESPONSE_CACHE_ENABLED = '0';
    process.env.DEVIN_CONNECT = '1';

    const account = addAccountByKey(
      `devin-session-token$cache-off-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      'cache-off',
    );
    createdAccountIds.push(account.id);
    cacheClear(); // zero the counters after any setup activity

    let upstreamCalls = 0;
    __setConnectDeps({
      toChatCompletion: async () => {
        upstreamCalls++;
        return {
          status: 200,
          body: {
            id: 'chatcmpl-cache-off',
            object: 'chat.completion',
            created: 1,
            model: 'swe-1-6-slow',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: `fresh answer ${upstreamCalls}` },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          },
        };
      },
    });

    const request = {
      model: 'swe-1-6-slow',
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: 'api:test:user:cache-off',
    };
    const first = await handleChatCompletions(request, { callerKey: request.__callerKey });
    const second = await handleChatCompletions(request, { callerKey: request.__callerKey });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(upstreamCalls, 2,
      'both identical requests must reach upstream when the switch is off');
    assert.notEqual(first.body.choices[0].message.content, second.body.choices[0].message.content,
      'the second response must be generated, not replayed from a cache slot');

    const stats = cacheStats();
    assert.equal(stats.enabled, false);
    assert.equal(stats.stores, 0, 'the disabled cache must never store a response');
    assert.equal(stats.hits, 0, 'the disabled cache must never serve a hit');
    assert.equal(stats.size, 0);
  });
});
