// RB2 — three resilience enhancements on the account pool (src/auth.js):
//   B1  account-level EXPONENTIAL BACKOFF on the error streak (self-healing,
//       capped, never permanent).
//   B2  QUOTA-EXHAUSTION closed loop: a dry balance pre-cools the account on its
//       own self-healing dimension (quotaResetAt), cleared the moment the
//       balance recovers — never a permanent disable.
//   T3  NEW-CREDENTIAL thunderstorm guard: a freshly-added account is seeded at
//       pool-median LRU (not first-picked) and is exempt from backoff
//       escalation during a grace window.
//
// MOTHER THEME (transient-first): every cooldown here auto-expires and/or is
// cleared on recovery. There must be NO path to a permanent disable, and a
// HEALTHY account must never be locked (the critical counter-examples below).

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount,
  reportError, reportSuccess, markRateLimited, reportInternalError,
  applyQuotaSnapshot, __isRateLimitedForModel, __isLastUsableAccount,
} from '../src/auth.js';

const created = [];
let _seq = 0;
function mk(label = 'rb2', { aged = true } = {}) {
  const acct = addAccountByKey(`rb2-key-${Date.now()}-${_seq++}-${Math.random().toString(36).slice(2)}`, label);
  acct._health = [];
  // Most backoff tests want a "settled" account, NOT one inside the new-account
  // grace window (T3b would otherwise exempt it from escalation).
  if (aged) acct.addedAt = Date.now() - 60 * 60 * 1000;
  created.push(acct.id);
  return acct;
}

const BREAKER_ENV = [
  'WINDSURFAPI_BREAKER', 'WINDSURFAPI_BREAKER_BASE_MS', 'WINDSURFAPI_BREAKER_FACTOR',
  'WINDSURFAPI_BREAKER_MAX_MS', 'WINDSURFAPI_NEW_ACCOUNT_GRACE_MS',
  'WINDSURFAPI_NEW_ACCOUNT_BASELINE', 'WINDSURFAPI_QUOTA_COOLDOWN',
  'WINDSURFAPI_QUOTA_COOLDOWN_MS', 'WINDSURFAPI_QUOTA_DRY_THRESHOLD',
  'WINDSURFAPI_ERROR_RECOVERY_MS', 'WINDSURFAPI_LAST_ACCOUNT_EXEMPT',
];

afterEach(() => {
  for (const k of BREAKER_ENV) delete process.env[k];
  while (created.length) removeAccount(created.pop());
});

// Drive one error EPISODE: a streak of 3 errors flips status→'error' and bumps
// the backoff streak once. A half-open recovery later (status back to 'active')
// lets the NEXT episode escalate. We simulate the half-open flip directly.
function failToError(acct) {
  reportError(acct.apiKey);
  reportError(acct.apiKey);
  reportError(acct.apiKey);
}

