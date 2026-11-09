// Two blockers in the #224 x #225 interaction, and the invariant that separates
// them.
//
// #224 made a RATE_LIMITED verdict write the upstream's real reset window to a
// cooldown. That dimension is now the throttled SELECTOR (`selector || model`),
// not the whole account: a 429 for one model is no evidence about the others, so
// the account stays eligible for every model it can still serve (T10).
// #225 made a client disconnect stop penalizing the account. Both are right on
// their own, but #225's abort arm sat FIRST in finalizeConnectAccount's else-if
// chain, so a disconnect that raced an in-flight upstream 429 skipped the WHOLE
// classification — including that cooldown.
// Measured before the fix: a declared 3h window became 0ms and the account was
// immediately re-selectable. Agent clients (Claude Code / Codex) cancel mid-turn
// constantly, so every cancelled turn re-armed an already-throttled account and
// the pool kept hammering the upstream velocity limiter — which is the documented
// escalation path to a multi-hour hard ban, i.e. exactly what #224 was merged to
// prevent.
//
// The invariant these tests pin: an upstream-declared COOLDOWN is a fact about the
// account or model that stays true whether or not our client is still listening.
// A PENALTY (errorCount eviction, re-login, internal-error streak) is a judgement
// that the account misbehaved, and a client disconnect is no evidence of that.
// Cooldown: always. Penalty: never on abort.
//
// Second blocker, same family: isAbortError's `/aborted/i` message fallback.
// classifyUpstreamError puts the raw upstream body into `.message` and passes
// unknown gRPC codes through verbatim, so a genuine gRPC `aborted` trailer — or
// any 5xx / middlebox body containing the word — was read as a client disconnect:
// 499 to a client that never left, failover suppressed, no cooldown recorded. The
// message arm still exists for the undici shapes that carry neither `name` nor
// `code`, but it is now only consulted when the error carries no upstream verdict.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addAccountByKey, removeAccount, setAccountTier, getAccountInternal,
} from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';
import { classifyUpstreamError } from '../src/devin-connect.js';

const created = [];
afterEach(() => { while (created.length) removeAccount(created.pop()); });

