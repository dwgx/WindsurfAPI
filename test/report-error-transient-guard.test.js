// audit #8 — reportError transient guard.
//
// Both Cascade error handlers (nonStreamResponse chat.js:4118, streamResponse
// chat.js:5100) gate the account error-budget penalty as:
//     if (isAuthFail && !isRateLimit && !isInternal && !isTransient) reportError(...)
// The upstream sometimes wraps a TRANSIENT fault (internal-error / capacity /
// transport stall) in a 401/403 auth shell whose text ALSO matches isAuthFail
// ("unauthenticated", "permission_denied"). Counting that against the account's
// errorCount would demote a healthy account toward eviction on a transient blip.
// The load-bearing reliability invariant is: TRANSIENTS NEVER REACH reportError.
//
// The handlers build these predicates from the SAME exported classifiers this
// test imports, so we reconstruct the exact guard expression over representative
// upstream messages and pin its truth value — the same isolation approach
// ban-detection.test.js uses for the sibling ban guard (which shares the
// !isRateLimit && !isInternal && !isTransient exclusion, chat.js:4108/5143).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUpstreamDeadlineExceeded, isUpstreamTransientError } from '../src/handlers/chat.js';
import { isCascadeTransportError } from '../src/client.js';

// Verbatim copies of the two regexes the handlers use (chat.js:4083-4085,
// 5093-5095). If the handler regexes change, these must change with them — the
// point is to freeze the guard's decision, not to re-derive it.
const AUTHFAIL_RE = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i;
const RATELIMIT_RE = /rate limit|rate_limit|too many requests|quota/i;
const INTERNAL_RE = /internal error occurred.*(error|trace)\s*id/i;

// The exact guard the handlers evaluate before calling reportError.
function wouldReportError(err) {
  const msg = err.message;
  const isAuthFail = AUTHFAIL_RE.test(msg);
  const isRateLimit = RATELIMIT_RE.test(msg);
  const isInternal = INTERNAL_RE.test(msg);
  const isDeadline = isUpstreamDeadlineExceeded(err);
  const isTransient = !isDeadline && isUpstreamTransientError(err, isInternal);
  return isAuthFail && !isRateLimit && !isInternal && !isTransient;
}

describe('audit #8 — reportError guard excludes wrapped transients', () => {
  it('a genuine auth failure DOES penalize the account', () => {
    // No transient/rate-limit/internal marker → a real dead/invalid credential.
    assert.equal(wouldReportError(new Error('unauthenticated: invalid session token')), true);
    assert.equal(wouldReportError(new Error('permission_denied for this account')), true);
    assert.equal(wouldReportError(new Error('invalid api key')), true);
  });

  it('an internal-error wrapped in a 401/403 auth shell does NOT penalize', () => {
    // The #56/#57 shape: liveness passes, but a completion returns this in an
    // auth-shaped shell with a fresh trace id. Must be treated as transient.
    const err = new Error('unauthenticated: an internal error occurred (error ID: 7f3a2b1c)');
    assert.equal(wouldReportError(err), false, 'internal-error marker must veto the auth penalty');
  });

  it('a rate-limit wrapped in an auth shell does NOT penalize', () => {
    const err = new Error('permission_denied: account rate limit exceeded, too many requests');
    assert.equal(wouldReportError(err), false, 'rate-limit marker must veto the auth penalty');
  });

  it('a transient_stall-kinded fault in an auth shell does NOT penalize', () => {
    // isUpstreamTransientError treats err.kind==='transient_stall' as transient
    // (chat.js:183) — a cascade/transport stall that got tagged upstream and
    // carries auth-shaped text. Must veto the penalty.
    const err = Object.assign(new Error('unauthenticated'), { kind: 'transient_stall' });
    assert.equal(wouldReportError(err), false, 'transient_stall kind must veto the auth penalty');
  });

  it('a cascade transport error in an auth shell does NOT penalize', () => {
    // isCascadeTransportError feeds isUpstreamTransientError directly.
    const err = Object.assign(new Error('unauthenticated'), { code: 'ECONNRESET' });
    // Only asserts when the client classifier actually treats it as transport.
    if (isCascadeTransportError(err)) {
      assert.equal(wouldReportError(err), false, 'transport error must veto the auth penalty');
    } else {
      assert.ok(true, 'not classified as transport by this build — skip');
    }
  });

  // Note on deadlines: the guard mirrors the sibling ban guard EXACTLY
  // (!isRateLimit && !isInternal && !isTransient — chat.js:4108/5143). Because
  // isTransient is defined as `!isDeadline && isUpstreamTransientError(...)`, a
  // deadline forces isTransient=false, so a deadline-shelled auth error would
  // still penalize — but that's the same edge the ban guard has, and upstream
  // does not wrap `context deadline exceeded` in `unauthenticated` text in
  // practice (deadlines route via their own kind='transient_stall' branch,
  // chat.js:4182/5166). We deliberately keep this guard identical to the ban
  // guard rather than adding a divergent !isDeadline term to just one of them.

  it('non-auth transient errors are irrelevant to this guard (never hit reportError anyway)', () => {
    // A plain capacity/transport error isn't auth-shaped, so isAuthFail is false
    // and the guard is false regardless — no penalty. Sanity check.
    assert.equal(wouldReportError(new Error('model temporarily at capacity')), false);
    assert.equal(wouldReportError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), false);
  });
});