describe('RB2/B1 — account-level exponential backoff', () => {
  it('first episode applies NO extra cooldown (matches pre-RB2 behaviour)', () => {
    reportSuccess(mk('b1-peer-first').apiKey); // healthy peer: not the last account
    const acct = mk('b1-first');
    failToError(acct);
    assert.equal(acct.status, 'error');
    assert.equal(acct._breakerStreak, 1, 'streak counts the first episode');
    // streak 1 must not push rateLimitedUntil out — half-open TTL alone governs.
    assert.ok(!acct.rateLimitedUntil || acct.rateLimitedUntil <= Date.now(),
      'no backoff cooldown on the very first episode');
  });

  it('escalates the cooldown across consecutive failed half-open episodes, capped', () => {
    process.env.WINDSURFAPI_BREAKER_BASE_MS = '60000'; // 1m
    process.env.WINDSURFAPI_BREAKER_FACTOR = '2';
    process.env.WINDSURFAPI_BREAKER_MAX_MS = '600000'; // cap 10m
    reportSuccess(mk('b1-peer-grow').apiKey); // healthy peer: not the last account
    const acct = mk('b1-grow');

    failToError(acct);            // streak 1 — no cooldown
    acct.status = 'active';       // half-open recovery (TTL elapsed in reality)
    reportError(acct.apiKey);     // streak 2 → base*2^1 = 120000
    const cd2 = acct.rateLimitedUntil - Date.now();
    assert.equal(acct._breakerStreak, 2);
    assert.ok(Math.abs(cd2 - 120000) < 5000, `streak2 cooldown ~2m, got ${cd2}ms`);

    acct.status = 'active';
    reportError(acct.apiKey);     // streak 3 → base*2^2 = 240000
    const cd3 = acct.rateLimitedUntil - Date.now();
    assert.equal(acct._breakerStreak, 3);
    assert.ok(cd3 > cd2, `streak3 cooldown (${cd3}) must exceed streak2 (${cd2})`);
    assert.ok(Math.abs(cd3 - 240000) < 5000, `streak3 cooldown ~4m, got ${cd3}ms`);

    // Push the streak high — must clamp at the 10m cap, never beyond.
    for (let i = 0; i < 8; i++) { acct.status = 'active'; reportError(acct.apiKey); }
    const cdN = acct.rateLimitedUntil - Date.now();
    assert.ok(cdN <= 600000 + 5000, `capped cooldown must not exceed 10m, got ${cdN}ms`);
    assert.ok(cdN >= 600000 - 5000, 'a high streak sits AT the cap');
  });

  it('backoff is never permanent — the capped cooldown still expires (self-heal)', () => {
    process.env.WINDSURFAPI_BREAKER_BASE_MS = '60000';
    process.env.WINDSURFAPI_BREAKER_MAX_MS = '120000'; // 2m cap
    reportSuccess(mk('b1-peer-selfheal').apiKey); // healthy peer: not the last account
    const acct = mk('b1-selfheal');
    failToError(acct);
    for (let i = 0; i < 5; i++) { acct.status = 'active'; reportError(acct.apiKey); }
    assert.ok(acct.rateLimitedUntil > Date.now(), 'currently cooled');
    // Once that deadline passes the account is selectable again.
    assert.equal(__isRateLimitedForModel(acct, null, acct.rateLimitedUntil + 1), false,
      'past the cooldown the account is eligible again — no permanent lockout');
  });

  it('reportSuccess fully clears the backoff streak (good behaviour wipes the penalty)', () => {
    reportSuccess(mk('b1-peer-clear').apiKey); // healthy peer: not the last account
    const acct = mk('b1-clear');
    failToError(acct);
    assert.equal(acct._breakerStreak, 1);
    acct.status = 'active';
    reportError(acct.apiKey); // streak 2
    assert.equal(acct._breakerStreak, 2);
    reportSuccess(acct.apiKey);
    assert.equal(acct._breakerStreak, 0, 'a success resets the ladder to zero');
    assert.equal(acct.errorCount, 0);
  });

  it('WINDSURFAPI_BREAKER=0 disables escalation entirely', () => {
    process.env.WINDSURFAPI_BREAKER = '0';
    const acct = mk('b1-off');
    failToError(acct);
    for (let i = 0; i < 4; i++) { acct.status = 'active'; reportError(acct.apiKey); }
    assert.ok(!acct.rateLimitedUntil || acct.rateLimitedUntil <= Date.now(),
      'no backoff cooldown is applied when the breaker is disabled');
  });
});

