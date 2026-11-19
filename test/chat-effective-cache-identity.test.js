// Cache identity must agree with the model and tool policy actually selected.
// Real handler seams compare warm and cold calls without upstream traffic.
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
assert.equal(process.env.WINDSURFAPI_SKIP_DOTENV, '1', 'use test/setup-env.mjs');
const mod = name => import(new URL('../' + name, import.meta.url));
delete process.env.DEVIN_CONNECT;
delete process.env.DEVIN_ONLY;
delete process.env.RESPONSE_CACHE_ENABLED;
delete process.env.WINDSURFAPI_RESPONSE_CACHE;
const chat = await mod('src/handlers/chat.js');
const auth = await mod('src/auth.js');
const cache = await mod('src/cache.js');
const pool = await mod('src/conversation-pool.js');
const sticky = await mod('src/account/sticky-session.js');
const CALLER = 'session:web-effective-cache-contract';
const ids = [];
let seq = 0;
function seed() {
  const a = auth.addAccountByKey(`devin-session-token$synthetic-web-cache-${++seq}`, 'synthetic-web-cache');
  ids.push(a.id);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}
const req = extra => ({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'synthetic cache identity question' }], ...extra });
const visible = result => ({ status: result.status, content: result.body?.choices?.[0]?.message?.content, reasoning: result.body?.choices?.[0]?.message?.reasoning_content || '' });
function cascadeContext(acct, seen) {
  class Client {
    async cascadeChat(_messages, modelEnum, modelUid) {
      seen.push({ modelEnum, modelUid });
      return Object.assign([{ text: `synthetic response for ${modelUid}`, thinking: '' }], {
        endReason: 'idle_done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 },
      });
    }
  }
  return {
    callerKey: CALLER,
    waitForAccount: tried => tried.length === 0 ? auth.acquireAccountByKey(acct.apiKey) : null,
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17777, csrfToken: 'synthetic', generation: 1 }),
    checkMessageRateLimit: async () => ({ hasCapacity: true }),
    WindsurfClient: Client,
  };
}
beforeEach(() => {
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_ONLY;
  delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
  chat.__resetConnectDeps();
  cache.cacheClear();
  pool.poolClear();
  sticky.resetAllBindings();
  assert.equal(cache.isCacheEnabled(), true, 'cache enabled without opting in');
});
afterEach(() => {
  chat.__resetConnectDeps();
  while (ids.length) auth.removeAccount(ids.pop());
});

test('Cascade valid flat/nested effort: warm answer agrees with same request cold', async () => {
  const acct = seed();
  const seen = [];
  const ctx = cascadeContext(acct, seen);
  const first = req({ reasoning_effort: 'high' });
  const second = req({ reasoning: { effort: 'high' } });
  const keysEqual = cache.cacheKey(first, CALLER) === cache.cacheKey(second, CALLER);
  const a = await chat.handleChatCompletions(first, ctx);
  const bWarm = await chat.handleChatCompletions(second, ctx);
  const warmDispatches = [...seen];
  const warmStats = cache.cacheStats();
  cache.cacheClear();
  seen.length = 0;
  const bCold = await chat.handleChatCompletions(second, ctx);
  console.log('CACHE_CONTRACT_EVIDENCE', JSON.stringify({ label: 'sonnet_effort_alias', keysEqual, a: visible(a), bWarm: visible(bWarm), bCold: visible(bCold), warmDispatches, coldDispatches: seen, warmStats }));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(bCold.status, 200, JSON.stringify(bCold.body));
  assert.deepEqual(visible(bWarm), visible(bCold), 'cache must represent the actual model and output policy of this request');
});

test('control: exact Cascade request repeat remains a cache hit', async () => {
  const acct = seed();
  const seen = [];
  const ctx = cascadeContext(acct, seen);
  const body = req({ reasoning_effort: 'high' });
  const a = await chat.handleChatCompletions(body, ctx);
  const b = await chat.handleChatCompletions(body, ctx);
  console.log('CACHE_CONTRACT_EVIDENCE', JSON.stringify({ label: 'cascade_exact_repeat', first: visible(a), second: visible(b), dispatches: seen, stats: cache.cacheStats() }));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(visible(a), visible(b));
  assert.equal(seen.length, 1);
  assert.equal(cache.cacheStats().hits, 1);
});

