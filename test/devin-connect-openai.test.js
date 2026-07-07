import { afterEach, describe, it } from 'node:test';
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

  it('emits content:"" (never undefined) when the model returns no answer text', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'reasoning', text: 'hmm' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    assert.equal(body.choices[0].message.content, '');
    assert.equal(body.choices[0].message.reasoning_content, 'hmm');
  });

  it('omits usage when the upstream gave none', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'hi' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { body } = await toChatCompletion({ model: 'm', messages: [] });
    assert.equal('usage' in body, false);
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
    const { body } = await toChatCompletion({ model: 'swe-1-6-slow', messages: [] }, { emulateTools: true });
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
    const { body } = await toChatCompletion({ model: 'm', messages: [] }, { emulateTools: true });
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
    const result = await streamChatCompletion({ model: 'swe-1-6-slow', messages: [] }, send, { emulateTools: true });

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
    const { body } = await toChatCompletion({ model: 'm', messages: [] }, { emulateTools: true });
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
    const { body } = await toChatCompletion({ model: 'm', messages: [] }, { emulateTools: true });
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

// retry-on-empty: fable (and other capacity-jittered models) occasionally return
// a COMPLETED turn (finish=stop, completion_tokens<=2) with zero content. This is
// probabilistic upstream capacity jitter, not a deterministic tool-count
// threshold and not an outage. The adapter transparently re-issues the identical
// request a bounded number of times. It must (a) heal a subsequent real answer,
// (b) never trim tools, (c) not retry a genuine terminal state (length /
// tool_calls / non-empty answer), (d) be a no-op on the hot path.
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
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
    assert.equal(calls, 2, 'one empty + one heal');
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
    const result = await streamChatCompletion({ model: 'claude-5-fable-medium', messages: [] }, send);
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
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
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
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
    assert.equal(calls, 1, 'no retry when disabled');
    assert.equal(body.choices[0].message.content, '');
  });

  it('does NOT retry a real answer (completion_tokens>2 with content) — hot path is a no-op', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      for (const ev of REAL) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
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
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
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
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
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
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
    assert.equal(calls, 1);
    assert.equal(body.choices[0].message.reasoning_content, 'thinking…');
  });

  it('treats a stop with no usage (free tier) + no content as empty and heals it', async () => {
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      if (calls === 1) yield { type: 'finish', reason: 'stop', usage: null };
      else for (const ev of REAL) yield ev;
    });
    const { body } = await toChatCompletion({ model: 'claude-5-fable-medium', messages: [] });
    assert.equal(calls, 2, 'no usage + no content still qualifies as empty');
    assert.equal(body.choices[0].message.content, 'real answer');
  });
});
