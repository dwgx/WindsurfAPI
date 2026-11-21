// Protocol stop-sequence repairs (SEED-C3a / SEED-C3b / SEED-C3c).
//
// What was broken, measured on the audited baseline:
//   * C3b — the Cascade paths never enforced the caller's `stop` at all. The Devin
//     wire has no stop field and only the DEVIN_CONNECT adapter applied the
//     sequence locally, so /v1/chat/completions on a Cascade model returned
//     "hello END tail" for stop:['END'] on every flow (stream and non-stream).
//   * C3a — the Anthropic route recovered `stop_sequence` by testing whether the
//     emitted text ENDED with one of the request's sequences. A real hit strips
//     the matched bytes, so the test could never fire for the case it existed
//     for: the composed Connect route reported stop_reason:'end_turn' with
//     stop_sequence:null while the answer had genuinely been cut at 'END'.
//   * C3c — the non-stream Connect adapter applied the stop gate to the RAW text
//     BEFORE parsing an emulated tool call, so a stop sequence inside a declared
//     call's JSON arguments truncated the markup and dropped the call entirely,
//     while the stream path (which parses first) returned it. Same request, two
//     different answers depending on `stream`.
//
// These are BEHAVIOUR tests driven through the real handlers. The only fakes are
// the upstream boundaries the repository already exposes for exactly this:
// context.WindsurfClient (Cascade, the seam test/cascade-stream-account-spend
// uses) and __setStreamChatForTest (the Connect adapter's event stream). The
// C3a legs additionally drive the REAL chat handler, so the route opt-in that
// carries the matched sequence is exercised rather than assumed.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addAccountByKey,
  getAccountInternal,
  getApiKey,
  removeAccount,
  __setModelCatalogDeps,
} from '../src/auth.js';
import { handleChatCompletions, __setConnectDeps, cascadeCacheIdentity } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { cacheKey, cacheGet, cacheSet } from '../src/cache.js';
import {
  toChatCompletion,
  streamChatCompletion,
  __setStreamChatForTest,
} from '../src/devin-connect-openai.js';

const createdIds = [];
const CASCADE_MODEL = 'gemini-2.5-flash';
const CONNECT_MODEL = 'swe-1-6-slow';
const UPSTREAM_TEXT = 'hello END tail';

let savedEnv = {};

function seed(label, availableModels = null) {
  const a = addAccountByKey(`devin-session-token$proto-${label}-${Math.random().toString(36).slice(2)}`, label);
  createdIds.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.tierManual = true;
  acct.status = 'active';
  if (availableModels) acct.availableModels = availableModels;
  return acct;
}

function fakeResponse() {
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.statusCode = status; return this; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true; },
    on() { return this; }, once() { return this; }, off() { return this; },
    removeListener() { return this; }, emit() { return true; },
  };
}

// Every `data:` frame of an OpenAI SSE stream, parsed.
function sseFrames(body) {
  return String(body)
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice(6))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload));
}

function streamedContent(body) {
  return sseFrames(body)
    .map((frame) => frame.choices?.[0]?.delta?.content)
    .filter((c) => typeof c === 'string')
    .join('');
}

function anthropicEvents(body) {
  const events = [];
  for (const block of String(body).split('\n\n')) {
    if (!block.trim()) continue;
    let event = null;
    let data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) { try { data = JSON.parse(line.slice(6)); } catch { data = null; } }
    }
    if (event) events.push({ event, data });
  }
  return events;
}

function anthropicText(events) {
  return events
    .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
}

/** Cascade context: the same fake-client seam test/cascade-stream-account-spend.test.js uses. */
function cascadeContextFor({ text = UPSTREAM_TEXT } = {}) {
  let calls = 0;
  class FakeClient {
    async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
      calls++;
      const usage = { inputTokens: 11, outputTokens: 5 };
      if (opts.onChunk) {
        opts.onChunk({ text });
        return { text: '', toolCalls: [], usage };
      }
      return Object.assign([{ text }], { toolCalls: [], usage });
    }
    async rawGetChatMessage(_messages, _modelEnum, _modelUid, opts = {}) {
      calls++;
      if (opts.onChunk) {
        opts.onChunk({ text });
        return undefined;
      }
      return [{ text }];
    }
  }
  const ctx = {
    waitForAccount(tried, _signal, _maxWait, modelKey) { return getApiKey(tried, modelKey); },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
  };
  Object.defineProperty(ctx, 'upstreamCalls', { get: () => calls });
  return ctx;
}