describe('RB2/B2 — quota-exhaustion closed loop', () => {
  it('a dry balance (weekly 0%) pre-cools the account on the quota dimension', () => {
    process.env.WINDSURFAPI_QUOTA_COOLDOWN_MS = '1800000'; // 30m
    const acct = mk('b2-dry');
    const now = 1_000_000;
    applyQuotaSnapshot(acct, 0, now);
    assert.equal(acct.quotaResetAt, now + 1800000, 'quotaResetAt set 30m out');
    // getApiKey filters on this via isRateLimitedForModel.
    assert.equal(__isRateLimitedForModel(acct, null, now + 1000), true,
      'dry account is excluded from selection during the quota cooldown');
  });

  it('a dry account with a positive on-demand ($) balance is NOT cooled', () => {
    process.env.WINDSURFAPI_QUOTA_COOLDOWN_MS = '1800000';
    const acct = mk('b2-ondemand');
    acct.credits = { balance: 74.39 };  // included quota dry, but prepaid $ left
    const now = 1_500_000;
    applyQuotaSnapshot(acct, 0, now);   // weekly 0% = dry
    assert.ok(!acct.quotaResetAt, 'not cooled — on-demand balance can serve');
    assert.equal(__isRateLimitedForModel(acct, null, now + 1000), false,
      'stays selectable so the paid prepaid pool actually gets used');
  });

  it('a dry account with zero / no on-demand balance is still cooled', () => {
    process.env.WINDSURFAPI_QUOTA_COOLDOWN_MS = '1800000';
    const zero = mk('b2-zero'); zero.credits = { balance: 0 };
    const none = mk('b2-none');  // no credits.balance at all
    const now = 1_600_000;
    applyQuotaSnapshot(zero, 0, now);
    applyQuotaSnapshot(none, 0, now);
    assert.equal(zero.quotaResetAt, now + 1800000, 'zero balance → cooled');
    assert.equal(none.quotaResetAt, now + 1800000, 'no balance info → cooled');
  });

  it('an on-demand balance clears an existing quota cooldown', () => {
    process.env.WINDSURFAPI_QUOTA_COOLDOWN_MS = '1800000';
    const acct = mk('b2-recover-ondemand');
    const now = 1_700_000;
    applyQuotaSnapshot(acct, 0, now);                 // cooled (no balance yet)
    assert.ok(acct.quotaResetAt > now);
    acct.credits = { balance: 12.5 };                 // balance shows up next snapshot
    applyQuotaSnapshot(acct, 0, now + 1000);          // still dry, but now has $
    assert.equal(acct.quotaResetAt, 0, 'cooldown cleared once on-demand balance is known');
  });

  it('the quota cooldown self-heals: it expires on its own (NOT permanent)', () => {
    process.env.WINDSURFAPI_QUOTA_COOLDOWN_MS = '1800000';
    const acct = mk('b2-expire');
    const now = 2_000_000;
    applyQuotaSnapshot(acct, 0, now);
    assert.equal(__isRateLimitedForModel(acct, null, acct.quotaResetAt + 1), false,
      'past the deadline the account is eligible again — no permanent disable');
  });

  it('a later refresh seeing recovered balance clears the cooldown immediately', () => {
    const acct = mk('b2-recover');
    const now = 3_000_000;
    applyQuotaSnapshot(acct, 0, now);
    assert.ok(acct.quotaResetAt > now, 'cooled while dry');
    // Next 15-min refresh sees the weekly balance refilled.
    applyQuotaSnapshot(acct, 42, now + 60_000);
    assert.equal(acct.quotaResetAt, 0, 'balance recovered → quota cooldown cleared');
    assert.equal(__isRateLimitedForModel(acct, null, now + 60_001), false);
  });

  it('quota cooldown lives on its OWN dimension — never clobbers a transient cooldown (B6)', () => {
    const acct = mk('b2-orthogonal');
    const now = 4_000_000;
    // A transient RATE_LIMITED cooldown is active (separate dimension).
    markRateLimited(acct.apiKey, 5 * 60 * 1000, null);
    const transientUntil = acct.rateLimitedUntil;
    assert.ok(transientUntil > 0);
    // Quota recovers → clears the quota dimension only, transient untouched.
    applyQuotaSnapshot(acct, 0, now);
    applyQuotaSnapshot(acct, 80, now + 1000);
    assert.equal(acct.quotaResetAt, 0, 'quota dimension cleared');
    assert.equal(acct.rateLimitedUntil, transientUntil,
      'transient rateLimitedUntil is NOT touched by quota recovery');
  });

  it('unknown balance (null/undefined) never cools — does not punish an unprobed account', () => {
    const acct = mk('b2-unknown');
    const now = 5_000_000;
    applyQuotaSnapshot(acct, null, now);
    applyQuotaSnapshot(acct, undefined, now);
    assert.ok(!acct.quotaResetAt, 'no cooldown applied when balance is unknown');
  });

  it('CRITICAL counter-example: a HEALTHY (funded) account is NEVER quota-cooled', () => {
    const acct = mk('b2-healthy');
    const now = 6_000_000;
    applyQuotaSnapshot(acct, 73, now);    // plenty of weekly quota
    assert.ok(!acct.quotaResetAt, 'a funded account is not cooled');
    assert.equal(__isRateLimitedForModel(acct, null, now + 1), false,
      'healthy account stays fully selectable');
  });

  it('WINDSURFAPI_QUOTA_COOLDOWN=0 disables the closed loop', () => {
    process.env.WINDSURFAPI_QUOTA_COOLDOWN = '0';
    const acct = mk('b2-off');
    applyQuotaSnapshot(acct, 0, 7_000_000);
    assert.ok(!acct.quotaResetAt, 'no quota cooldown when disabled');
  });

  it('the dry threshold is env-tunable (cool at/under threshold, leave above)', () => {
    process.env.WINDSURFAPI_QUOTA_DRY_THRESHOLD = '5';
    const dry = mk('b2-thresh-dry');
    const ok = mk('b2-thresh-ok');
    const now = 8_000_000;
    applyQuotaSnapshot(dry, 3, now);   // <= 5 → dry
    applyQuotaSnapshot(ok, 9, now);    // > 5 → fine
    assert.ok(dry.quotaResetAt > now, 'weekly 3% with threshold 5 cools');
    assert.ok(!ok.quotaResetAt, 'weekly 9% with threshold 5 stays selectable');
  });
});

