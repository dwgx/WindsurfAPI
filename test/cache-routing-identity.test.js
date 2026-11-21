// P2 — the response cache must key the generation the router actually selects,
// not the raw client spelling (BLUE-CACHE "Effective cache identity").
//
// Two witnessed defects at 70defee2:
//
//   1. Cascade: flat `reasoning_effort` and nested `reasoning.effort` produced
//      EQUAL cache keys while routing sent them to DIFFERENT Cascade models
//      (the thinking sibling route read only the flat spelling). 7ed61802
//      later aligned that route to resolveReasoningEffort, so the spellings
//      now select the SAME generation and must share the slot — the test
//      asserts the sharing (no surprise second dispatch, no stale prose).
//   2. Cascade, blank flat effort: `reasoning_effort: ''` + nested
//      `low`/`high` both normalized to the same key (`''` beats the nested
//      value under nullish precedence) while the router merged the nested
//      value into `gpt-5.5-low` / `gpt-5.5-high` — the warm second request got
//      the wrong tier's answer.
//   3. Connect: with DEVIN_CONNECT_TOOL_CHOICE=1 the encoder emits the
//      sequential flag for `parallel_tool_calls:false`; opposite preferences
//      shared one cache slot, so prose generated under one preference replayed
//      for the other. With the switch off the field is dropped and the
//      preferences are default-equivalent — they must keep sharing.
//
// The remediation binds the key to the effective routed identity: the resolved
// model + thinking-sibling route + router-canonical effort (shared precedence
// with mergeReasoningEffortIntoModel), looked up AND stored under the same
// identity. Exact replays still hit; distinct generations still miss.

process.env.DEVIN_CONNECT = '0';
process.env.RESPONSE_CACHE_ENABLED = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { handleChatCompletions, __setConnectDeps, __resetConnectDeps } =
  await import('../src/handlers/chat.js');
const { cacheKey, cacheClear, cacheStats } = await import('../src/cache.js');
const auth = await import('../src/auth.js');

const CALLER = 'api:cache-identity:user:u1';
const created = [];

function seedAccount(label) {
  const a = auth.addAccountByKey(`cache-identity-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

// Cascade seam: count upstream turns and record the dispatched model uid, so a
// cache replay (zero new turns) is distinguishable from a fresh dispatch and
// the dispatched VARIANT is observable. `text` may be a function of the
// dispatch ordinal (1-based) to give each turn its own prose.
function cascadeDeps(text, state) {
  class FakeClient {
    async cascadeChat(_messages, _modelEnum, modelUid, opts = {}) {
      state.dispatches += 1;
      state.modelUids.push(modelUid);
      const out = typeof text === 'function' ? text(state.dispatches) : text;
      state.contents.push(out);
      if (opts.onChunk) await opts.onChunk({ text: out, thinking: '', isError: false });
      const chunks = opts.onChunk ? [] : [{ text: out, thinking: '', isError: false }];
      chunks.toolCalls = [];
      chunks.totalYielded = out.length;
      chunks.totalThinking = 0;
      return chunks;
    }
  }
  return {
    waitForAccount(tried) { return tried.length === 0 ? auth.getApiKey(tried) : null; },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17991, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
    callerKey: CALLER,
  };
}

const cascadeBody = (extra = {}) => ({
  model: 'claude-sonnet-4.6',
  stream: false,
  messages: [{ role: 'user', content: 'answer this turn' }],
  ...extra,
});

const connectBody = (extra = {}) => ({
  model: 'claude-5-fable-medium',
  stream: false,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

function connectStub(state) {
  __setConnectDeps({
    toChatCompletion: async (params) => {
      state.seenFlags.push(params.parallelToolCalls);
      const n = state.seenFlags.length;
      return {
        status: 200,
        body: {
          id: 'chatcmpl-connect',
          object: 'chat.completion',
          created: 1,
          model: 'claude-5-fable-medium',
          choices: [{ index: 0, message: { role: 'assistant', content: `prose-${n}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      };
    },
  });
}

beforeEach(() => {
  __resetConnectDeps();
  delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
  cacheClear();
});

afterEach(() => {
  __resetConnectDeps();
  delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
  while (created.length) {
    try { auth.removeAccount(created.pop()); } catch {}
  }
});

