import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, getApiKey, getRpmStats, removeAccount, getAccountList, __setReloginDeps, __resetReloginState } from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';
import { setBreakerTunables } from '../src/runtime-config.js';
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

  // F2 (2026-07-10): a BARE 429 (no upstream reset window) applies an account-wide
  // cooldown of `rlBurstMs`. Default 300000 = the historical 5min (byte-identical);
  // an operator can shorten it so a transient burst does not bench the account for
  // 5 minutes. A 429 WITH a reset window is unaffected (stays model-scoped).
  it('F2: bare 429 default cools the account ~5min account-wide (byte-identical)', () => {
    const acct = seed('rl-bare-default');
    const t0 = Date.now();
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', startTime: t0, err: Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' }) },
    );
    const until = acct.rateLimitedUntil || 0;
    assert.ok(until > t0 + 4.5 * 60 * 1000 && until < t0 + 5.5 * 60 * 1000, `account-wide ~5min (got ${(until - t0) / 1000}s)`);
  });

  it('F2: rlBurstMs override shortens the bare-429 account-wide cooldown', () => {
    setBreakerTunables({ rlBurstMs: 15000 });
    try {
      const acct = seed('rl-bare-short');
      const t0 = Date.now();
      finalizeConnectAccount(
        { id: acct.id, apiKey: acct.apiKey },
        { model: 'swe-1-6-slow', startTime: t0, err: Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' }) },
      );
      const until = acct.rateLimitedUntil || 0;
      assert.ok(until > t0 + 10 * 1000 && until < t0 + 20 * 1000, `shortened to ~15s (got ${(until - t0) / 1000}s)`);
    } finally {
      setBreakerTunables({ rlBurstMs: null });
    }
  });

  it('F2: a 429 WITH a reset window stays model-scoped, ignores rlBurstMs', () => {
    setBreakerTunables({ rlBurstMs: 15000 });
    try {
      const acct = seed('rl-window');
      const t0 = Date.now();
      finalizeConnectAccount(
        { id: acct.id, apiKey: acct.apiKey },
        { model: 'swe-1-6-slow', startTime: t0, err: Object.assign(new Error('resets in 3h'), { code: 'RATE_LIMITED', resetMs: 3 * 60 * 60 * 1000 }) },
      );
      // reset-window path is model-scoped: no account-wide rateLimitedUntil.
      assert.ok(!(acct.rateLimitedUntil > t0), 'account-wide cooldown NOT set for a windowed 429');
      assert.ok((acct._modelRateLimits?.['swe-1-6-slow'] || 0) > t0 + 2 * 60 * 60 * 1000, 'model-scoped cooldown honours the 3h window');
    } finally {
      setBreakerTunables({ rlBurstMs: null });
    }
  });

  it('fires a background re-login on UNAUTHORIZED when auto-relogin is configured', async () => {
    const acct = seed('relogin-trigger');
    acct.email = `relogin-${acct.id}@example.com`;
    acct.method = 'email';
    process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
    __resetReloginState();
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'devin-session-token$RECOVERED' }; },
    });
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', startTime: Date.now(), err: Object.assign(new Error('401'), { code: 'UNAUTHORIZED' }) },
    );
    // finalize fires re-login fire-and-forget; let the microtask/import settle.
    await new Promise(r => setTimeout(r, 30));
    assert.equal(loginCalls, 1, 'UNAUTHORIZED triggered exactly one re-login');
    assert.equal(acct.apiKey, 'devin-session-token$RECOVERED', 'fresh token swapped in');
    __setReloginDeps(null);
    __resetReloginState();
    delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  });

  it('does not re-login on UNAUTHORIZED when auto-relogin is off', async () => {
    const acct = seed('relogin-off');
    acct.email = `off-${acct.id}@example.com`;
    delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
    __resetReloginState();
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'x' }; },
    });
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', startTime: Date.now(), err: Object.assign(new Error('401'), { code: 'UNAUTHORIZED' }) },
    );
    await new Promise(r => setTimeout(r, 30));
    assert.equal(loginCalls, 0);
    __setReloginDeps(null);
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

  // The health-budget contract: an account's errorCount (the signal that
  // eventually evicts it from rotation) must only move on genuine account
  // faults — not on a tier wall a client triggered by naming a paid selector.
  function errorCountOf(id) {
    return getAccountList().find((a) => a.id === id)?.errorCount ?? 0;
  }

  it('does NOT penalize the account error budget on MODEL_BLOCKED (tier wall)', () => {
    const acct = seed('blocked');
    const before = errorCountOf(acct.id);
    // Free account asked for claude-* → upstream "/upgrade" → MODEL_BLOCKED.
    // That's an entitlement wall, not a bad token; the account stays healthy.
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'claude-opus-4.8', startTime: Date.now() - 5, err: Object.assign(new Error('/upgrade to access this model'), { code: 'MODEL_BLOCKED' }) },
    );
    assert.equal(errorCountOf(acct.id), before, 'MODEL_BLOCKED must not bump errorCount');
  });

  it('DOES penalize the account error budget on UNAUTHORIZED (bad token)', () => {
    const acct = seed('unauth');
    const before = errorCountOf(acct.id);
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', startTime: Date.now() - 5, err: Object.assign(new Error('bad token'), { code: 'UNAUTHORIZED' }) },
    );
    assert.equal(errorCountOf(acct.id), before + 1, 'UNAUTHORIZED is a real account fault');
  });
});
