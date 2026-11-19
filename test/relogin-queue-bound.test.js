// GFReliability: the global re-login gate queues waiters in `_reloginWaiters`
// and hands them a slot when one frees up. Nothing bounded the wait: if the
// holder never finished (a hung upstream login) — or the caller went away — the
// waiter promise never settled, the queued reLoginAccount call hung forever, and
// the entry stayed in the array. These tests pin the fix: a waiter is released
// (removed from the queue and settled with `false` at the reLoginAccount
// boundary) on both a queue timeout and an AbortSignal.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, reLoginAccount,
  __setReloginDeps, __resetReloginState, __reloginGateState,
} from '../src/auth.js';

const createdIds = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seed(label) {
  const key = `devin-session-token$queue-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  acct.email = `${label}-${acct.id}@example.com`;
  // Re-login requires a verified identity; the display label is deliberately a
  // different string so the test also proves it is not used.
  acct.identityEmail = `identity-${label}-${acct.id}@example.com`;
  acct.credentialEmail = acct.identityEmail;
  createdIds.push(acct.id);
  return acct;
}

beforeEach(() => {
  process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
  process.env.DEVIN_CONNECT_RELOGIN_MAX_CONCURRENT = '1';
  process.env.DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS = '60';
  __resetReloginState();
});

afterEach(() => {
  __setReloginDeps(null);
  __resetReloginState();
  while (createdIds.length) removeAccount(createdIds.pop());
  delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  delete process.env.DEVIN_CONNECT_RELOGIN_MAX_CONCURRENT;
  delete process.env.DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS;
});

// Account `a`'s login never resolves, so it holds the only slot for the whole
// test; account `b`'s attempt is the waiter under test.
function hungHolder(a, hung) {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  __setReloginDeps({
    isCredStoreEnabled: () => true,
    getCredential: () => 'pw',
    windsurfLogin: (email) => {
      if (email === a.identityEmail) {
        started();
        return hung;
      }
      return Promise.resolve({ apiKey: 'devin-session-token$OTHER', identityEmail: email });
    },
  });
  return startedPromise;
}

describe('re-login gate: waiters are bounded', () => {
  it('releases a waiter that never gets a slot when the queue timeout fires', async () => {
    const a = seed('timeout-a');
    const b = seed('timeout-b');
    let release;
    const hung = new Promise((resolve) => { release = resolve; });
    const started = hungHolder(a, hung);

    const held = reLoginAccount(a.id, { force: true });
    await started;
    assert.equal(__reloginGateState().active, 1, 'holder owns the only slot');

    const t0 = Date.now();
    const result = await Promise.race([
      reLoginAccount(b.id, { force: true }),
      delay(2000).then(() => 'HUNG'),
    ]);
    const elapsed = Date.now() - t0;

    assert.notEqual(result, 'HUNG', 'a waiter must settle instead of hanging forever');
    assert.equal(result, false, 'a timed-out re-login reports false, not a throw');
    assert.ok(elapsed < 2000, `settled on the queue timeout (took ${elapsed}ms)`);
    assert.equal(__reloginGateState().waiting, 0, 'timed-out waiter is removed from the queue');
    assert.equal(__reloginGateState().active, 1, 'the holder still owns its slot');

    release({ apiKey: 'devin-session-token$TIMEOUT-A', identityEmail: a.identityEmail });
    await held;
    assert.equal(__reloginGateState().active, 0, 'slot is returned when the holder finishes');
  });

  it('releases a waiter when its abort signal fires', async () => {
    const a = seed('abort-a');
    const b = seed('abort-b');
    let release;
    const hung = new Promise((resolve) => { release = resolve; });
    const started = hungHolder(a, hung);

    const held = reLoginAccount(a.id, { force: true });
    await started;

    const ac = new AbortController();
    const pending = reLoginAccount(b.id, { force: true, signal: ac.signal });
    assert.equal(__reloginGateState().waiting, 1, 'second attempt is queued');
    setTimeout(() => ac.abort(), 20);

    const result = await Promise.race([pending, delay(2000).then(() => 'HUNG')]);
    assert.notEqual(result, 'HUNG', 'an aborted waiter must settle instead of hanging forever');
    assert.equal(result, false, 'an aborted re-login reports false, not a throw');
    assert.equal(__reloginGateState().waiting, 0, 'aborted waiter is removed from the queue');
    assert.equal(__reloginGateState().active, 1, 'the holder still owns its slot');

    release({ apiKey: 'devin-session-token$ABORT-A', identityEmail: a.identityEmail });
    await held;
    assert.equal(__reloginGateState().active, 0, 'slot is returned when the holder finishes');
  });
});
