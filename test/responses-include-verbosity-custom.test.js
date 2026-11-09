// G01/G02/G03 (Q4-05) — three Responses contract fields the bridge used to drop:
//
//   G01 `include:["reasoning.encrypted_content"]` — reasoning items never carried
//       the opaque upstream blob. The field is emitted ONLY when the caller asked
//       for it AND the upstream supplied one; nothing is fabricated.
//   G02 `text.verbosity` — never parsed, so Codex's `verbosity:"low"` on every
//       request was silently ignored. It rides the forwarded chat body.
//   G03 custom-tool input — streamed only as a completed item with no progressive
//       input. It now streams `response.custom_tool_call_input.delta` and closes
//       the family with `.done` + an item carrying the FULL input.
//
// Every case drives the real handler through handleResponses.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleResponses, responsesToChat, chatToResponse, handleGetResponse } from '../src/handlers/responses.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { resetResponseStore } from '../src/response-store.js';

const DONE = 'data: [DONE]\n\n';
const chatChunk = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;

function parseEvents(raw) {
  return raw
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => frame !== 'data: [DONE]')
    .map(frame => {
      const lines = frame.split('\n');
      const event = lines.find(line => line.startsWith('event: '))?.slice(7);
      const data = JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}');
      return { event, data };
    });
}

function assertSequenceNumbers(events) {
  events.forEach((event, index) => {
    assert.equal(event.data.sequence_number, index);
  });
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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

const CONTEXT = { callerKey: 'api:responsesfix:user:t' };

/** deps whose chat handler returns a fixed non-stream result and records the body. */
function nonStreamDeps(resultFor, captured) {
  return {
    async handleChatCompletions(body) {
      captured.body = body;
      return resultFor(body);
    },
    context: CONTEXT,
  };
}

/** deps whose chat handler streams the given raw frames. */
function streamDeps(frames, captured = {}) {
  return {
    async handleChatCompletions(body) {
      captured.body = body;
      return {
        status: 200,
        stream: true,
        async handler(res) {
          for (const frame of frames) res.write(frame);
          res.end();
        },
      };
    },
    context: CONTEXT,
  };
}

async function runStream(body, frames, captured = {}) {
  const result = await handleResponses(body, streamDeps(frames, captured));
  assert.equal(result.status, 200);
  const res = fakeRes();
  await result.handler(res);
  return parseEvents(res.body);
}

const reasoningUpstream = (extra = {}) => (body) => ({
  status: 200,
  body: {
    created: 123,
    model: body.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', reasoning_content: 'thinking it through', content: 'answer', ...extra },
      finish_reason: 'stop',
    }],
  },
});

