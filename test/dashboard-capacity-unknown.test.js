// G4 (Q1 audit §7/§8.5) — `CheckUserMessageRateLimit` reports `messagesRemaining: -1`
// UNCONDITIONALLY.
//
// S01 re-tested this against the live service on 2026-09-15 and recorded both halves
// (docs/upstream-protocol.md, "限流与配额"):
//
//   * 「CheckUserMessageRateLimit 恒报 {messagesRemaining:-1}」 — the value is a
//     constant, so it cannot distinguish "unlimited" from "no count available";
//   * 「容量检查说有」≠「生成不报 429」 — a positive answer does not predict a
//     successful generation.
//
// What this suite PINS is the part the dashboard already gets right: the sentinel
// never becomes a numeric "capacity available" figure, and every probe that could
// not answer (fail-open, throw) reports `unknown`, never "available".
//
// [UNVERIFIED] / DEFERRED — the remaining half of G4. A *successful* probe carrying
// the constant `-1` still reads as `verdict: 'ok'` + `upstream.unlimited: true`
// (`buildCapacityPreflight`, src/dashboard/devin-cards.js). The audit's position is
// that a constant must land in `unknown`; the current code and
// test/dashboard-devin-cards.test.js ("reports unlimited only from a successful -1
// answer") deliberately pin the opposite. Reversing it edits a pinned dashboard
// contract outside this ticket's file scope, so it is recorded here as the current
// behaviour — a future change has to edit this test on purpose instead of flipping
// the badge silently. See the report's §7 G4 for the evidence.
//
// No live call is made: the upstream probe is injected through the documented
// `__setPreflightDepsForTest` seam.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCapacityPreflight,
  preflightCapacity,
  __setPreflightDepsForTest,
} from '../src/dashboard/devin-cards.js';
import { addAccountByKey, removeAccount } from '../src/auth.js';

// The documented wire shape: has_capacity true, the constant -1, no error.
const CONSTANT_PROBE = { hasCapacity: true, messagesRemaining: -1, maxMessages: -1, retryAfterMs: null };

const created = new Set();
function addAccount(label) {
  const account = addAccountByKey(`cap-unknown-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, label);
  created.add(account.id);
  return account;
}

afterEach(() => {
  __setPreflightDepsForTest({});
  while (created.size) {
    try { removeAccount(created.values().next().value); } catch { /* best effort */ }
    created.delete(created.values().next().value);
  }
});

describe('G4: the -1 sentinel never becomes a numeric capacity figure', () => {
  it('reports no remaining count and no maximum — never -1, never a number', () => {
    const pre = buildCapacityPreflight({
      availability: { available: true, reason: 'available' },
      upstream: CONSTANT_PROBE,
    });
    assert.equal(pre.upstream.messagesRemaining, null,
      'a sentinel rendered as "-1 remaining" is exactly the numeric capacity state G4 forbids');
    assert.equal(pre.upstream.maxMessages, null);
    assert.notEqual(typeof pre.upstream.messagesRemaining, 'number');
    // The raw upstream answer is still reported verbatim for diagnosis, so the
    // panel can show WHAT the probe said without treating it as a count.
    assert.equal(pre.upstream.hasCapacity, true);
  });

  it('[DEFERRED] a successful -1 probe currently reads as ok/unlimited — see the file header', () => {
    const pre = buildCapacityPreflight({
      availability: { available: true, reason: 'available' },
      upstream: CONSTANT_PROBE,
    });
    // CURRENT behaviour, deliberately pinned so a future change is an edit here.
    // The audit (G4) wants `state: 'unknown'` / `verdict: 'unknown'` / no unlimited
    // claim for this shape; that is deferred, not forgotten.
    assert.equal(pre.upstream.state, 'ok');
    assert.equal(pre.upstream.unlimited, true);
    assert.equal(pre.verdict, 'ok');
  });

  it('a throttled probe that also carries -1 is "limited", never "available"', () => {
    const pre = buildCapacityPreflight({
      availability: { available: true, reason: 'available' },
      upstream: { hasCapacity: false, messagesRemaining: -1, maxMessages: -1, retryAfterMs: 15_000 },
    });
    assert.equal(pre.upstream.state, 'limited');
    assert.equal(pre.verdict, 'throttled', 'a negative answer is believed and must never read as available');
    assert.equal(pre.upstream.messagesRemaining, null);
    // `unlimited` is currently true even here (it keys off the -1 alone, not off
    // hasCapacity) — part of the deferred half documented in the file header.
    assert.equal(pre.upstream.hasCapacity, false);
  });
});

describe('G4: a probe that could not answer reports unknown, never available', () => {
  it('a fail-open probe (-1 + upstream_unreachable) is unknown', () => {
    const pre = buildCapacityPreflight({
      availability: { available: true, reason: 'available' },
      upstream: { ...CONSTANT_PROBE, error: 'upstream_unreachable' },
    });
    assert.equal(pre.upstream.state, 'unknown');
    assert.equal(pre.verdict, 'unknown', 'a probe that failed open must not read as capacity available');
    assert.equal(pre.upstream.unlimited, false);
    assert.equal(pre.upstream.messagesRemaining, null);
    assert.equal(pre.upstream.error, 'upstream_unreachable');
  });

  it('the route-level preflight normalizes the sentinel and keeps the failure visible', async () => {
    const account = addAccount('fail-open');
    __setPreflightDepsForTest({
      rateLimit: async () => ({ ...CONSTANT_PROBE, error: 'upstream_unreachable' }),
    });
    const result = await preflightCapacity({ id: account.id, model: 'gemini-2.5-flash' });
    assert.equal(result.ok, true);
    assert.equal(result.upstream.messagesRemaining, null);
    assert.equal(result.upstream.state, 'unknown');
    assert.equal(result.verdict, 'unknown');
  });

  it('the route-level preflight passes the constant through as null, not as a count', async () => {
    const account = addAccount('constant');
    __setPreflightDepsForTest({ rateLimit: async () => CONSTANT_PROBE });
    const result = await preflightCapacity({ id: account.id, model: 'gemini-2.5-flash' });
    assert.equal(result.ok, true);
    assert.equal(result.upstream.messagesRemaining, null,
      'the route must not hand the panel a -1 it would render as a remaining count');
    assert.equal(result.upstream.maxMessages, null);
  });
});
