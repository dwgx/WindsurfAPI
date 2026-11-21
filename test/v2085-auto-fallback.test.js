// v2.0.85 — auto-fallback on rate_limit_exceeded (#126 KLFDan +
// #128 wnfilm). Tests the gating decision; the actual second-pass
// retry is exercised via the live e2e probe against the VPS.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoFallback } from '../src/handlers/chat.js';
import { cleanupOrphanLanguageServers } from '../src/langserver.js';

describe('shouldAutoFallback — gating decision', () => {
  const baseBody = { model: 'claude-opus-4-7-max', messages: [] };
  const rateLimitResult = {
    status: 429,
    body: {
      error: {
        type: 'rate_limit_exceeded',
        fallback_model: 'claude-opus-4-7-xhigh',
        message: 'all accounts rate-limited',
      },
    },
  };

  let savedEnv;
  beforeEach(() => { savedEnv = process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT;
    else process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT = savedEnv;
  });

  it('release-candidate default OFF: rate_limit + fallback_model → error, no silent swap', () => {
    delete process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT;
    assert.equal(shouldAutoFallback(baseBody, {}, rateLimitResult), false);
  });

  it('env =0 → no fallback (operator opt-out for clients that mistrust silent variant changes)', () => {
    process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT = '0';
    assert.equal(shouldAutoFallback(baseBody, {}, rateLimitResult), false);
  });

  it('env =1 (explicit on) → fallback', () => {
    process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT = '1';
    assert.equal(shouldAutoFallback(baseBody, {}, rateLimitResult), true);
  });

  it('stream request → no fallback (chunks may already be sent)', () => {
    delete process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT;
    assert.equal(shouldAutoFallback({ ...baseBody, stream: true }, {}, rateLimitResult), false);
  });

  it('already a fallback attempt → no recursive retry', () => {
    delete process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT;
    assert.equal(shouldAutoFallback(baseBody, { __fallbackAttempt: true }, rateLimitResult), false);
  });

  it('no fallback_model in error → no fallback', () => {
    delete process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT;
    const noFallback = { status: 429, body: { error: { type: 'rate_limit_exceeded' } } };
    assert.equal(shouldAutoFallback(baseBody, {}, noFallback), false);
  });

  it('non-rate-limit error → no fallback', () => {
    delete process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT;
    const otherErr = {
      status: 502,
      body: { error: { type: 'upstream_error', fallback_model: 'claude-opus-4-7-xhigh' } },
    };
    assert.equal(shouldAutoFallback(baseBody, {}, otherErr), false);
  });

  it('successful response → no fallback', () => {
    delete process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT;
    const ok = { status: 200, body: { id: 'x', choices: [] } };
    assert.equal(shouldAutoFallback(baseBody, {}, ok), false);
  });

  it('null result → no fallback (defensive)', () => {
    delete process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT;
    assert.equal(shouldAutoFallback(baseBody, {}, null), false);
    assert.equal(shouldAutoFallback(baseBody, {}, undefined), false);
  });
});

describe('cleanupOrphanLanguageServers — sanity', () => {
  it('callable, returns scanned/killed counts', () => {
    // We can't reliably reproduce orphan LS processes in CI, but the
    // function should return a result object and not throw on a host
    // with zero matching processes.
    const r = cleanupOrphanLanguageServers();
    assert.ok(r && typeof r.scanned === 'number' && typeof r.killed === 'number',
      `expected {scanned:N,killed:N}, got ${JSON.stringify(r)}`);
    assert.ok(r.scanned >= 0 && r.killed >= 0);
  });

  it('Windows skip — returns 0/0 without scanning', () => {
    // We can't fake the platform check at runtime in node:test cheaply,
    // but on win32 it's expected to short-circuit. Smoke check that the
    // function never throws regardless of host OS.
    assert.doesNotThrow(() => cleanupOrphanLanguageServers());
  });
});