describe('G01: include reasoning.encrypted_content', () => {
  it('parses the include list into an internal flag and never forwards it upstream', () => {
    const out = responsesToChat({ input: 'hi', include: ['reasoning.encrypted_content'] });
    assert.equal(out.__includeReasoningEncrypted, true);
    // `include` itself is response-side only; the chat wire has no such parameter.
    assert.equal('include' in out, false);
    assert.equal(responsesToChat({ input: 'hi' }).__includeReasoningEncrypted, undefined);
  });

  it('emits encrypted_content on the reasoning item when the caller asked and the upstream supplied it', async () => {
    const captured = {};
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi', include: ['reasoning.encrypted_content'] },
      nonStreamDeps(reasoningUpstream({ encrypted_content: 'enc_blob_1' }), captured),
    );
    assert.equal(result.status, 200);
    const reasoning = result.body.output.find(item => item.type === 'reasoning');
    assert.ok(reasoning, 'the upstream reasoning text still produces a reasoning item');
    assert.equal(reasoning.encrypted_content, 'enc_blob_1');
    // The internal flag is stripped before the upstream call.
    assert.equal('__includeReasoningEncrypted' in captured.body, false);
  });

  it('omits encrypted_content when the caller did not ask for it, even if the upstream sent one', async () => {
    const captured = {};
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi' },
      nonStreamDeps(reasoningUpstream({ encrypted_content: 'enc_blob_1' }), captured),
    );
    assert.equal(result.status, 200);
    const reasoning = result.body.output.find(item => item.type === 'reasoning');
    assert.equal('encrypted_content' in reasoning, false);
  });

  it('never fabricates a value: include without an upstream blob leaves the field absent', async () => {
    const captured = {};
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi', include: ['reasoning.encrypted_content'] },
      nonStreamDeps(reasoningUpstream(), captured),
    );
    assert.equal(result.status, 200);
    const reasoning = result.body.output.find(item => item.type === 'reasoning');
    assert.equal('encrypted_content' in reasoning, false);
  });

  it('carries an upstream reasoning signature as the opaque blob (the established carrier)', async () => {
    const captured = {};
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi', include: ['reasoning.encrypted_content'] },
      nonStreamDeps(reasoningUpstream({ reasoning_signature: 'sig_blob' }), captured),
    );
    assert.equal(result.status, 200);
    const reasoning = result.body.output.find(item => item.type === 'reasoning');
    assert.equal(reasoning.encrypted_content, 'sig_blob');
  });

  it('streams encrypted_content on the reasoning item done event and the completed output', async () => {
    const events = await runStream(
      { model: 'gpt-5.2', input: 'hi', stream: true, include: ['reasoning.encrypted_content'] },
      [
        chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'think', reasoning_signature: 'sig_stream' } }] }),
        chatChunk({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
        chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        DONE,
      ],
    );
    assertSequenceNumbers(events);
    const reasoningDone = events
      .filter(e => e.event === 'response.output_item.done')
      .map(e => e.data.item)
      .find(item => item.type === 'reasoning');
    assert.ok(reasoningDone, 'the reasoning item must still close');
    assert.equal(reasoningDone.encrypted_content, 'sig_stream');
    const completed = events.at(-1);
    assert.equal(completed.event, 'response.completed');
    const reasoningOut = completed.data.response.output.find(item => item.type === 'reasoning');
    assert.equal(reasoningOut.encrypted_content, 'sig_stream');
  });

  it('streams no encrypted_content when the caller did not include it', async () => {
    const events = await runStream(
      { model: 'gpt-5.2', input: 'hi', stream: true },
      [
        chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'think', reasoning_signature: 'sig_stream' } }] }),
        chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        DONE,
      ],
    );
    const reasoningDone = events
      .filter(e => e.event === 'response.output_item.done')
      .map(e => e.data.item)
      .find(item => item.type === 'reasoning');
    assert.equal('encrypted_content' in reasoningDone, false);
  });
});

