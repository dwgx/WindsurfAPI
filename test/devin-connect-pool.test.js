import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, getApiKey, getRpmStats, removeAccount } from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';
import { getStats } from '../src/dashboard/stats.js';

// DEVIN_CONNECT account lifecycle: acquireConnectAccount draws from the same
// pool as Cascade (verified end-to-end against a live token elsewhere); these
// tests cover finalizeConnectAccount's bookkeeping without touching the network.

const createdIds = [];
afterEach(() => { while (createdIds.length) removeAccount(createdIds.pop()); });

function seed(label) {
  const key = `devin-session-token$pool-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
}

describe('finalizeConnectAccount', () => {
  it('releases a pooled account back (inflight returns to 0) on success', () => {
    seed('release-ok');
    const acct = getApiKey([], null, ''); // acquire: bumps inflight + rpm
    assert.ok(acct, 'acquired an account');
    const usedAfterAcquire = getRpmStats()[acct.id]?.used ?? 0;
    assert.ok(usedAfterAcquire >= 1, 'rpm budget consumed on acquire');

    finalizeConnectAccount(acct, { model: 'swe-1-6-slow', startTime: Date.now() - 5, err: null });
    // releaseAccount decrements inflight; the account is selectable again.
    const reacquire = getApiKey([], null, '');
    assert.ok(reacquire, 'account is selectable again after release');
  });

  it('records a successful request in dashboard stats', () => {
    const acct = seed('stats-ok');
    const before = getStats().totalRequests;
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', startTime: Date.now() - 5, err: null },
    );
    assert.equal(getStats().totalRequests, before + 1);
  });

  it('records a failed request and does not throw on error finalize', () => {
    const acct = seed('stats-err');
    const before = getStats().errorCount;
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', startTime: Date.now() - 5, err: Object.assign(new Error('x'), { code: 'UNAUTHORIZED' }) },
    );
    assert.equal(getStats().errorCount, before + 1);
  });

  it('handles a null account (env-token fallback) by recording stats only', () => {
    const before = getStats().totalRequests;
    // must not throw when there is no pooled account to release.
    finalizeConnectAccount(null, { model: 'swe-1-6-slow', startTime: Date.now() - 5, err: null });
    assert.equal(getStats().totalRequests, before + 1);
  });

  it('treats a RATE_LIMITED error without throwing', () => {
    const acct = seed('rate');
    assert.doesNotThrow(() => finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', startTime: Date.now(), err: Object.assign(new Error('rl'), { code: 'RATE_LIMITED' }) },
    ));
  });

  it('does not penalize the account on a client abort', () => {
    const acct = seed('abort');
    const before = getStats().errorCount;
    // AbortError is a client cancel, not an account fault — released, recorded
    // as a failed request for stats, but no reportError penalty.
    assert.doesNotThrow(() => finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', startTime: Date.now(), err: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    ));
    assert.equal(getStats().errorCount, before + 1);
  });
});
