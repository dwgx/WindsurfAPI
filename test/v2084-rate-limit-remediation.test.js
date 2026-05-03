// v2.0.84 — rate-limit error remediation (#118 0a00).
//
// When all 31 trial accounts hit a per-(account,model) rate-limit on
// `claude-opus-4-7-max`, daily quota at 100% but every account is
// burning a 26-29 minute upstream cooldown. The 429 the client sees
// should suggest a same-base lower-effort variant (medium / high) so
// the user can switch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickRateLimitFallback } from '../src/models.js';

describe('pickRateLimitFallback — effort-ladder downgrade', () => {
  it('claude-opus-4-7-max → claude-opus-4-7-xhigh', () => {
    assert.equal(pickRateLimitFallback('claude-opus-4-7-max'), 'claude-opus-4-7-xhigh');
  });

  it('claude-opus-4-7-xhigh → claude-opus-4-7-high', () => {
    assert.equal(pickRateLimitFallback('claude-opus-4-7-xhigh'), 'claude-opus-4-7-high');
  });

  it('claude-opus-4-7-high → claude-opus-4-7-medium', () => {
    assert.equal(pickRateLimitFallback('claude-opus-4-7-high'), 'claude-opus-4-7-medium');
  });

  it('claude-opus-4-7-medium → claude-opus-4-7-low', () => {
    assert.equal(pickRateLimitFallback('claude-opus-4-7-medium'), 'claude-opus-4-7-low');
  });

  it('claude-opus-4-7-low has no lower variant → null', () => {
    assert.equal(pickRateLimitFallback('claude-opus-4-7-low'), null);
  });

  it('1m context variant drops the suffix when sibling exists', () => {
    assert.equal(pickRateLimitFallback('claude-sonnet-4.6-1m'), 'claude-sonnet-4.6');
    assert.equal(pickRateLimitFallback('claude-sonnet-4.6-thinking-1m'), 'claude-sonnet-4.6-thinking');
  });

  it('-thinking variants stay as-is (different behaviour, not a fallback)', () => {
    // Auto-fallback would silently drop reasoning content — caller
    // explicitly asked for thinking, don't second-guess them.
    assert.equal(pickRateLimitFallback('claude-sonnet-4.6-thinking'), null);
  });

  it('claude-sonnet-4.6 (no effort suffix) → null', () => {
    // Already a daily-quota baseline, nothing to fall back to.
    assert.equal(pickRateLimitFallback('claude-sonnet-4.6'), null);
  });

  it('claude-haiku-4.5 → null (no effort tiers)', () => {
    assert.equal(pickRateLimitFallback('claude-haiku-4.5'), null);
  });

  it('null / non-string returns null', () => {
    assert.equal(pickRateLimitFallback(null), null);
    assert.equal(pickRateLimitFallback(''), null);
    assert.equal(pickRateLimitFallback(undefined), null);
  });

  it('unknown model returns null (no catalog match)', () => {
    assert.equal(pickRateLimitFallback('made-up-model-xhigh'), null);
  });
});