describe('G01 input side: replayed reasoning becomes signed thinking', () => {
  it('round-trips an emitted reasoning item onto the assistant frame the Connect builder signs', () => {
    const emitted = chatToResponse({
      created: 123,
      model: 'gpt-5.2',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          reasoning_content: 'think it through',
          encrypted_content: 'enc_blob_rt',
          tool_calls: [{ id: 'call_rt', type: 'function', function: { name: 'exec', arguments: '{"input":"echo hi"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }, 'gpt-5.2', 'resp_rt', 'msg_rt', [{ type: 'custom', name: 'exec' }], null, null, { includeReasoningEncrypted: true });
    const reasoning = emitted.output.find(item => item.type === 'reasoning');
    assert.ok(reasoning, 'the emitted turn carries a reasoning item');
    assert.equal(reasoning.encrypted_content, 'enc_blob_rt');

    // Replay the item exactly as a client would: before the call it preceded.
    const chat = responsesToChat({
      model: 'gpt-5.2',
      input: [
        { role: 'user', content: 'run it' },
        reasoning,
        { type: 'custom_tool_call', call_id: 'call_rt', name: 'exec', input: 'echo hi' },
        { type: 'custom_tool_call_output', call_id: 'call_rt', output: 'hi' },
      ],
    });
    const assistant = chat.messages.find(m => m.role === 'assistant');
    assert.ok(assistant, 'the replayed reasoning no longer vanishes');
    assert.equal(assistant.reasoning_content, 'think it through');
    // A tool-call turn must NOT carry the signature: with signed-thinking replay
    // enabled, chat.js rejects exactly that shape in prompt-emulation mode
    // (`signed_thinking_tool_history_unsupported`). The summary text still rides.
    assert.equal('reasoning_signature' in assistant, false);
    assert.equal(assistant.tool_calls[0].id, 'call_rt');
    assert.equal(assistant.tool_calls[0].function.name, 'exec');
    assert.equal(chat.messages.filter(m => m.role === 'assistant').length, 1);
  });

  it('attaches replayed reasoning to an explicit assistant message item', () => {
    const chat = responsesToChat({
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }], encrypted_content: 'blob2' },
        { role: 'assistant', content: 'because' },
      ],
    });
    assert.deepEqual(chat.messages, [{
      role: 'assistant',
      content: 'because',
      reasoning_content: 'why',
      reasoning_signature: 'blob2',
    }]);
  });

  it('forwards the summary text alone when the item has no encrypted_content', () => {
    const chat = responsesToChat({
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }], encrypted_content: null },
        { role: 'assistant', content: 'ok' },
      ],
    });
    assert.equal(chat.messages[0].reasoning_content, 'why');
    assert.equal('reasoning_signature' in chat.messages[0], false);
  });

  it('does not leak reasoning across a new user turn', () => {
    const chat = responsesToChat({
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'old' }], encrypted_content: 'old_blob' },
        { role: 'user', content: 'next question' },
        { role: 'assistant', content: 'new answer' },
      ],
    });
    assert.equal(chat.messages[0].role, 'user');
    assert.equal('reasoning_content' in chat.messages[1], false);
    assert.equal('reasoning_signature' in chat.messages[1], false);
  });

  it('drops an ambiguous second signature instead of pairing it with text it does not seal', () => {
    const chat = responsesToChat({
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'a' }], encrypted_content: 'sig_a' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'b' }], encrypted_content: 'sig_b' },
        { role: 'assistant', content: 'ok' },
      ],
    });
    assert.equal(chat.messages[0].reasoning_content, 'ab');
    assert.equal('reasoning_signature' in chat.messages[0], false);
  });

  it('drops the signature when unsigned summary text is mixed into the same turn', () => {
    // sig_a seals ONLY 'a'; attaching it to the concatenated 'ab' would claim
    // coverage the blob never had.
    const chat = responsesToChat({
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'a' }], encrypted_content: 'sig_a' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'b' }], encrypted_content: null },
        { role: 'assistant', content: 'ok' },
      ],
    });
    assert.equal(chat.messages[0].reasoning_content, 'ab');
    assert.equal('reasoning_signature' in chat.messages[0], false);
  });

  it('drops a blob-only signature when unsigned text arrives after it', () => {
    // The signature seals no text at all here; 'b' is unsigned text, so the
    // pair can never honestly claim 'b' is sealed.
    const chat = responsesToChat({
      input: [
        { type: 'reasoning', summary: [], encrypted_content: 'sig_a' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'b' }] },
        { role: 'assistant', content: 'ok' },
      ],
    });
    assert.equal(chat.messages[0].reasoning_content, 'b');
    assert.equal('reasoning_signature' in chat.messages[0], false);
  });

  it('still drops the signature when unsigned text arrives BEFORE the signed item', () => {
    // Same mispairing, other order: 'a' is unsigned, sig_b seals only 'b',
    // and the replayed field would carry 'ab'.
    const chat = responsesToChat({
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'a' }], encrypted_content: null },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'b' }], encrypted_content: 'sig_b' },
        { role: 'assistant', content: 'ok' },
      ],
    });
    assert.equal(chat.messages[0].reasoning_content, 'ab');
    assert.equal('reasoning_signature' in chat.messages[0], false);
  });
});

describe('G01 input side: signed replay on the prompt-emulation path', () => {
  it('does not 400 with signed_thinking_tool_history_unsupported when tools are declared', async () => {
    const prevConnect = process.env.DEVIN_CONNECT;
    const prevReplay = process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING;
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = '1';
    // Prompt-emulation default: native tool calling off → the chat layer's gate
    // is live (chat.js `signed_thinking_tool_history_unsupported`).
    _resetRuntimeConfigForTests({ experimental: { nativeToolCall: false } });
    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen.push(params);
        return {
          status: 200,
          body: {
            id: 'chatcmpl-test',
            model: 'claude-5-fable-medium',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          },
        };
      },
    });
    const body = {
      model: 'claude-5-fable-medium',
      input: [
        { role: 'user', content: 'run it' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'prior thought' }], encrypted_content: 'enc_blob' },
        { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'echo hi' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'hi' },
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run code.' }],
    };
    try {
      // The translated shape itself: text rides the turn, signature does not.
      const translated = responsesToChat(body);
      const assistant = translated.messages.find(m => m.role === 'assistant');
      assert.equal(assistant.reasoning_content, 'prior thought');
      assert.equal('reasoning_signature' in assistant, false);

      // And the real chat handler must accept it end to end.
      const result = await handleResponses(body, { handleChatCompletions });
      assert.notEqual(
        result.body?.error?.code,
        'signed_thinking_tool_history_unsupported',
        JSON.stringify(result.body),
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(seen.length, 1, 'the replayed turn must reach the model');
    } finally {
      __resetConnectDeps();
      _resetRuntimeConfigForTests();
      if (prevConnect === undefined) delete process.env.DEVIN_CONNECT;
      else process.env.DEVIN_CONNECT = prevConnect;
      if (prevReplay === undefined) delete process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING;
      else process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING = prevReplay;
    }
  });
});