beforeEach(() => {
  savedEnv = {
    devinConnect: process.env.DEVIN_CONNECT,
    devinOnly: process.env.DEVIN_ONLY,
  };
  // Cascade transport by default; the C3a/C3c legs opt back in explicitly.
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_ONLY;
  // Account creation kicks off a model-catalog sync; stub its RPCs so the fixture
  // never dials the provider (the same boundary the protocol probes use).
  __setModelCatalogDeps({
    getCascadeModelConfigs: async () => ({ configs: [] }),
    fetchConnectCatalog: async () => [],
    disableConnectSync: true,
  });
});

afterEach(() => {
  // Only ids this file created — never map removeAccount over the account list.
  while (createdIds.length) { try { removeAccount(createdIds.pop()); } catch {} }
  __setStreamChatForTest(null);
  __setConnectDeps(null);
  if (savedEnv.devinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = savedEnv.devinConnect;
  if (savedEnv.devinOnly === undefined) delete process.env.DEVIN_ONLY;
  else process.env.DEVIN_ONLY = savedEnv.devinOnly;
});

describe('SEED-C3b: the Cascade route enforces the caller stop sequence', () => {
  it('non-stream returns the stopped prefix instead of the full answer', async () => {
    seed('c3b-ns');
    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(
      { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'hi' }], stop: ['END'] },
      ctx,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'hello ');
    assert.ok(!JSON.stringify(result.body).includes('END tail'), 'the post-stop tail never reaches the client');
    assert.equal(result.body.choices[0].finish_reason, 'stop');
    assert.equal(ctx.upstreamCalls, 1);
  });

  it('non-stream without a stop returns the full answer (control)', async () => {
    seed('c3b-ns-nostop');
    const result = await handleChatCompletions(
      { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      cascadeContextFor(),
    );
    assert.equal(result.body.choices[0].message.content, UPSTREAM_TEXT);
  });

  it('non-stream with no match returns the full answer (control)', async () => {
    seed('c3b-ns-nomatch');
    const result = await handleChatCompletions(
      { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'hi' }], stop: ['NOT-PRESENT'] },
      cascadeContextFor(),
    );
    assert.equal(result.body.choices[0].message.content, UPSTREAM_TEXT);
  });

  it('non-stream with a first-character stop is a successful empty answer (control)', async () => {
    seed('c3b-ns-zeroprefix');
    const result = await handleChatCompletions(
      { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'hi' }], stop: ['hello'] },
      cascadeContextFor(),
    );
    assert.equal(result.status, 200, 'a zero-prefix stop is an answer, not an upstream failure');
    assert.equal(result.body.choices[0].message.content, null);
    assert.equal(result.body.choices[0].finish_reason, 'stop');
  });

  it('stream delivers the stopped prefix once, with one terminal frame and one DONE', async () => {
    seed('c3b-stream');
    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(
      { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'hi' }], stop: ['END'], stream: true },
      ctx,
    );
    assert.equal(result.status, 200);
    const res = fakeResponse();
    await result.handler(res);
    assert.equal(streamedContent(res.body), 'hello ');
    assert.ok(!res.body.includes('END tail'), 'no post-stop bytes escape, in any frame');
    assert.equal(sseFrames(res.body).filter((f) => f.choices?.[0]?.finish_reason).length, 1);
    assert.equal(String(res.body).split('data: [DONE]').length - 1, 1);
    assert.equal(ctx.upstreamCalls, 1);
  });

  it('stream without a stop keeps the full answer and its byte order (control)', async () => {
    seed('c3b-stream-nostop');
    const result = await handleChatCompletions(
      { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      cascadeContextFor(),
    );
    const res = fakeResponse();
    await result.handler(res);
    assert.equal(streamedContent(res.body), UPSTREAM_TEXT);
  });

  it('a second identical request replays from cache with no producer call, in both modes', async () => {
    seed('c3b-cache');
    const callerKey = 'proto-key:user:c3b-cache';
    const ctx = cascadeContextFor();
    const body = { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'cache me' }], stop: ['END'] };

    const first = await handleChatCompletions(body, { ...ctx, callerKey });
    assert.equal(first.body.choices[0].message.content, 'hello ');
    const second = await handleChatCompletions(body, { ...ctx, callerKey });
    assert.equal(second.body.choices[0].message.content, 'hello ', 'the replay serves the same fenced text');
    assert.equal(ctx.upstreamCalls, 1, 'the second request never reached the producer');

    const ctxStream = cascadeContextFor();
    // A separate caller scope: the response cache is keyed by caller + normalized
    // body, and `stream` is not part of that normalization, so the two modes must
    // not share a fixture slot here.
    const streamCallerKey = 'proto-key:user:c3b-cache-stream';
    const streamBody = { ...body, stream: true };
    const s1 = await handleChatCompletions(streamBody, { ...ctxStream, callerKey: streamCallerKey });
    const res1 = fakeResponse();
    await s1.handler(res1);
    const s2 = await handleChatCompletions(streamBody, { ...ctxStream, callerKey: streamCallerKey });
    const res2 = fakeResponse();
    await s2.handler(res2);
    assert.equal(streamedContent(res1.body), 'hello ');
    assert.equal(streamedContent(res2.body), 'hello ');
    assert.ok(!res2.body.includes('END tail'));
    assert.equal(ctxStream.upstreamCalls, 1, 'the streamed replay never reached the producer');
  });

  it('a cache hit still reports the exact stop cause through the Anthropic route', async () => {
    seed('c3b-cache-cause');
    const callerKey = 'proto-key:user:c3b-cause';
    const ctx = cascadeContextFor();
    const run = (body, context) => handleChatCompletions(body, { ...ctx, ...context });
    const request = {
      model: CASCADE_MODEL,
      messages: [{ role: 'user', content: 'cause leg' }],
      stop_sequences: ['END'],
    };
    const first = await handleMessages(request, { callerKey, handleChatCompletions: run });
    assert.equal(first.body.content[0].text, 'hello ');
    assert.equal(first.body.stop_reason, 'stop_sequence');
    assert.equal(first.body.stop_sequence, 'END');
    assert.equal(ctx.upstreamCalls, 1);

    const second = await handleMessages(request, { callerKey, handleChatCompletions: run });
    assert.equal(ctx.upstreamCalls, 1, 'the second request was served from the cache');
    assert.equal(second.body.content[0].text, 'hello ', 'the replay serves the fenced text');
    assert.equal(second.body.stop_reason, 'stop_sequence', 'the cached cause survives the replay');
    assert.equal(second.body.stop_sequence, 'END');
  });

  it('a raw cache entry is re-enforced on replay instead of leaking the sentinel', async () => {
    seed('c3b-cache-raw');
    const callerKey = 'proto-key:user:c3b-raw';
    const body = { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'raw entry' }], stop: ['END'] };
    // An entry written before the repair: raw upstream text, no recorded cause.
    // Seed under the routed identity — the handler looks up by the effective
    // generation, not the raw spelling (BLUE-CACHE P2).
    const key = cacheKey(body, callerKey, cascadeCacheIdentity(body));
    assert.ok(key, 'the fixture needs a shareable per-user cache key');
    cacheSet(key, { text: UPSTREAM_TEXT, thinking: '' });
    assert.ok(cacheGet(key), 'the raw entry is in the cache');

    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(body, { ...ctx, callerKey });
    assert.equal(result.body.choices[0].message.content, 'hello ');
    assert.equal(ctx.upstreamCalls, 0, 'the replay came from the cache');
  });
});

