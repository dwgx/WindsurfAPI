// UPSTREAM_INTERNAL — "an internal error occurred (trace ID/error ID: ...)" is a
// TRANSIENT upstream backend fault, NOT a dead session token, even when wrapped
// in a 401/403 auth shell. Discovered live (free account <redacted>):
// GetUserStatus + liveness both pass while completions return this 3/3 with
// fresh trace IDs. Misclassifying it as UNAUTHORIZED would re-login a live token
// and risk #56/#57-style escalation to permanent MODEL_BLOCKED.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUpstreamError, isRetryable } from '../src/devin-connect.js';
import { connectErrorToHttp } from '../src/handlers/chat.js';

describe('classifyUpstreamError — internal-error class', () => {
  it('classifies "trace ID" internal error as UPSTREAM_INTERNAL, not UNAUTHORIZED', () => {
    const msg = 'an internal error occurred (trace ID: dd6dd0c0b57db14a3f72d92b307af800)';
    assert.equal(classifyUpstreamError(msg, null, 500).code, 'UPSTREAM_INTERNAL');
  });

  it('classifies "error ID" internal error the same way', () => {
    const msg = 'an internal error occurred (error ID: abc123)';
    assert.equal(classifyUpstreamError(msg, null, 500).code, 'UPSTREAM_INTERNAL');
  });

  it('wins over the 401/403 auth shell (the dangerous case)', () => {
    const msg = 'an internal error occurred (trace ID: abc)';
    // The upstream wraps the transient backend fault in an auth status. The
    // body must take precedence so it does NOT read as a dead token.
    assert.equal(classifyUpstreamError(msg, null, 401).code, 'UPSTREAM_INTERNAL');
    assert.equal(classifyUpstreamError(msg, null, 403).code, 'UPSTREAM_INTERNAL');
  });

  it('still classifies a genuine auth failure as UNAUTHORIZED', () => {
    // No internal-error body → a real 401/unauthenticated is still a dead token.
    assert.equal(classifyUpstreamError('unauthenticated', null, 401).code, 'UNAUTHORIZED');
    assert.equal(classifyUpstreamError('invalid token', null, 403).code, 'UNAUTHORIZED');
  });

  it('does not let CAPACITY regress (high-demand stays CAPACITY)', () => {
    const msg = "We're currently facing high demand for this model. Please try again later.";
    assert.equal(classifyUpstreamError(msg, null, 401).code, 'CAPACITY');
  });

  it('is NOT in-process retryable (persistent backend faults amplify load — #35)', () => {
    // UPSTREAM_INTERNAL was observed persistent 3/3; same-token retry would just
    // triple the load. Pool-level cooldown + failover handle it instead.
    assert.equal(isRetryable({ code: 'UPSTREAM_INTERNAL' }), false);
  });

  it('stays non-retryable even when delivered as a genuine 5xx (audit F4)', () => {
    // The 5xx status branch must not re-admit it past the code-level exclusion.
    assert.equal(isRetryable({ code: 'UPSTREAM_INTERNAL', status: 500 }), false);
    assert.equal(isRetryable({ code: 'UPSTREAM_INTERNAL', status: 503 }), false);
  });
});

describe('classifyUpstreamError — widened transient vocabulary (audit F2)', () => {
  for (const body of [
    'service unavailable',
    'backend unavailable',
    'the model is temporarily unavailable',
    'server overloaded',
  ]) {
    it(`"${body}" in a 401 shell → CAPACITY, not UNAUTHORIZED`, () => {
      assert.equal(classifyUpstreamError(body, null, 401).code, 'CAPACITY');
    });
  }

  it('upstream code "unavailable" → CAPACITY even with empty body', () => {
    assert.equal(classifyUpstreamError('', 'unavailable', 503).code, 'CAPACITY');
  });

  it('upstream code "resource_exhausted" on the non-200 path → RATE_LIMITED', () => {
    // F2: the non-200 path now forwards the upstream code instead of dropping it.
    assert.equal(classifyUpstreamError('quota', 'resource_exhausted', 429).code, 'RATE_LIMITED');
  });
});

describe('classifyUpstreamError — transient-before-permanent ordering (audit F1)', () => {
  it('gRPC code "internal" (permanent client mistake) → UPSTREAM_ERROR, not retryable', () => {
    // Distinct from the transient "internal error occurred" body.
    const r = classifyUpstreamError('bad request', 'internal', 500);
    assert.equal(r.code, 'UPSTREAM_ERROR');
    assert.equal(isRetryable({ code: r.code, status: 500 }), true); // 5xx status still transient at transport level
  });

  it('a transient body that also mentions a tier word is not pre-empted to MODEL_BLOCKED', () => {
    // "high demand ... requires retry" must classify CAPACITY (transient-first),
    // not MODEL_BLOCKED via the greedy "requires .*" tier-wall regex.
    const body = 'high demand for this model, requires the team to try again later';
    assert.equal(classifyUpstreamError(body, null, 401).code, 'CAPACITY');
  });

  it('a genuine /upgrade tier wall still classifies MODEL_BLOCKED', () => {
    assert.equal(classifyUpstreamError('please /upgrade to access this model', null, 402).code, 'MODEL_BLOCKED');
  });

  it('a genuine out-of-credit body still classifies QUOTA_EXHAUSTED', () => {
    assert.equal(classifyUpstreamError('insufficient credit balance', null, 402).code, 'QUOTA_EXHAUSTED');
  });
});

describe('connectErrorToHttp — UPSTREAM_INTERNAL mapping', () => {
  it('maps to 503 upstream_transient_error (client retry-after, not auth)', () => {
    assert.deepEqual(connectErrorToHttp('UPSTREAM_INTERNAL'), {
      status: 503, type: 'upstream_transient_error',
    });
  });

  it('UNAUTHORIZED still maps to 401 authentication_error', () => {
    assert.deepEqual(connectErrorToHttp('UNAUTHORIZED'), {
      status: 401, type: 'authentication_error',
    });
  });
});
