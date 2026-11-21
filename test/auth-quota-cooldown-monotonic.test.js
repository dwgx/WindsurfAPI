// V-18 (audit CORE-004) — one quota cooldown dimension, two writers.
//
//   * applyQuotaSnapshot() reacts to a proactive weekly-credit snapshot.
//   * markQuotaExhausted()  reacts to a LIVE 402 for an actual request.
//
// The audit probe: a live 402 armed a three-hour deadline; a later snapshot that
// reported 80% weekly cleared it, and a snapshot reporting 0% overwrote it with
// the 30-minute default. Both are wrong:
//
//  1. MONOTONIC — a cooldown is a deadline, not a value. A later write may
//     extend it (more evidence of dryness) but must never pull it closer, or an
//     account re-enters rotation before the upstream said it would be usable.
//  2. SAME-SOURCE PROOF — a weekly snapshot only knows the INCLUDED-quota
//     dimension. A live 402 can be about the on-demand/ACU dimension while the
//     weekly number reads healthy, so "weekly 80%" is not evidence that the
//     dimension the 402 came from recovered. Only a snapshot that wrote the
//     deadline may clear it; a live-402 deadline self-heals on expiry.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, applyQuotaSnapshot, markQuotaExhausted,
  __isRateLimitedForModel, __serializeAccounts, __deserializeAccount,
} from '../src/auth.js';

const created = [];
const ENV_KEYS = [
  'WINDSURFAPI_QUOTA_COOLDOWN', 'WINDSURFAPI_QUOTA_COOLDOWN_MS',
  'WINDSURFAPI_QUOTA_DRY_THRESHOLD', 'WINDSURFAPI_SPEND_ON_DEMAND',
];
const savedEnv = {};

function add(label) {
  const account = addAccountByKey(
    `v18-key-${Date.now()}-${created.length}-${Math.random().toString(36).slice(2)}`,
    label,
  );
  created.push(account.id);
  return account;
}

function persistEnv(key) { savedEnv[key] = process.env[key]; }

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (!(k in savedEnv)) continue;
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
  while (created.length) removeAccount(created.pop());
});