function seed(label, tier = 'pro') {
  const a = addAccountByKey(`devin-session-token$abrt-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  setAccountTier(a.id, tier);
  return a;
}

// Finalize one request and report what it did to the account.
function finalize(label, { err, aborted = false }) {
  const a = seed(label);
  finalizeConnectAccount(
    { id: a.id, apiKey: a.apiKey },
    { model: 'gpt-5.5', selector: 'gpt-5-5-low', startTime: Date.now() - 5, err, aborted },
  );
  const fresh = getAccountInternal(a.id);
  return {
    cooldownMs: fresh.rateLimitedUntil ? fresh.rateLimitedUntil - Date.now() : 0,
    modelCooldowns: { ...(fresh._modelRateLimits || {}) },
    quotaResetMs: fresh.quotaResetAt ? fresh.quotaResetAt - Date.now() : 0,
    errorCount: fresh.errorCount || 0,
    status: fresh.status,
    // The consecutive-internal-error streak reportInternalError maintains. Non-zero
    // means the error was classified as a fault of SOME kind; zero means nothing was
    // recorded, which is the client-disconnect signature.
    healthEvents: fresh.internalErrorStreak || 0,
  };
}

const RESET_MS = 3 * 60 * 60 * 1000;
const rateLimited = () => Object.assign(
  new Error('Reached message rate limit for this model. Please try again later. Resets in: 3h0m0s'),
  { code: 'RATE_LIMITED', resetMs: RESET_MS },
);

describe('a client disconnect does not discard an upstream-declared cooldown', () => {
  it('applies the 429 reset window whether or not the client stayed connected', () => {
    const stayed = finalize('rl-stayed', { err: rateLimited(), aborted: false });
    const left = finalize('rl-left', { err: rateLimited(), aborted: true });

    // The window is wall-clock derived, so assert it landed near the declared
    // value rather than to the millisecond. It is scoped to the throttled
    // SELECTOR (`selector || model`), not the account: a 429 for one model is
    // no evidence about the others, and the account-wide dimension stays clear.
    for (const [name, r] of [['connected', stayed], ['disconnected', left]]) {
      const remaining = (r.modelCooldowns['gpt-5-5-low'] || 0) - Date.now();
      assert.ok(
        remaining > RESET_MS - 60_000 && remaining <= RESET_MS,
        `${name}: expected ~${RESET_MS}ms selector cooldown, got ${remaining}ms`,
      );
      assert.equal(r.cooldownMs, 0, `${name}: the account-wide dimension must stay clear`);
    }
    // The whole point: the disconnect must not shorten or drop the window.
    assert.ok(
      Math.abs(stayed.modelCooldowns['gpt-5-5-low'] - left.modelCooldowns['gpt-5-5-low']) < 60_000,
      `a disconnect changed the cooldown: connected=${stayed.modelCooldowns['gpt-5-5-low']} disconnected=${left.modelCooldowns['gpt-5-5-low']}`,
    );
  });

  it('still exempts the account from the error budget when the client disconnects', () => {
    const left = finalize('rl-left-budget', { err: rateLimited(), aborted: true });
    assert.equal(left.errorCount, 0, 'a disconnect must not charge the error budget');
    assert.equal(left.status, 'active');
  });

  it('applies the quota dry-well cooldown on a disconnected 402', () => {
    const r = finalize('quota-left', {
      err: Object.assign(new Error('quota'), { code: 'QUOTA_EXHAUSTED' }),
      aborted: true,
    });
    assert.ok(r.quotaResetMs > 0, `expected a quota cooldown, got ${r.quotaResetMs}ms`);
    assert.equal(r.errorCount, 0);
  });

  it('applies the CAPACITY selector cooldown on a disconnected overload', () => {
    const r = finalize('cap-left', {
      err: Object.assign(new Error('high demand'), { code: 'CAPACITY' }),
      aborted: true,
    });
    // Written under the resolved SELECTOR, not the client-facing model name —
    // connect selection looks up with modelKey=null + selector.
    assert.ok(
      r.modelCooldowns['gpt-5-5-low'] > Date.now(),
      `expected a selector-scoped cooldown, got ${JSON.stringify(r.modelCooldowns)}`,
    );
    assert.equal(r.errorCount, 0);
  });

  it('a pure abort with no upstream verdict records neither cooldown nor penalty', () => {
    const r = finalize('pure-abort', {
      err: Object.assign(new Error('client disconnected'), { name: 'AbortError' }),
      aborted: true,
    });
    assert.equal(r.cooldownMs, 0, 'nothing was declared upstream, so nothing to cool');
    assert.equal(r.quotaResetMs, 0);
    assert.deepEqual(r.modelCooldowns, {});
    assert.equal(r.errorCount, 0);
  });

  it('keeps the penalty exemption for a genuine account fault raced by a disconnect', () => {
    const left = finalize('auth-left', {
      err: Object.assign(new Error('unauthorized'), { code: 'UNAUTHORIZED' }),
      aborted: true,
    });
    const stayed = finalize('auth-stayed', {
      err: Object.assign(new Error('unauthorized'), { code: 'UNAUTHORIZED' }),
      aborted: false,
    });
    assert.equal(left.errorCount, 0, 'a disconnect must not charge the error budget');
    assert.equal(stayed.errorCount, 1, 'a connected client MUST still charge it');
  });

  it('does not let a disconnect suppress the cooldown across repeated cancelled turns', () => {
    // The amplification loop: before the fix, N cancelled turns absorbed N
    // upstream 429s with zero cooldown, so the pool kept re-selecting the
    // throttled account.
    const a = seed('amplify');
    for (let i = 0; i < 5; i++) {
      finalizeConnectAccount(
        { id: a.id, apiKey: a.apiKey },
        { model: 'gpt-5.5', selector: 'gpt-5-5-low', startTime: Date.now() - 5, err: rateLimited(), aborted: true },
      );
    }
    const fresh = getAccountInternal(a.id);
    const remaining = (fresh._modelRateLimits?.['gpt-5-5-low'] || 0) - Date.now();
    assert.ok(remaining > RESET_MS - 60_000, `expected the selector window to hold, got ${remaining}ms`);
    assert.ok(!(fresh.rateLimitedUntil > Date.now()), 'the account-wide dimension must stay clear');
    assert.equal(fresh.errorCount || 0, 0);
  });
});

// The `/aborted/i` fallback, exercised through the real function rather than a
// copy: chat.js does not export isAbortError, so drive it via the observable
// consequence — an error the classifier produced must never be treated as a local
// abort, which means its cooldown/penalty must still be applied.
describe('an upstream fault mentioning "aborted" is not a client disconnect', () => {
  it('a gRPC aborted trailer still charges the account, unlike a real abort', () => {
    // classifyUpstreamError passes unknown gRPC codes through verbatim, so this
    // error carries code:'aborted' AND the word in its message — the exact shape
    // that used to satisfy the message regex.
    const upstream = classifyUpstreamError(
      '{"code":"aborted","message":"the operation was aborted"}', 'aborted', null,
    );
    assert.equal(upstream.code, 'aborted', 'precondition: the code passes through verbatim');
    assert.match(upstream.message, /aborted/i, 'precondition: the message carries the word');

    const err = Object.assign(new Error(upstream.message), { code: upstream.code });
    const graded = finalize('grpc-aborted', { err, aborted: false });
    const realAbort = finalize('real-abort', {
      err: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
      aborted: false,
    });

    // Neither charges the error budget — an upstream `aborted` is a transport fault
    // (the call was aborted, which says nothing about this account's token), so it is
    // exempt from eviction just like a client disconnect is.
    //
    // This assertion originally read `graded.errorCount === 1`, because at the time
    // `aborted` had no classification and fell to the account-fault fallthrough. That
    // froze a defect into a contract: classifying it correctly then made this test
    // fail. The distinguishing property is not the error budget, it is whether the
    // error was CLASSIFIED at all — a transport fault records a health event so a
    // genuinely sick account is still de-prioritized by selection, while a client
    // disconnect records nothing because the client leaving is not evidence about the
    // account.
    assert.equal(graded.errorCount, 0, 'a transport fault must not charge the error budget');
    assert.equal(realAbort.errorCount, 0, 'and neither must a genuine AbortError');

    assert.ok(
      graded.healthEvents > 0,
      'an upstream aborted trailer must be GRADED — it should record a health event, which is what '
      + 'distinguishes "classified as a transport fault" from "waved through as a client disconnect"',
    );
    assert.equal(
      realAbort.healthEvents, 0,
      'a genuine client disconnect must record nothing at all — it is not evidence about the account',
    );
  });

  it('a 429 whose body mentions "aborted" still gets its reset window', () => {
    const upstream = classifyUpstreamError(
      'rate limit reached, stream aborted. Resets in: 3h0m0s', null, 429,
    );
    assert.equal(upstream.code, 'RATE_LIMITED', 'precondition: classified as a rate limit');
    const err = Object.assign(new Error(upstream.message), upstream);
    const r = finalize('rl-aborted-word', { err, aborted: false });
    const remaining = (r.modelCooldowns['gpt-5-5-low'] || 0) - Date.now();
    assert.ok(remaining > 60_000, `expected a real selector cooldown, got ${remaining}ms`);
    assert.equal(r.cooldownMs, 0, 'the account-wide dimension must stay clear');
  });

  it('an undici abort carrying neither name nor code is still recognised', () => {
    // This is why the message arm exists at all (#225): some undici shapes set
    // neither marker. Such an error has no upstream verdict, so it must still be
    // read as an abort — removing the arm outright would regress that fix.
    const r = finalize('undici-bare', { err: new Error('The operation was aborted'), aborted: false });
    assert.equal(r.errorCount, 0, 'a marker-less undici abort must stay exempt');
  });
});

// Structural guard. The two fixes above are both orderings inside one function,
// and an ordering is exactly what a behavioural test can silently stop covering
// (a future refactor may reshape the chain so these cases never reach it). Assert
// the source-level invariants directly, as a set difference rather than a
// presence check: every cooldown-bearing code must be handled ABOVE the abort
// short-circuit, and the abort arm must not be the first arm again.
describe('finalizeConnectAccount keeps cooldowns above the abort short-circuit', () => {
  const CHAT = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
  const body = (() => {
    const start = CHAT.indexOf('export function finalizeConnectAccount');
    assert.ok(start !== -1, 'finalizeConnectAccount must exist');
    const end = CHAT.indexOf('\n}', CHAT.indexOf('releaseAccountById', start));
    return CHAT.slice(start, end);
  })();

  // Codes whose handling writes a cooldown the upstream declared. These are facts
  // about the account/model, so a client disconnect must not skip them.
  const COOLDOWN_CODES = ['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'CAPACITY'];

  it('every cooldown-bearing code is classified before the abort arm', () => {
    const abortArm = body.search(/else if \(aborted\)/);
    assert.ok(abortArm !== -1, 'the abort short-circuit must still exist');

    const late = COOLDOWN_CODES.filter((code) => {
      const at = body.indexOf(`err.code === '${code}'`);
      return at === -1 || at > abortArm;
    });
    assert.deepEqual(
      late, [],
      'these upstream-declared cooldowns are handled at or after the abort arm, so a client '
      + 'disconnect discards them (the #224/#225 blocker). Move them above `else if (aborted)`.',
    );
  });

  it('the abort arm is not the first arm in the chain', () => {
    const firstArm = body.search(/\n    if \(/);
    const abortArm = body.search(/else if \(aborted\)/);
    assert.ok(firstArm !== -1 && abortArm > firstArm,
      'the abort check must not lead the classification chain again — leading it is what '
      + 'made a disconnect skip every cooldown below.');
  });

  it('callers flag the abort instead of substituting a synthetic error', () => {
    // The call sites used to pass `err: isAbortError(e) ? e : new AbortError()`,
    // which erased the upstream verdict (RATE_LIMITED + resetMs) before this
    // function could act on it.
    assert.doesNotMatch(
      CHAT,
      /err: isAbortError\([a-zA-Z]+\) \?/,
      'a caller is substituting a synthetic AbortError for the real error, which erases the '
      + 'upstream verdict. Pass the real error plus `aborted: true` instead.',
    );
    assert.ok(
      CHAT.includes('aborted: true'),
      'the disconnect paths must signal the abort via the `aborted` flag',
    );
  });
});
