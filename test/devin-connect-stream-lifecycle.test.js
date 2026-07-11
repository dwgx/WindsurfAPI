import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount, getAccountInternal, __resetReloginState, __setReloginDeps } from '../src/auth.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { activeSseCount, abortActiveSse } from '../src/sse-registry.js';

// DEVIN_CONNECT stream lifecycle (audit finding): the connect streaming handler
// gained the same abort/heartbeat/SSE-registry wiring the Cascade path already
// had. These exercise the real handler with the connect network call mocked, so
// no token/socket is touched.
//   1. client disconnect mid-stream aborts and does NOT hop to a fresh account
//   2. a server-level context.signal abort likewise stops account-hopping
//   3. heartbeat `: ping` comments are emitted while the stream is silent
//   4. the SSE controller is registered during the stream and unregistered after
//   5. graceful-shutdown drain (abortActiveSse) tears the stream down

const createdIds = [];
const prevEnv = {};

const HEARTBEAT_MS = 15_000; // mirrors the constant in chat.js

function seed(label) {
  const key = `devin-session-token$lc-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
}

function rateLimited() {
  // Pre-emit account dry-well: WITHOUT the abort guard this triggers a
  // cross-account failover hop. It is the control that proves the guard fires.
  return Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' });
}

// Fake res mirroring the SSE write/end/on contract the handler relies on, plus a
// `disconnect()` that fires 'close' WITHOUT marking writableEnded — exactly how
// a real client hang-up (and messages.js's _clientDisconnected) surfaces, so the
// handler's close listener takes the abort path.
function fakeRes() {
  const listeners = new Map();
  return {
    body: '', writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; for (const cb of listeners.get('close') || []) cb(); },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
    disconnect() { for (const cb of listeners.get('close') || []) cb(); },
  };
}

function parseFrames(raw) {
  return raw.split('\n\n').filter(Boolean).filter(f => !f.startsWith(':')).map(f => {
    const d = f.split('\n').find(l => l.startsWith('data: '))?.slice(6) || '';
    return d === '[DONE]' ? '[DONE]' : JSON.parse(d);
  });
}

beforeEach(() => {
  prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
  prevEnv.MAX = process.env.DEVIN_CONNECT_FAILOVER_MAX;
  process.env.DEVIN_CONNECT = '1';
  delete process.env.DEVIN_CONNECT_FAILOVER_MAX;
});

afterEach(() => {
  mock.timers.reset();
  __resetConnectDeps();
  __resetReloginState();
  __setReloginDeps(null);
  if (prevEnv.DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = prevEnv.DEVIN_CONNECT;
  if (prevEnv.MAX === undefined) delete process.env.DEVIN_CONNECT_FAILOVER_MAX;
  else process.env.DEVIN_CONNECT_FAILOVER_MAX = prevEnv.MAX;
  while (createdIds.length) removeAccount(createdIds.pop());
});

describe('DEVIN_CONNECT stream — client disconnect stops account-hopping', () => {
  it('aborts on client disconnect and does NOT fail over to a fresh account', async () => {
    const a = seed('dc-1');
    const b = seed('dc-2');
    let res; // assigned before handler() runs; referenced by the mock closure
    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params) => {
        seen.push(params.token);
        // Client hangs up while the first upstream call is in flight, THEN the
        // upstream returns a normally-failover-eligible RATE_LIMITED. The abort
        // guard must win: no hop to account b.
        res.disconnect();
        throw rateLimited();
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    res = fakeRes();
    await result.handler(res);

    assert.equal(seen.length, 1, 'stopped after the first account — no failover to a dead socket');
    assert.ok(!seen.includes(b.apiKey), 'never touched the second pooled account');
    assert.ok(seen.includes(a.apiKey), 'the first account was the one attempted');
    // No error frame is spun up for a client that already left.
    const frames = parseFrames(res.body);
    assert.ok(!frames.some(f => f !== '[DONE]' && f.error), 'no error frame emitted to the gone client');
  });

  it('aborts on a server-level context.signal and does NOT fail over', async () => {
    const a = seed('sig-1');
    const b = seed('sig-2');
    const ctrl = new AbortController();
    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params) => {
        seen.push(params.token);
        ctrl.abort(); // e.g. server drain / request teardown from server.js wiring
        throw rateLimited();
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '', signal: ctrl.signal },
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(seen.length, 1, 'context.signal abort stops the failover loop');
    assert.ok(!seen.includes(b.apiKey), 'no hop to a second account after the caller aborted');
    assert.ok(seen.includes(a.apiKey));
  });

  it('still fails over normally when the client stays connected (guard is abort-gated)', async () => {
    // Control: without an abort, a pre-emit RATE_LIMITED must still hop — proving
    // the new guard only trips on a real abort, not on every failover.
    seed('ok-1');
    seed('ok-2');
    const seen = [];
    let call = 0;
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        seen.push(params.token);
        // First account (whichever the pool picks) is dry → must hop; the second
        // streams clean. No abort, so the guard stays out of the way.
        if (call++ === 0) throw rateLimited();
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(seen.length, 2, 'connected client still gets the failover hop');
    const frames = parseFrames(res.body);
    assert.ok(frames.some(f => f !== '[DONE]' && f.choices?.[0]?.delta?.content === 'OK'), 'streamed from the healthy account');
  });
});

describe('DEVIN_CONNECT stream — inflight release on pre-attempt abort (audit #2/#3)', () => {
  // REF-3: the top-of-loop abort break at chat.js:2570 fires when a client
  // disconnects between failover hops — AFTER an account was acquired but
  // BEFORE attemptStream (→ finalizeConnectAccount → releaseAccountById) ran for
  // it. Without the release in that break, the acquired account's _inflight slot
  // leaks until the acquire reservation ages out (≤15min), shrinking the pool
  // under disconnect churn. This asserts the slot is returned to 0.
  it('no account is left in-flight when a disconnect interrupts mid-failover', async () => {
    // Account A fails over eligibly, but the disconnect fires during A's attempt.
    // acquireConnectFailover then short-circuits on the aborted signal (returns
    // null → no B acquired), and the post-attempt abort check breaks. A was
    // already finalized (released) by attemptStream. This asserts the whole
    // failover teardown leaves ZERO in-flight slots — the pool-integrity
    // invariant the leak would violate.
    const a = seed('inflight-a');
    const b = seed('inflight-b');
    let res;
    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params) => {
        seen.push(params.token);
        res.disconnect(); // client hangs up during the (only) attempt
        throw rateLimited();
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    res = fakeRes();
    await result.handler(res);

    assert.equal(seen.length, 1, 'no failover hop to a dead socket');
    assert.equal(getAccountInternal(a.id)?._inflight || 0, 0, 'attempted account released');
    assert.equal(getAccountInternal(b.id)?._inflight || 0, 0, 'untouched account holds no slot');
  });

  it('leaves no in-flight slot when the client aborts before the very first attempt', async () => {
    // hop 0 edge: ccAcct was acquired before the loop; if the abort is already
    // visible at loop entry, the break must still release ccAcct.
    const a = seed('inflight-first');
    const ctrl = new AbortController();
    ctrl.abort(); // already aborted before the handler streams
    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params) => { seen.push(params.token); throw rateLimited(); },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '', signal: ctrl.signal },
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(seen.length, 0, 'pre-aborted request never attempts an upstream call');
    assert.equal(getAccountInternal(a.id)?._inflight || 0, 0, 'ccAcct released at the entry abort break (no leak)');
  });
});

describe('DEVIN_CONNECT stream — heartbeat', () => {
  it('emits `: ping` comments while the upstream is silent', async () => {
    seed('hb-1');
    mock.timers.enable({ apis: ['setInterval'] });
    let release;
    const gate = new Promise((r) => { release = r; });
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        // Hold the stream open with no bytes so the heartbeat interval is the
        // only thing writing — the idle-timeout risk the fix addresses.
        await gate;
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'DONE_NOW' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    const done = result.handler(res);
    // Let the handler park at `await gate` (interval already armed), then fire it.
    await Promise.resolve();
    mock.timers.tick(HEARTBEAT_MS);
    mock.timers.tick(HEARTBEAT_MS);
    release();
    await done;

    const pings = (res.body.match(/: ping/g) || []).length;
    assert.ok(pings >= 2, `expected heartbeat pings while idle, got ${pings}`);
    const frames = parseFrames(res.body);
    assert.ok(frames.some(f => f !== '[DONE]' && f.choices?.[0]?.delta?.content === 'DONE_NOW'), 'content still streamed after the idle window');
    assert.equal(frames.at(-1), '[DONE]');
  });

  it('stops the heartbeat after the stream ends (no interval leak)', async () => {
    seed('hb-2');
    mock.timers.enable({ apis: ['setInterval'] });
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'X' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    await result.handler(res);
    const before = res.body.length;
    // The stream is over and the interval should be cleared: further ticks add
    // no more pings.
    mock.timers.tick(HEARTBEAT_MS * 5);
    assert.equal(res.body.length, before, 'no pings after stopHeartbeat()');
  });
});

describe('DEVIN_CONNECT stream — SSE registry', () => {
  it('registers a controller during the stream and unregisters when it ends', async () => {
    seed('reg-1');
    const before = activeSseCount();
    let midCount = -1;
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        midCount = activeSseCount();
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(midCount, before + 1, 'controller was registered while streaming');
    assert.equal(activeSseCount(), before, 'controller unregistered in the finally after the stream ended');
  });

  it('graceful-shutdown drain (abortActiveSse) tears the stream down and stops hopping', async () => {
    const a = seed('drain-1');
    const b = seed('drain-2');
    let release;
    const gate = new Promise((r) => { release = r; });
    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params) => {
        seen.push(params.token);
        await gate; // park so the drain lands mid-stream
        throw rateLimited();
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    const done = result.handler(res);
    await Promise.resolve();
    const drained = abortActiveSse('server shutting down');
    release();
    await done;

    assert.ok(drained >= 1, 'the connect stream was visible to the shutdown drain');
    assert.equal(seen.length, 1, 'drain aborted the stream — no failover hop');
    assert.ok(!seen.includes(b.apiKey), 'never hopped to the second account during drain');
    assert.ok(seen.includes(a.apiKey));
    const frames = parseFrames(res.body);
    assert.ok(frames.some(f => f !== '[DONE]' && f.error?.code === 'server_shutdown'), 'emitted a server_shutdown frame');
  });
});
