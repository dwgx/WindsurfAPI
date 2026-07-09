import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerSession, validateState, getStatus, getSession,
  completeSession, failSession, __testing,
} from '../src/dashboard/oauth-sessions.js';
import { extractOAuthToken } from '../src/dashboard/api.js';

// Public remote-onboarding: the OAuth session state machine (in-memory port of
// CLIProxyAPI's oauth_sessions) + the token extractor that lets a public deploy
// onboard without ever receiving a localhost callback (user pastes the whole
// redirect URL, server pulls the token out).

describe('oauth-sessions: state machine', () => {
  beforeEach(() => __testing.sessions.clear());

  it('issues a URL-safe state that validates and starts pending', () => {
    const s = registerSession('windsurf');
    assert.ok(validateState(s), 'issued state must pass validateState');
    assert.equal(getStatus(s).status, 'wait');
    assert.equal(getSession(s).provider, 'windsurf');
  });

  it('rejects path-traversal, oversized, and non-token states', () => {
    assert.equal(validateState('../etc/passwd'), false);
    assert.equal(validateState('a/b'), false);
    assert.equal(validateState('has space'), false);
    assert.equal(validateState('x'.repeat(129)), false);
    assert.equal(validateState(''), false);
    assert.equal(validateState(null), false);
    assert.equal(validateState('Ok_valid.State-123'), true);
  });

  it('fail -> error status with message; complete -> ok (dropped)', () => {
    const s = registerSession();
    failSession(s, 'ERR_NO_TOKEN_IN_INPUT');
    assert.deepEqual(getStatus(s), { status: 'error', error: 'ERR_NO_TOKEN_IN_INPUT' });

    const s2 = registerSession();
    completeSession(s2);
    // A consumed/unknown session reads terminal-ok so a post-success poll ends.
    assert.equal(getStatus(s2).status, 'ok');
  });

  it('unknown state reads ok (never leaks pending for a bogus state)', () => {
    assert.equal(getStatus('never-registered').status, 'ok');
  });

  it('purges expired sessions', () => {
    const s = registerSession();
    __testing.sessions.get(s).expiresAt = Date.now() - 1;
    __testing.purgeExpired();
    assert.equal(__testing.sessions.has(s), false);
  });
});

describe('extractOAuthToken', () => {
  it('pulls token from query params (token / access_token / auth_token)', () => {
    assert.equal(extractOAuthToken('https://windsurf.com/show-auth-token?token=devin-session-token$abc&state=x'), 'devin-session-token$abc');
    assert.equal(extractOAuthToken('https://x.com/cb?access_token=tok_9&foo=1'), 'tok_9');
    assert.equal(extractOAuthToken('https://x.com/cb?auth_token=at_7'), 'at_7');
  });

  it('pulls token from the #fragment (implicit flow)', () => {
    assert.equal(extractOAuthToken('https://x.com/cb#access_token=hashtok&state=y'), 'hashtok');
  });

  it('accepts a bare token paste', () => {
    assert.equal(extractOAuthToken('devin-session-token$rawpaste'), 'devin-session-token$rawpaste');
  });

  it('returns empty for junk / no token', () => {
    assert.equal(extractOAuthToken(''), '');
    assert.equal(extractOAuthToken('   '), '');
    assert.equal(extractOAuthToken('https://x.com/cb?foo=1'), '');
    assert.equal(extractOAuthToken('hello world with spaces'), '');
    assert.equal(extractOAuthToken(null), '');
  });

  // assert.throws matches a RegExp against String(error) ("Error: <msg>"), so
  // assert on err.message directly for an exact-code check.
  const msgIs = (expected) => (err) => err.message === expected;
  const msgStarts = (prefix) => (err) => err.message.startsWith(prefix);

  it('throws ERR_INTERMEDIATE_CALLBACK for a federated ?code= callback URL', () => {
    // User pasted the intermediate app.devin.ai -> windsurf.com/auth/devin/callback
    // page (has ?code=) instead of waiting for the final show-auth-token page.
    assert.throws(
      () => extractOAuthToken('https://windsurf.com/auth/devin/callback?code=7TPbmmW7abc&state=xyz&intent=show-auth-token'),
      msgIs('ERR_INTERMEDIATE_CALLBACK'),
    );
    assert.throws(
      () => extractOAuthToken('https://windsurf.com/auth/google/callback?code=abc&state=xyz'),
      msgIs('ERR_INTERMEDIATE_CALLBACK'),
    );
  });

  it('does NOT treat a bare ?code= (no /auth/*/callback path) as intermediate', () => {
    // A code param on some unrelated path is not our federated callback shape —
    // there is simply no token, so return '' (generic "no token" handling).
    assert.equal(extractOAuthToken('https://x.com/random?code=abc'), '');
  });

  it('prefers an actual token over the intermediate-callback diagnostic', () => {
    // If the callback URL somehow also carries a real token, hand back the token
    // rather than throwing.
    assert.equal(
      extractOAuthToken('https://windsurf.com/auth/devin/callback?code=abc&token=devin-session-token$real'),
      'devin-session-token$real',
    );
  });

  it('throws ERR_OAUTH_UPSTREAM:<error> for a provider error redirect', () => {
    assert.throws(
      () => extractOAuthToken('https://windsurf.com/auth/devin/callback?error=access_denied&state=xyz'),
      msgIs('ERR_OAUTH_UPSTREAM:access_denied'),
    );
  });

  it('includes error_description in the upstream error when present', () => {
    assert.throws(
      () => extractOAuthToken('https://x.com/cb?error=server_error&error_description=upstream+down'),
      msgIs('ERR_OAUTH_UPSTREAM:server_error:upstream down'),
    );
  });

  it('surfaces an error carried in the #fragment (implicit flow)', () => {
    assert.throws(
      () => extractOAuthToken('https://x.com/cb#error=access_denied'),
      msgStarts('ERR_OAUTH_UPSTREAM:access_denied'),
    );
  });

  it('prefers upstream error over intermediate-callback when both apply', () => {
    // error= wins over code= — the real failure reason is more actionable.
    assert.throws(
      () => extractOAuthToken('https://windsurf.com/auth/devin/callback?code=abc&error=access_denied'),
      msgIs('ERR_OAUTH_UPSTREAM:access_denied'),
    );
  });
});
