import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  addAccountByKey,
  configureBindHost,
  getAccountInternal,
  getAccountList,
  getAccountListStats,
  maskApiKey,
  removeAccount,
  reportError,
  reportSuccess,
  shouldEmitNoAuthWarning,
  validateApiKey,
} from '../src/auth.js';

const originalApiKey = config.apiKey;
const createdAccountIds = [];

afterEach(() => {
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
});

describe('shouldEmitNoAuthWarning', () => {
  it('warns when unauthenticated service binds all interfaces', () => {
    assert.equal(shouldEmitNoAuthWarning('0.0.0.0', false), true);
    assert.equal(shouldEmitNoAuthWarning('::', false), true);
  });

  it('does not warn for localhost or configured auth', () => {
    assert.equal(shouldEmitNoAuthWarning('127.0.0.1', false), false);
    assert.equal(shouldEmitNoAuthWarning('0.0.0.0', true), false);
  });

  it('missing API_KEY fails closed by default; opt-in allows it only on local binds (M1)', () => {
    config.apiKey = '';
    // Default (no opt-in): fail closed even on a local bind — "local bind" is
    // not "no proxy" (same-host reverse proxy makes every peer look loopback).
    delete process.env.WINDSURFAPI_ALLOW_UNAUTHENTICATED;
    configureBindHost('127.0.0.1');
    assert.equal(validateApiKey(''), false);

    // Opt-in: allowed, but ONLY on a local bind.
    process.env.WINDSURFAPI_ALLOW_UNAUTHENTICATED = '1';
    configureBindHost('127.0.0.1');
    assert.equal(validateApiKey(''), true);
    configureBindHost('::1');
    assert.equal(validateApiKey(''), true);
    configureBindHost('[::1]');
    assert.equal(validateApiKey(''), true);
    configureBindHost('::ffff:127.0.0.1');
    assert.equal(validateApiKey(''), true);
    // Empty bindHost is "didn't configure / Node defaults to all interfaces"
    // which is non-local. Must fail closed even with opt-in.
    configureBindHost('');
    assert.equal(validateApiKey(''), false);

    configureBindHost('0.0.0.0');
    assert.equal(validateApiKey(''), false);
    configureBindHost('192.168.1.10');
    assert.equal(validateApiKey('anything'), false);
    delete process.env.WINDSURFAPI_ALLOW_UNAUTHENTICATED;
  });

  it('compares configured API_KEY without default-allowing missing or wrong keys', () => {
    config.apiKey = 'server-secret';
    configureBindHost('0.0.0.0');

    assert.equal(validateApiKey('server-secret'), true);
    assert.equal(validateApiKey('wrong'), false);
    assert.equal(validateApiKey(''), false);
  });

  it('returns masked account keys without the raw upstream apiKey', () => {
    const key = `abcd1234efgh5678-${Date.now()}`;
    const account = addAccountByKey(key, 'masked-list');
    createdAccountIds.push(account.id);

    const listed = getAccountList().find(a => a.id === account.id);
    assert.equal(listed.apiKey, undefined);
    assert.equal(listed.apiKey_masked, `${key.slice(0, 8)}...${key.slice(-4)}`);
    assert.equal(listed.keyPrefix, 'abcd1234...');
  });

  it('counts flagged, rate-limited, and disabled accounts in one stats view', () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const active = addAccountByKey(`active-${suffix}`, 'active');
    const errored = addAccountByKey(`errored-${suffix}`, 'errored');
    const limited = addAccountByKey(`limited-${suffix}`, 'limited');
    const disabled = addAccountByKey(`disabled-${suffix}`, 'disabled');
    createdAccountIds.push(active.id, errored.id, limited.id, disabled.id);

    getAccountInternal(errored.id).errorCount = 1;
    getAccountInternal(limited.id).rateLimitedUntil = Date.now() + 60_000;
    getAccountInternal(disabled.id).status = 'disabled';

    const stats = getAccountListStats();
    assert.ok(stats.total >= 4);
    assert.ok(stats.flagged >= 2);
    assert.ok(stats.rateLimited >= 1);
    assert.ok(stats.disabled >= 1);
  });
});

describe('reportError — time-windowed auth-failure streak', () => {
  it('does not disable a key when 3 failures are spread beyond the window', () => {
    const key = `err-spread-${Date.now()}-${Math.random()}`;
    const account = addAccountByKey(key, 'err-spread');
    createdAccountIds.push(account.id);

    // Three failures, each older than the window relative to the next: the
    // streak resets every time, so the account stays active (transient blips
    // during separate Windsurf deploys must not kill a healthy key).
    reportError(key, { windowMs: 1 });
    const internal = getAccountInternal(account.id);
    internal._errorAt = Date.now() - 10; // age the last failure past windowMs
    reportError(key, { windowMs: 1 });
    internal._errorAt = Date.now() - 10;
    reportError(key, { windowMs: 1 });

    assert.equal(internal.errorCount, 1);
    assert.notEqual(internal.status, 'error');
  });

  it('disables a key after 3 failures inside the window, and success rehabilitates', () => {
    // A healthy peer so the key under test isn't the pool's last usable account
    // (the LB last-account exemption keeps a sole account active by design).
    const peer = addAccountByKey(`err-burst-peer-${Date.now()}-${Math.random()}`, 'err-burst-peer');
    createdAccountIds.push(peer.id);
    reportSuccess(peer.apiKey);
    const key = `err-burst-${Date.now()}-${Math.random()}`;
    const account = addAccountByKey(key, 'err-burst');
    createdAccountIds.push(account.id);

    reportError(key);
    reportError(key);
    reportError(key);
    const internal = getAccountInternal(account.id);
    assert.equal(internal.errorCount, 3);
    assert.equal(internal.status, 'error');

    // A later success clears the streak and reactivates the account.
    reportSuccess(key);
    assert.equal(internal.errorCount, 0);
    assert.equal(internal.status, 'active');
  });
});

describe('S6-F1: maskApiKey never exposes more than ~25% of a short key', () => {
  it('scales the visible prefix with key length', () => {
    assert.equal(maskApiKey('12345678'), '12...', 'the 8-char floor key used to leak half its entropy');
    assert.equal(maskApiKey('123456789'), '123...');
    assert.equal(maskApiKey('123456789012'), '123...');
    assert.equal(maskApiKey('1234567890123'), '12345678...0123');
    assert.equal(maskApiKey('sk-ant-very-long-key-abcdef'), 'sk-ant-v...cdef');
    assert.equal(maskApiKey(''), '');
  });

  it('keyPrefix on a listed account is bounded the same way', () => {
    const account = addAccountByKey('abcdefgh', 'short-prefix');
    createdAccountIds.push(account.id);
    const listed = getAccountList().find((a) => a.id === account.id);
    assert.equal(listed.keyPrefix, 'ab...', '8-char key must not render all 8 chars as its "prefix"');
  });
});
