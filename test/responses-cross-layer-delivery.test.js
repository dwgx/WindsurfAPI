// Real Chat -> Responses translation. Only Connect/Cascade producers and the
// final socket are synthetic. Delivery state must wait for the outer terminal;
// accounting and acquired resources must not wait with it.
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';

assert.equal(process.env.WINDSURFAPI_SKIP_DOTENV, '1', 'use test/setup-env.mjs');
process.env.STICKY_SESSION_ENABLED = '1';
process.env.DEVIN_CONNECT_SESSION_REUSE = '1';
process.env.RESPONSE_CACHE_ENABLED = '1';
const chat = await import('../src/handlers/chat.js');
const { handleResponses } = await import('../src/handlers/responses.js');
const auth = await import('../src/auth.js');
const cache = await import('../src/cache.js');
const continuity = await import('../src/session-continuity.js');
const sticky = await import('../src/account/sticky-session.js');
const pool = await import('../src/conversation-pool.js');
const store = await import('../src/response-store.js');
const { activeSseCount } = await import('../src/sse-registry.js');

const CALLER = 'session:responses-delivery-effects';
const TEXT = 'synthetic complete answer';
const created = [];
let serial = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pump = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture did not settle')), 2000); })]); }
  finally { clearTimeout(timer); }
}

function controlledSink(mode = 'normal') {
  const res = new EventEmitter();
  const terminal = deferred();
  Object.assign(res, { writableEnded: false, destroyed: false, writes: [], writesAfterClose: 0, terminal });
  res.closeNow = () => { res.destroyed = true; res.emit('close'); };
  res.errorNow = () => { res.destroyed = true; res.emit('error', new Error('synthetic socket failure')); };
  res.writeHead = () => res;
  res.write = raw => {
    if (res.destroyed) { res.writesAfterClose++; return false; }
    const text = String(raw); res.writes.push(text);
    if (/^event: response\.(completed|incomplete|failed)$/m.test(text)) {
      if (mode === 'sync-close') res.closeNow();
      terminal.resolve();
      return mode === 'normal';
    }
    return true;
  };
  res.end = raw => { if (raw) res.write(raw); res.writableEnded = true; return res; };
  return res;
}

