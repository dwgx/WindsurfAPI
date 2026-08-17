import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toChatCompletion,
  streamChatCompletion,
  __setStreamChatForTest,
} from '../src/devin-connect-openai.js';

afterEach(() => __setStreamChatForTest(null));

// Build a fake streamChat that yields a scripted event sequence.
function fakeStream(events) {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

const SAMPLE = [
  { type: 'reasoning', text: 'let me think ' },
  { type: 'reasoning', text: 'about it.' },
  { type: 'content', text: 'The answer ' },
  { type: 'content', text: 'is 42.' },
  { type: 'finish', reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
];

describe('toChatCompletion (non-stream)', () => {
  it('keeps both when reasoning and content differ', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'reasoning', text: 'the deliberation' },
      { type: 'content', text: 'the answer' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    const msg = body.choices[0].message;
    assert.equal(msg.content, 'the answer');
    assert.equal(msg.reasoning_content, 'the deliberation');
  });

  it('assembles a chat.completion with separated content and reasoning', async () => {
    __setStreamChatForTest(fakeStream(SAMPLE));
    const { status, body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(status, 200);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'swe-1-6-slow');
    const msg = body.choices[0].message;
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.content, 'The answer is 42.');
    assert.equal(msg.reasoning_content, 'let me think about it.');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('echoes displayModel over the request model when given', async () => {
    __setStreamChatForTest(fakeStream(SAMPLE));
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] }, { displayModel: 'claude-sonnet-4-6' });
    assert.equal(body.model, 'claude-sonnet-4-6');
  });

  it('MOVES reasoning into content when the model returns no answer text', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'reasoning', text: 'hmm' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    const message = body.choices[0].message;
    assert.equal(message.content, 'hmm', 'the answer must be visible to the client');
    // Moved, not copied. This assertion used to require BOTH fields to carry the
    // same text, which made every client that renders reasoning show the answer
    // twice — and on the Anthropic route produced a `thinking` block and a `text`
    // block with byte-identical content. Nothing is lost by dropping the duplicate:
    // the text is still delivered, once, in the field the client renders as the
    // answer.
    assert.equal(message.reasoning_content, undefined,
      'reasoning_content must be dropped once its text has been promoted into content, '
      + 'or the same answer is rendered twice');
  });

  it('omits usage when the upstream gave none', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'hi' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    assert.equal('usage' in body, false);
  });

  it('preserves fractional ACU billing for the account-spend caller', async () => {
    const acu = 0.0006735000060871243;
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'ok' },
      { type: 'finish', reason: 'stop', usage: null, billing: { committed_acu_cost: acu } },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    assert.deepEqual(body._windsurf_billing, { committed_acu_cost: acu });
  });

  it('uses a stable id/created when supplied', async () => {
    __setStreamChatForTest(fakeStream(SAMPLE));
    const { body } = await toChatCompletion({ model: 'm', messages: [] }, { id: 'chatcmpl-fixed', created: 123 });
    assert.equal(body.id, 'chatcmpl-fixed');
    assert.equal(body.created, 123);
  });

  it('retries a transient failure then succeeds (no token duplication)', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      if (calls === 1) {
        // fail AFTER yielding a partial — the retry must discard it cleanly.
        yield { type: 'content', text: 'PARTIAL' };
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      }
      yield { type: 'content', text: 'clean answer' };
      yield { type: 'finish', reason: 'stop', usage: null };
    });
    const { body } = await toChatCompletion({ model: 'm', messages: [] }, { retryBaseMs: 1 });
    assert.equal(calls, 2);
    assert.equal(body.choices[0].message.content, 'clean answer'); // no leading PARTIAL
  });

  it('does not retry a terminal MODEL_BLOCKED error', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      throw Object.assign(new Error('/upgrade required'), { code: 'MODEL_BLOCKED' });
    });
    await assert.rejects(
      toChatCompletion({ model: 'm', messages: [] }, { retryBaseMs: 1 }),
      /upgrade/,
    );
    assert.equal(calls, 1); // one attempt, no retry
  });

  it('gives up after maxRetries on a persistent transient error', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      throw Object.assign(new Error('down'), { code: 'ETIMEDOUT' });
    });
    await assert.rejects(
      toChatCompletion({ model: 'm', messages: [] }, { maxRetries: 2, retryBaseMs: 1 }),
      /down/,
    );
    assert.equal(calls, 3); // initial + 2 retries
  });
});

describe('streamChatCompletion (SSE)', () => {
  function collectSend() {
    const frames = [];
    return { send: (d) => frames.push(d), frames };
  }

  it('emits role-prime, reasoning, content, finish, and usage chunks in order', async () => {
    __setStreamChatForTest(fakeStream(SAMPLE));
    const { send, frames } = collectSend();
    // O1: the trailing usage frame is opt-in; this test asserts its shape.
    const result = await streamChatCompletion({ model: 'swe-1-6-slow', messages: [] }, send, { id: 'x', created: 1, includeUsage: true });

    // 1. role-prime
    assert.deepEqual(frames[0].choices[0].delta, { role: 'assistant', content: '' });
    // every chunk carries the chat.completion.chunk envelope
    for (const f of frames) {
      assert.equal(f.object, 'chat.completion.chunk');
      assert.equal(f.id, 'x');
      assert.equal(f.created, 1);
    }
    // reasoning chunks precede content chunks
    const kinds = frames.map(f => {
      const d = f.choices[0]?.delta;
      if (d?.reasoning_content != null) return 'reasoning';
      if (d?.content && f.choices[0].finish_reason == null && !('role' in d)) return 'content';
      if (f.choices[0]?.finish_reason) return 'finish';
      if (f.choices.length === 0) return 'usage';
      return 'role';
    });
    assert.equal(kinds[0], 'role');
    const firstReasoning = kinds.indexOf('reasoning');
    const firstContent = kinds.indexOf('content');
    assert.ok(firstReasoning > 0 && firstReasoning < firstContent, 'reasoning before content');
    assert.equal(kinds.at(-2), 'finish');
    assert.equal(kinds.at(-1), 'usage');

    // finish chunk shape
    const finish = frames.find(f => f.choices[0]?.finish_reason === 'stop');
    assert.deepEqual(finish.choices[0].delta, {});
    // usage chunk shape
    const usageFrame = frames.find(f => f.choices.length === 0);
    assert.deepEqual(usageFrame.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    // returns the assembled result for caching
    assert.equal(result.content, 'The answer is 42.');
    assert.equal(result.reasoning, 'let me think about it.');
    assert.equal(result.finish_reason, 'stop');
  });

  it('does not emit a usage frame when upstream had no usage', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'hi' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    await streamChatCompletion({ model: 'm', messages: [] }, send);
    assert.equal(frames.some(f => f.choices.length === 0), false);
  });

  it('returns fractional ACU billing to the handler without exposing it in SSE chunks', async () => {
    const acu = 0.0006735000060871243;
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'ok' },
      { type: 'finish', reason: 'stop', usage: null, billing: { committed_acu_cost: acu } },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send);
    assert.deepEqual(result.billing, { committed_acu_cost: acu });
    assert.ok(frames.every((frame) => !('_windsurf_billing' in frame) && !('billing' in frame)));
  });

  it('streams each content delta as its own chunk (verbatim, not coalesced)', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'a' },
      { type: 'content', text: 'b' },
      { type: 'content', text: 'c' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    await streamChatCompletion({ model: 'm', messages: [] }, send);
    const contentDeltas = frames
      .map(f => f.choices[0]?.delta?.content)
      .filter(c => c != null && c !== '');
    assert.deepEqual(contentDeltas, ['a', 'b', 'c']);
  });
});

