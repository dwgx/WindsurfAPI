import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/config.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { getSessionReasoningTrail, _getStoreSize, _resetForTests } from '../src/session-continuity.js';

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

const CALLER = 'session:t2-fallback-caller';
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

// The deployment scope switch is sampled once, at module load. Isolate that
// snapshot while using the real handler with the same synthetic transport.
async function scopedChat(singleTenant) {
  const saved = process.env.WINDSURFAPI_SINGLE_TENANT_CACHE;
  try {
    process.env.WINDSURFAPI_SINGLE_TENANT_CACHE = singleTenant ? '1' : '0';
    return await import(`../src/handlers/chat.js?continuity-single-tenant=${singleTenant}`);
  } finally {
    if (saved === undefined) delete process.env.WINDSURFAPI_SINGLE_TENANT_CACHE;
    else process.env.WINDSURFAPI_SINGLE_TENANT_CACHE = saved;
  }
}

describe('Connect continuity follows the caller scope at dispatch and completion', () => {
  const settings = {
    DEVIN_CONNECT: '1', DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_MODEL_CONFIG_STABLE: '1',
    DEVIN_CONNECT_SESSION_REASONING_INJECT: '1', DEVIN_CONNECT_IMAGE_TAG: '10', RESPONSE_CACHE_ENABLED: '0',
  };
  let account, saved;
  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    Object.assign(process.env, settings);
    _resetForTests();
    account = addAccountByKey('fixture-connect-scope', 'scope-fixture');
  });
  afterEach(() => {
    removeAccount(account.id);
    _resetForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const cases = [
    { name: 'absent identity', callerKey: '' },
    { name: 'unattributed key', callerKey: 'api:fixture' },
    { name: 'guessed client', callerKey: 'api:fixture:client:fixture' },
    { name: 'attributed user', callerKey: 'api:fixture:user:fixture', reuse: true },
    { name: 'explicit session', callerKey: 'session:fixture', reuse: true },
    { name: 'single-tenant guessed client', callerKey: 'api:fixture:client:fixture', singleTenant: true, reuse: true },
    { name: 'single-tenant unattributed key', callerKey: 'api:fixture', singleTenant: true },
    { name: 'disabled reuse', callerKey: 'session:fixture', disabled: true },
    { name: 'disabled image transport', callerKey: 'session:fixture', imagesOff: true, reuse: true },
    { name: 'media-only opener with disabled image transport', callerKey: 'session:fixture', imagesOff: true, mediaOnly: true },
  ];
  for (const stream of [false, true]) {
    it(`${stream ? 'streamed' : 'buffered'} completion cannot recreate a state evicted after dispatch`, async (t) => {
      const chat = await scopedChat(false);
      t.after(() => chat.__resetConnectDeps());
      let dispatches = 0;
      const evict = (params) => {
        assert.ok(params.sessionId);
        assert.equal(_getStoreSize(), 1);
        _resetForTests();
        dispatches++;
      };
      chat.__setConnectDeps({
        async toChatCompletion(params) {
          evict(params);
          return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
        },
        async streamChatCompletion(params, send) {
          evict(params);
          await send('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
          await send('data: [DONE]\n\n');
          return { content: 'ok', finish_reason: 'stop' };
        },
      });
      const result = await chat.handleChatCompletions(
        { model: 'swe-1-6-slow', stream, messages: [{ role: 'user', content: 'one work item' }] },
        { callerKey: CALLER },
      );
      assert.equal(result.status, 200);
      if (stream) {
        const res = makeRes();
        await result.handler(res);
        assert.match(res.body, /\[DONE\]/);
      } else assert.equal(result.body.choices[0].message.content, 'ok');
      assert.equal(dispatches, 1);
      assert.equal(_getStoreSize(), 0);
    });
  }
  it('reports a fresh session for an image with no stable content identity', async (t) => {
    const chat = await scopedChat(false);
    t.after(() => chat.__resetConnectDeps());
    const notices = [];
    t.mock.method(log, 'debug', line => notices.push(line));
    chat.__setConnectDeps({
      async toChatCompletion(params) {
        assert.equal(params.sessionId, undefined);
        assert.equal(params.sessionModelConfig, undefined);
        assert.equal(params.continuityTrail, undefined);
        return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
      },
    });
    const result = await chat.handleChatCompletions({
      model: 'swe-1-6-slow', messages: [{ role: 'user', content: [
        { type: 'text', text: 'image input' },
        { type: 'image_url', image_url: { url: 'https://fixture.invalid/image' } },
      ] }],
    }, { callerKey: CALLER });
    assert.equal(result.status, 200);
    assert.equal(_getStoreSize(), 0);
    assert.ok(notices.some(line => String(line).includes('image content identity unavailable')));
  });
  for (const stream of [false, true]) {
    for (const example of cases) {
      it(`${stream ? 'streamed' : 'buffered'} / ${example.name}`, async (t) => {
        const chat = await scopedChat(!!example.singleTenant);
        t.after(() => chat.__resetConnectDeps());
        if (example.disabled) delete process.env.DEVIN_CONNECT_SESSION_REUSE;
        if (example.imagesOff) process.env.DEVIN_CONNECT_IMAGE_TAG = '0';
        const notices = [];
        t.mock.method(log, 'debug', (message) => {
          if (typeof message === 'string' && message.includes('session_id source=fresh-per-request')) notices.push(message);
        });
        const calls = [];
        chat.__setConnectDeps({
          async toChatCompletion(params) {
            calls.push(params);
            return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
          },
          async streamChatCompletion(params, send) {
            calls.push(params);
            await send('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
            await send('data: [DONE]\n\n');
            return { content: 'ok', finish_reason: 'stop' };
          },
        });
        const image = { type: 'image_url', image_url: { url: 'https://fixture.invalid/image' } };
        let openingContent = 'hi';
        if (example.imagesOff) {
          openingContent = example.mediaOnly ? [image] : [{ type: 'text', text: 'hi' }, image];
        }
        const opening = [{ role: 'user', content: openingContent }];
        for (const messages of [opening, example.mediaOnly ? opening : nextTurnMessages()]) {
          const result = await chat.handleChatCompletions(
            { model: 'swe-1-6-slow', stream, messages, __incomingThinking: INCOMING },
            { callerKey: example.callerKey },
          );
          assert.equal(result.status, 200);
          if (stream) {
            const res = makeRes();
            await result.handler(res);
            assert.match(res.body, /\[DONE\]/);
          } else {
            assert.equal(result.body.choices[0].message.content, 'ok');
          }
        }
        assert.equal(calls.length, 2);
        if (example.imagesOff) {
          // Only the continuity view strips images. This mock never fetches the reference.
          assert.ok(calls[0].messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')));
        }
        if (example.reuse) {
          const [first, second] = calls;
          assert.ok(first.sessionId, 'the opening turn must receive a continuity session ID');
          assert.equal(notices.length, 0);
          assert.equal(second.sessionId, first.sessionId);
          assert.ok(first.sessionModelConfig.id);
          assert.deepEqual(second.sessionModelConfig, { id: first.sessionModelConfig.id, turn: 2 });
          assert.ok(second.continuityTrail?.includes(INCOMING));
          assert.equal(_getStoreSize(), 1);
        } else {
          assert.equal(_getStoreSize(), 0, 'a caller on the fresh-session path must leave no continuity state');
          const reason = example.disabled ? 'DEVIN_CONNECT_SESSION_REUSE off'
            : example.mediaOnly ? 'no input identity after disabling images' : 'no per-user or session scope';
          assert.equal(notices.length, 2);
          assert.ok(notices.every(line => line.includes(reason)));
          for (const params of calls) {
            assert.equal(params.sessionId, undefined, 'leave ID generation to the fresh-session adapter');
            assert.equal(params.sessionModelConfig, undefined);
            assert.equal(params.continuityTrail, undefined);
          }
        }
      });
    }
  }
});

describe('session-continuity T2: commit fallback to inbound captured thinking', () => {
  let cacheSetting;
  beforeEach(() => {
    cacheSetting = process.env.RESPONSE_CACHE_ENABLED;
    process.env.RESPONSE_CACHE_ENABLED = '0';
    _resetForTests();
    addAccountByKey('sk-connect-test-t2', 't2');
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_SESSION_REUSE = '1';
  });
  afterEach(() => {
    if (cacheSetting === undefined) delete process.env.RESPONSE_CACHE_ENABLED;
    else process.env.RESPONSE_CACHE_ENABLED = cacheSetting;
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
        return { content: 'ok', finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } };
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
