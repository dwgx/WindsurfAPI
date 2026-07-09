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
});