// Tool emulation: the connect models have no native function-calling, so the
// adapter parses <tool_call>{...}</tool_call> markup out of the answer (the
// same machinery the Cascade path uses) and surfaces OpenAI tool_calls.
describe('toChatCompletion tool emulation', () => {
  const TOOL_ANSWER = '<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool_call>';

  it('extracts a tool_call and sets finish_reason=tool_calls, content=null', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: TOOL_ANSWER },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [], tools: [{ type: 'function', function: { name: 'get_weather' } }] }, { emulateTools: true });
    const msg = body.choices[0].message;
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(msg.content, null);
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].type, 'function');
    assert.equal(msg.tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: 'Paris' });
    assert.ok(msg.tool_calls[0].id, 'has an id');
  });

  it('leaves a plain answer untouched when emulateTools is on but no markup present', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'just a normal answer' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'search' } }] }, { emulateTools: true });
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.choices[0].message.content, 'just a normal answer');
    assert.equal('tool_calls' in body.choices[0].message, false);
  });

  it('does NOT parse tool markup when emulateTools is off (passes through as text)', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: TOOL_ANSWER },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] }); // no emulateTools
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.choices[0].message.content, TOOL_ANSWER);
  });
});

describe('streamChatCompletion tool emulation', () => {
  function collectSend() {
    const frames = [];
    return { send: (d) => frames.push(d), frames };
  }

  it('emits a tool_calls delta and finishes with finish_reason=tool_calls', async () => {
    // Split the markup across deltas to exercise the streaming parser's
    // cross-chunk buffering.
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: '<tool_call>{"name": "search", ' },
      { type: 'content', text: '"arguments": {"q": "cats"}}</tool_call>' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    const tools = [{ type: 'function', function: { name: 'search' } }];
    const result = await streamChatCompletion({ model: 'swe-1-6-slow', messages: [], tools }, send, { emulateTools: true });

    const toolFrame = frames.find(f => f.choices[0]?.delta?.tool_calls);
    assert.ok(toolFrame, 'a tool_calls delta was emitted');
    const tc = toolFrame.choices[0].delta.tool_calls[0];
    assert.equal(tc.index, 0);
    assert.equal(tc.type, 'function');
    assert.equal(tc.function.name, 'search');
    assert.deepEqual(JSON.parse(tc.function.arguments), { q: 'cats' });

    const finish = frames.find(f => f.choices[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
    assert.equal(result.finish_reason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);

    // The tool markup must NOT leak into content deltas.
    const leaked = frames.map(f => f.choices[0]?.delta?.content || '').join('');
    assert.equal(leaked.includes('<tool_call>'), false, 'markup leaked to content');
  });

  it('streams normal text untouched when emulateTools is on but no tool markup', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'hello ' },
      { type: 'content', text: 'world' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send, { emulateTools: true });
    const text = frames.map(f => f.choices[0]?.delta?.content || '').join('');
    assert.equal(text, 'hello world');
    assert.equal(result.finish_reason, 'stop');
    assert.equal(result.toolCalls.length, 0);
  });

  it('ToolGuard: drops tool_calls not in declared tools[] (P1 allowlist)', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: '<tool_call>{"name": "search", ' },
      { type: 'content', text: '"arguments": {"q": "cats"}}</tool_call>' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    // No tools[] declared → ToolGuard drops the parsed call entirely.
    await streamChatCompletion({ model: 'swe-1-6-slow', messages: [] }, send, { emulateTools: true });
    const toolFrame = frames.find(f => f.choices[0]?.delta?.tool_calls);
    assert.ok(!toolFrame, 'undeclared tool_call must be filtered (ToolGuard parity)');
  });
});


// Native tool calls: when DEVIN_CONNECT_TOOL_CALL_TAGS is calibrated, streamChat
// surfaces real ChatToolCall structs on the terminal finish event
// (devin-connect.js:927) as ev.toolCalls = [{ id, name, arguments }] where
// `arguments` is the raw JSON string. The adapter must translate these to
// OpenAI tool_calls WITHOUT also running text emulation (the two are mutually
// exclusive — calibrated native means no <tool_call> markup in the text).
describe('toChatCompletion native tool calls', () => {
  const NATIVE = [
    { type: 'content', text: 'let me check that' },
    {
      type: 'finish', reason: 'stop', usage: null,
      toolCalls: [{ id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' }],
    },
  ];

  it('translates ev.toolCalls into OpenAI tool_calls and sets finish_reason', async () => {
    __setStreamChatForTest(fakeStream(NATIVE));
    const { body } = await toChatCompletion({ model: 'claude-sonnet-4-6', messages: [] });
    const msg = body.choices[0].message;
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(msg.content, null);
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].id, 'call_abc');
    assert.equal(msg.tool_calls[0].type, 'function');
    assert.equal(msg.tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: 'Paris' });
  });

  it('native wins over emulation — markup in text is NOT double-counted', async () => {
    // Both a native tool call AND <tool_call> markup present: native takes the
    // call, the text parser must not run (no second/duplicate tool_call).
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: '<tool_call>{"name":"shadow","arguments":{}}</tool_call>' },
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ id: 'call_real', name: 'real_tool', arguments: '{"a":1}' }],
      },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'search' } }] }, { emulateTools: true });
    const msg = body.choices[0].message;
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].function.name, 'real_tool');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
  });

  it('handles multiple (parallel) native tool calls', async () => {
    __setStreamChatForTest(fakeStream([
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [
          { id: 'c1', name: 'a', arguments: '{"x":1}' },
          { id: 'c2', name: 'b', arguments: '{"y":2}' },
        ],
      },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    const calls = body.choices[0].message.tool_calls;
    assert.equal(calls.length, 2);
    assert.equal(calls[0].function.name, 'a');
    assert.equal(calls[1].function.name, 'b');
  });

  it('falls back to text emulation when finish carries no native tool calls', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: '<tool_call>{"name":"search","arguments":{"q":"x"}}</tool_call>' },
      { type: 'finish', reason: 'stop', usage: null }, // no toolCalls field
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'search' } }] }, { emulateTools: true });
    const msg = body.choices[0].message;
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].function.name, 'search');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
  });

  it('ignores an empty native toolCalls array (stays plain text)', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'plain answer' },
      { type: 'finish', reason: 'stop', usage: null, toolCalls: [] },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.choices[0].message.content, 'plain answer');
    assert.equal('tool_calls' in body.choices[0].message, false);
  });
});