describe('G02: text.verbosity forwarding', () => {
  it('maps text.verbosity to the forwarded chat body verbosity', () => {
    const out = responsesToChat({ input: 'hi', text: { verbosity: 'low' } });
    assert.equal(out.verbosity, 'low');
  });

  it('forwards verbosity to the chat handler and omits it when not supplied', async () => {
    const withVerbosity = {};
    await handleResponses(
      { model: 'gpt-5.2', input: 'hi', text: { verbosity: 'low' } },
      nonStreamDeps(reasoningUpstream(), withVerbosity),
    );
    assert.equal(withVerbosity.body.verbosity, 'low');

    const without = {};
    await handleResponses(
      { model: 'gpt-5.2', input: 'hi' },
      nonStreamDeps(reasoningUpstream(), without),
    );
    assert.equal('verbosity' in without.body, false, 'absence stays absence');
  });

  it('ignores a non-string verbosity instead of forwarding a malformed value', () => {
    const out = responsesToChat({ input: 'hi', text: { verbosity: 5 } });
    assert.equal('verbosity' in out, false);
  });

  it('carries verbosity to the chat boundary on the streaming path without breaking the turn', async () => {
    const captured = {};
    const events = await runStream(
      { model: 'gpt-5.2', input: 'hi', stream: true, text: { verbosity: 'low' } },
      [
        chatChunk({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
        chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        DONE,
      ],
      captured,
    );
    // The Responses surface hands the preference to the chat layer; whether the
    // selected backend can honour it is that layer's decision and is NOT claimed
    // here. What this pins is the boundary contract and that the turn still ends.
    assert.equal(captured.body.verbosity, 'low');
    assert.equal(events.at(-1).event, 'response.completed');
    assert.equal(events.some(e => e.event === 'response.failed'), false);
  });
});

describe('G03: custom tool input streaming', () => {
  it('streams custom_tool_call_input deltas and a final item with the full raw input', async () => {
    // The upstream streams the {"input":"…"} envelope the bridge declared, split
    // INSIDE an escape sequence — the decoder must withhold the partial escape
    // and never guess a character.
    const fullArgs = JSON.stringify({ input: 'print("hi")' });
    const splitAt = fullArgs.indexOf('\\') + 1; // between the backslash and the quote
    const events = await runStream(
      {
        model: 'gpt-5.2',
        input: 'run it',
        stream: true,
        tools: [{ type: 'custom', name: 'exec', description: 'Run code.' }],
      },
      [
        chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_exec', type: 'function', function: { name: 'exec', arguments: fullArgs.slice(0, splitAt) } }] } }] }),
        chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fullArgs.slice(splitAt) } }] } }] }),
        chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        DONE,
      ],
    );
    assertSequenceNumbers(events);

    const addedEvent = events.find(e => e.event === 'response.output_item.added');
    const added = addedEvent.data.item;
    assert.equal(added.type, 'custom_tool_call');
    assert.ok(added.id, 'the custom item needs an id for its input events to name');

    const deltas = events.filter(e => e.event === 'response.custom_tool_call_input.delta');
    assert.ok(deltas.length >= 2, 'input must stream progressively, not in one final lump');
    assert.equal(deltas.map(e => e.data.delta).join(''), 'print("hi")');
    for (const delta of deltas) {
      assert.equal(delta.data.item_id, added.id);
      assert.equal(delta.data.output_index, addedEvent.data.output_index);
    }

    const inputDone = events.find(e => e.event === 'response.custom_tool_call_input.done');
    assert.ok(inputDone, 'the input family must close with .done');
    assert.equal(inputDone.data.input, 'print("hi")');

    const doneItem = events.find(e => e.event === 'response.output_item.done').data.item;
    assert.equal(doneItem.type, 'custom_tool_call');
    assert.equal(doneItem.input, 'print("hi")', 'the final item must carry the full input, not input:""');
    assert.equal(doneItem.status, 'completed');

    // Custom input must not leak onto the function-call channel.
    assert.equal(events.some(e => e.event === 'response.function_call_arguments.delta'), false);
  });

  it('emits the deltas after a split name settles (deferred custom call)', async () => {
    const events = await runStream(
      {
        model: 'gpt-5.2',
        input: 'run it',
        stream: true,
        tools: [{ type: 'custom', name: 'exec', description: 'Run code.' }],
      },
      [
        // Arguments first: the name is not known yet, so the item is deferred.
        chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_exec', type: 'function', function: { arguments: '{"input":"ec' } }] } }] }),
        chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'exec', arguments: 'ho"}' } }] } }] }),
        chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        DONE,
      ],
    );
    assertSequenceNumbers(events);

    const addedIndex = events.findIndex(e => e.event === 'response.output_item.added');
    const firstDelta = events.findIndex(e => e.event === 'response.custom_tool_call_input.delta');
    assert.ok(addedIndex >= 0 && firstDelta > addedIndex, 'added must precede the input deltas');
    assert.equal(
      events.filter(e => e.event === 'response.custom_tool_call_input.delta').map(e => e.data.delta).join(''),
      'echo',
    );
    const inputDone = events.find(e => e.event === 'response.custom_tool_call_input.done');
    assert.ok(inputDone, 'the input family must close with .done');
    assert.equal(inputDone.data.input, 'echo');
    const doneItem = events.find(e => e.event === 'response.output_item.done').data.item;
    assert.equal(doneItem.type, 'custom_tool_call');
    assert.equal(doneItem.input, 'echo');
  });

  it('gives a non-stream custom item the same item id shape as the streamed one', async () => {
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'run it', tools: [{ type: 'custom', name: 'exec', description: 'Run code.' }] },
      nonStreamDeps((body) => ({
        status: 200,
        body: {
          created: 123,
          model: body.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_exec', type: 'function', function: { name: 'exec', arguments: '{"input":"echo hi"}' } }],
            },
            finish_reason: 'tool_calls',
          }],
        },
      }), {}),
    );
    assert.equal(result.status, 200);
    const item = result.body.output.find(i => i.type === 'custom_tool_call');
    assert.ok(item);
    assert.match(item.id, /^fc_[0-9a-f]{24}$/, 'non-stream and streamed custom items must agree on having an id');
    assert.equal(item.call_id, 'call_exec');
    assert.equal(item.input, 'echo hi');
  });
});

