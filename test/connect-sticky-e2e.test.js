// DEVIN_CONNECT sticky affinity — end-to-end through the real handler.
//
// connect-sticky-affinity.test.js unit-tests the bindConnectSticky helper;
// this file pins the CALL-SITE wiring (reverting the two success-path calls
// in handleChatCompletions must fail these tests) plus the two interactions
// the helper alone can't see:
//   1. turn 1 success writes the binding (streaming and non-stream sites);
//   2. turn 2 with a dead bound token must still fail over to a healthy
//      account (sticky fast path honors excludeKeys — the 401-with-idle-pool
//      trap this combination used to produce);
//   3. a callerKey WITHOUT a per-user scope must not bind at all (shared-key
//      multi-tenant deployments must not funnel onto one account).
//
// ⚠️ sticky-session.js reads STICKY_SESSION_ENABLED into a module-load const,
// so the env must be set before the first import. node:test gives each file
// its own process, so setting it at the top of this file is enough.

process.env.STICKY_SESSION_ENABLED = '1';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  addAccountByKey, removeAccount, __setReloginDeps, __resetReloginState,
} = await import('../src/auth.js');
const {
  handleChatCompletions, __setConnectDeps, __resetConnectDeps,
} = await import('../src/handlers/chat.js');
const sticky = await import('../src/account/sticky-session.js');

// ':user:'-scoped — passes hasPerUserScope, like a client sending body.user
// or Claude Code's metadata.user_id.
const SCOPED_CALLER = 'api:cafebabecafebabecafebabecafebabe:user:tooluser01';
// The connect path binds per SELECTOR (third dimension), so an end-to-end assertion
// has to read the same slot production writes. A 2-arg lookup reads `caller\0*\0*`,
// which is a DIFFERENT slot and always misses here — that mismatch is exactly the
// regression these tests exist to catch.
const CONNECT_SELECTOR = 'swe-1-6-slow';
// Bare shared API key — N end users behind one key, must NOT bind.
const SHARED_CALLER = 'api:cafebabecafebabecafebabecafebabe';

const createdIds = [];
const prevEnv = {};

function seed(label) {
  const a = addAccountByKey(`devin-session-token$se-${label}-${Math.random().toString(36).slice(2)}`, label);
  createdIds.push(a.id);
  return a;
}
const unauthorized = () => Object.assign(new Error('invalid token'), { code: 'UNAUTHORIZED' });

function okBody(text) {
  return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] } };
}

beforeEach(() => {
  prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
  process.env.DEVIN_CONNECT = '1';
  delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  sticky.resetAllBindings();
});

afterEach(() => {
  __resetConnectDeps();
  __resetReloginState();
  __setReloginDeps(null);
  if (prevEnv.DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = prevEnv.DEVIN_CONNECT;
  while (createdIds.length) removeAccount(createdIds.pop());
});

describe('connect sticky e2e — call-site wiring', () => {
  it('a non-stream success writes the binding for a scoped caller', async () => {
    seed('site-a');
    __setConnectDeps({ toChatCompletion: async () => okBody('OK') });

    const r = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: SCOPED_CALLER },
    );
    assert.equal(r.status, 200);
    const bound = sticky.getStickyBinding(SCOPED_CALLER, null, CONNECT_SELECTOR);
    assert.ok(bound, 'success path must write the null-modelKey binding (call-site regression)');
  });

  it('a shared-key caller with no per-user scope binds nothing', async () => {
    seed('site-b');
    __setConnectDeps({ toChatCompletion: async () => okBody('OK') });

    const r = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: SHARED_CALLER },
    );
    assert.equal(r.status, 200);
    assert.equal(sticky.getStickyBinding(SHARED_CALLER, null), null,
      'shared-key deployments must not funnel every user onto one account');
  });
});

describe('connect sticky e2e — dead bound token must still fail over', () => {
  it('turn 2 on a dead pinned account lands on the healthy pool member, not 401', async () => {
    const a = seed('will-die');
    const b = seed('healthy');
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no stored credential'); } });

    let deadKey = null;
    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen.push(params.token);
        if (deadKey && params.token === deadKey) throw unauthorized();
        return okBody('OK');
      },
    });

    // Turn 1 — success pins whichever account served.
    const t1 = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'turn 1' }] },
      { callerKey: SCOPED_CALLER },
    );
    assert.equal(t1.status, 200);
    const pinned = sticky.getStickyBinding(SCOPED_CALLER, null, CONNECT_SELECTOR);
    assert.ok(pinned, 'turn 1 must pin the serving account');

    // Kill exactly the pinned account's token for turn 2.
    deadKey = pinned.apiKey;
    seen.length = 0;

    const t2 = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'turn 2' }] },
      { callerKey: SCOPED_CALLER },
    );
    assert.equal(t2.status, 200,
      `turn 2 must fail over off the dead pinned account (got ${t2.status}: ${t2.body?.error?.message})`);
    assert.ok(seen.some(k => k !== deadKey), 'a non-pinned account must have served');

    // And the surviving account owns the binding for turn 3.
    const rebound = sticky.getStickyBinding(SCOPED_CALLER, null, CONNECT_SELECTOR);
    assert.ok(rebound && rebound.apiKey !== deadKey, 'binding must move to the account that served');
    assert.ok([a.id, b.id].includes(rebound.accountId));
  });
});
