import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost, _resetLockoutForTests } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { isLoopbackAddress } from '../src/dashboard/local-windsurf.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const originalAllowNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;

afterEach(() => {
  _resetLockoutForTests();
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('127.0.0.1');
  if (originalAllowNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = originalAllowNoAuth;
});

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

describe('isLoopbackAddress (high-risk address parsing)', () => {
  it('accepts bracketed IPv6 and mapped IPv6 variants', () => {
    assert.equal(isLoopbackAddress('[::1]'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::ffff:7f00:1'), true);
  });

  it('rejects URL-encoded public-looking loopback candidates', () => {
    assert.equal(isLoopbackAddress('%3a%3a1'), false);
    assert.equal(isLoopbackAddress('7f%00:1'), false);
  });
});

describe('GET /accounts/import-local (security posture)', () => {
  it('rejects public binds even when dashboard secret is provided', async () => {
    _resetLockoutForTests();
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    config.dashboardPassword = 'dash-secret';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi(
      'GET',
      '/accounts/import-local',
      {},
      { headers: { 'x-dashboard-password': 'dash-secret' }, socket: { remoteAddress: '127.0.0.1' } },
      res
    );

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'ERR_LOCAL_IMPORT_NOT_AVAILABLE_PUBLIC_BIND');
  });

  it('rejects remote callers that are not loopback on local binds', async () => {
    _resetLockoutForTests();
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');
    // audit #1: DASHBOARD_ALLOW_NO_AUTH=1 is "open LOCAL", now peer-gated to
    // loopback. A non-loopback remote caller is rejected at the AUTH layer (401)
    // BEFORE reaching the endpoint's own loopback guard — a tighter, earlier
    // rejection. (Previously the remote peer passed ambient auth and hit the
    // endpoint's 403 ERR_LOCAL_IMPORT_LOOPBACK_ONLY; both reject the caller, but
    // fail-closing at auth is strictly safer.)
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';

    const res = fakeRes();
    await handleDashboardApi(
      'GET',
      '/accounts/import-local',
      {},
      { headers: {}, socket: { remoteAddress: '192.168.1.10' } },
      res
    );

    assert.equal(res.statusCode, 401, 'remote peer rejected at auth layer (open-local is loopback-only)');
  });

  it('does not leak absolute paths in discovery metadata', async () => {
    _resetLockoutForTests();
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');
    // AUTH-1: this case tests the discovery metadata shape, not auth; it used
    // localhost-open as a convenience. Opt in so ambient auth passes.
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';

    const res = fakeRes();
    await handleDashboardApi(
      'GET',
      '/accounts/import-local',
      {},
      { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res
    );

    const r = res.json();
    assert.equal(Array.isArray(r.sources), true);
    for (const s of r.sources) {
      assert.equal(typeof s.path, 'string');
      assert.equal(/[/\\]/.test(s.path), false, `path leaked: ${s.path}`);
    }
  });
});
