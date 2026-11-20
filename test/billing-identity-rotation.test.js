// Billing identity across a credential rotation (GPT-6-Pro review #3).
//
// The account ledger used to be keyed by `apiKey` — a secret that is allowed to
// rotate in place (background re-login, Firebase refresh, manual paste-over).
// A request holds the key it acquired with; if the pool re-keys the account
// while that request is in flight, `accounts.find(a => a.apiKey === snapshot)`
// no longer resolves and `recordAccountSpend` returns early. The turn finishes
// normally, the client sees [DONE], and the account ledger silently loses the
// row (requests/tokens/credit all under-report).
//
// The ledger must be owned by the immutable `accountId`. The credential epoch
// only decides whether a late FAILURE is evidence about the credential that is
// current now — it must never decide who owns a spend row.
//
// These are behaviour tests against the real handler / finalizer, not source
// greps: the connect stream is mocked at the `__setConnectDeps` seam, the
// rotation uses the real `setAccountTokens`, and the assertions read the real
// per-account ring (`getAccountRequests`) and lifetime tally (`getAccountPublic`).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  removeAccount,
  getAccountInternal,
  getAccountPublic,
  getAccountRequests,
  recordAccountSpend,
  setAccountCredentialEmail,
  setAccountTokens,
  __setReloginDeps,
  __resetReloginState,
} from '../src/auth.js';
import {
  handleChatCompletions,
  finalizeConnectAccount,
  __setConnectDeps,
  __resetConnectDeps,
} from '../src/handlers/chat.js';

const createdIds = [];
const prevEnv = {};