describe('streamChatCompletion native tool calls', () => {
  function collectSend() {
    const frames = [];
    return { send: (d) => frames.push(d), frames };
  }

  it('emits a tool_calls delta from ev.toolCalls and finishes with tool_calls', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'checking…' },
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ id: 'call_xyz', name: 'lookup', arguments: '{"id":7}' }],
      },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send);

    const toolFrame = frames.find(f => f.choices[0]?.delta?.tool_calls);
    assert.ok(toolFrame, 'a tool_calls delta was emitted');
    const tc = toolFrame.choices[0].delta.tool_calls[0];
    assert.equal(tc.index, 0);
    assert.equal(tc.id, 'call_xyz');
    assert.equal(tc.type, 'function');
    assert.equal(tc.function.name, 'lookup');
    assert.deepEqual(JSON.parse(tc.function.arguments), { id: 7 });

    const finish = frames.find(f => f.choices[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
    assert.equal(result.finish_reason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);

    // The plain content still streams through (native doesn't strip text).
    const text = frames.map(f => f.choices[0]?.delta?.content || '').join('');
    assert.equal(text, 'checking…');
  });

  it('native wins over emulation in the stream — no duplicate tool_calls delta', async () => {
    // On the wire native and emulation never coexist (calibrated native means
    // the model emits structured calls, not <tool_call> text markup). The
    // de-dup guard makes that structural: if emulation already streamed a call
    // inline, native is suppressed at finish so the call is never counted twice.
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: '<tool_call>{"name":"emulated","arguments":{}}</tool_call>' },
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ id: 'call_real', name: 'real_tool', arguments: '{"a":1}' }],
      },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send, { emulateTools: true });

    const toolFrames = frames.filter(f => f.choices[0]?.delta?.tool_calls);
    assert.equal(toolFrames.length, 1, 'exactly one tool_calls delta (no double count)');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.finish_reason, 'tool_calls');
  });

  it('native emits in the stream when emulation produced nothing', async () => {
    // Realistic calibrated-native shape: structured call at finish, no markup.
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'checking…' },
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ id: 'call_real', name: 'real_tool', arguments: '{"a":1}' }],
      },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send, { emulateTools: true });

    const toolFrames = frames.filter(f => f.choices[0]?.delta?.tool_calls);
    assert.equal(toolFrames.length, 1);
    assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].function.name, 'real_tool');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.finish_reason, 'tool_calls');
  });

  it('emits multiple parallel native tool calls on distinct indices', async () => {
    __setStreamChatForTest(fakeStream([
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [
          { id: 'c1', name: 'a', arguments: '{}' },
          { id: 'c2', name: 'b', arguments: '{}' },
        ],
      },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send);
    const toolFrames = frames.filter(f => f.choices[0]?.delta?.tool_calls);
    const indices = toolFrames.map(f => f.choices[0].delta.tool_calls[0].index);
    assert.deepEqual(indices, [0, 1]);
    assert.equal(result.toolCalls.length, 2);
  });
});

// retry-on-empty: NON-weak models occasionally return a COMPLETED turn
// (finish=stop) with zero content — probabilistic upstream capacity jitter. The
// adapter transparently re-issues the identical request a bounded number of
// times. It must (a) heal a subsequent real answer, (b) never trim tools, (c) not
// retry a genuine terminal state, (d) be a no-op on the hot path. NOTE: weak
// models (fable) are EXEMPT — their empties are deterministic (paid 27/27), so
// retry only amplifies rate limits; see the dedicated weak-model test below.
describe('retry-on-empty (fable capacity-jitter self-heal)', () => {
  const RETRY_ENV = ['DEVIN_CONNECT_RETRY_ON_EMPTY', 'DEVIN_CONNECT_RETRY_ON_EMPTY_MAX', 'DEVIN_CONNECT_RETRY_ON_EMPTY_MS'];
  afterEach(() => { for (const k of RETRY_ENV) delete process.env[k]; });

  const EMPTY = [{ type: 'finish', reason: 'stop', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }];
  const REAL = [
    { type: 'content', text: 'real answer' },
    { type: 'finish', reason: 'stop', usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
  ];

  function collectSend() {
    const frames = [];
    return { send: (d) => frames.push(d), frames };
  }

  it('non-stream: retries an empty completion then returns the real answer', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      for (const ev of (calls === 1 ? EMPTY : REAL)) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 2, 'one empty + one heal');
    assert.equal(body.choices[0].message.content, 'real answer');
  });

  // Weak-model exemption (paid E2E 2026-07-08): fable empties are DETERMINISTIC,
  // retry never heals + triples upstream load → 3h rate limit. So a weak model
  // must NOT retry on empty (single call, empty result returned as-is).
  it('weak model (fable) does NOT retry on empty — single call, no amplification', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      for (const ev of EMPTY) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
    assert.equal(calls, 1, 'weak model fired exactly once (no retry)');
    assert.equal(body.choices[0].message.content, '', 'empty returned as-is, not errored');
  });

  // REGRESSION (live paid probe 2026-07-08): genuine fable empties came back with
  // completion_tokens of 3/5/8/9, NOT <=2. An earlier `ct <= 2` gate vetoed the
  // retry on every one (15/15 empty, zero heals in production). The empty OUTPUT
  // is the signature, not the token count.
  it('retries an empty completion even when completion_tokens > 2 (no ct gate)', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      if (calls === 1) yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 8, completion_tokens: 9, total_tokens: 17 } };
      else for (const ev of REAL) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 2, 'ct=9 empty is still healed');
    assert.equal(body.choices[0].message.content, 'real answer');
  });

  it('stream: retries an empty completion without emitting a premature role/finish frame', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      for (const ev of (calls === 1 ? EMPTY : REAL)) yield ev;
    });
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'swe-1-6-slow', messages: [] }, send);
    assert.equal(calls, 2);
    assert.equal(result.content, 'real answer');
    // Exactly ONE role-prime frame (the empty attempt must not have primed/emitted).
    const roleFrames = frames.filter(f => 'role' in (f.choices[0]?.delta || {}));
    assert.equal(roleFrames.length, 1, 'no premature role frame from the discarded empty attempt');
    // Exactly ONE terminal finish frame.
    const finishFrames = frames.filter(f => f.choices[0]?.finish_reason);
    assert.equal(finishFrames.length, 1);
    const text = frames.map(f => f.choices[0]?.delta?.content || '').join('');
    assert.equal(text, 'real answer');
  });

  it('gives up after RETRY_ON_EMPTY_MAX and returns the empty completion (never errors)', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MAX = '2';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      for (const ev of EMPTY) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 3, 'initial + 2 retries');
    assert.equal(body.choices[0].message.content, ''); // degrades to empty, no throw
    assert.equal(body.choices[0].finish_reason, 'stop');
  });

  it('is disabled by DEVIN_CONNECT_RETRY_ON_EMPTY=0 (single attempt)', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      for (const ev of EMPTY) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 1, 'no retry when disabled');
    assert.equal(body.choices[0].message.content, '');
  });

  it('does NOT retry a real answer (completion_tokens>2 with content) — hot path is a no-op', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      for (const ev of REAL) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 1);
    assert.equal(body.choices[0].message.content, 'real answer');
  });

  it('does NOT retry a finish_reason=length truncation (real terminal state)', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      yield { type: 'finish', reason: 'length', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } };
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 1, 'length is a genuine terminal state, not empty-jitter');
    assert.equal(body.choices[0].finish_reason, 'length');
  });

  it('does NOT retry an empty-text turn that carries native tool calls', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      yield {
        type: 'finish', reason: 'stop', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
        toolCalls: [{ id: 'c1', name: 'do_thing', arguments: '{}' }],
      };
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 1, 'a tool call is a real answer even with no visible text');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
  });

  it('does NOT retry when reasoning-only content arrived (thinking counts as real)', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      yield { type: 'reasoning', text: 'thinking…' };
      yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } };
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 1, 'a reasoning-only turn must not trigger the empty-completion retry');
    // This test's subject is the retry decision above. It used to assert the text
    // sits in `reasoning_content`, which was incidental — a reasoning-only turn is
    // now PROMOTED (the text moves into content so the client is never handed an
    // empty answer), so pin what actually matters here: the text is not lost.
    const message = body.choices[0].message;
    assert.equal(message.content, 'thinking…', 'the reasoning text must still reach the client');
  });

  it('treats a stop with no usage (free tier) + no content as empty and heals it', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      if (calls === 1) yield { type: 'finish', reason: 'stop', usage: null };
      else for (const ev of REAL) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] });
    assert.equal(calls, 2, 'no usage + no content still qualifies as empty');
    assert.equal(body.choices[0].message.content, 'real answer');
  });
});

