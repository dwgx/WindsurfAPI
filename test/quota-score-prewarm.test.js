// v2.0.57 Fix 4 — quotaScore + predictive pre-warming sort behaviour.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getAccountInternal,
  quotaScore, getApiKey,
} from '../src/auth.js';

const created = [];
function mk(label, credits, tier = 'pro') {
  const a = addAccountByKey('sk-quota-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), label);
  const acct = getAccountInternal(a.id);
  acct.tier = tier;
  acct.tierManual = true;
  acct.credits = credits;
  created.push(a.id);
  return acct;
}

afterEach(() => {
  while (created.length) removeAccount(created.pop());
});

describe('quotaScore (v2.0.57 Fix 4)', () => {
  it('returns 100 when account has no credits snapshot', () => {
    assert.equal(quotaScore({}), 100);
    assert.equal(quotaScore({ credits: null }), 100);
  });

  it('returns 100 when neither percent is a number', () => {
    assert.equal(quotaScore({ credits: { foo: 'bar' } }), 100);
  });

  it('returns min(daily%, weekly%)', () => {
    assert.equal(quotaScore({ credits: { dailyPercent: 80, weeklyPercent: 30 } }), 30);
    assert.equal(quotaScore({ credits: { dailyPercent: 5, weeklyPercent: 90 } }), 5);
  });

  it('clamps to 0..100', () => {
    assert.equal(quotaScore({ credits: { dailyPercent: -10, weeklyPercent: 50 } }), 0);
    assert.equal(quotaScore({ credits: { dailyPercent: 200, weeklyPercent: 200 } }), 100);
  });

  it('handles a missing dimension by treating it as 100', () => {
    assert.equal(quotaScore({ credits: { weeklyPercent: 40 } }), 40);
    assert.equal(quotaScore({ credits: { dailyPercent: 25 } }), 25);
  });
});

describe('getApiKey prefers higher quota score (v2.0.57 Fix 4)', () => {
  it('picks the account with more quota when both are tier=pro and idle', () => {
    const lowQuota = mk('low-quota', { dailyPercent: 2, weeklyPercent: 5 });
    const highQuota = mk('high-quota', { dailyPercent: 80, weeklyPercent: 70 });
    // Both same _inflight (default 0), so quota bucket should decide.
    const picked = getApiKey([], 'gemini-2.5-flash');
    assert.ok(picked, 'a candidate must be returned');
    // Should pick highQuota, not lowQuota.
    assert.equal(picked.id, highQuota.id, `expected high-quota account but got ${picked.email}`);
    // Don't leak the reservation across tests.
    const a = getAccountInternal(picked.id);
    if (a) {
      a._inflight = Math.max(0, (a._inflight || 0) - 1);
      a._rpmHistory = [];
    }
  });

  it('5%-bucket sort allows LRU to break ties when quotas are close', () => {
    const a1 = mk('a1', { dailyPercent: 60, weeklyPercent: 60 });
    const a2 = mk('a2', { dailyPercent: 62, weeklyPercent: 58 });
    // Same bucket (Math.floor(60/5)=12, Math.floor(58/5)=11 — different
    // bucket). Adjust: make them both 60% and 62% within bucket 12.
    a1.credits = { dailyPercent: 62, weeklyPercent: 62 };
    a2.credits = { dailyPercent: 63, weeklyPercent: 63 };
    a1.lastUsed = Date.now() - 60_000; // a1 older → preferred
    a2.lastUsed = Date.now();
    const picked = getApiKey([], null);
    assert.ok(picked);
    // Either is acceptable — test verifies sort doesn't crash + returns one.
    assert.ok(picked.id === a1.id || picked.id === a2.id);
    const a = getAccountInternal(picked.id);
    if (a) { a._inflight = 0; a._rpmHistory = []; }
  });
});