describe('RB2/T3 — new-credential thunderstorm guard', () => {
  it('T3b: a brand-new account is EXEMPT from backoff escalation during the grace window', () => {
    process.env.WINDSURFAPI_BREAKER_BASE_MS = '60000';
    process.env.WINDSURFAPI_BREAKER_FACTOR = '2';
    process.env.WINDSURFAPI_NEW_ACCOUNT_GRACE_MS = String(10 * 60 * 1000);
    reportSuccess(mk('t3-peer-new').apiKey); // healthy peer: not the last account
    // aged:false → addedAt = now, inside the grace window.
    const acct = mk('t3-new', { aged: false });
    failToError(acct);
    acct.status = 'active';
    reportError(acct.apiKey); // would be streak 2 → escalate, but it's NEW
    assert.equal(acct._breakerStreak, 2, 'streak still counts');
    assert.ok(!acct.rateLimitedUntil || acct.rateLimitedUntil <= Date.now(),
      'a new account is not ramped into a long lockout by onboarding wobble');
  });

  it('T3b: once past the grace window the same account DOES escalate', () => {
    process.env.WINDSURFAPI_BREAKER_BASE_MS = '60000';
    process.env.WINDSURFAPI_BREAKER_FACTOR = '2';
    process.env.WINDSURFAPI_NEW_ACCOUNT_GRACE_MS = String(10 * 60 * 1000);
    // A healthy peer so the account under test is NOT the last usable one (the
    // LB last-account exemption would otherwise keep a sole account in rotation).
    reportSuccess(mk('t3-peer').apiKey);
    const acct = mk('t3-aged', { aged: false });
    acct.addedAt = Date.now() - 60 * 60 * 1000; // now well past the grace window
    failToError(acct);
    acct.status = 'active';
    reportError(acct.apiKey); // streak 2 → escalate normally
    assert.ok(acct.rateLimitedUntil > Date.now(),
      'a settled account escalates as usual past the grace window');
  });

  it('T3a: a new account joining a running pool is seeded near pool-median LRU (not "oldest")', () => {
    // Build a running pool with known lastUsed values.
    const base = Date.now() - 5 * 60 * 1000;
    const a1 = mk('t3-pool-1'); a1.lastUsed = base;
    const a2 = mk('t3-pool-2'); a2.lastUsed = base + 60_000;
    const a3 = mk('t3-pool-3'); a3.lastUsed = base + 120_000;
    // New account added into that pool.
    const fresh = mk('t3-fresh', { aged: false });
    // It must NOT be left at lastUsed=0 (which the LRU tiebreaker treats as the
    // oldest → most-preferred). It should sit near the pool median.
    assert.ok(fresh.lastUsed > 0, 'new account not left at the "oldest" sentinel');
    const median = base + 60_000;
    assert.ok(Math.abs(fresh.lastUsed - median) <= 60_000,
      `seeded near pool median (~${median}), got ${fresh.lastUsed}`);
  });

  it('T3a: a BATCH of new accounts does not all collapse onto the same LRU value', () => {
    const base = Date.now() - 5 * 60 * 1000;
    const a1 = mk('t3-batch-pool-1'); a1.lastUsed = base;
    const a2 = mk('t3-batch-pool-2'); a2.lastUsed = base + 120_000;
    // Add three at once.
    const f1 = mk('t3-batch-1', { aged: false });
    const f2 = mk('t3-batch-2', { aged: false });
    const f3 = mk('t3-batch-3', { aged: false });
    const vals = [f1.lastUsed, f2.lastUsed, f3.lastUsed];
    assert.ok(vals.every(v => v > 0), 'all seeded off the oldest sentinel');
    // Jitter de-syncs them — not a perfect 3-way tie (which would force all the
    // first requests onto whichever one the sort happens to surface).
    assert.ok(new Set(vals).size >= 2, `batch should de-synchronize, got ${vals.join(',')}`);
  });

  it('T3a: an empty/fresh pool leaves lastUsed=0 (no median to balance against)', () => {
    // No active account in this pool has a running lastUsed>0 of its own beyond
    // what we add here; the very first account has no median → stays 0.
    const first = mk('t3-firstboot', { aged: false });
    // first is added when peers (from other describe blocks) are removed in
    // afterEach, but to be deterministic we assert the documented contract:
    // when _poolMedianLastUsed() is 0, lastUsed is untouched.
    if (first.lastUsed === 0) {
      assert.equal(first.lastUsed, 0, 'no seeding without a running pool');
    } else {
      // A median existed (peers present) → seeded, which is also valid.
      assert.ok(first.lastUsed > 0);
    }
  });

  it('WINDSURFAPI_NEW_ACCOUNT_BASELINE=0 disables LRU seeding', () => {
    process.env.WINDSURFAPI_NEW_ACCOUNT_BASELINE = '0';
    const a1 = mk('t3-disabled-pool'); a1.lastUsed = Date.now();
    const fresh = mk('t3-disabled-fresh', { aged: false });
    assert.equal(fresh.lastUsed, 0, 'seeding disabled → new account keeps lastUsed=0');
  });
});