describe('V-18 — quota cooldown is monotonic and source-aware', () => {
  it('weekly quota snapshot cannot shorten a live 402 cooldown', () => {
    persistEnv('WINDSURFAPI_QUOTA_COOLDOWN_MS');
    process.env.WINDSURFAPI_QUOTA_COOLDOWN_MS = '1800000'; // 30m snapshot default
    const acct = add('v18-shorten');
    const now = 30_000_000;
    const liveMs = 3 * 60 * 60 * 1000;                     // upstream said 3h
    markQuotaExhausted(acct.apiKey, liveMs, now);
    const liveDeadline = acct.quotaResetAt;
    assert.equal(liveDeadline, now + liveMs);

    applyQuotaSnapshot(acct, 0, now + 1000);               // still dry
    assert.equal(acct.quotaResetAt, liveDeadline,
      'a 30m snapshot must not pull a 3h live-402 deadline closer');
    assert.equal(__isRateLimitedForModel(acct, null, liveDeadline - 1), true,
      'the account stays out of rotation until the upstream window ends');
  });

  it('a recovered weekly snapshot does not clear a live-402 cooldown', () => {
    const acct = add('v18-cross-source');
    const now = 31_000_000;
    markQuotaExhausted(acct.apiKey, 60 * 60 * 1000, now);
    const liveDeadline = acct.quotaResetAt;

    // Weekly data reads healthy — but it says nothing about the dimension the
    // live 402 came from (it can be an on-demand/ACU exhaustion).
    applyQuotaSnapshot(acct, 80, now + 1000);
    assert.equal(acct.quotaResetAt, liveDeadline,
      'unrelated weekly data cannot clear a live-402 cooldown');
    assert.equal(__isRateLimitedForModel(acct, null, now + 2000), true,
      'the account stays cooled');
  });

  it('a snapshot-written cooldown still clears on a recovered snapshot (control)', () => {
    const acct = add('v18-same-source');
    const now = 32_000_000;
    applyQuotaSnapshot(acct, 0, now);
    assert.ok(acct.quotaResetAt > now, 'dry snapshot cools');
    applyQuotaSnapshot(acct, 42, now + 60_000);
    assert.equal(acct.quotaResetAt, 0, 'same-source recovery clears it immediately');
    assert.equal(acct.quotaResetSource, null, 'and the provenance is dropped with it');
  });

  it('a snapshot never shortens a longer snapshot cooldown either', () => {
    persistEnv('WINDSURFAPI_QUOTA_COOLDOWN_MS');
    process.env.WINDSURFAPI_QUOTA_COOLDOWN_MS = '7200000'; // 2h
    const acct = add('v18-snapshot-monotonic');
    const now = 33_000_000;
    applyQuotaSnapshot(acct, 0, now);
    const first = acct.quotaResetAt;
    assert.equal(first, now + 7200000);
    process.env.WINDSURFAPI_QUOTA_COOLDOWN_MS = '1800000'; // operator lowers it
    applyQuotaSnapshot(acct, 0, now + 1000);
    assert.equal(acct.quotaResetAt, first,
      'a tunable change does not retroactively shorten an armed cooldown');
  });

  it('an expired live-402 cooldown is cleaned up by the next snapshot (self-healing)', () => {
    const acct = add('v18-expire');
    const now = 34_000_000;
    markQuotaExhausted(acct.apiKey, 60 * 60 * 1000, now);
    const liveDeadline = acct.quotaResetAt;
    applyQuotaSnapshot(acct, 80, liveDeadline + 1);
    assert.equal(acct.quotaResetAt, 0, 'an expired deadline is stale state, not a cooldown');
    assert.equal(acct.quotaResetSource, null);
  });

  it('a spendable balance does not clear a live-402 deadline either (deliberate)', () => {
    const acct = add('v18-funded-live');
    const now = 36_000_000;
    markQuotaExhausted(acct.apiKey, 30 * 60 * 1000, now);
    const liveDeadline = acct.quotaResetAt;
    acct.credits = { balance: 50 };      // policy says a funded account may serve
    applyQuotaSnapshot(acct, 0, now + 1000);
    assert.equal(acct.quotaResetAt, liveDeadline,
      'the 402 window bounds the re-probe rate; only expiry clears it');
  });

  it('the live-402 provenance survives a restart', () => {
    const acct = add('v18-persist');
    const now = Date.now();
    markQuotaExhausted(acct.apiKey, 60 * 60 * 1000, now);
    const record = __serializeAccounts().find(a => a.apiKey === acct.apiKey);
    assert.equal(record.quotaResetSource, 'live402',
      'the source is persisted with the deadline');

    const restored = __deserializeAccount(record);
    assert.equal(restored.quotaResetAt, record.quotaResetAt);
    assert.equal(restored.quotaResetSource, 'live402');
    applyQuotaSnapshot(restored, 90, now + 1000);
    assert.equal(restored.quotaResetAt, record.quotaResetAt,
      'a restart must not make the live-402 deadline clearable by weekly data');
  });

  it('a legacy deadline with no recorded source is treated as not-snapshot-clearable', () => {
    const now = 35_000_000;
    // Written by a version that did not persist provenance (or hand-edited).
    const legacy = __deserializeAccount({ apiKey: 'v18-legacy', quotaResetAt: now + 60_000 }, now);
    assert.equal(legacy.quotaResetSource, null, 'unknown provenance is null, not guessed');
    applyQuotaSnapshot(legacy, 80, now + 1000);
    assert.equal(legacy.quotaResetAt, now + 60_000,
      'the snapshot cannot prove anything about a deadline it did not write');
    applyQuotaSnapshot(legacy, 80, now + 120_000);
    assert.equal(legacy.quotaResetAt, 0, 'expiry still self-heals it');
  });
});