describe('SEED-C3a: the exact matched sequence reaches the Anthropic route', () => {
  const connectEvents = [
    { type: 'content', text: 'hello E' },
    { type: 'content', text: 'ND tail' },
    { type: 'finish', reason: 'stop' },
  ];

  function connectContext() {
    return {
      waitForAccount(tried, _signal, _maxWait, modelKey) { return getApiKey(tried, modelKey); },
      ensureLs: async () => {},
      getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
    };
  }

  function fakeUpstream(events) {
    return async function* () { for (const ev of events) yield ev; };
  }

  async function viaRealChatHandler(requestBody, events = connectEvents) {
    process.env.DEVIN_CONNECT = '1';
    seed('c3a', [CONNECT_MODEL]);
    __setStreamChatForTest(fakeUpstream(events));
    const ctx = connectContext();
    return handleMessages(requestBody, {
      // The REAL handler, so the route opt-in that carries the matched sequence
      // is exercised end to end.
      handleChatCompletions: (body, context) => handleChatCompletions(body, { ...ctx, ...context }),
    });
  }

  it('non-stream reports stop_reason stop_sequence with the exact sequence', async () => {
    const result = await viaRealChatHandler({
      model: CONNECT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
      stop_sequences: ['END'],
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.content.filter((c) => c.type === 'text').map((c) => c.text).join(''), 'hello ');
    assert.equal(result.body.stop_reason, 'stop_sequence');
    assert.equal(result.body.stop_sequence, 'END');
    assert.ok(!JSON.stringify(result.body).includes('_windsurf_stop_sequence'), 'the carrier stays internal');
  });

  it('stream reports stop_reason stop_sequence in message_delta', async () => {
    const result = await viaRealChatHandler({
      model: CONNECT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
      stop_sequences: ['END'],
      stream: true,
    });
    const res = fakeResponse();
    await result.handler(res);
    const events = anthropicEvents(res.body);
    const delta = events.find((e) => e.event === 'message_delta');
    assert.equal(anthropicText(events), 'hello ');
    assert.equal(delta.data.delta.stop_reason, 'stop_sequence');
    assert.equal(delta.data.delta.stop_sequence, 'END');
    assert.ok(!res.body.includes('_windsurf_stop_sequence'), 'the carrier stays internal');
  });

  it('a natural completion with identical visible text stays end_turn/null (control)', async () => {
    const result = await viaRealChatHandler({
      model: CONNECT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
      stop_sequences: ['END'],
    }, [{ type: 'content', text: 'hello ' }, { type: 'finish', reason: 'stop' }]);
    assert.equal(result.body.content.filter((c) => c.type === 'text').map((c) => c.text).join(''), 'hello ');
    assert.equal(result.body.stop_reason, 'end_turn');
    assert.equal(result.body.stop_sequence, null);
  });

  it('a sequence the caller did not send is never echoed (control)', async () => {
    const result = await viaRealChatHandler({
      model: CONNECT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
      stop_sequences: ['NOT-END'],
    });
    assert.equal(
      result.body.content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
      'hello END tail',
      'a stop the caller did not send does not fence the answer',
    );
    assert.equal(result.body.stop_reason, 'end_turn');
    assert.equal(result.body.stop_sequence, null);
  });

  it('a first-character stop is a successful empty stopped answer (control)', async () => {
    const result = await viaRealChatHandler({
      model: CONNECT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
      stop_sequences: ['hello'],
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.content.filter((c) => c.type === 'text').map((c) => c.text).join(''), '');
    assert.equal(result.body.stop_reason, 'stop_sequence');
    assert.equal(result.body.stop_sequence, 'hello');
  });

  it('the direct OpenAI route exposes no private stop field', async () => {
    process.env.DEVIN_CONNECT = '1';
    seed('c3a-openai', [CONNECT_MODEL]);
    __setStreamChatForTest(fakeUpstream(connectEvents));
    const result = await handleChatCompletions(
      { model: CONNECT_MODEL, messages: [{ role: 'user', content: 'hi' }], stop: ['END'] },
      connectContext(),
    );
    assert.equal(result.body.choices[0].message.content, 'hello ');
    assert.ok(!('_windsurf_stop_sequence' in result.body.choices[0]), 'direct OpenAI clients keep the public shape');
  });
});

describe('SEED-C3c: a declared structured call survives a sentinel in its arguments', () => {
  const TOOLS = [{
    type: 'function',
    function: { name: 'f', description: 'probe tool', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
  }];
  const ANSWER = '<tool_call>{"name": "f", "arguments": {"x": "END"}}</tool_call>';

  function fakeUpstream(text) {
    return async function* () {
      yield { type: 'content', text };
      yield { type: 'finish', reason: 'stop' };
    };
  }

  afterEach(() => { __setStreamChatForTest(null); });

  it('non-stream returns the same call the stream path returns', async () => {
    __setStreamChatForTest(fakeUpstream(ANSWER));
    const { body } = await toChatCompletion(
      { model: CONNECT_MODEL, messages: [], tools: TOOLS },
      { emulateTools: true, stop: ['END'] },
    );
    const msg = body.choices[0].message;
    assert.equal(msg.tool_calls?.[0]?.function?.name, 'f');
    assert.equal(msg.tool_calls?.[0]?.function?.arguments, '{"x":"END"}');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.ok(!String(msg.content || '').includes('<tool_call>'), 'no truncated markup is handed back as prose');
  });

  it('stream returns the same call (control)', async () => {
    __setStreamChatForTest(fakeUpstream(ANSWER));
    const frames = [];
    await streamChatCompletion(
      { model: CONNECT_MODEL, messages: [], tools: TOOLS },
      (d) => frames.push(d),
      { id: 'c3c', created: 1, emulateTools: true, stop: ['END'] },
    );
    const toolDeltas = frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls || []);
    assert.equal(toolDeltas[0]?.function?.name, 'f');
    assert.equal(toolDeltas[0]?.function?.arguments, '{"x":"END"}');
    assert.equal(frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean).pop(), 'tool_calls');
  });

  it('a complete declared call preserves its opaque arguments (control)', async () => {
    __setStreamChatForTest(fakeUpstream(ANSWER));
    const { body } = await toChatCompletion(
      { model: CONNECT_MODEL, messages: [], tools: TOOLS },
      { emulateTools: true, stop: ['END'] },
    );
    const msg = body.choices[0].message;
    assert.equal(msg.tool_calls?.[0]?.function?.arguments, '{"x":"END"}');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
  });

  it('an undeclared tool stays unfiltered by the stop gate and is not surfaced (control)', async () => {
    __setStreamChatForTest(fakeUpstream('<tool_call>{"name": "other", "arguments": {"x": "END"}}</tool_call>'));
    const { body } = await toChatCompletion(
      { model: CONNECT_MODEL, messages: [], tools: TOOLS },
      { emulateTools: true, stop: ['END'] },
    );
    const msg = body.choices[0].message;
    assert.equal(msg.tool_calls, undefined, 'the ToolGuard allowlist still drops calls the caller never declared');
  });
});

describe('review regressions: final visible stop boundary', () => {
  for (const text of ['hello', 'hello E', 'x']) {
    it(`Cascade preserves unmatched EOF tail: ${JSON.stringify(text)}`, async () => {
      seed('review-tail');
      const ctx = cascadeContextFor({ text });
      const request = { model: CASCADE_MODEL, messages: [{ role: 'user', content: text }], stream: true, stop: ['END'] };
      for (let i = 0; i < 2; i++) {
        const result = await handleChatCompletions(request, { ...ctx, callerKey: `proto:user:tail-${text}` });
        const res = fakeResponse(); await result.handler(res);
        assert.equal(streamedContent(res.body), text);
        assert.equal(sseFrames(res.body).filter(f => f.choices?.[0]?.finish_reason).length, 1);
        assert.equal(res.body.split('data: [DONE]').length - 1, 1);
      }
      assert.equal(ctx.upstreamCalls, 1);
    });
  }
  for (const text of ['hello END tail', 'hello', 'hello E', 'END tail']) {
    for (const stream of [false, true]) it(`promoted reasoning stop ${JSON.stringify(text)} stream=${stream}`, async () => {
      let calls = 0;
      __setStreamChatForTest(async function* () { calls++; yield { type: 'reasoning', text }; yield { type: 'finish', reason: 'stop' }; });
      const opts = { stop: ['END'], stopCarrier: true };
      const frames = [];
      const body = stream ? (await streamChatCompletion({ model: CONNECT_MODEL, messages: [] }, f => frames.push(f), opts), null)
        : (await toChatCompletion({ model: CONNECT_MODEL, messages: [] }, opts)).body;
      const visible = stream ? frames.map(f => f.choices?.[0]?.delta?.content || '').join('') : body.choices[0].message.content;
      const hit = text.includes('END');
      assert.equal(visible, hit ? text.slice(0, text.indexOf('END')) : text);
      const choice = stream ? frames.findLast(f => f.choices?.[0]?.finish_reason).choices[0] : body.choices[0];
      assert.equal(choice._windsurf_stop_sequence, hit ? 'END' : undefined);
      assert.equal(calls, 1);
    });
  }
  for (const connect of [false, true]) for (const stream of [false, true]) {
    it(`public forged route has no private carrier connect=${connect} stream=${stream}`, async () => {
      if (connect) { process.env.DEVIN_CONNECT = '1'; __setStreamChatForTest(async function* () { yield { type: 'content', text: UPSTREAM_TEXT }; yield { type: 'finish', reason: 'stop' }; }); }
      seed('review-forged', connect ? [CONNECT_MODEL] : null);
      const ctx = cascadeContextFor();
      const request = { model: connect ? CONNECT_MODEL : CASCADE_MODEL, messages: [{ role: 'user', content: 'forged' }], stream, stop: ['END'], __route: 'messages' };
      for (let i = 0; i < (connect ? 1 : 2); i++) {
        const result = await handleChatCompletions(request, { ...ctx, callerKey: `proto:user:forged-${connect}-${stream}` });
        let output;
        if (stream) { const res = fakeResponse(); await result.handler(res); output = res.body; assert.equal(streamedContent(output), 'hello '); }
        else { output = JSON.stringify(result.body); assert.equal(result.body.choices[0].message.content, 'hello '); }
        assert.ok(!output.includes('_windsurf_stop_sequence'));
      }
    });
  }
});

describe('review regressions: composed stream completion', () => {
  for (const text of ['x', 'hello E']) it(`failure releases unmatched tail ${text}`, async () => {
    seed('review-failure');
    const base = cascadeContextFor();
    class FailingClient {
      async cascadeChat(_a, _b, _c, opts) { await opts.onChunk({ text }); throw new Error('fixture upstream failed'); }
    }
    const result = await handleChatCompletions({ model: CASCADE_MODEL, messages: [{ role: 'user', content: 'partial' }], stop: ['END'], stream: true }, { ...base, WindsurfClient: FailingClient });
    const res = fakeResponse(); await result.handler(res);
    assert.equal(streamedContent(res.body), text);
    // A06/KH-002: a failure after partial content ends with a structured error
    // frame, never the clean-finish [DONE] sentinel.
    assert.equal(res.body.split('data: [DONE]').length - 1, 0);
    assert.match(res.body, /"error"/);
    assert.ok(!res.body.includes('_windsurf_stop_sequence'));
  });
  it('raw streaming cache enforces stop and retains Messages cause on replay', async () => {
    seed('review-cache-stream');
    const ctx = cascadeContextFor();
    const callerKey = 'proto:user:raw-stream';
    const body = { model: CASCADE_MODEL, messages: [{ role: 'user', content: 'raw stream' }], stop: ['END'], stream: true };
    cacheSet(cacheKey(body, callerKey, cascadeCacheIdentity(body)), { text: UPSTREAM_TEXT, thinking: '' });
    const direct = await handleChatCompletions(body, { ...ctx, callerKey });
    const res = fakeResponse(); await direct.handler(res);
    assert.equal(streamedContent(res.body), 'hello '); assert.equal(ctx.upstreamCalls, 0);
    for (let i = 0; i < 2; i++) {
      const result = await handleMessages({ model: CASCADE_MODEL, messages: [{ role: 'user', content: 'messages stream' }], stop_sequences: ['END'], stream: true }, { callerKey, handleChatCompletions: (b, c) => handleChatCompletions(b, { ...ctx, ...c }) });
      const out = fakeResponse(); await result.handler(out);
      const events = anthropicEvents(out.body);
      assert.equal(anthropicText(events), 'hello ');
      assert.equal(events.find(e => e.event === 'message_delta').data.delta.stop_sequence, 'END');
    }
    assert.equal(ctx.upstreamCalls, 1);
  });
});