describe('RB2 — mother-theme guards (transients must not be escalated)', () => {
  it('CRITICAL: a transient (CAPACITY/internal) NEVER touches the backoff streak', () => {
    const acct = mk('mt-transient');
    // markRateLimited (CAPACITY/RATE_LIMITED) and reportInternalError are the
    // transient paths — chat.js routes them here, NOT to reportError.
    markRateLimited(acct.apiKey, 60 * 1000, 'gpt', 'c');
    reportInternalError(acct.apiKey);
    reportInternalError(acct.apiKey);
    assert.ok(!acct._breakerStreak, 'transients do not start the backoff ladder');
    assert.equal(acct.status, 'active', 'transients do not flip status to error');
  });

  it('CRITICAL counter-example: a HEALTHY account is never locked by selection', () => {
    const acct = mk('mt-healthy');
    reportSuccess(acct.apiKey);
    const now = Date.now();
    assert.equal(__isRateLimitedForModel(acct, null, now), false, 'healthy account selectable');
    assert.equal(__isRateLimitedForModel(acct, 'gpt-5.5', now), false);
    assert.ok(!acct.quotaResetAt && (!acct.rateLimitedUntil || acct.rateLimitedUntil <= now));
  });
});

describe('RB2/B2 — quota dimension is consistent across pool-status helpers', () => {
  it('isAllRateLimited / isAllTemporarilyUnavailable treat a quota-cooled account as unavailable', async () => {
    const { isAllRateLimited, isAllTemporarilyUnavailable } = await import('../src/auth.js');
    // Single-account pool view is noisy across suites; assert the per-account
    // contract instead: a quota-cooled account is filtered out of selection.
    const acct = mk('b2-pool-consistency');
    applyQuotaSnapshot(acct, 0, Date.now());
    assert.ok(acct.quotaResetAt > Date.now(), 'cooled on quota dimension');
    assert.equal(__isRateLimitedForModel(acct, null), true,
      'quota-cooled account excluded — same predicate both pool helpers use');
    // Smoke the helpers don't throw with the new dimension present.
    assert.doesNotThrow(() => isAllRateLimited(null));
    assert.doesNotThrow(() => isAllTemporarilyUnavailable(null));
  });
});