function producer(backend, finishReason = 'stop', synthetic = false) {
  const made = auth.addAccountByKey(`devin-session-token$synthetic-delivery-${++serial}`, 'synthetic-delivery');
  created.push(made.id);
  const account = auth.getAccountInternal(made.id);
  account.tier = 'pro'; account.status = 'active'; account.tierManual = true;
  const model = backend === 'connect' ? 'swe-1-6-slow' : 'gemini-2.5-flash';
  let calls = 0;
  const context = { callerKey: CALLER };
  if (backend === 'connect') {
    process.env.DEVIN_CONNECT = '1';
    chat.__setConnectDeps({ streamChatCompletion: async (_params, send) => {
      calls++;
      const frame = choices => ({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model, choices });
      await send(frame([{ index: 0, delta: { content: TEXT }, finish_reason: null }]));
      await send({ ...frame([{ index: 0, delta: {}, finish_reason: finishReason }]), ...(synthetic ? { __synthetic_finish: true } : {}) });
      await send({ ...frame([]), usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
      return { content: TEXT, delivered: TEXT, reasoning: '', toolCalls: [], finish_reason: finishReason,
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, billing: null };
    } });
  } else {
    delete process.env.DEVIN_CONNECT; delete process.env.DEVIN_ONLY;
    class FakeClient {
      async cascadeChat(_messages, _enum, _uid, options) {
        calls++;
        await options.onChunk({ text: TEXT });
        return { text: '', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 },
          cascadeId: 'synthetic-delivery-cascade', sessionId: 'synthetic-session', lsGeneration: 1 };
      }
    }
    Object.assign(context, {
      waitForAccount: (tried, _signal, _wait, modelKey) => auth.getApiKey(tried, modelKey),
      ensureLs: async () => {}, getLsFor: () => ({ port: 17777, csrfToken: 'synthetic', generation: 1 }),
      WindsurfClient: FakeClient,
    });
  }
  return { account, model, context, get calls() { return calls; } };
}

function observe(p) {
  return {
    cache: cache.cacheStats().stores, continuity: continuity._getIndexStats().commitKeys,
    affinity: sticky.getStickyStats().size, pool: pool.poolStats().size,
    responses: store.getResponseStoreStats().stored,
    billedRequests: p.account._totalSpend?.requests || 0,
    billedTokens: p.account._totalSpend?.totalTokens || 0,
    inflight: p.account._inflight || 0, sse: activeSseCount(),
  };
}

function assertState(p, backend, delivered, responseStored = delivered) {
  assert.deepEqual(observe(p), {
    cache: Number(delivered), continuity: Number(delivered && backend === 'connect'),
    affinity: Number(delivered), pool: Number(delivered && backend === 'cascade'),
    responses: Number(responseStored), billedRequests: 1, billedTokens: 8, inflight: 0, sse: 0,
  });
}

beforeEach(() => {
  chat.__resetConnectDeps(); cache.cacheClear(); continuity._resetForTests();
  sticky.resetAllBindings(); pool.poolClear(); store.resetResponseStore();
  delete process.env.WINDSURFAPI_MAX_DRAIN_MS;
});
afterEach(() => {
  chat.__resetConnectDeps();
  while (created.length) auth.removeAccount(created.pop());
  delete process.env.WINDSURFAPI_MAX_DRAIN_MS;
});

for (const backend of ['connect', 'cascade']) {
  for (const mode of ['drain', 'close', 'error', 'timeout', 'sync-close']) {
    test(`${backend}: outer terminal ${mode} gates reusable state, accounting/resources settle once`, async () => {
      if (mode === 'timeout') process.env.WINDSURFAPI_MAX_DRAIN_MS = '25';
      const p = producer(backend);
      const body = { model: p.model, stream: true, input: 'bounded cross-layer delivery' };
      const result = await handleResponses(body, { context: p.context });
      assert.equal(result.stream, true);
      const res = controlledSink(mode);
      const running = result.handler(res);
      await bounded(res.terminal.promise);
      await pump();
      // Upstream work is billed and its reservation/SSE registration released
      // even while an outer writer remains blocked; nothing reusable is published.
      assertState(p, backend, false);
      if (mode === 'drain') res.emit('drain');
      else if (mode === 'close') res.closeNow();
      else if (mode === 'error') res.errorNow();
      await bounded(running);
      assertState(p, backend, mode === 'drain');
      assert.equal(res.writesAfterClose, 0);
      assert.equal(res.writes.filter(w => w.includes('data: [DONE]')).length, Number(mode === 'drain'));
      if (mode === 'drain') {
        res.emit('drain'); res.emit('close');
        assertState(p, backend, true); // no duplicate publication on late events
      }
    });
  }
  test(`${backend}: store:false still publishes normal inner delivery state`, async () => {
    const p = producer(backend);
    const result = await handleResponses({ model: p.model, stream: true, store: false, input: 'no response retention' }, { context: p.context });
    const res = controlledSink('drain'); const running = result.handler(res);
    await bounded(res.terminal.promise); await pump();
    assertState(p, backend, false);
    res.emit('drain'); await bounded(running);
    assertState(p, backend, true, false);
  });
  test(`${backend}: direct Chat without adapter hook retains existing successful publication`, async () => {
    const p = producer(backend);
    const result = await chat.handleChatCompletions({ model: p.model, stream: true, messages: [{ role: 'user', content: 'direct chat' }] }, p.context);
    await result.handler(controlledSink());
    assertState(p, backend, true, false);
  });
}

for (const finish of ['length', 'content_filter']) {
  test(`Connect legitimate ${finish} publishes once after drain and remains chainable`, async () => {
    const p = producer('connect', finish);
    const result = await handleResponses({ model: p.model, stream: true, input: 'legitimate incomplete result' }, { context: p.context });
    const res = controlledSink('drain'); const running = result.handler(res);
    await bounded(res.terminal.promise); await pump(); assertState(p, 'connect', false);
    res.emit('drain'); await bounded(running); assertState(p, 'connect', true);
    const terminal = res.writes.find(w => /^event: response.incomplete$/m.test(w));
    assert.ok(terminal);
    assert.ok(terminal.includes(`"reason":"${finish === 'length' ? 'max_output_tokens' : 'content_filter'}"`));
  });
}

test('synthetic upstream length cannot publish successful delivery effects', async () => {
  const p = producer('connect', 'length', true);
  const result = await handleResponses({ model: p.model, stream: true, input: 'upstream truncated' }, { context: p.context });
  const res = controlledSink(); await result.handler(res);
  assertState(p, 'connect', false);
  assert.ok(res.writes.some(w => w.includes('"reason":"upstream_incomplete"')));
});

test('terminal disconnect leaves no cached answer for the identical retry', async () => {
  const p = producer('connect');
  const body = { model: p.model, stream: true, input: 'identical retry after terminal close' };
  const first = await handleResponses(body, { context: p.context });
  await first.handler(controlledSink('sync-close')); assertState(p, 'connect', false);
  const retry = await handleResponses(body, { context: p.context });
  await retry.handler(controlledSink());
  assert.equal(p.calls, 2);
  assert.equal(cache.cacheStats().hits, 0);
  assert.equal(p.account._totalSpend.requests, 2);
  assert.equal(p.account._totalSpend.totalTokens, 16);
});

test('adapter end failure discards queued state without losing accounting or resource cleanup', async () => {
  const p = producer('connect');
  const result = await handleResponses({ model: p.model, stream: true, input: 'adapter end failure' }, {
    context: p.context,
    handleChatCompletions: async (body, context) => {
      const inner = await chat.handleChatCompletions(body, context);
      return { ...inner, handler: async capture => {
        // The real producer and Chat success arm run; only the adapter end
        // boundary fails, after Chat has registered its delivery effects.
        capture.end = () => { throw new Error('synthetic adapter end failure'); };
        return inner.handler(capture);
      } };
    },
  });
  const res = controlledSink(); await result.handler(res);
  assertState(p, 'connect', false);
  assert.equal(res.writes.filter(w => /^event: response.failed$/m.test(w)).length, 1);
  assert.equal(res.writes.filter(w => w.includes('data: [DONE]')).length, 0);
});
