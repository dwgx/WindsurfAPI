// C5: per-account rolling-hour health window — PERSISTED across restart.
//
// errorCount answers "is this account disabled right now"; _rpmHistory answers
// "is it busy right now". Neither answers "how has it BEHAVED over the last
// hour". This covers recording outcomes (ok/error/throttle/capacity/dead),
// the 1h prune, the hard event cap, the per-account + pool summaries, and the
// round-trip through accounts.json (the key differentiator vs an in-memory
// counter: a restart must NOT reset the picture to all-healthy).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount,
  reportSuccess, reportError, markRateLimited, reportDeadToken,
  getAccountHealth, getPoolHealthWindow, __resetReloginState,
} from '../src/auth.js';

let acct;
const KEY = 'devin-session-token$HEALTH';
const EMAIL = 'health-test@example.com';

beforeEach(() => {
  acct = addAccountByKey(KEY, EMAIL);
  acct.email = EMAIL;
  acct.tier = 'free';
  acct._health = []; // start clean
});

afterEach(() => {
  if (acct) removeAccount(acct.id);
  __resetReloginState();
});

describe('account health window — recording', () => {
  it('counts each outcome kind into the rolling-hour summary', () => {
    reportSuccess(KEY);
    reportSuccess(KEY);
    reportError(KEY);
    markRateLimited(KEY, 60 * 1000);        // default kind = throttle
    markRateLimited(KEY, 60 * 1000, 'gpt', 'c'); // capacity, model-scoped
    reportDeadToken(KEY);
    const h = getAccountHealth(KEY);
    assert.equal(h.ok, 2);
    assert.equal(h.error, 1);
    assert.equal(h.throttle, 1);
    assert.equal(h.capacity, 1);
    assert.equal(h.dead, 1);
    assert.equal(h.total, 6);
  });

  it('returns null for an unknown apiKey', () => {
    assert.equal(getAccountHealth('devin-session-token$NOPE'), null);
  });
});

describe('account health window — pruning', () => {
  it('drops events older than the 1h window', () => {
    const now = Date.now();
    // Seed two stale (>1h) and one fresh event directly.
    acct._health = [
      { t: now - 90 * 60 * 1000, k: 'e' },
      { t: now - 61 * 60 * 1000, k: 't' },
      { t: now - 5 * 60 * 1000, k: 'o' },
    ];
    const h = getAccountHealth(KEY, now);
    assert.equal(h.total, 1, 'only the in-window event survives');
    assert.equal(h.ok, 1);
    assert.equal(h.error, 0);
  });

  it('caps the window so a hot account cannot bloat the store', () => {
    // Push well past the cap; the summary total must be bounded.
    for (let i = 0; i < 500; i++) reportSuccess(KEY);
    const h = getAccountHealth(KEY);
    assert.ok(h.total <= 240, `event count ${h.total} must be capped at 240`);
    assert.ok(h.total >= 240, 'recent events are retained up to the cap');
  });
});

describe('account health window — pool summary', () => {
  it('reports per-account health across the pool without leaking secrets', () => {
    reportError(KEY);
    reportDeadToken(KEY);
    const pool = getPoolHealthWindow();
    const mine = pool.find(p => p.email === EMAIL);
    assert.ok(mine, 'account present in pool health');
    assert.equal(mine.health.error, 1);
    assert.equal(mine.health.dead, 1);
    assert.equal(mine.tier, 'free');
    assert.equal(mine.status, 'active');
    // No raw apiKey/password fields in the summary.
    assert.equal('apiKey' in mine, false);
    assert.equal('password' in mine, false);
  });
});

describe('account health window — persistence across restart (C5 differentiator)', () => {
  it('survives a save → reload round-trip via accounts.json', async () => {
    // Record some history, then force a save and a fresh module instance to
    // simulate a process restart reading the same on-disk accounts file.
    reportSuccess(KEY);
    reportError(KEY);
    reportDeadToken(KEY);

    // The save is wired into status-flipping paths; trigger one deterministically.
    const auth = await import('../src/auth.js');
    auth.saveAccountsSync?.();

    // Re-read straight from disk and assert the window persisted (not reset).
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { config } = await import('../src/config.js');
    const file = join(config.sharedDataDir || config.dataDir, 'accounts.json');
    let onDisk;
    try { onDisk = JSON.parse(readFileSync(file, 'utf8')); } catch { onDisk = null; }
    assert.ok(onDisk, 'accounts.json readable from the test data dir');
    const rec = (Array.isArray(onDisk) ? onDisk : []).find(a => a.apiKey === KEY);
    assert.ok(rec, 'account persisted to disk');
    assert.ok(Array.isArray(rec._health), '_health array persisted');
    const kinds = rec._health.map(e => e.k).sort();
    assert.deepEqual(kinds, ['d', 'e', 'o'], 'all three outcome events persisted across the boundary');
  });
});
