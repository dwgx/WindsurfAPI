import './setup-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { acquireAccountByKey, addAccountByKey, getAccountInternal, removeAccount } from '../src/auth.js';
import { cacheClear, cacheStats } from '../src/cache.js';
import { DEFER_STREAM_DELIVERY, handleChatCompletions, __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';

class CaptureResponse extends EventEmitter {
  body = '';
  writableEnded = false;

  writeHead() { return this; }
  write(chunk) {
    this.body += String(chunk);
    return true;
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
  }
}

const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };

function setup(t, connect, stream) {
  assert.equal(process.env.WINDSURFAPI_SKIP_DOTENV, '1', 'use test/setup-env.mjs');
  process.env.DEVIN_CONNECT = connect ? '1' : '0';
  process.env.DEVIN_ONLY = '0';
  process.env.DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT = '0';
  process.env.RESPONSE_CACHE_ENABLED = '1';
  cacheClear();

  const { id } = addAccountByKey('devin-session-token$synthetic-cache-clear', 'synthetic-cache-clear');
  const account = getAccountInternal(id);
  account.tier = 'pro';
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let dispatches = 0;
  async function upstreamAnswer() {
    if (++dispatches > 1) return 'answer after clear';
    entered.resolve();
    await finish.promise;
    return 'answer before clear';
  }

  t.after(() => {
    finish.resolve();
    __resetConnectDeps();
    removeAccount(id);
    cacheClear();
  });

  const model = connect ? 'swe-1-6-slow' : 'gemini-2.5-flash';
  const context = { callerKey: 'session:synthetic-cache-clear' };
  if (connect) {
    __setConnectDeps({
      toChatCompletion: async () => ({
        status: 200,
        body: {
          id: 'chatcmpl-synthetic', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, message: { role: 'assistant', content: await upstreamAnswer() }, finish_reason: 'stop' }],
          usage,
        },
      }),
      streamChatCompletion: async (_params, send, meta) => {
        const text = await upstreamAnswer();
        const chunk = { id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.displayModel };
        await send({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
        await send({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        return { content: text, delivered: text, reasoning: '', finish_reason: 'stop', usage, toolCalls: [], stop: null };
      },
    });
  } else {
    context.waitForAccount = () => acquireAccountByKey(account.apiKey);
    context.ensureLs = async () => {};
    context.getLsFor = () => ({ port: 17777, csrfToken: 'synthetic', generation: 1 });
    context.checkMessageRateLimit = async () => ({ hasCapacity: true });
    context.WindsurfClient = class {
      async cascadeChat(_messages, _modelEnum, _modelUid, opts) {
        const text = await upstreamAnswer();
        const metadata = { endReason: 'idle_done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 } };
        if (!stream) return Object.assign([{ text }], metadata);
        await opts.onChunk({ text });
        return { ...metadata, text: '' };
      }
    };
  }

  async function request() {
    const body = { model, stream, messages: [{ role: 'user', content: 'synthetic cache clear test' }] };
    const result = await handleChatCompletions(body, context);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (!stream) return result.body.choices[0].message.content;
    const res = new CaptureResponse();
    await result.handler(res);
    assert.equal(res.writableEnded, true);
    assert.match(res.body, /data: \[DONE\]\n\n$/);
    return res.body.split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '')
      .join('');
  }

  function waitForDispatch(pending) {
    return Promise.race([
      entered.promise,
      pending.then(() => assert.fail('the response completed before upstream was released')),
    ]);
  }

  return { account, context, request, waitForDispatch, finish: finish.resolve, dispatches: () => dispatches };
}

for (const connect of [true, false]) {
  for (const stream of [false, true]) {
    const mode = (connect ? 'Connect' : 'Cascade') + (stream ? ' stream' : ' buffered');
    test(mode + ': clearing the cache fences an in-flight response', { timeout: 10_000 }, async t => {
      const { account, request, waitForDispatch, finish, dispatches } = setup(t, connect, stream);
      const pending = request();
      try {
        await waitForDispatch(pending);
        assert.equal(account._inflight, 1);
        assert.equal(cacheStats().misses, 1, 'cache lookup already ran');
        cacheClear(); // A miss is in flight even though the cache is already empty.
      } finally {
        finish();
      }
      assert.equal(await pending, 'answer before clear');
      assert.equal(account._inflight, 0);
      assert.equal(account._totalSpend.requests, 1);
      assert.equal(account._totalSpend.totalTokens, 8);
      const { size, bytes, hits, misses, stores, evictions, skips } = cacheStats();
      assert.deepEqual({ size, bytes, hits, misses, stores, evictions, skips }, {
        size: 0, bytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0, skips: 0,
      });
      assert.equal(await request(), 'answer after clear');
      assert.equal(dispatches(), 2);
      assert.equal(cacheStats().stores, 1);
      assert.equal(await request(), 'answer after clear');
      assert.equal(dispatches(), 2, 'the repeated request replays the fresh response');
      assert.equal(cacheStats().hits, 1);
      assert.equal(account._totalSpend.requests, 2);
    });
  }
}

test('an older completion cannot overwrite a fresh same-key cache entry', { timeout: 10_000 }, async t => {
  const { request, waitForDispatch, finish, dispatches } = setup(t, true, false);
  const pending = request();
  try {
    await waitForDispatch(pending);
    cacheClear();
    assert.equal(await request(), 'answer after clear');
    assert.equal(cacheStats().stores, 1);
  } finally {
    finish();
  }
  assert.equal(await pending, 'answer before clear');
  assert.equal(await request(), 'answer after clear');
  assert.equal(dispatches(), 2);
  assert.equal(cacheStats().stores, 1);
  assert.equal(cacheStats().hits, 1);
});

for (const connect of [true, false]) {
  const provider = connect ? 'Connect' : 'Cascade';
  test(provider + ' stream: a deferred delivery cannot publish into a new generation', { timeout: 10_000 }, async t => {
    const { context, request, finish, dispatches } = setup(t, connect, true);
    const effects = [];
    context[DEFER_STREAM_DELIVERY] = effect => effects.push(effect);
    finish();
    assert.equal(await request(), 'answer before clear');
    assert.ok(effects.length > 0);
    assert.equal(cacheStats().stores, 0, 'delivery has deferred the first cache write');

    cacheClear();
    delete context[DEFER_STREAM_DELIVERY];
    assert.equal(await request(), 'answer after clear');
    assert.equal(cacheStats().stores, 1);
    for (const effect of effects) effect();
    assert.equal(await request(), 'answer after clear');
    assert.equal(cacheStats().stores, 1);
    assert.equal(cacheStats().hits, 1);
    assert.equal(dispatches(), 2);
  });
}
