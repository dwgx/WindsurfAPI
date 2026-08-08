import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { addAccountByKey } from '../src/auth.js';
import { getSessionReasoningTrail, _resetForTests } from '../src/session-continuity.js';

// T2 commit-fallback fixture (review: the documented survivor was wrong — the
// __incomingThinking carrier is a plain body field and IS drivable at this
// layer, no handler-integration harness needed).
//
// Under test: when the outbound response carries NO reasoning of its own, the
// reasoning stored for the session must fall back to the inbound captured
// thinking (body.__incomingThinking) — otherwise T2 continuity silently dies
// on exactly that branch. Both commit call sites are driven: the streaming
// one (r.sr?.reasoning) and the non-stream one (msg?.reasoning_content).
// Readback goes through getSessionReasoningTrail: a next-turn history that
// prefixes the committed pair must surface the stored reasoning in the trail.

const CALLER = 't2-fallback-caller';
const INCOMING = 'inbound captured thinking trace';
const TRAIL_ENV = { DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_SESSION_REASONING_INJECT: '1' };

function makeRes() {
  const listeners = new Map();
  return {
    chunks: [],
    body: '', writableEnded: false,
    setHeader() {},
    write(chunk) { const s = String(chunk); this.chunks.push(s); this.body += s; return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; for (const cb of listeners.get('close') || []) cb(); },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
  };
}

function nextTurnMessages() {
  return [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'and again' },
  ];
}

describe('session-continuity T2: commit fallback to inbound captured thinking', () => {
  beforeEach(() => {
    _resetForTests();
    addAccountByKey('sk-connect-test-t2', 't2');
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_SESSION_REUSE = '1';
  });
  afterEach(() => {
    __resetConnectDeps();
    _resetForTests();
    delete process.env.DEVIN_CONNECT;
    delete process.env.DEVIN_CONNECT_SESSION_REUSE;
  });

  it('stream path: r.sr?.reasoning empty → stored reasoning falls back to __incomingThinking', async () => {
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        send('data: {"id":"x","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
        send('data: {"id":"x","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        send('data: [DONE]\n\n');
        // No reasoning on the outbound stream record — the fallback must fire.
        // (attemptStream wraps this into { kind:'ok', sr } itself.)
        return { content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    });
    const { handler } = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, __incomingThinking: INCOMING,
        messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: CALLER });
    assert.equal(typeof handler, 'function');
    await handler(makeRes());
    const trail = getSessionReasoningTrail(CALLER, nextTurnMessages(), TRAIL_ENV);
    assert.ok(trail, 'trail must exist after the commit');
    assert.ok(trail.includes(INCOMING), 'stored reasoning must be the inbound captured thinking');
  });

  it('non-stream path: msg?.reasoning_content empty → stored reasoning falls back to __incomingThinking', async () => {
    __setConnectDeps({
      toChatCompletion: async () => ({
        status: 200,
        body: {
          id: 'x', created: 1, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      }),
    });
    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, __incomingThinking: INCOMING,
        messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: CALLER });
    assert.equal(result.status, 200);
    const trail = getSessionReasoningTrail(CALLER, nextTurnMessages(), TRAIL_ENV);
    assert.ok(trail, 'trail must exist after the commit');
    assert.ok(trail.includes(INCOMING), 'stored reasoning must be the inbound captured thinking');
  });

  it('control: outbound reasoning present → it wins over __incomingThinking', async () => {
    __setConnectDeps({
      toChatCompletion: async () => ({
        status: 200,
        body: {
          id: 'x', created: 1, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok', reasoning_content: 'outbound reasoning wins' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      }),
    });
    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, __incomingThinking: INCOMING,
        messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: CALLER });
    assert.equal(result.status, 200);
    const trail = getSessionReasoningTrail(CALLER, nextTurnMessages(), TRAIL_ENV);
    assert.ok(trail, 'trail must exist after the commit');
    assert.ok(trail.includes('outbound reasoning wins'), 'outbound reasoning must be stored when present');
    assert.ok(!trail.includes(INCOMING), 'the inbound fallback must NOT override outbound reasoning');
  });
});
