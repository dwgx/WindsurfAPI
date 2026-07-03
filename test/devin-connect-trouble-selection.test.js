// C2×C5: the persisted rolling health window feeds account SELECTION.
//
// An account that's wobbling right now (recent dead-token / error burst) should
// be softly de-prioritized for a short window even while it's still 'active'
// with RPM headroom — instead of being hammered until it hard-fails. Failures
// decay out of a 5-min window so a recovered account climbs back on its own.
// Crucially this must be a NO-OP for healthy accounts (score 0) so existing
// inflight→quota→LRU ordering is untouched.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getApiKey,
  reportError, reportDeadToken, markRateLimited,
  __recentTroubleScore, releaseAccount,
} from '../src/auth.js';

const createdIds = [];
afterEach(() => { while (createdIds.length) removeAccount(createdIds.pop()); });

function seed(label) {
  const key = `devin-session-token$trouble-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  acct.email = label;
  acct.tier = 'free';
  acct._health = [];
  createdIds.push(acct.id);
  return acct;
}

describe('recentTroubleScore', () => {
  it('is 0 for a clean account (no effect on healthy selection)', () => {
    const a = seed('clean');
    assert.equal(__recentTroubleScore(a), 0);
  });

  it('weighs dead/error (3) heavier than throttle/capacity (1)', () => {
    const a = seed('weights');
    reportDeadToken(a.apiKey);              // +3
    reportError(a.apiKey);                  // +3
    markRateLimited(a.apiKey, 1000);        // +1 (throttle)
    markRateLimited(a.apiKey, 1000, 'm', 'c'); // +1 (capacity)
    assert.equal(__recentTroubleScore(a), 8);
  });

  it('ignores trouble older than the 5-min window (decay)', () => {
    const a = seed('decay');
    const now = Date.now();
    a._health = [
      { t: now - 6 * 60 * 1000, k: 'd' }, // stale: outside 5-min window
      { t: now - 6 * 60 * 1000, k: 'e' },
      { t: now - 30 * 1000, k: 't' },     // fresh: +1
    ];
    assert.equal(__recentTroubleScore(a, now), 1);
  });
});

describe('selection de-prioritizes a recently-wobbling account', () => {
  it('prefers the healthy account when a peer just burst dead-tokens', () => {
    const healthy = seed('healthy');
    const wobbly = seed('wobbly');
    // Wobbly just threw two hard failures (score 6 → bucket 2); healthy is clean.
    reportDeadToken(wobbly.apiKey);
    reportError(wobbly.apiKey);

    // Acquire once; with equal inflight/quota/LRU the trouble tiebreaker should
    // route to the healthy account.
    const picked = getApiKey([], null, '');
    assert.ok(picked, 'selected an account');
    assert.equal(picked.id, healthy.id, 'healthy account preferred over the wobbling one');
    releaseAccount(picked.apiKey);
  });

  it('does NOT demote on a single minor throttle (sub-bucket noise)', () => {
    const a = seed('minor-a');
    const b = seed('minor-b');
    // One throttle on `a` → score 1 → bucket 0, same as b's bucket 0. The
    // tiebreaker must not fire; selection falls through to quota/LRU as before.
    markRateLimited(a.apiKey, 1000);
    assert.equal(Math.floor(__recentTroubleScore(a) / 3), 0);
    assert.equal(Math.floor(__recentTroubleScore(b) / 3), 0);
    const picked = getApiKey([], null, '');
    assert.ok(picked, 'still selects an account despite a minor throttle');
    releaseAccount(picked.apiKey);
  });
});