function seed(label) {
  const key = `devin-session-token$bid-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
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
  };
}

function unauthorized() {
  return Object.assign(new Error('retired session token'), { code: 'UNAUTHORIZED' });
}

const spendOf = (id) => getAccountPublic(id)?.totalSpend || { requests: 0, totalTokens: 0 };

beforeEach(() => {
  prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
  prevEnv.AUTO_RELOGIN = process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  process.env.DEVIN_CONNECT = '1';
  delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
});

afterEach(() => {
  __resetConnectDeps();
  __resetReloginState();
  __setReloginDeps(null);
  while (createdIds.length) removeAccount(createdIds.pop());
  if (prevEnv.DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = prevEnv.DEVIN_CONNECT;
  if (prevEnv.AUTO_RELOGIN === undefined) delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  else process.env.DEVIN_CONNECT_AUTO_RELOGIN = prevEnv.AUTO_RELOGIN;
});

describe('review #3 — ledger ownership survives a mid-request key rotation', () => {
  it('a streaming turn that finishes after the key rotated still bills the account', async () => {
    const acct = seed('stream-rotate');
    const acquireKey = acct.apiKey;
    const rotatedKey = `${acquireKey}$ROTATED`;
    let rotatedMidFlight = false;

    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        assert.equal(params.token, acquireKey, 'the attempt presents the acquire-time credential');
        // Exactly what a background re-login / manual paste-over does: replace
        // the account's key in place while the handler still holds the old one.
        assert.equal(setAccountTokens(acct.id, { apiKey: rotatedKey }), true);
        rotatedMidFlight = true;
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        return { usage: { prompt_tokens: 0, completion_tokens: 12, total_tokens: 12 } };
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(result.status, 200);
    assert.ok(rotatedMidFlight, 'precondition: the rotation happened while the stream was in flight');
    assert.equal(getAccountInternal(acct.id).apiKey, rotatedKey, 'precondition: the rotation landed');
    assert.ok(res.body.includes('[DONE]'), 'the client still got a normal terminal frame');

    const page = getAccountRequests(acct.id);
    assert.equal(page.total, 1, 'exactly one ledger row for the turn');
    assert.equal(page.summary.requests, 1);
    assert.equal(page.summary.totalTokens, 12, 'the row carries the upstream usage');
    assert.ok(page.items[0].attemptId, 'the row records the attempt that produced it');

    const spend = spendOf(acct.id);
    assert.equal(spend.requests, 1, 'the lifetime tally must count the turn');
    assert.equal(spend.totalTokens, 12);
  });

  it('a late 401 from the retired credential does not charge the new epoch', () => {
    const acct = seed('late-401');
    const oldKey = acct.apiKey;
    // A reservation is a value snapshot: id + the credential it presented.
    const snapshot = { id: acct.id, apiKey: oldKey };
    getAccountInternal(acct.id)._inflight = 1; // mimic acquire

    assert.equal(setAccountTokens(acct.id, { apiKey: `${oldKey}$NEW` }), true);
    finalizeConnectAccount(snapshot, {
      model: 'swe-1-6-slow',
      startTime: Date.now() - 5,
      err: unauthorized(),
    });

    const live = getAccountInternal(acct.id);
    assert.equal(live.errorCount || 0, 0, 'the retired credential\'s failure must not charge the new key');
    assert.equal(live.status, 'active', 'the new key stays in rotation');
    assert.equal(live._inflight, 0, 'the slot is still released');
  });

  it('control: the same 401 on the current credential still charges it', () => {
    const acct = seed('current-401');
    const snapshot = { id: acct.id, apiKey: acct.apiKey };
    getAccountInternal(acct.id)._inflight = 1;

    finalizeConnectAccount(snapshot, {
      model: 'swe-1-6-slow',
      startTime: Date.now() - 5,
      err: unauthorized(),
    });

    assert.equal(getAccountInternal(acct.id).errorCount, 1,
      'the epoch guard must be scoped to stale credentials, not suppress auth faults');
    assert.equal(getAccountInternal(acct.id)._inflight, 0);
  });

  it('a stale 401 does not trigger a re-login that would rotate the fresh key', async () => {
    const acct = seed('handler-rotate');
    const loginEmail = 'billing-relogin@example.test';
    // Enroll the fixture so the credential epoch determines re-login eligibility.
    setAccountCredentialEmail(acct.id, loginEmail);
    const acquireKey = acct.apiKey;
    const rotatedKey = `${acquireKey}$ROTATED`;
    process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';

    let logins = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: email => email === loginEmail ? 'stored-password' : null,
      windsurfLogin: async () => {
        logins++;
        return {
          apiKey: `devin-session-token$third-${Math.random().toString(36).slice(2)}`,
          identityEmail: loginEmail,
        };
      },
    });
    let calls = 0;
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        calls++;
        if (calls === 1) {
          assert.equal(params.token, acquireKey, 'the first attempt presents the acquire-time credential');
          setAccountTokens(acct.id, { apiKey: rotatedKey });
          throw unauthorized();
        }
        // The failover hop re-acquires the same account under its live key —
        // recovery happens without minting a third credential.
        assert.equal(params.token, rotatedKey, 'the retry presents the live credential');
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        return { usage: { total_tokens: 3 } };
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(logins, 0, 'a failure from the retired credential must not re-login the account');
    assert.ok(calls >= 2, 'the request recovered on the live key');
    assert.ok(res.body.includes('[DONE]'), 'the client got a completed turn');
    const live = getAccountInternal(acct.id);
    assert.equal(live.apiKey, rotatedKey, 'the freshly rotated key was not overwritten');
    assert.equal(live.errorCount || 0, 0, 'the new epoch was not charged for the old key\'s 401');
  });
});

describe('review #3 — recordAccountSpend identity contract', () => {
  it('resolves by accountId even when the key snapshot is stale', () => {
    const acct = seed('unit-id');
    recordAccountSpend(
      { accountId: acct.id, apiKey: 'retired-key', attemptId: 'attempt-42' },
      { total_tokens: 7 },
    );

    const page = getAccountRequests(acct.id);
    assert.equal(page.total, 1);
    assert.equal(page.summary.totalTokens, 7);
    assert.equal(page.items[0].attemptId, 'attempt-42');
  });

  it('an unknown accountId does not fall back to a key that resolves elsewhere', () => {
    const acct = seed('recycled-key');
    recordAccountSpend(
      { accountId: 'missing-account', apiKey: acct.apiKey },
      { total_tokens: 9 },
    );
    assert.equal(getAccountRequests(acct.id).total, 0,
      'the id is authoritative; a key alone must not re-attribute a row whose id is unknown');
  });
});
