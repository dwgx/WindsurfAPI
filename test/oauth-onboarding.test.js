import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractOAuthToken, handleDashboardApi } from '../src/dashboard/api.js';
import { config } from '../src/config.js';
import { getAccountCount } from '../src/auth.js';

describe('retired browser account onboarding', () => {
  async function call(method, path, body, password) {
    const req = {
      url: '/dashboard/api' + path,
      headers: { 'content-type': 'application/json', ...(password ? { 'x-dashboard-password': password } : {}) },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const response = {};
    const res = {
      setHeader() {},
      writeHead(status, headers) { Object.assign(response, { status, headers }); return this; },
      end(payload) { response.body = JSON.parse(payload); },
    };
    await handleDashboardApi(method, path.split('?')[0], body, req, res);
    return response;
  }

  it('requires dashboard authentication before revealing retired route status', async () => {
    const password = config.dashboardPassword;
    config.dashboardPassword = 'synthetic-dashboard-fixture';
    try {
      const response = await call('POST', '/oauth/start', {});
      assert.equal(response.status, 401);
      assert.equal(response.body.url, undefined);
    } finally {
      config.dashboardPassword = password;
    }
  });

  it('never issues a stale sign-in URL, consumes a callback or reports success', async () => {
    const password = config.dashboardPassword;
    config.dashboardPassword = 'synthetic-dashboard-fixture';
    const state = 'stale-browser-flow-fixture';
    const secret = 'synthetic-callback-fixture';
    const callback = { state, redirect_url: 'https://example.test/callback?code=' + secret };
    const before = getAccountCount();
    try {
      const attempts = [
        ['POST', '/oauth/start', { state }],
        ['POST', '/oauth/callback', callback],
        ['POST', '/oauth/callback', callback],
        ['GET', '/oauth/status?state=' + state, {}],
        ['GET', '/oauth/status?state=cancelled-fixture', {}],
        ['GET', '/oauth/status?state=expired-fixture', {}],
      ];
      const responses = await Promise.all(attempts.map(args => call(...args, config.dashboardPassword)));
      for (const response of responses) {
        assert.equal(response.status, 410);
        assert.equal(response.headers['Cache-Control'], 'no-store');
        assert.deepEqual(response.body, { error: 'ERR_BROWSER_ENROLLMENT_UNAVAILABLE', success: false });
        assert.doesNotMatch(JSON.stringify(response), new RegExp(state + '|' + secret));
      }
      assert.deepEqual(getAccountCount(), before);
    } finally {
      config.dashboardPassword = password;
    }
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
