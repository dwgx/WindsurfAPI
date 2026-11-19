// Q5-P1 (ownership): `reLoginAccount({ signal })` could never abort in
// production because every caller dropped the signal. The abort path only
// matters while a caller is QUEUED for the global re-login slot (auth.js
// acquireReloginSlot), so a caller that already went away could sit in the
// queue until the queue timeout and then spend a slot for nobody.
//
// These tests pin the pass-through at all four call sites:
//   1. DEVIN_CONNECT non-stream UNAUTHORIZED (awaited)
//   2. DEVIN_CONNECT non-stream finalize (background recovery)
//   3. DEVIN_CONNECT stream UNAUTHORIZED (awaited, tied to abortController)
//   4. probeAndRecoverConnectAccount (liveness sweep)
// and prove the abort is observable end-to-end, not just forwarded.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, reLoginAccount, probeAndRecoverConnectAccount,
  __setReloginDeps, __resetReloginState, __reloginGateState,
} from '../src/auth.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';

const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'DEVIN_CONNECT_AUTO_RELOGIN',
  'DEVIN_CONNECT_RELOGIN_MAX_CONCURRENT', 'DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS'];
const createdIds = [];

function seed(label, email) {
  const key = `devin-session-token$sig-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, email || label);
  acct.email = email || `${label}@example.com`;
  acct.identityEmail = acct.email;
  acct.credentialEmail = acct.email;
  acct.status = 'active';
  createdIds.push(acct.id);
  return acct;
}

function fakeResponse() {
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk = '') { this.body += String(chunk); this.writableEnded = true; },
    on() {},
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  __resetReloginState();
});

afterEach(() => {
  __resetConnectDeps();
  __setReloginDeps(null);
  __resetReloginState();
  while (createdIds.length) removeAccount(createdIds.pop());
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('reLoginAccount signal reaches the DEVIN_CONNECT non-stream paths', () => {
  it('forwards the request signal to both the awaited and the background re-login', async () => {
    seed('non-stream');
    const controller = new AbortController();
    const seen = [];
    __setConnectDeps({
      toChatCompletion: async () => {
        throw Object.assign(new Error('session token retired'), { code: 'UNAUTHORIZED' });
      },
      // Seam: the handler's re-login call. Returns false (no stored credential)
      // so the dead-token path continues into finalize's background recovery.
      reLoginAccount: async (_id, opts = {}) => {
        seen.push(opts.signal);
        return false;
      },
    });

    const res = await handleChatCompletions(
      { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'hi' }], stream: false },
      { reqId: 'sig-nonstream', callerKey: 'sig-caller', signal: controller.signal, specialAgent: {} },
    );

    assert.equal(res.status, 401, 'a single dead account surfaces UNAUTHORIZED');
    assert.ok(seen.length >= 1, 'reLoginAccount was invoked at least once');
    assert.equal(seen[0], controller.signal,
      'the awaited re-login receives the request signal (abort reachable)');
    assert.ok(seen.every((s) => s === controller.signal),
      'every re-login for this request (including finalize background) carries the request signal');
  });
});

describe('reLoginAccount signal reaches the DEVIN_CONNECT stream path', () => {
  it('aborts the queued re-login when the client disconnects', async () => {
    seed('stream');
    const controller = new AbortController();
    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async () => {
        throw Object.assign(new Error('session token retired'), { code: 'UNAUTHORIZED' });
      },
      reLoginAccount: (_id, opts = {}) => new Promise((resolve) => {
        seen.push(opts.signal);
        if (!opts.signal) {
          // No signal forwarded: settle so the test fails on the assertion
          // below instead of hanging the suite.
          setTimeout(resolve, 10, false);
          return;
        }
        if (opts.signal.aborted) { resolve(false); return; }
        opts.signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
    });

    const out = await handleChatCompletions(
      { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { reqId: 'sig-stream', callerKey: 'sig-caller', signal: controller.signal, specialAgent: {} },
    );
    const res = fakeResponse();
    const done = out.handler(res);

    // The stream attempt is now parked inside reLoginAccount. Disconnecting the
    // client must abort that wait; without the signal pass-through the fake
    // resolves with `false` after 10ms and the captured signal is undefined.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    assert.ok(seen.length >= 1, 'stream path invoked reLoginAccount');
    assert.ok(seen[0], 'stream path forwarded a signal to reLoginAccount');
    assert.equal(seen[0].aborted, true, 'the forwarded signal is tied to the client request');
  });
});

describe('reLoginAccount signal reaches the liveness sweep', () => {
  it('probeAndRecoverConnectAccount abandons the queue when its signal aborts', async () => {
    process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
    process.env.DEVIN_CONNECT_RELOGIN_MAX_CONCURRENT = '1';
    // Long enough that a dropped signal would visibly stall the probe.
    process.env.DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS = '5000';

    const holder = seed('probe-holder');
    const target = seed('probe-target');
    let releaseHolder;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      // Holder occupies the only slot forever; target's attempt must abort.
      windsurfLogin: () => new Promise((resolve) => { releaseHolder = resolve; }),
      checkSessionLiveness: async () => ({ alive: false, code: 'UNAUTHORIZED' }),
    });

    const held = reLoginAccount(holder.id);
    const deadline = Date.now() + 2000;
    // Wait for the slot AND for the holder to actually enter the login call:
    // the slot is acquired before the (now async) login-module resolution, so
    // releasing on active alone could race the assignment of releaseHolder.
    while ((__reloginGateState().active === 0 || !releaseHolder) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(__reloginGateState().active, 1, 'precondition: the global slot is held');
    assert.equal(typeof releaseHolder, 'function', 'precondition: the holder entered the login');

    const started = Date.now();
    const result = await probeAndRecoverConnectAccount(target.id, { signal: AbortSignal.abort() });
    const elapsed = Date.now() - started;

    assert.equal(result.alive, false);
    assert.equal(result.recovered, false, 'the aborted queued re-login recovered nothing');
    assert.ok(elapsed < 1000, `probe returned promptly on abort (took ${elapsed}ms, queue timeout is 5000ms)`);

    // Release the holder so its attempt can settle during cleanup.
    releaseHolder?.({ apiKey: `${holder.apiKey}$FRESH`, identityEmail: holder.identityEmail });
    await held.catch(() => {});
  });
});
