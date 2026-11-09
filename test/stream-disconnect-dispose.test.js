// M9 — SseFramer.dispose() had zero callers. On a client disconnect the
// Messages and Gemini translators disposed the bounded writer but never the
// framer, so whatever the framer still retained (a partial line, queued data
// bytes) stayed reachable until GC — the "flood bytes unreachable" contract
// documented on SseFramer.dispose() was unenforced on both captureRes shims.
//
// These tests drive the real handleMessages / handleGemini streaming path with
// a chat handler that parks mid-turn, emit 'close' on the socket, and observe
// SseFramer.prototype.dispose through a spy — the only caller the fix adds is
// _clientDisconnected(), so a green run proves the wiring, not just the method.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SseFramer } from '../src/sse-framer.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleGemini } from '../src/handlers/gemini.js';
import { handleResponses } from '../src/handlers/responses.js';

// A socket the test owns: 'close' can be emitted mid-stream (a real hang-up)
// without writableEnded flipping — exactly the state _clientDisconnected() is
// built for.
function emitterRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = () => res;
  res.write = () => true;
  res.end = function end(chunk) {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    return this;
  };
  return res;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// One content delta, then the producer parks until the capture side reports
// 'close' — the window a client disconnect lands in.
const parkedChat = async () => ({
  status: 200,
  stream: true,
  async handler(captureRes) {
    captureRes.write('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
    await new Promise((resolve) => captureRes.on('close', resolve));
  },
});

async function disconnectDisposals(run) {
  let calls = 0;
  const original = SseFramer.prototype.dispose;
  SseFramer.prototype.dispose = function dispose() {
    calls += 1;
    return original.call(this);
  };
  try {
    const result = await run();
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);
    const res = emitterRes();
    const running = result.handler(res);
    await tick(); // let the first frame reach the framer
    res.emit('close');
    await running;
    return calls;
  } finally {
    SseFramer.prototype.dispose = original;
  }
}

describe('client disconnect disposes the translator SSE framer', () => {
  it('/v1/messages: _clientDisconnected runs sseFramer.dispose()', async () => {
    const calls = await disconnectDisposals(() => handleMessages(
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { handleChatCompletions: parkedChat },
    ));
    assert.equal(calls, 1, 'the framer must be disposed exactly once on disconnect');
  });

  it('Gemini stream: _clientDisconnected runs sseFramer.dispose()', async () => {
    const calls = await disconnectDisposals(() => handleGemini(
      'gemini-2.5-pro',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      { handleChatCompletions: parkedChat },
      { stream: true, alt: 'sse' },
    ));
    assert.equal(calls, 1, 'the framer must be disposed exactly once on disconnect');
  });

  it('/v1/responses: _clientDisconnected runs sseFramer.dispose()', async () => {
    const calls = await disconnectDisposals(() => handleResponses(
      {
        model: 'claude-sonnet-4.6',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      },
      { handleChatCompletions: parkedChat, context: { callerKey: 'api:test:disconnect' } },
    ));
    assert.equal(calls, 1, 'the framer must be disposed exactly once on disconnect');
  });
});
