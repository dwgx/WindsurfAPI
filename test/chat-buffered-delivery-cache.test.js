// A completed buffered Connect attempt may race caller cancellation.
// Preserve successful upstream accounting, but never commit an undelivered turn.
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';

assert.equal(process.env.WINDSURFAPI_SKIP_DOTENV, '1', 'use test/setup-env.mjs');
const mod = name => import(new URL('../' + name, import.meta.url));
process.env.DEVIN_CONNECT = '1';
process.env.STICKY_SESSION_ENABLED = '1';
process.env.DEVIN_CONNECT_SESSION_REUSE = '1';
delete process.env.RESPONSE_CACHE_ENABLED;
delete process.env.WINDSURFAPI_RESPONSE_CACHE;
const chat = await mod('src/handlers/chat.js');
const auth = await mod('src/auth.js');
const cache = await mod('src/cache.js');
const sticky = await mod('src/account/sticky-session.js');
const continuity = await mod('src/session-continuity.js');
const MODEL = 'swe-1-6-slow';
const CALLER = 'session:web-buffered-delivery-contract';
const ids = [];
let seq = 0;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function seed() {
  const a = auth.addAccountByKey(`devin-session-token$synthetic-web-delivery-${++seq}`, 'synthetic-web-delivery');
  ids.push(a.id);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}
const body = () => ({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'synthetic bounded delivery turn' }] });
const ok = () => ({ status: 200, body: {
  id: 'chatcmpl-synthetic', object: 'chat.completion', created: 1, model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
} });
function observe(label, result, acct, calls) {
  const spent = auth.getAccountInternal(acct.id)._totalSpend;
  const out = {
    status: result.status, code: result.body?.error?.code || null, calls,
    commitKeys: continuity._getIndexStats().commitKeys,
    stores: cache.cacheStats().stores,
    affinity: sticky.getStickyStats().size,
    billedRequests: spent?.requests || 0, billedTokens: spent?.totalTokens || 0,
  };
  console.log('CACHE_CONTRACT_EVIDENCE', JSON.stringify({ label, ...out }));
  return out;
}
beforeEach(() => {
  process.env.DEVIN_CONNECT_SESSION_REUSE = '1';
  chat.__resetConnectDeps();
  cache.cacheClear();
  sticky.resetAllBindings();
  continuity._resetForTests();
  assert.equal(cache.isCacheEnabled(), true, 'cache is enabled by shipped default');
});
afterEach(() => {
  chat.__resetConnectDeps();
  while (ids.length) auth.removeAccount(ids.pop());
});

test('control: completed buffered turn commits/caches/binds once and accounts once', async () => {
  const acct = seed();
  let calls = 0;
  chat.__setConnectDeps({ toChatCompletion: async () => { calls++; return ok(); } });
  const result = await chat.handleChatCompletions(body(), { callerKey: CALLER });
  assert.deepEqual(observe('normal_success', result, acct, calls), {
    status: 200, code: null, calls: 1, commitKeys: 1, stores: 1, affinity: 1, billedRequests: 1, billedTokens: 8,
  });
});

for (const reuse of [true, false]) {
  test(`late successful upstream after cancellation has no delivery effects (reuse ${reuse ? 'on' : 'off/default'})`, async () => {
    process.env.DEVIN_CONNECT_SESSION_REUSE = reuse ? '1' : '0';
    const acct = seed();
    const entered = deferred();
    const finish = deferred();
    const controller = new AbortController();
    let calls = 0;
    chat.__setConnectDeps({ toChatCompletion: async params => {
      calls++;
      assert.equal(params.signal, controller.signal, 'real handler forwards caller signal');
      entered.resolve();
      return finish.promise;
    } });
    const pending = chat.handleChatCompletions(body(), { callerKey: CALLER, signal: controller.signal });
    await entered.promise;
    controller.abort(new Error('synthetic caller gone'));
    finish.resolve(ok()); // The upstream already completed; cancellation loses the transport race.
    const result = await pending;
    assert.deepEqual(observe(`late_cancel_reuse_${reuse}`, result, acct, calls), {
      status: 499, code: 'client_disconnect', calls: 1, commitKeys: 0, stores: 0, affinity: 0, billedRequests: 1, billedTokens: 8,
    });
  });
}

test('negative control: pre-aborted caller never starts upstream or records work', async () => {
  const acct = seed();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  chat.__setConnectDeps({ toChatCompletion: async () => { calls++; return ok(); } });
  const result = await chat.handleChatCompletions(body(), { callerKey: CALLER, signal: controller.signal });
  assert.deepEqual(observe('pre_aborted', result, acct, calls), {
    status: 499, code: 'client_disconnect', calls: 0, commitKeys: 0, stores: 0, affinity: 0, billedRequests: 0, billedTokens: 0,
  });
});

test('relogin retry late success has the same cancellation delivery gate', async () => {
  const acct = seed();
  const enteredRetry = deferred();
  const finishRetry = deferred();
  const controller = new AbortController();
  let calls = 0;
  chat.__setConnectDeps({
    reLoginAccount: async id => {
      assert.equal(id, acct.id);
      const fresh = `devin-session-token$synthetic-web-retry-${seq}`;
      auth.setAccountTokens(id, { apiKey: fresh });
      return fresh;
    },
    toChatCompletion: async params => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('synthetic expired token'), { code: 'UNAUTHORIZED' });
      assert.equal(params.signal, controller.signal);
      enteredRetry.resolve();
      return finishRetry.promise;
    },
  });
  const pending = chat.handleChatCompletions(body(), { callerKey: CALLER, signal: controller.signal });
  await enteredRetry.promise;
  controller.abort();
  finishRetry.resolve(ok());
  const result = await pending;
  assert.deepEqual(observe('relogin_late_cancel', result, acct, calls), {
    status: 499, code: 'client_disconnect', calls: 2, commitKeys: 0, stores: 0, affinity: 0, billedRequests: 1, billedTokens: 8,
  });
});