describe('proto-openai-03: stop enforcement', () => {
  function collectSend() {
    const frames = [];
    return { send: (d) => frames.push(d), frames };
  }
  const streamText = (frames) => frames
    .filter(f => f.choices[0]?.delta?.content && f.choices[0].finish_reason == null && !('role' in f.choices[0].delta))
    .map(f => f.choices[0].delta.content).join('');

  it('non-stream: truncates content at the stop sequence and reports finish_reason stop', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'keep this' },
      { type: 'content', text: ' STOP drop this' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] }, { stop: 'STOP' });
    assert.equal(body.choices[0].message.content, 'keep this ');
    assert.equal(body.choices[0].finish_reason, 'stop');
  });

  it('non-stream: no stop configured leaves content whole', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'a STOP b' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    assert.equal(body.choices[0].message.content, 'a STOP b');
  });

  it('stream: emits only the prefix before the stop, even split across chunks', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'answer ST' },
      { type: 'content', text: 'OP leaked' },
      { type: 'content', text: ' more leaked' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send, { stop: 'STOP' });
    assert.equal(streamText(frames), 'answer ');
    assert.equal(result.finish_reason, 'stop');
    // nothing after the stop leaked
    assert.ok(!streamText(frames).includes('leaked'));
  });

  it('stream: without stop, all content flows (regression)', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'a STOP ' },
      { type: 'content', text: 'b' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    await streamChatCompletion({ model: 'm', messages: [] }, send, {});
    assert.equal(streamText(frames), 'a STOP b');
  });
});