describe('cache key routing identity (unit: cacheKey identity overrides)', () => {
  const base = { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hi' }] };

  it('an effective-model override decides the slot, not the raw spelling', () => {
    const raw = cacheKey(base, CALLER);
    const thinking = cacheKey(base, CALLER, { model: 'claude-sonnet-4.6-thinking', thinking: true, effort: 'high' });
    const plain = cacheKey(base, CALLER, { model: 'claude-sonnet-4.6', thinking: false, effort: 'high' });
    assert.notEqual(thinking, plain,
      'flat vs nested reasoning.effort route to different Cascade variants — different slots');
    assert.notEqual(thinking, raw);
    assert.notEqual(plain, raw);
    assert.equal(
      cacheKey(base, CALLER, { model: 'claude-sonnet-4.6', thinking: false, effort: 'high' }),
      plain,
      'the same identity resolves to the same slot',
    );
  });

  it('the reasoning-mode dimension only splits when output handling can differ', () => {
    const high = cacheKey(base, CALLER, { model: 'gpt-5.5-high', thinking: true, effort: 'high' });
    assert.notEqual(high, cacheKey(base, CALLER, { model: 'gpt-5.5-high', thinking: false, effort: 'high' }),
      'thinking-requested suppresses the thinking→text fallback — a different output contract');
    assert.notEqual(high, cacheKey(base, CALLER, { model: 'gpt-5.5-high', thinking: true, effort: null }),
      'a consumed effort is part of the identity');
  });

  it('the sequential connect preference splits the slot only when the encoder can use it', () => {
    const ptc = {
      ...base,
      parallel_tool_calls: false,
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
    };
    const seq = cacheKey(ptc, CALLER, { connectSequential: true });
    const par = cacheKey({ ...ptc, parallel_tool_calls: true }, CALLER);
    assert.notEqual(seq, par,
      'the sequential request (encoder may emit #11) and the parallel one (no dim) are different wire requests → different slots');
    assert.equal(cacheKey(ptc, CALLER, { connectSequential: false }), cacheKey(ptc, CALLER),
      'an inactive preference must not split the slot');
    assert.equal(cacheKey(ptc, CALLER, { connectSequential: false }), cacheKey(ptc, CALLER, {}),
      'an empty identity is also key-neutral');
  });
});

describe('cascade cache identity: effort spellings must agree with routing', () => {
  it('flat and nested reasoning.effort route to the same variant and share one warm slot', async () => {
    // 7ed61802 aligned the thinking-sibling route to resolveReasoningEffort
    // (flat || nested, truthy) — the two spellings select the SAME Cascade
    // generation now, so the identity-keyed cache must share the slot.
    seedAccount('flat-vs-nested');
    const state = { dispatches: 0, modelUids: [], contents: [] };

    const flat = await handleChatCompletions(cascadeBody({ reasoning_effort: 'high' }), cascadeDeps('flat answer', state));
    assert.equal(flat.status, 200, JSON.stringify(flat?.body));

    const nested = await handleChatCompletions(cascadeBody({ reasoning: { effort: 'high' } }), cascadeDeps('nested answer', state));

    assert.equal(state.dispatches, 1,
      'the two spellings resolve the same routed generation — one dispatch, the second replays warm');
    assert.deepEqual(state.modelUids, ['claude-sonnet-4-6-thinking']);
    assert.equal(nested.body.choices[0].message.content, 'flat answer',
      'equivalent spellings of one generation must be served by the same cache entry');
  });

  it('a blank flat effort with a nested effort keys by the tier the router consumed', async () => {
    seedAccount('blank-flat');
    const state = { dispatches: 0, modelUids: [], contents: [] };

    const low = await handleChatCompletions(
      cascadeBody({ model: 'gpt-5.5', reasoning_effort: '', reasoning: { effort: 'low' } }), cascadeDeps((n) => `tier-${n}-answer`, state));
    assert.equal(low.status, 200, JSON.stringify(low?.body));

    const high = await handleChatCompletions(
      cascadeBody({ model: 'gpt-5.5', reasoning_effort: '', reasoning: { effort: 'high' } }), cascadeDeps((n) => `tier-${n}-answer`, state));

    assert.equal(state.dispatches, 2,
      'blank-flat + nested low/high merge into different tiers — one key would replay the wrong tier');
    assert.deepEqual(state.modelUids, ['gpt-5-5-low', 'gpt-5-5-high']);
    assert.equal(high.body.choices[0].message.content, 'tier-2-answer');
  });

  it('normalization-equivalent effort spellings share one dispatch', async () => {
    seedAccount('equivalent');
    const state = { dispatches: 0, modelUids: [], contents: [] };

    const first = await handleChatCompletions(cascadeBody({ model: 'gpt-5.5', reasoning_effort: 'HIGH' }), cascadeDeps('canonical answer', state));
    assert.equal(first.status, 200, JSON.stringify(first?.body));
    const second = await handleChatCompletions(cascadeBody({ model: 'gpt-5.5', reasoning_effort: 'high' }), cascadeDeps('second answer', state));

    assert.equal(state.dispatches, 1,
      'case is not a generation boundary — the router treats HIGH and high as one tier');
    assert.equal(second.body.choices[0].message.content, 'canonical answer');

    const minimal = await handleChatCompletions(cascadeBody({ model: 'gpt-5.5', reasoning_effort: 'minimal' }), cascadeDeps('none-tier answer', state));
    const none = await handleChatCompletions(cascadeBody({ model: 'gpt-5.5', reasoning_effort: 'none' }), cascadeDeps('late answer', state));
    assert.deepEqual(state.modelUids.slice(1), ['gpt-5-5-none'],
      'minimal and none are the same tier on the wire — one dispatch serves both spellings');
    assert.equal(state.dispatches, 2, 'the none-tier spellings share one slot (total: high pair + this one)');
    assert.equal(none.body.choices[0].message.content, 'none-tier answer');
  });

  it('control: an exact repeat hits its slot and never re-dispatches', async () => {
    seedAccount('exact-repeat');
    const state = { dispatches: 0, modelUids: [], contents: [] };
    const body = cascadeBody();

    const first = await handleChatCompletions(body, cascadeDeps('first answer', state));
    assert.equal(first.status, 200);
    const second = await handleChatCompletions(body, cascadeDeps('never served', state));

    assert.equal(state.dispatches, 1, 'an exact repeat must be a cache hit');
    assert.equal(second.body.choices[0].message.content, 'first answer');
    assert.equal(cacheStats().hits, 1);
  });

  it('control: distinct tiers still miss and dispatch independently', async () => {
    seedAccount('distinct-tiers');
    const state = { dispatches: 0, modelUids: [], contents: [] };

    await handleChatCompletions(cascadeBody({ model: 'gpt-5.5', reasoning_effort: 'high' }), cascadeDeps('high answer', state));
    await handleChatCompletions(cascadeBody({ model: 'gpt-5.5', reasoning_effort: 'xhigh' }), cascadeDeps('xhigh answer', state));

    assert.equal(state.dispatches, 2, 'different effort tiers are different generations');
    assert.deepEqual(state.modelUids, ['gpt-5-5-high', 'gpt-5-5-xhigh']);
  });
});

describe('connect cache identity: the opt-in sequential preference', () => {
  it('opposite parallel_tool_calls preferences never share a slot while the passthrough is on', async () => {
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOOL_CHOICE = '1';
    seedAccount('sequential');
    const state = { seenFlags: [] };
    connectStub(state);

    const seq = await handleChatCompletions(connectBody({ parallel_tool_calls: false }), { callerKey: CALLER });
    assert.equal(seq.status, 200, JSON.stringify(seq?.body));
    const par = await handleChatCompletions(connectBody({ parallel_tool_calls: true }), { callerKey: CALLER });

    assert.deepEqual(state.seenFlags, [false, true],
      'each preference must reach its own upstream turn — a replay never re-reads the preference');
    assert.equal(par.body.choices[0].message.content, 'prose-2',
      'the parallel-preference turn must not be served the sequential turn\'s prose');
  });

  it('default-equivalent preferences share one slot when the passthrough is off', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    seedAccount('switch-off');
    const state = { seenFlags: [] };
    connectStub(state);

    const first = await handleChatCompletions(connectBody({ parallel_tool_calls: false }), { callerKey: CALLER });
    assert.equal(first.status, 200, JSON.stringify(first?.body));
    const second = await handleChatCompletions(connectBody({ parallel_tool_calls: true }), { callerKey: CALLER });

    assert.equal(state.seenFlags.length, 1,
      'with the switch off the field is dropped on the wire — the two preferences are the same generation');
    assert.equal(second.body.choices[0].message.content, 'prose-1');
  });
});