describe('G3: an upstream that never said how it ended is a failed turn', () => {
  beforeEach(() => resetResponseStore());

  const errorUpstream = () => (body) => ({
    status: 200,
    body: {
      created: 123,
      model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'half an answer' },
        finish_reason: 'error',
      }],
    },
  });

  it('non-stream: finish_reason "error" closes as status failed, not completed', async () => {
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi', store: true },
      nonStreamDeps(errorUpstream(), {}),
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.error?.code, 'UPSTREAM_UNTERMINATED');
    assert.equal('incomplete_details' in result.body, false, 'a failure is not a token-cap truncation');
    // The bytes the upstream did send stay visible; only the terminal changes.
    assert.equal(result.body.output.some(item => item.type === 'message'), true);
  });

  it('non-stream: an explicit unterminated flag fails even with finish_reason "stop"', async () => {
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi' },
      nonStreamDeps((body) => ({
        status: 200,
        body: {
          created: 123,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'half' }, finish_reason: 'stop', unterminated: true }],
        },
      }), {}),
    );
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.error?.code, 'UPSTREAM_UNTERMINATED');
  });

  it('does not store a failed turn as the next turn\'s context', async () => {
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi', store: true },
      nonStreamDeps(errorUpstream(), {}),
    );
    assert.equal(result.body.status, 'failed');
    const got = handleGetResponse(result.body.id, { context: { callerKey: CONTEXT.callerKey } });
    assert.equal(got.status, 404, JSON.stringify(got.body));
  });

  it('stream: finish_reason "error" emits response.failed, never response.completed', async () => {
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi', stream: true },
      streamDeps([
        chatChunk({ choices: [{ index: 0, delta: { content: 'half an answer' } }] }),
        chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }),
        DONE,
      ]),
    );
    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    const failed = events.find(e => e.event === 'response.failed');
    assert.ok(failed, 'the terminal event must be a failure');
    assert.equal(failed.data.response.status, 'failed');
    assert.equal(failed.data.response.error?.code, 'UPSTREAM_UNTERMINATED');
    assert.equal(events.some(e => e.event === 'response.completed'), false);
    assert.equal(events.some(e => e.event === 'response.incomplete'), false);
    // A failed turn must not wear the clean-end sentinel a relay reads as "whole".
    assert.equal(res.body.includes('data: [DONE]'), false);
  });

  it('stream: an unterminated marker fails even when finish_reason is "stop"', async () => {
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi', stream: true },
      streamDeps([
        chatChunk({ choices: [{ index: 0, delta: { content: 'half' } }] }),
        chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop', unterminated: true }] }),
        DONE,
      ]),
    );
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.ok(events.find(e => e.event === 'response.failed'));
    assert.equal(events.some(e => e.event === 'response.completed'), false);
    assert.equal(events.some(e => e.event === 'response.incomplete'), false);
  });
});