describe('thinking-only rescue & promotion', () => {
  const SAMPLE_TOOLS = [{ type: 'function', function: { name: 'read_file' } }];

  it('rescues thinking-only response in streamChatCompletion when tools are present (includes digest in nudge)', async () => {
    let callCount = 0;
    let lastParams = null;
    __setStreamChatForTest(async function* (params) {
      callCount++;
      lastParams = params;
      if (callCount === 1) {
        yield { type: 'reasoning', text: "I'll use the read_file tool" };
        yield { type: 'finish', reason: 'stop', usage: null };
      } else {
        yield {
          type: 'finish',
          reason: 'stop',
          usage: null,
          toolCalls: [{ id: 't1', name: 'read_file', arguments: '{"path":"/tmp/x"}' }],
        };
      }
    });

    const initialMessages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '   ' },
    ];
    const frames = [];
    const send = (frame) => frames.push(frame);

    const result = await streamChatCompletion(
      { model: 'swe-1-7', messages: initialMessages, tools: SAMPLE_TOOLS },
      send,
      { emulateTools: true },
    );

    assert.equal(callCount, 2);
    const passedMsgs = lastParams.messages;
    assert.equal(passedMsgs.length, 2);
    assert.equal(passedMsgs[0].role, 'user');
    assert.equal(passedMsgs[0].content, 'hello');
    assert.equal(passedMsgs[1].role, 'user');
    assert.equal(
      passedMsgs[1].content,
      'Your previous reasoning ended with: """I\'ll use the read_file tool"""\nStop reasoning. Emit the tool call markup now.',
    );
    assert.equal(result.finish_reason, 'tool_calls');
  });

  it('caps reasoning digest at DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS (tail kept)', async () => {
    let callCount = 0;
    let lastParams = null;
    const longReasoning = 'A'.repeat(150) + 'B'.repeat(50);
    __setStreamChatForTest(async function* (params) {
      callCount++;
      lastParams = params;
      if (callCount === 1) {
        yield { type: 'reasoning', text: longReasoning };
        yield { type: 'finish', reason: 'stop', usage: null };
      } else {
        yield { type: 'content', text: '<tool_call>{"name":"read_file"}</tool_call>' };
        yield { type: 'finish', reason: 'stop', usage: null };
      }
    });

    const oldLimit = process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS;
    process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS = '50';
    try {
      await streamChatCompletion(
        { model: 'swe-1-7', messages: [{ role: 'user', content: 'hi' }], tools: SAMPLE_TOOLS },
        () => {},
        { emulateTools: true },
      );
    } finally {
      if (oldLimit === undefined) delete process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS;
      else process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS = oldLimit;
    }

    assert.equal(callCount, 2);
    const nudge = lastParams.messages.at(-1).content;
    // Buffer is a capped tail: no truncation marker, just the last 50 chars.
    const expectedDigest = 'B'.repeat(50);
    assert.equal(
      nudge,
      `Your previous reasoning ended with: """${expectedDigest}"""\nStop reasoning. Emit the tool call markup now.`,
    );
  });

  it('does not accumulate nudges across consecutive rescues (one fresh nudge per rescue)', async () => {
    // Review finding on this PR: rebuilding filteredMsgs from attemptParams kept every
    // prior rescue's nudge (role:'user' survives the empty-assistant filter), so rescue
    // call k carried k-1 nudges. Invisible at 46 chars/nudge pre-digest, ~2.1KB each
    // with one. Rebuild from the untouched original instead — see devin-connect-openai.js.
    const seen = [];
    let callCount = 0;
    __setStreamChatForTest(async function* (params) {
      callCount++;
      seen.push(params.messages.map((m) => ({ role: m.role, content: m.content })));
      if (callCount <= 3) {
        yield { type: 'reasoning', text: `reasoning tail ${callCount}` };
        yield { type: 'finish', reason: 'stop', usage: null };
      } else {
        yield { type: 'content', text: '<tool_call>{"name":"read_file"}</tool_call>' };
        yield { type: 'finish', reason: 'stop', usage: null };
      }
    });

    const oldMax = process.env.DEVIN_CONNECT_RESCUE_MAX;
    process.env.DEVIN_CONNECT_RESCUE_MAX = '5';
    try {
      await streamChatCompletion(
        { model: 'swe-1-7', messages: [{ role: 'user', content: 'hi' }], tools: SAMPLE_TOOLS },
        () => {},
        { emulateTools: true },
      );
    } finally {
      if (oldMax === undefined) delete process.env.DEVIN_CONNECT_RESCUE_MAX;
      else process.env.DEVIN_CONNECT_RESCUE_MAX = oldMax;
    }

    assert.equal(callCount, 4, 'three thinking-only attempts, then the healed one');
    for (let k = 2; k <= 4; k++) {
      const msgs = seen[k - 1];
      const nudges = msgs.filter(
        (m) => m.role === 'user' && String(m.content).startsWith('Your previous reasoning ended with'),
      );
      assert.equal(nudges.length, 1, `rescue call ${k} carries ${nudges.length} nudge(s), expected exactly 1`);
      assert.equal(msgs.length, 2, `rescue call ${k} must be original message + one nudge, got ${msgs.length} messages`);
      assert.ok(
        nudges[0].content.includes(`reasoning tail ${k - 1}`),
        `rescue call ${k} must quote the immediately-preceding failed attempt`,
      );
      if (k >= 3) {
        assert.ok(
          !nudges[0].content.includes(`reasoning tail ${k - 2}`),
          `rescue call ${k} still carries the stale digest from attempt ${k - 2}`,
        );
      }
    }
  });

  it('disables reasoning digest when DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS=0', async () => {
    let callCount = 0;
    let lastParams = null;
    __setStreamChatForTest(async function* (params) {
      callCount++;
      lastParams = params;
      if (callCount === 1) {
        yield { type: 'reasoning', text: 'some reasoning' };
        yield { type: 'finish', reason: 'stop', usage: null };
      } else {
        yield { type: 'content', text: 'ok' };
        yield { type: 'finish', reason: 'stop', usage: null };
      }
    });

    const oldLimit = process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS;
    process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS = '0';
    try {
      await streamChatCompletion(
        { model: 'swe-1-7', messages: [{ role: 'user', content: 'hi' }], tools: SAMPLE_TOOLS },
        () => {},
        { emulateTools: true },
      );
    } finally {
      if (oldLimit === undefined) delete process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS;
      else process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS = oldLimit;
    }

    assert.equal(callCount, 2);
    assert.equal(lastParams.messages.at(-1).content, 'Stop reasoning. Emit the tool call markup now.');
  });

  // Post-merge review of #241. `Number.isFinite` lets `1e9` through, exactly as it did
  // for the RESCUE_MAX knob twelve lines above the digest cap in the source — that one
  // already carries RESCUE_MAX_CEILING because an unbounded value hung the request for
  // hours of upstream calls. The digest cap shipped without the equivalent clamp.
  //
  // These three pin the whole sanitisation surface as ONE unit, because the failing
  // direction differs per input and asserting only the clamp would leave the other two
  // free to drift:
  //   1e9  → clamped to the ceiling      (the defect this adds the clamp for)
  //   ''   → 0, i.e. digest OFF          (Number('') === 0; the file-wide convention)
  //   abc  → NaN, i.e. the 2000 default  (the only input the fallback actually serves)
  describe('digest cap sanitisation (post-merge hardening)', () => {
    const digestFor = async (envValue, reasoningLen) => {
      let callCount = 0;
      let lastParams = null;
      __setStreamChatForTest(async function* (params) {
        callCount++;
        lastParams = params;
        if (callCount === 1) {
          yield { type: 'reasoning', text: 'R'.repeat(reasoningLen) };
          yield { type: 'finish', reason: 'stop', usage: null };
        } else {
          yield { type: 'content', text: 'ok' };
          yield { type: 'finish', reason: 'stop', usage: null };
        }
      });
      const old = process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS;
      process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS = envValue;
      try {
        await streamChatCompletion(
          { model: 'swe-1-7', messages: [{ role: 'user', content: 'hi' }], tools: SAMPLE_TOOLS },
          () => {},
          { emulateTools: true },
        );
      } finally {
        if (old === undefined) delete process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS;
        else process.env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS = old;
      }
      // Precondition, not decoration — but NOT for the reason the first version of this
      // comment claimed. It said the length assertions "would pass on a run where nothing
      // happened"; they would not, they would THROW: with no rescue, .at(-1) is the original
      // user turn, the `"""` regex returns null, and `m[1]` is a TypeError. What this buys is
      // a NAMED failure ("the rescue must actually have fired") instead of a bare
      // "Cannot read properties of null", which is what sent an earlier debugging round
      // looking at the regex instead of at the fixture.
      assert.equal(callCount, 2, 'precondition: the rescue must actually have fired');
      const nudge = lastParams.messages.at(-1).content;
      const m = nudge.match(/"""([\s\S]*)"""/);
      return { nudge, quoted: m ? m[1] : null };
    };

    it('clamps an unbounded value (1e9) to the ceiling instead of quoting everything', async () => {
      const { quoted } = await digestFor('1e9', 50000);
      assert.equal(
        quoted.length, 32000,
        'Number.isFinite accepts 1e9; without the clamp the whole 50000-char reasoning ships in the nudge',
      );
    });

    it('an empty value disables the digest — same convention as the sibling knobs', async () => {
      const { nudge, quoted } = await digestFor('', 3000);
      assert.equal(quoted, null, 'no quoted block at all');
      assert.equal(
        nudge, 'Stop reasoning. Emit the tool call markup now.',
        "Number('') === 0, so an empty value reads as 0 (digest off), NOT as the 2000 default",
      );
    });

    it('a genuinely non-numeric value falls back to the 2000 default', async () => {
      const { quoted } = await digestFor('abc', 3000);
      assert.equal(quoted.length, 2000, 'NaN is the only input the default fallback serves');
    });

    // Found by the post-release review pass, and it is the OTHER HALF of the 1e9 hole: the
    // clamp alone does not cover it, because Math.min(0.5, 32000) is correctly 0.5 — the
    // inversion happens one step later, in slice(). Measured before the fix: MAX_CHARS=0.5
    // shipped all 50000 chars. Fractional values above 1 are the benign direction (they
    // truncate downward), so both are pinned to keep the asymmetry visible.
    it('a fractional cap below 1 does not invert into "no cap" (slice(-0.5) === slice(0))', async () => {
      const { nudge, quoted } = await digestFor('0.5', 5000);
      // Math.floor(0.5) === 0, and cap 0 takes the same branch as an explicit 0: bare nudge,
      // no fence at all. The assertion that matters is the FIRST one — before the fix this
      // shipped the entire 5000-char reasoning.
      assert.equal(quoted, null, 'no fence: a sub-1 cap floors to 0, i.e. digest disabled');
      assert.equal(nudge, 'Stop reasoning. Emit the tool call markup now.');
      assert.ok(!nudge.includes('R'.repeat(50)), 'the reasoning body must not appear anywhere in the nudge');
    });

    it('a fractional cap above 1 truncates downward rather than throwing', async () => {
      const { quoted } = await digestFor('100.9', 5000);
      assert.equal(quoted.length, 100, 'Math.floor(100.9) === 100');
    });
  });

  it('rescues in native tool mode when tools are present (emulateTools=false)', async () => {
    let callCount = 0;
    __setStreamChatForTest(async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'reasoning', text: 'I should call a tool' };
        yield { type: 'finish', reason: 'stop', usage: null };
      } else {
        yield {
          type: 'finish',
          reason: 'stop',
          usage: null,
          toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }],
        };
      }
    });

    const result = await streamChatCompletion(
      { model: 'swe-1-7', messages: [{ role: 'user', content: 'hi' }], tools: SAMPLE_TOOLS },
      () => {},
      { emulateTools: false },
    );

    assert.equal(callCount, 2, 'the rescue fires on the native tool path too, not only under emulation');
    assert.equal(result.finish_reason, 'tool_calls');
  });

  it('skips the rescue when the request carries no tools', async () => {
    let callCount = 0;
    __setStreamChatForTest(async function* () {
      callCount++;
      yield { type: 'reasoning', text: 'just thinking out loud' };
      yield { type: 'finish', reason: 'stop', usage: null };
    });

    await streamChatCompletion(
      { model: 'swe-1-7', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
      { emulateTools: true },
    );

    assert.equal(callCount, 1, 'no tools in the request — a reasoning-only finish is legitimate, not a trap');
  });

  it('respects rescue budget when DEVIN_CONNECT_RESCUE_MAX=0', async () => {
    let callCount = 0;
    __setStreamChatForTest(async function* () {
      callCount++;
      yield { type: 'reasoning', text: 'thinking only' };
      yield { type: 'finish', reason: 'stop', usage: null };
    });

    const frames = [];
    const send = (frame) => frames.push(frame);

    const oldVal = process.env.DEVIN_CONNECT_RESCUE_MAX;
    process.env.DEVIN_CONNECT_RESCUE_MAX = '0';
    try {
      await streamChatCompletion(
        { model: 'swe-1-7', messages: [{ role: 'user', content: 'hi' }], tools: SAMPLE_TOOLS },
        send,
        { emulateTools: true },
      );
    } finally {
      if (oldVal === undefined) delete process.env.DEVIN_CONNECT_RESCUE_MAX;
      else process.env.DEVIN_CONNECT_RESCUE_MAX = oldVal;
    }

    assert.equal(callCount, 1);
  });

  it('promotes reasoning to content in toChatCompletion when content is empty and no tool calls', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'reasoning', text: 'standalone reasoning answer' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));

    const { body } = await toChatCompletion({ model: 'swe-1-7', messages: [] }, { emulateTools: false });
    assert.equal(body.choices[0].message.content, 'standalone reasoning answer');
  });

  it('promotes reasoning to content in streamChatCompletion when content is empty and no tool calls', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'reasoning', text: 'streamed reasoning answer' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));

    const frames = [];
    const send = (frame) => frames.push(frame);

    const result = await streamChatCompletion({ model: 'swe-1-7', messages: [] }, send, { emulateTools: false });
    assert.equal(result.content, 'streamed reasoning answer');
    const contentDeltas = frames
      .flatMap((f) => f.choices || [])
      .map((c) => c.delta?.content)
      .filter(Boolean);
    assert.ok(contentDeltas.includes('streamed reasoning answer'));
  });

  // Promotion MOVES the text; it must not leave a copy behind.
  //
  // The review of #238 measured the duplicate on all three surfaces: non-stream
  // (`content === reasoning_content`), stream (same after accumulating deltas), and
  // the Anthropic route, where it became a `thinking` block and a `text` block with
  // byte-identical content — i.e. the reporter's own client (kimi CLI) rendering the
  // answer twice. The non-stream half is fixed here; the stream half cannot be
  // (deltas already left) and is documented as an accepted cost at the call site.
  it('does not leave a reasoning_content copy behind after promoting (non-stream)', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'reasoning', text: 'the whole answer lives in reasoning' },
      { type: 'finish', reason: 'stop', usage: { completion_tokens: 12 } },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-1-7', messages: [] });
    const message = body.choices[0].message;
    assert.equal(message.content, 'the whole answer lives in reasoning');
    assert.notEqual(
      message.content, message.reasoning_content,
      'content and reasoning_content must not carry the same text — a client that renders '
      + 'reasoning would show the answer twice',
    );
    assert.equal(message.reasoning_content, undefined, 'the promoted copy must be dropped');
  });

  // A rescue attempt REPLACES the previous one; it must not be appended to it.
  //
  // The rescue loop lives inside streamChatWithEmptyRetry, while the accumulators
  // live in its two consumers — which reset per THEIR OWN retry, so they never saw a
  // rescue boundary. Measured before the fix: three thinking-only attempts produced
  // `"PASS1. PASS2. PASS3. "`, i.e. the user was shown all three tries glued
  // together as the answer. The generator now emits an `attempt_reset` sentinel.
  for (const [label, run] of [
    ['non-stream', async (params, opts) => {
      const { body } = await toChatCompletion(params, opts);
      return body.choices[0].message.content;
    }],
    ['stream', async (params, opts) => {
      const result = await streamChatCompletion(params, () => {}, opts);
      return result.content;
    }],
  ]) {
    it(`discards an abandoned rescue attempt instead of concatenating it (${label})`, async () => {
      let attempts = 0;
      __setStreamChatForTest(async function* () {
        attempts++;
        yield { type: 'reasoning', text: `PASS${attempts}. ` };
        yield { type: 'finish', reason: 'stop', usage: { completion_tokens: 10 } };
      });
      const content = await run(
        { model: 'swe-1-7', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] },
        { emulateTools: true },
      );
      assert.ok(attempts > 1, `precondition: the rescue must have fired (attempts=${attempts})`);
      assert.doesNotMatch(
        String(content || ''), /PASS1/,
        `the first attempt's output leaked into the final answer (${JSON.stringify(content)}) — each `
        + 'rescue replaces the previous attempt, it does not continue it',
      );
      assert.match(String(content || ''), new RegExp(`PASS${attempts}`),
        'the LAST attempt is the one whose output the client should see');
    });
  }

  // Promotion must run the promoted text through the SAME tool-call extraction the
  // content path uses.
  //
  // The rescue nudge literally says "Emit the tool call markup now." A model that
  // complies but keeps writing into the REASONING channel produces markup that the
  // promotion previously delivered unparsed: raw `<tool_call>` XML as the visible
  // answer with finish_reason='stop'. The agent loop does not advance and the user
  // sees markup — worse than the empty turn the promotion exists to prevent, and on
  // the exact model this whole change set targets.
  for (const [label, run] of [
    ['non-stream', async (params, opts) => {
      const { body } = await toChatCompletion(params, opts);
      return {
        finish: body.choices[0].finish_reason,
        toolCalls: (body.choices[0].message.tool_calls || []).length,
        content: String(body.choices[0].message.content || ''),
      };
    }],
    ['stream', async (params, opts) => {
      const frames = [];
      const result = await streamChatCompletion(params, (f) => frames.push(f), opts);
      const deltas = frames.flatMap((f) => f.choices || []);
      return {
        finish: deltas.map((c) => c.finish_reason).filter(Boolean).join(','),
        toolCalls: deltas.reduce((n, c) => n + (c.delta?.tool_calls?.length || 0), 0),
        content: deltas.map((c) => c.delta?.content).filter(Boolean).join(''),
      };
    }],
  ]) {
    it(`extracts a tool call that arrived in the reasoning channel (${label})`, async () => {
      __setStreamChatForTest(fakeStream([
        { type: 'reasoning', text: '<tool_call>\n{"name":"read_file","arguments":{"path":"a.js"}}\n</tool_call>' },
        { type: 'finish', reason: 'stop', usage: { completion_tokens: 20 } },
      ]));
      const out = await run(
        { model: 'swe-1-7', messages: [{ role: 'user', content: 'read a.js' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }] },
        { emulateTools: true },
      );
      assert.doesNotMatch(
        out.content, /<tool_call>/,
        'raw tool markup reached the client as the visible answer — the promoted text must go '
        + 'through the same extraction the content path uses',
      );
      assert.equal(out.toolCalls, 1, 'the tool call must be delivered as a tool call');
      assert.match(String(out.finish), /tool_calls/, 'and the finish reason must say so');
    });
  }

  it('a successful rescue delivers the tool call with no stale reasoning attached', async () => {
    let attempts = 0;
    __setStreamChatForTest(async function* () {
      attempts++;
      if (attempts === 1) {
        yield { type: 'reasoning', text: 'I should use read_file.' };
        yield { type: 'finish', reason: 'stop', usage: { completion_tokens: 10 } };
        return;
      }
      yield { type: 'content', text: '<tool_call>\n{"name":"read_file","arguments":{"path":"a.js"}}\n</tool_call>' };
      yield { type: 'finish', reason: 'stop', usage: { completion_tokens: 20 } };
    });
    const { body } = await toChatCompletion(
      { model: 'swe-1-7', messages: [{ role: 'user', content: 'read a.js' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }] },
      { emulateTools: true },
    );
    const message = body.choices[0].message;
    assert.equal(attempts, 2, 'the rescue should heal on the first retry');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal((message.tool_calls || []).length, 1);
    assert.doesNotMatch(
      String(message.content || ''), /I should use read_file/,
      "the abandoned attempt's reasoning must not ride along with the healed turn",
    );
  });

  // The rescue budget must be bounded and must honour the existing off switches.
  //
  // Measured before this was hardened: DEVIN_CONNECT_RESCUE_MAX=Infinity and =1e9
  // both defeated the `rescueAttempt < rescueMax` bound (the 1e9 probe had to be
  // killed), a non-numeric value produced NaN and silently turned the whole feature
  // OFF with no log line, the documented empty-retry master off switch did not cover
  // the rescue at all, and the weak-model veto — written against a paid E2E that
  // proved retrying the fable family only burns the account into a 3h rate limit —
  // was bypassed.
  for (const [label, env, expected] of [
    ['default', {}, 3],
    ['RESCUE_MAX=Infinity', { DEVIN_CONNECT_RESCUE_MAX: 'Infinity' }, 3],
    ['RESCUE_MAX=1e9 (hard ceiling)', { DEVIN_CONNECT_RESCUE_MAX: '1e9' }, 6],
    ['RESCUE_MAX=abc (must stay ON at the default)', { DEVIN_CONNECT_RESCUE_MAX: 'abc' }, 3],
    ['RESCUE_MAX=0 (explicit off)', { DEVIN_CONNECT_RESCUE_MAX: '0' }, 1],
    ['RETRY_ON_EMPTY=0 (master off switch)', { DEVIN_CONNECT_RETRY_ON_EMPTY: '0' }, 1],
  ]) {
    it(`bounds upstream calls: ${label}`, async () => {
      const saved = {};
      for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
      process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
      try {
        let calls = 0;
        __setStreamChatForTest(async function* () {
          calls++;
          yield { type: 'reasoning', text: 'thinking. ' };
          yield { type: 'finish', reason: 'stop', usage: { completion_tokens: 5 } };
        });
        await toChatCompletion(
          { model: 'swe-1-7', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] },
          { emulateTools: true },
        );
        assert.equal(calls, expected,
          `${label}: expected ${expected} upstream call(s), got ${calls} — an unbounded rescue turns `
          + 'one client request into a loop that burns the account into a rate limit');
      } finally {
        for (const k of Object.keys(saved)) {
          if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
        delete process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS;
      }
    });
  }

  it('does not rescue a weak model, honouring the paid-probe account-burn veto', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    try {
      let calls = 0;
      __setStreamChatForTest(async function* () {
        calls++;
        yield { type: 'reasoning', text: 'thinking. ' };
        yield { type: 'finish', reason: 'stop', usage: { completion_tokens: 5 } };
      });
      await toChatCompletion(
        { model: 'claude-5-fable-medium', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] },
        { emulateTools: true },
      );
      assert.equal(calls, 1,
        'the fable family must not be retried — a paid E2E (27/27) proved retries never heal it and '
        + 'only triple upstream load into a 3h rate limit');
    } finally {
      delete process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS;
    }
  });

  it('keeps reasoning_content when there is a real answer to distinguish it from', async () => {
    // The promotion must not fire when the model DID answer: reasoning and content
    // are genuinely different text and both belong in the response.
    __setStreamChatForTest(fakeStream([
      { type: 'reasoning', text: 'let me think' },
      { type: 'content', text: 'the answer is 255' },
      { type: 'finish', reason: 'stop', usage: { completion_tokens: 20 } },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-1-7', messages: [] });
    const message = body.choices[0].message;
    assert.equal(message.content, 'the answer is 255');
    assert.equal(message.reasoning_content, 'let me think',
      'a genuine reasoning trace must survive alongside a real answer');
  });
});

// Pin tests — GOAL-2026-08-06-PR-REWORK item 3. The leading think-tag reroute
// moved from the messages.js egress translators into the connect layer, at the
// stream-event level (streamChatWithEmptyRetry), BEFORE the #238 rescue
// decision. These pin the combined behavior: reclassification + rescue + the
// egress invariant "text block always present".
describe('think-text reroute (connect layer, DEVIN_CONNECT_THINKTEXT_REROUTE)', () => {
  const OPEN = '<' + 'think' + '>';
  const CLOSE = '<' + '/' + 'think' + '>';
  const SAMPLE_TOOLS = [{ type: 'function', function: { name: 'read_file' } }];
  let prev;
  beforeEach(() => { prev = process.env.DEVIN_CONNECT_THINKTEXT_REROUTE; process.env.DEVIN_CONNECT_THINKTEXT_REROUTE = '1'; });
  afterEach(() => { if (prev === undefined) delete process.env.DEVIN_CONNECT_THINKTEXT_REROUTE; else process.env.DEVIN_CONNECT_THINKTEXT_REROUTE = prev; });

  it('(a) whole turn = think block: the #238 rescue fires and the client gets an answer', async () => {
    // Attempt 1 is an ENTIRE turn on the content channel, think-tagged. With the
    // classifier at the event level this decodes to reasoning-only, so sawText
    // stays false and the rescue fires naturally — it never did before the move:
    // the egress reroute ran AFTER the rescue had already given up, leaving a
    // reasoning-only finish (#238 form, APIEmptyResponseError on strict clients).
    let callCount = 0;
    let lastParams = null;
    __setStreamChatForTest(async function* (params) {
      callCount++;
      lastParams = params;
      if (callCount === 1) {
        yield { type: 'content', text: OPEN + 'Let me think through the whole request. ' + CLOSE };
        yield { type: 'finish', reason: 'stop', usage: null };
      } else {
        yield { type: 'content', text: 'Here is the answer.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      }
    });
    const frames = [];
    const result = await streamChatCompletion(
      { model: 'swe-1-7', messages: [{ role: 'user', content: 'hi' }], tools: SAMPLE_TOOLS },
      (f) => frames.push(f),
      { emulateTools: true },
    );
    assert.equal(callCount, 2, 'the #238 rescue must fire for a whole-think turn');
    assert.ok(
      lastParams.messages.at(-1).content.includes('Stop reasoning. Emit the tool call markup now.'),
      'the rescue nudge reaches the second attempt',
    );
    // The rescued attempt's answer is what reaches the client — the abandoned
    // think-only attempt is not concatenated onto it.
    assert.equal(result.content, 'Here is the answer.');
  });

  it('(a) whole-think turn without tools: promotion keeps a visible answer (no empty message)', async () => {
    // No tools -> no rescue (plain chat legitimately ends in reasoning/text). The
    // think-only content must still reach the client as the visible answer via
    // the existing reasoning->content promotion, so the anthropic egress below
    // (openAIToAnthropic) always has a text block to push.
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: OPEN + 'reasoning only, no tools. ' + CLOSE },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-1-7', messages: [] });
    const msg = body.choices[0].message;
    assert.equal(msg.content, 'reasoning only, no tools. ', 'promoted into the visible content');
    assert.equal(msg.reasoning_content, undefined, 'promotion moves, not copies');
  });

  it('(b) think + answer still splits into thinking and text', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: OPEN + 'inner reasoning. ' + CLOSE },
      { type: 'content', text: 'The answer.' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-1-7', messages: [] });
    const msg = body.choices[0].message;
    assert.equal(msg.reasoning_content, 'inner reasoning. ', 'think span lands on the reasoning channel');
    assert.equal(msg.content, 'The answer.', 'the answer stays on the content channel');
  });

  it('(c) stream variant: think + answer renders as reasoning_content deltas then content deltas', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: OPEN + 'inner reasoning. ' + CLOSE },
      { type: 'content', text: 'The answer.' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const frames = [];
    const result = await streamChatCompletion(
      { model: 'swe-1-7', messages: [] },
      (f) => frames.push(f),
      {},
    );
    assert.equal(result.reasoning, 'inner reasoning. ');
    assert.equal(result.content, 'The answer.');
    const reasoningDeltas = frames.filter((f) => f.choices?.[0]?.delta?.reasoning_content).map((f) => f.choices[0].delta.reasoning_content).join('');
    assert.equal(reasoningDeltas, 'inner reasoning. ');
    const contentDeltas = frames.filter((f) => f.choices?.[0]?.delta?.content).map((f) => f.choices[0].delta.content).join('');
    assert.equal(contentDeltas, 'The answer.');
  });

  it('respects the gate: with DEVIN_CONNECT_THINKTEXT_REROUTE off, think-tagged content stays text', async () => {
    process.env.DEVIN_CONNECT_THINKTEXT_REROUTE = '0';
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: OPEN + 'inner reasoning. ' + CLOSE + 'The answer.' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-1-7', messages: [] });
    const msg = body.choices[0].message;
    assert.equal(msg.content, OPEN + 'inner reasoning. ' + CLOSE + 'The answer.');
    assert.equal(msg.reasoning_content, undefined);
  });

  it('history isolation: a leading think block inside an INBOUND history message is forwarded upstream untouched, even with the gate on', async () => {
    // The classifier runs ONLY on live upstream output events. Caller-pasted
    // content (a quoted transcript, a literal "what does the tag mean") rides
    // the inbound message list and must never be reclassified — that would
    // lose attribution, the mirror image of the leak this feature fixes.
    process.env.DEVIN_CONNECT_THINKTEXT_REROUTE = '1';
    let captured = null;
    __setStreamChatForTest(async function* (params) {
      captured = params;
      yield { type: 'content', text: 'ok' };
      yield { type: 'finish', reason: 'stop', usage: null };
    });
    const history = [
      { role: 'user', content: 'what does ' + OPEN + CLOSE + ' mean?' },
      { role: 'assistant', content: OPEN + 'quoted from a log' + CLOSE + ' and here is my real answer' },
      { role: 'user', content: 'go on' },
    ];
    const { status, body } = await toChatCompletion({ model: 'swe-1-7', messages: history });
    assert.equal(status, 200);
    assert.deepEqual(captured.messages, history);
    assert.equal(body.choices[0].message.content, 'ok');
  });
});
