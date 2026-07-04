import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, releaseAccount,
  __runInflightCleanup, __inflightStaleMs,
} from '../src/auth.js';

// R2: the stale-inflight safety net must not wipe the counter of a request that
// is still legitimately in flight. The old fixed 120s threshold fired well
// before the 600s upstream deadline, so any normal 2–10min stream/ACP session
// got its _inflight zeroed → the busy account read as idle in getApiKey's sort
// and was oversubscribed. The threshold is now derived from the request deadline
// (with margin), and _inflightAt tracks the newest activity via releaseAccount.

const createdIds = [];
const prevEnv = {};

function seed(label) {
  const key = `devin-session-token$inf-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
}

// Reach into the account record the same way the source does (module singleton).
function setInflight(acct, n, ageMs) {
  acct._inflight = n;
  acct._inflightAt = Date.now() - ageMs;
}

beforeEach(() => {
  prevEnv.TIMEOUT = process.env.DEVIN_CONNECT_TIMEOUT_MS;
  delete process.env.DEVIN_CONNECT_TIMEOUT_MS;
});

afterEach(() => {
  if (prevEnv.TIMEOUT === undefined) delete process.env.DEVIN_CONNECT_TIMEOUT_MS;
  else process.env.DEVIN_CONNECT_TIMEOUT_MS = prevEnv.TIMEOUT;
  while (createdIds.length) removeAccount(createdIds.pop());
});

describe('R2: inflight stale-reset threshold', () => {
  it('the stale threshold exceeds the absolute upstream deadline (default 600s)', () => {
    // Floor is max(deadline + 5min, 15min). With the 600s default → 900s.
    assert.ok(__inflightStaleMs() >= 15 * 60_000, 'threshold at least the 15min floor');
    assert.ok(__inflightStaleMs() >= 600_000 + 5 * 60_000, 'threshold clears deadline + margin');
  });

  it('scales the threshold with a larger configured deadline', () => {
    process.env.DEVIN_CONNECT_TIMEOUT_MS = String(20 * 60_000); // 20min deadline
    assert.equal(__inflightStaleMs(), 20 * 60_000 + 5 * 60_000, 'deadline + 5min margin');
  });

  it('does NOT reset a request in flight for 3 minutes (was wrongly reset at 120s)', () => {
    const a = seed('long-stream');
    setInflight(a, 1, 3 * 60_000); // 3min old — well past the old 120s bug
    const reset = __runInflightCleanup();
    assert.equal(reset, 0, 'a 3min stream is NOT stale under the new threshold');
    assert.equal(a._inflight, 1, 'counter preserved for the live request');
  });

  it('DOES reset a genuinely abandoned slot older than the threshold', () => {
    const a = seed('leaked');
    setInflight(a, 2, __inflightStaleMs() + 60_000); // past the cap
    const reset = __runInflightCleanup();
    assert.equal(reset, 1, 'the abandoned account was reset');
    assert.equal(a._inflight, 0, 'leaked counter cleared');
    assert.equal(a._inflightAt, 0, 'timestamp cleared');
  });
});

describe('R2: releaseAccount refreshes _inflightAt to newest activity', () => {
  it('refreshes the timestamp while other requests remain in flight', () => {
    const a = seed('concurrent');
    // Two concurrent requests; the pair was acquired long ago.
    setInflight(a, 2, 10 * 60_000);
    const before = a._inflightAt;
    releaseAccount(a.apiKey); // one finishes, one still running
    assert.equal(a._inflight, 1, 'one request still in flight');
    assert.ok(a._inflightAt > before, '_inflightAt refreshed to now, not left at the old acquire');
    // The survivor is now measured from the refresh, so it is not judged stale.
    assert.equal(__runInflightCleanup(), 0, 'survivor is fresh after the release refresh');
  });

  it('clears _inflightAt when the account goes fully idle', () => {
    const a = seed('idle');
    setInflight(a, 1, 5 * 60_000);
    releaseAccount(a.apiKey);
    assert.equal(a._inflight, 0, 'no requests left');
    assert.equal(a._inflightAt, 0, 'timestamp cleared so a future slot is measured from ITS acquire');
  });
});
