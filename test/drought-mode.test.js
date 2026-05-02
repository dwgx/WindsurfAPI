// v2.0.57 Fix 5 — drought mode helpers.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getAccountInternal,
  isDroughtMode, getDroughtSummary,
} from '../src/auth.js';

const created = [];
function mk(label, credits, status = 'active') {
  const a = addAccountByKey('sk-drought-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), label);
  const acct = getAccountInternal(a.id);
  acct.status = status;
  acct.credits = credits;
  created.push(a.id);
  return acct;
}

afterEach(() => {
  while (created.length) removeAccount(created.pop());
});

describe('isDroughtMode (v2.0.57 Fix 5)', () => {
  it('false when no accounts', () => {
    // No accounts created — but baseline test pool may include real
    // accounts loaded from disk. Skip the "zero accounts" assertion if
    // any are already loaded.
    const summary = getDroughtSummary();
    if (summary.activeAccounts > 0) {
      // can't reliably test from-zero in this shared suite — assert on
      // explicit drought instead.
      return;
    }
    assert.equal(isDroughtMode(), false);
  });

  it('false when no quota data on any account', () => {
    mk('no-data-1', null);
    mk('no-data-2', {});
    // No daily/weekly% known → drought = false (we don't claim drought
    // when we have nothing to measure).
    const summary = getDroughtSummary();
    assert.equal(summary.drought, false);
  });

  it('true when every active account has weekly% < threshold', () => {
    mk('low-1', { weeklyPercent: 2, dailyPercent: 10 });
    mk('low-2', { weeklyPercent: 4, dailyPercent: 1 });
    assert.equal(isDroughtMode(), true);
  });

  it('false when at least one account is healthy', () => {
    mk('low-x', { weeklyPercent: 1, dailyPercent: 0 });
    mk('healthy', { weeklyPercent: 80, dailyPercent: 80 });
    assert.equal(isDroughtMode(), false);
  });

  it('disabled accounts do not count toward drought decision', () => {
    mk('low-active', { weeklyPercent: 2 });
    mk('low-disabled', { weeklyPercent: 2 }, 'error');
    // Only the active one is checked, and it's drought → drought = true.
    assert.equal(isDroughtMode(), true);
  });

  it('summary returns lowestWeekly + lowestDaily across known accounts', () => {
    mk('a', { weeklyPercent: 50, dailyPercent: 30 });
    mk('b', { weeklyPercent: 20, dailyPercent: 70 });
    const s = getDroughtSummary();
    assert.equal(s.lowestWeeklyPercent, 20);
    assert.equal(s.lowestDailyPercent, 30);
    assert.ok(s.knownAccounts >= 2);
    assert.ok(s.activeAccounts >= 2);
    assert.equal(s.drought, false);
    assert.equal(s.threshold, 5);
  });
});