test('effort precedence and canonical spelling agree between cache and model routing', () => {
  const canonical = req({ model: 'gpt-5.5', reasoning_effort: 'high' });
  for (const flat of ['', false, 0, null, undefined]) {
    const body = req({ model: 'gpt-5.5', reasoning_effort: flat, reasoning: { effort: 'high' } });
    assert.equal(cache.cacheKey(body, CALLER), cache.cacheKey(canonical, CALLER));
    assert.equal(chat.mergeReasoningEffortIntoModel(body.model, body), 'gpt-5.5-high');
    assert.equal(chat.isThinkingRequested(body), true);
  }
  const mixed = req({ model: 'gpt-5.5', reasoning_effort: ' HIGH ', reasoning: { effort: 'low' } });
  assert.equal(cache.cacheKey(mixed, CALLER), cache.cacheKey(canonical, CALLER));
  assert.equal(chat.mergeReasoningEffortIntoModel(mixed.model, mixed), 'gpt-5.5-high');
  // The router's existing truthy precedence precedes trimming: whitespace
  // shadows nested effort, then normalizes to no effort in all three readers.
  const whitespace = req({ model: 'gpt-5.5', reasoning_effort: '  ', reasoning: { effort: 'high' } });
  assert.equal(cache.cacheKey(whitespace, CALLER), cache.cacheKey(req({ model: 'gpt-5.5' }), CALLER));
  assert.equal(chat.mergeReasoningEffortIntoModel(whitespace.model, whitespace), 'gpt-5.5');
  assert.equal(chat.isThinkingRequested(whitespace), false);
});

test('raw JSON effort with non-callable coercion properties does not throw while keying', () => {
  const malformed = req({ reasoning_effort: JSON.parse('{"toString":{},"valueOf":{}}') });
  assert.doesNotThrow(() => cache.cacheKey(malformed, CALLER));
  assert.equal(chat.mergeReasoningEffortIntoModel(malformed.model, malformed), malformed.model);
  assert.equal(chat.isThinkingRequested(malformed), false);
});

for (const enabled of [true, false]) {
  test(`Connect parallel preference warm/cold agree (experimental passthrough ${enabled ? 'on' : 'off/default'})`, async () => {
    process.env.DEVIN_CONNECT = '1';
    if (enabled) process.env.DEVIN_CONNECT_TOOL_CHOICE = '1';
    else delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    seed();
    const seen = [];
    chat.__setConnectDeps({ toChatCompletion: async params => {
      // Deliberately model the exact local encoder decision, not any unverified
      // provider semantics. Tools are declared; this response is prose only.
      const sequential = process.env.DEVIN_CONNECT_TOOL_CHOICE === '1' && params.parallelToolCalls === false;
      seen.push({ parallelToolCalls: params.parallelToolCalls, sequential });
      return { status: 200, body: {
        id: 'chatcmpl-synthetic-policy', object: 'chat.completion', created: 1, model: 'swe-1-6-slow',
        choices: [{ index: 0, message: { role: 'assistant', content: sequential ? 'synthetic sequential-policy response' : 'synthetic default-policy response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } };
    } });
    const body = value => ({ model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'synthetic policy question' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }], parallel_tool_calls: value });
    const first = body(true);
    const second = body(false);
    const keysEqual = cache.cacheKey(first, CALLER) === cache.cacheKey(second, CALLER);
    const ctx = { callerKey: CALLER };
    const a = await chat.handleChatCompletions(first, ctx);
    const bWarm = await chat.handleChatCompletions(second, ctx);
    const warmDispatches = [...seen];
    cache.cacheClear();
    seen.length = 0;
    const bCold = await chat.handleChatCompletions(second, ctx);
    console.log('CACHE_CONTRACT_EVIDENCE', JSON.stringify({ label: `connect_parallel_${enabled}`, keysEqual, a: visible(a), bWarm: visible(bWarm), bCold: visible(bCold), warmDispatches, coldDispatches: seen }));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(bCold.status, 200, JSON.stringify(bCold.body));
    assert.deepEqual(visible(bWarm), visible(bCold));
    if (!enabled) assert.equal(warmDispatches.length, 1, 'default-equivalent policies should retain the existing cache hit');
  });
}
