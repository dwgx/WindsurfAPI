// A06/KH-018: Cascade's poll loop returns `max_wait` / `stall_warm` /
// `idle_empty` as a NORMAL array. Before this, both Chat builders chose only
// `stop` or `tool_calls`, so a half answer looked complete; /v1/responses then
// committed it to the store as the next turn's context.
//
// The contract this file pins:
//   - a poll-window/stall exit WITH output is a typed `length` truncation on
//     Chat, and an `upstream_incomplete` Responses turn that is NOT stored;
//   - an exit with NO output (`idle_empty`) is a typed upstream error, never a
//     200 empty completion;
//   - the stream paths never say `finish_reason:"stop"` for either shape.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleGemini } from '../src/handlers/gemini.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import * as store from '../src/response-store.js';
import { addAccountByKey, getApiKey, removeAccount } from '../src/auth.js';

const CALLER = 'api:a06:user:u1';
const createdAccountIds = [];

afterEach(() => {
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
});

beforeEach(() => store.resetResponseStore());

function newAccount() {
  const account = addAccountByKey(
    `a06-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'a06',
  );
  createdAccountIds.push(account.id);
  return account;
}

function chatDeps(Client) {
  return {
    waitForAccount(tried, _signal, _maxWaitMs, modelKey) {
      return tried.length === 0 ? getApiKey(tried, modelKey) : null;
    },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: Client,
    callerKey: CALLER,
  };
}

class TruncatingClient {
  constructor(options = {}) {
    this.options = options;
    this.calls = 0;
  }

  async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
    this.calls++;
    const { text = '', thinking = '', endReason = 'max_wait' } = this.options;
    if (opts.onChunk) {
      if (thinking) await opts.onChunk({ text: '', thinking, isError: false });
      if (text) await opts.onChunk({ text, thinking: '', isError: false });
    }
    const chunks = opts.onChunk
      ? []
      : (text || thinking ? [{ text, thinking, isError: false }] : []);
    chunks.endReason = endReason;
    chunks.toolCalls = [];
    chunks.totalYielded = text.length;
    chunks.totalThinking = thinking.length;
    return chunks;
  }
}

async function runChat(body, options) {
  newAccount();
  const holder = { instance: null };
  class Client extends TruncatingClient {
    constructor(...args) {
      super(options);
      holder.instance = this;
    }
  }
  const result = await handleChatCompletions(body, chatDeps(Client));
  return { result, client: holder.instance };
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
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
    removeListener() {},
  };
}

function chatFrames(body) {
  return body.split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => frame.split('\n').find(line => line.startsWith('data: '))?.slice(6))
    .filter(Boolean);
}

function terminalChunk(body) {
  for (const raw of chatFrames(body)) {
    if (raw === '[DONE]') continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const choice = parsed.choices?.[0];
    if (choice?.finish_reason) return { parsed, choice };
  }
  return null;
}

function eventNames(body) {
  return [...body.matchAll(/^event: (\S+)$/gm)].map(m => m[1]);
}

function lastEvent(body) {
  return eventNames(body).at(-1);
}

function eventData(body, name) {
  const m = body.match(new RegExp(`^event: ${name}\\ndata: (.*)$`, 'm'));
  return m ? JSON.parse(m[1]) : null;
}

async function runResponses(body, options) {
  newAccount();
  const holder = { instance: null };
  class Client extends TruncatingClient {
    constructor(...args) {
      super(options);
      holder.instance = this;
    }
  }
  const result = await handleResponses(body, {
    context: chatDeps(Client),
  });
  return { result, client: holder.instance };
}

async function runMessages(body, options) {
  newAccount();
  const holder = { instance: null };
  class Client extends TruncatingClient {
    constructor(...args) {
      super(options);
      holder.instance = this;
    }
  }
  const result = await handleMessages(body, {
    callerKey: CALLER,
    async handleChatCompletions(chatBody, context) {
      return handleChatCompletions(chatBody, { ...context, ...chatDeps(Client) });
    },
  });
  return { result, client: holder.instance };
}

async function runGemini(body, options, { alt = null } = {}) {
  newAccount();
  const holder = { instance: null };
  class Client extends TruncatingClient {
    constructor(...args) {
      super(options);
      holder.instance = this;
    }
  }
  const result = await handleGemini(body.model, body, {
    callerKey: CALLER,
    async handleChatCompletions(chatBody, context) {
      return handleChatCompletions(chatBody, { ...context, ...chatDeps(Client) });
    },
  }, { stream: !!body.stream, alt });
  return { result, client: holder.instance };
}

function geminiSseFrames(body) {
  return body.split('\r\n\r\n')
    .filter(Boolean)
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
}

describe('A06 Cascade poll truncation terminal', () => {
  it('max_wait/stall_warm/idle_empty end with typed length/error and are not committed as completed', async () => {
    for (const endReason of ['max_wait', 'stall_warm']) {
      const { result: nonStream } = await runChat({
        model: 'gemini-2.5-flash',
        stream: false,
        messages: [{ role: 'user', content: 'write a long answer' }],
      }, { text: 'partial answer', endReason });

      assert.equal(nonStream.status, 200, `${endReason}: a partial answer is still delivered`);
      assert.equal(nonStream.body.choices[0].finish_reason, 'length',
        `${endReason}: truncation must be typed length, never stop`);
      assert.equal(nonStream.body.choices[0]._windsurf_end_reason, 'upstream_truncated');
      assert.equal(nonStream.body.choices[0].message.content, 'partial answer');

      const { result: stream } = await runChat({
        model: 'gemini-2.5-flash',
        stream: true,
        messages: [{ role: 'user', content: 'write a long answer' }],
      }, { text: 'partial answer', endReason });
      assert.equal(stream.status, 200);
      const res = fakeRes();
      await stream.handler(res);
      const terminal = terminalChunk(res.body);
      assert.equal(terminal?.choice.finish_reason, 'length',
        `${endReason}: stream truncation must be typed length, never stop`);
      assert.equal(terminal?.parsed.__windsurf_end_reason, 'upstream_truncated');
      assert.equal(res.body.includes('"finish_reason":"stop"'), false);

      // /v1/responses: incomplete + upstream_incomplete, and NOT chainable.
      const { result: responsesNonStream } = await runResponses({
        model: 'gemini-2.5-flash',
        stream: false,
        store: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'write a long answer' }] }],
      }, { text: 'partial answer', endReason });
      assert.equal(responsesNonStream.status, 200);
      assert.equal(responsesNonStream.body.status, 'incomplete');
      assert.equal(responsesNonStream.body.incomplete_details.reason, 'upstream_incomplete');
      assert.equal(store.getResponse(responsesNonStream.body.id, CALLER).ok, false,
        `${endReason}: an interrupted turn must not be committed to the response store`);

      const { result: responsesStream } = await runResponses({
        model: 'gemini-2.5-flash',
        stream: true,
        store: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'write a long answer' }] }],
      }, { text: 'partial answer', endReason });
      assert.equal(responsesStream.status, 200);
      const responsesRes = fakeRes();
      await responsesStream.handler(responsesRes);
      assert.equal(lastEvent(responsesRes.body), 'response.incomplete');
      assert.equal(eventData(responsesRes.body, 'response.incomplete').response.incomplete_details.reason, 'upstream_incomplete');
      const responseId = responsesRes.body.match(/"id":"(resp_[^"]+)"/)?.[1];
      assert.ok(responseId, 'precondition: a response id was minted');
      assert.equal(store.getResponse(responseId, CALLER).ok, false,
        `${endReason}: a streamed interrupted turn must not be chainable`);
      assert.equal(responsesRes.body.trimEnd().endsWith('data: [DONE]'), false,
        `${endReason}: an upstream truncation must not get the clean-end sentinel`);

      // /v1/messages stream: the Anthropic translator must emit an error event,
      // not a normal end_turn/message_stop for a fabricated length terminal.
      const { result: messagesStream } = await runMessages({
        model: 'claude-sonnet-4.6',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'write a long answer' }],
      }, { text: 'partial answer', endReason });
      assert.equal(messagesStream.status, 200);
      const messagesRes = fakeRes();
      await messagesStream.handler(messagesRes);
      assert.equal(/"stop_reason":"end_turn"/.test(messagesRes.body), false,
        `${endReason}: a truncated turn must not be reported as a natural end_turn`);
      assert.ok(/event: error/.test(messagesRes.body),
        `${endReason}: the truncation must surface as an Anthropic error event`);

      // Buffered Messages: the fabricated length terminal rides the private
      // truncation carrier, so the buffered arm must refuse the turn through
      // the same retryable envelope (529 overloaded_error), never render the
      // interrupted answer as a 200 max_tokens completion.
      const { result: messagesNonStream } = await runMessages({
        model: 'claude-sonnet-4.6',
        stream: false,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'write a long answer' }],
      }, { text: 'partial answer', endReason });
      assert.equal(messagesNonStream.status, 529,
        `${endReason}: buffered Messages must report the interruption as 529 overloaded_error`);
      assert.equal(messagesNonStream.body.type, 'error');
      assert.equal(messagesNonStream.body.error.type, 'overloaded_error');

      // Buffered Gemini: same refusal in Gemini vocabulary — 503 UNAVAILABLE,
      // never a 200 candidate typed MAX_TOKENS.
      const { result: geminiNonStream } = await runGemini({
        model: 'gemini-2.5-flash',
        stream: false,
        contents: [{ role: 'user', parts: [{ text: 'write a long answer' }] }],
      }, { text: 'partial answer', endReason });
      assert.equal(geminiNonStream.status, 503,
        `${endReason}: buffered Gemini must report the interruption as 503 UNAVAILABLE`);
      assert.equal(geminiNonStream.body.error.code, 503);
      assert.equal(geminiNonStream.body.error.status, 'UNAVAILABLE');

      // Gemini streams (SSE and JSON array): the partial deltas may flow, but
      // the terminal must be an error frame (503 UNAVAILABLE), not a STOP /
      // MAX_TOKENS candidate.
      for (const alt of ['sse', null]) {
        const { result: geminiStream } = await runGemini({
          model: 'gemini-2.5-flash',
          stream: true,
          contents: [{ role: 'user', parts: [{ text: 'write a long answer' }] }],
        }, { text: 'partial answer', endReason }, { alt });
        assert.equal(geminiStream.status, 200);
        const geminiRes = fakeRes();
        await geminiStream.handler(geminiRes);
        const frames = alt === 'sse'
          ? geminiSseFrames(geminiRes.body)
          : JSON.parse(geminiRes.body);
        const errorFrame = frames.find((frame) => frame.error);
        assert.ok(errorFrame, `${endReason}: ${alt || 'array'} stream must carry an error frame`);
        assert.equal(errorFrame.error.code, 503,
          `${endReason}: ${alt || 'array'} stream interruption must be retryable 503`);
        assert.equal(errorFrame.error.status, 'UNAVAILABLE');
        assert.equal(frames.some((frame) => frame.candidates?.[0]?.finishReason),
          false, `${endReason}: ${alt || 'array'} stream must not emit a terminal candidate`);
      }
    }

    // idle_empty: no output at all is an upstream error, never a 200 empty stop.
    const { result: emptyNonStream } = await runChat({
      model: 'gemini-2.5-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, { text: '', endReason: 'idle_empty' });
    assert.equal(emptyNonStream.status, 502);
    assert.equal(emptyNonStream.body.error.type, 'upstream_empty_response');
    assert.equal(emptyNonStream.body.error.code, 'EMPTY_RESPONSE');

    const { result: emptyStream } = await runChat({
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, { text: '', endReason: 'idle_empty' });
    const emptyRes = fakeRes();
    await emptyStream.handler(emptyRes);
    assert.match(emptyRes.body, /"error"/);
    assert.equal(emptyRes.body.includes('"finish_reason":"stop"'), false);
    assert.equal(chatFrames(emptyRes.body).includes('[DONE]'), false,
      'an error stream must not claim a clean finish');

    const { result: emptyResponses } = await runResponses({
      model: 'gemini-2.5-flash',
      stream: false,
      store: true,
      input: 'hi',
    }, { text: '', endReason: 'idle_empty' });
    assert.equal(emptyResponses.status, 502);
    assert.equal(emptyResponses.body.error.type, 'upstream_empty_response');
  });

  it('a legitimate upstream stop is still a normal completion and stays chainable', async () => {
    const { result } = await runChat({
      model: 'gemini-2.5-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, { text: 'complete answer', endReason: 'idle_done' });
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].finish_reason, 'stop');
    assert.equal(result.body.choices[0]._windsurf_end_reason, undefined);

    const { result: responses } = await runResponses({
      model: 'gemini-2.5-flash',
      stream: false,
      store: true,
      input: 'hi',
    }, { text: 'complete answer', endReason: 'idle_done' });
    assert.equal(responses.status, 200);
    assert.equal(responses.body.status, 'completed');
    assert.equal(store.getResponse(responses.body.id, CALLER).ok, true,
      'a clean turn must remain chainable');

    // The buffered adapters must keep translating a clean turn normally — the
    // interruption guard below keys on the private truncation carrier, not on
    // the stop reason itself.
    const { result: messagesClean } = await runMessages({
      model: 'claude-sonnet-4.6',
      stream: false,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }, { text: 'complete answer', endReason: 'idle_done' });
    assert.equal(messagesClean.status, 200);
    assert.equal(messagesClean.body.stop_reason, 'end_turn');

    const { result: geminiClean } = await runGemini({
      model: 'gemini-2.5-flash',
      stream: false,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, { text: 'complete answer', endReason: 'idle_done' });
    assert.equal(geminiClean.status, 200);
    assert.equal(geminiClean.body.candidates[0].finishReason, 'STOP');
  });

  it('a genuine caller output cap stays a normal token-limit completion on every adapter', async () => {
    // A real token cap reaches the adapters as finish_reason:'length' WITHOUT
    // the private truncation carrier (chat.js applyOutputCap), so it must keep
    // its ordinary max_tokens / MAX_TOKENS rendering everywhere.
    const longText = 'x'.repeat(200);
    const { result: chatCap } = await runChat({
      model: 'gemini-2.5-flash',
      stream: false,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'write a long chat answer' }],
    }, { text: longText, endReason: 'idle_done' });
    assert.equal(chatCap.status, 200);
    assert.equal(chatCap.body.choices[0].finish_reason, 'length',
      'precondition: the caller cap is enforced locally as length');
    assert.equal(chatCap.body.choices[0]._windsurf_end_reason, undefined,
      'precondition: a genuine cap carries no interruption marker');
    assert.equal(chatCap.body.choices[0]._windsurf_truncated, undefined);
    assert.ok(chatCap.body.choices[0].message.content.length <= 80,
      'precondition: the cap actually truncated the text (20 tokens × 4 chars)');

    const { result: messagesCap } = await runMessages({
      model: 'claude-sonnet-4.6',
      stream: false,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'write a long messages answer' }],
    }, { text: longText, endReason: 'idle_done' });
    assert.equal(messagesCap.status, 200);
    assert.equal(messagesCap.body.stop_reason, 'max_tokens',
      'a genuine cap must stay a normal max_tokens stop');

    const { result: geminiCap } = await runGemini({
      model: 'gemini-2.5-flash',
      stream: false,
      generationConfig: { maxOutputTokens: 20 },
      contents: [{ role: 'user', parts: [{ text: 'write a long gemini answer' }] }],
    }, { text: longText, endReason: 'idle_done' });
    assert.equal(geminiCap.status, 200);
    assert.equal(geminiCap.body.candidates[0].finishReason, 'MAX_TOKENS',
      'a genuine cap must stay a normal MAX_TOKENS candidate');
  });

});
