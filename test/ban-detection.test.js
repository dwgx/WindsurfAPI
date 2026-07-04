// v2.0.56 — ban-shaped error detection. windsurf-assistant-pub
// inspiration: when upstream returns "Account suspended" / "API key
// revoked" we promote the account to status='banned' after a 2-strike
// streak, so the pool stops handing out a known-dead key.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getAccountInternal,
  looksLikeBanSignal, reportBanSignal, reportSuccess,
} from '../src/auth.js';

const created = [];
function mkAccount(label = 'ban-test') {
  const a = addAccountByKey('sk-ban-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), label);
  created.push(a.id);
  return a;
}

afterEach(() => {
  while (created.length) removeAccount(created.pop());
});

describe('looksLikeBanSignal (audit windsurf-assistant-pub)', () => {
  const positives = [
    'Your account has been suspended for terms-of-service violation',
    'account_disabled',
    'Account banned by upstream',
    'User suspended due to abuse',
    'Subscription cancelled',
    'subscription expired',
    'Authentication failed: invalid credentials',
    'Invalid API key',
    'API key revoked',
    'API key disabled',
    'unauthorized: account does not exist',
    '账号已停用',
    '账号封禁',
    '用户已禁用',
    '订阅已过期',
  ];
  const negatives = [
    'rate limit exceeded',
    'too many requests',
    'context deadline exceeded',
    'internal error occurred (error ID: abc)',
    'cascade transport failure',
    'panel state not found',
    'temporary upstream stall',
    '',
    null,
    undefined,
    42,
  ];

  const labelOf = (msg) => {
    const s = (msg === null) ? 'null' : (msg === undefined) ? 'undefined' : String(msg);
    return s.slice(0, 60).replace(/\s+/g, ' ');
  };
  for (const msg of positives) {
    it(`detects ban signal: ${labelOf(msg)}`, () => {
      assert.equal(looksLikeBanSignal(msg), true);
    });
  }
  for (const msg of negatives) {
    it(`ignores non-ban: ${labelOf(msg) || '(empty)'}`, () => {
      assert.equal(looksLikeBanSignal(msg), false);
    });
  }
});

describe('reportBanSignal: 2-strike → status=banned', () => {
  it('first ban-shaped error does NOT flip status', () => {
    const a = mkAccount();
    reportBanSignal(a.apiKey, 'Account suspended');
    assert.equal(getAccountInternal(a.id).status, 'active', 'one strike must not ban');
  });

  it('two ban-shaped errors within window → status=banned', () => {
    const a = mkAccount();
    reportBanSignal(a.apiKey, 'Account suspended');
    reportBanSignal(a.apiKey, 'Invalid API key');
    const after = getAccountInternal(a.id);
    assert.equal(after.status, 'banned', 'two strikes must promote to banned');
    assert.ok(after.bannedAt > 0, 'bannedAt timestamp must be set');
    assert.ok(after.bannedReason, 'bannedReason must be set');
  });

  it('reportSuccess between two ban signals resets the streak', () => {
    const a = mkAccount();
    reportBanSignal(a.apiKey, 'Authentication failed');
    reportSuccess(a.apiKey);
    reportBanSignal(a.apiKey, 'Authentication failed');
    assert.equal(getAccountInternal(a.id).status, 'active', 'success must clear ban-streak');
  });

  it('signal on unknown apiKey is a no-op', () => {
    const result = reportBanSignal('sk-does-not-exist', 'Account suspended');
    assert.equal(result, false);
  });
});

describe('R3: transient-first guard prevents ban promotion of transient errors', () => {
  // The upstream sometimes wraps a transient stall in a 401/403 shell whose text
  // matches BAN_PATTERNS (e.g. "authentication ... failed"). The handler guard is
  // `!isRateLimit && !isInternal && !isTransient && looksLikeBanSignal(msg)`, so a
  // transient/internal error must NEVER reach reportBanSignal, even though its text
  // is ban-shaped — otherwise two transient stalls would burn a healthy account.
  const banShapedButTransient = 'Authentication failed'; // matches BAN_PATTERNS

  it('the text alone still looks ban-shaped (guard is not about the text)', () => {
    assert.equal(looksLikeBanSignal(banShapedButTransient), true);
  });

  it('twice-repeated transient error carrying ban-shaped text does NOT ban when guard skips it', () => {
    const a = mkAccount();
    // Simulate the handler: because isInternal/isTransient is true, the ban branch
    // is guarded off and reportBanSignal is never called — so no promotion.
    const isInternal = true; // e.g. "internal error occurred (error ID ...)" shell
    for (let strike = 0; strike < 2; strike++) {
      if (!isInternal && looksLikeBanSignal(banShapedButTransient)) {
        reportBanSignal(a.apiKey, banShapedButTransient);
      }
    }
    assert.equal(getAccountInternal(a.id).status, 'active',
      'a transient error wrapped in an auth-shaped shell must not burn the account');
  });

  it('genuine ban signal (not transient) still promotes after 2 strikes', () => {
    const a = mkAccount();
    const isInternal = false; // real auth failure, not a transient shell
    for (let strike = 0; strike < 2; strike++) {
      if (!isInternal && looksLikeBanSignal('Account suspended')) {
        reportBanSignal(a.apiKey, 'Account suspended');
      }
    }
    assert.equal(getAccountInternal(a.id).status, 'banned',
      'a genuine ban signal must still promote — the guard only spares transient errors');
  });
});