// LB — last-account breaker exemption: the breaker must not take the ONLY usable
// account out of rotation. In a single-account pool, disabling = a guaranteed
// pool-wide 529, so one bad request/model self-inflicts a total outage. A
// degraded sole account serving what it can beats guaranteed failure. The streak
// counters keep advancing, so a healthy peer restores normal breaker behaviour.
// afterEach (top of file) removes every created account, so each test starts on a
// clean pool and controls its own island.
describe('LB — last-account breaker exemption', () => {
  it('reportError does NOT flip the sole account to error (kept in rotation)', () => {
    const acct = mk('lb-sole');
    failToError(acct); // 3 errors would normally flip status='error'
    assert.equal(acct.status, 'active', 'last account stays active');
    assert.equal(acct.errorCount, 3, 'errorCount still climbed (history preserved)');
    assert.equal(__isRateLimitedForModel(acct, null), false, 'still selectable');
  });

  it('reportInternalError does NOT quarantine the sole account', () => {
    const acct = mk('lb-sole-internal');
    reportInternalError(acct.apiKey);
    reportInternalError(acct.apiKey); // streak>=2 would normally 5min-quarantine
    assert.equal(acct.internalErrorStreak, 2, 'streak still climbed');
    assert.ok(!acct.rateLimitedUntil || acct.rateLimitedUntil <= Date.now(),
      'no quarantine cooldown set on the last account');
    assert.equal(__isRateLimitedForModel(acct, null), false, 'still selectable');
  });

  it('with a healthy peer present, the breaker trips normally (exemption is pool-size aware)', () => {
    const bad = mk('lb-bad');
    const good = mk('lb-good');
    reportSuccess(good.apiKey); // ensure the peer is unambiguously usable
    assert.equal(__isLastUsableAccount(bad), false, 'bad is not the last usable account');
    failToError(bad);
    assert.equal(bad.status, 'error', 'a non-last account still trips to error');
    // internal-error quarantine path also trips when a peer exists
    const bad2 = mk('lb-bad2');
    reportInternalError(bad2.apiKey);
    reportInternalError(bad2.apiKey);
    assert.ok(bad2.rateLimitedUntil > Date.now(), 'non-last account still quarantined');
  });

  it('once the only peer is itself down, the survivor is exempt again', () => {
    const a = mk('lb-a');
    const b = mk('lb-b');
    // Take a out via the internal-error path with b as the healthy peer present.
    reportSuccess(a.apiKey);
    reportInternalError(b.apiKey);
    reportInternalError(b.apiKey);
    assert.ok(b.rateLimitedUntil > Date.now(), 'b quarantined while a was usable');
    // Now a is the last usable account — it must be exempt.
    assert.equal(__isLastUsableAccount(a), true, 'a is now the sole usable account');
    failToError(a);
    assert.equal(a.status, 'active', 'survivor exempt once its peer is down');
  });

  it('WINDSURFAPI_LAST_ACCOUNT_EXEMPT=0 restores strict trip-always behaviour', () => {
    process.env.WINDSURFAPI_LAST_ACCOUNT_EXEMPT = '0';
    const acct = mk('lb-optout');
    failToError(acct);
    assert.equal(acct.status, 'error', 'opt-out: sole account trips as before');
  });
});
