// v2.0.56 — runtime-config credentials persistence + scrypt verify.
// Covers the new helpers in src/runtime-config.js:
//   - hashPassword / verifyPassword (scrypt)
//   - setRuntimeApiKey / setRuntimeDashboardPassword
//   - getEffectiveApiKey / getEffectiveDashboardPasswordStored
//
// We don't write real files — instead we exercise the in-memory state
// after each setter and snap the round-trip via verifyPassword on the
// returned hash format.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  setRuntimeApiKey,
  setRuntimeDashboardPassword,
  getCredentials,
  getEffectiveApiKey,
  getEffectiveDashboardPasswordStored,
} from '../src/runtime-config.js';
import { config } from '../src/config.js';

const original = {
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
};

beforeEach(() => {
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  config.apiKey = original.apiKey;
  config.dashboardPassword = original.dashboardPassword;
});

afterEach(() => {
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  config.apiKey = original.apiKey;
  config.dashboardPassword = original.dashboardPassword;
});

describe('hashPassword + verifyPassword (scrypt)', () => {
  it('hash format is `scrypt$N$r$p$salt$hash`', () => {
    const h = hashPassword('correct-horse-battery-staple');
    const parts = h.split('$');
    assert.equal(parts[0], 'scrypt');
    assert.equal(parts.length, 6);
    assert.ok(parseInt(parts[1], 10) > 0, 'N must be positive int');
    assert.ok(parts[4].length > 0, 'salt must be non-empty');
    assert.ok(parts[5].length > 0, 'hash must be non-empty');
  });

  it('round-trips: verify(plain, hash(plain)) === true', () => {
    const h = hashPassword('mypassword');
    assert.equal(verifyPassword('mypassword', h), true);
  });

  it('verify rejects wrong password', () => {
    const h = hashPassword('mypassword');
    assert.equal(verifyPassword('wrongpassword', h), false);
    assert.equal(verifyPassword('', h), false);
    assert.equal(verifyPassword('mypassword2', h), false);
  });

  it('verify falls back to plaintext compare when stored has no scrypt prefix', () => {
    // env-supplied `DASHBOARD_PASSWORD=plain` takes this branch.
    assert.equal(verifyPassword('hello', 'hello'), true);
    assert.equal(verifyPassword('hello', 'world'), false);
    assert.equal(verifyPassword('', ''), false);
    assert.equal(verifyPassword('hello', ''), false);
  });

  it('verify rejects malformed hash strings', () => {
    assert.equal(verifyPassword('x', 'scrypt$bad'), false);
    assert.equal(verifyPassword('x', 'scrypt$1$2$3$4'), false); // only 5 parts
    assert.equal(verifyPassword('x', null), false);
    assert.equal(verifyPassword('x', undefined), false);
    assert.equal(verifyPassword('x', 123), false);
  });

  it('different salts produce different hashes for the same password', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    assert.notEqual(a, b, 'salt randomness must produce distinct outputs');
    assert.equal(verifyPassword('same', a), true);
    assert.equal(verifyPassword('same', b), true);
  });
});

describe('setRuntimeApiKey / getEffectiveApiKey', () => {
  it('runtime override wins over config.apiKey', () => {
    config.apiKey = 'env-key';
    setRuntimeApiKey('runtime-key');
    assert.equal(getEffectiveApiKey(), 'runtime-key');
  });

  it('empty runtime falls back to env', () => {
    config.apiKey = 'env-key';
    setRuntimeApiKey('');
    assert.equal(getEffectiveApiKey(), 'env-key');
  });

  it('both empty → empty string', () => {
    config.apiKey = '';
    setRuntimeApiKey('');
    assert.equal(getEffectiveApiKey(), '');
  });

  it('whitespace-only input is normalised to empty', () => {
    setRuntimeApiKey('   ');
    assert.equal(getCredentials().apiKey, '');
  });
});

describe('setRuntimeDashboardPassword / getEffectiveDashboardPasswordStored', () => {
  it('runtime password is stored as scrypt hash', () => {
    setRuntimeDashboardPassword('newpassword');
    const stored = getEffectiveDashboardPasswordStored();
    assert.ok(stored.startsWith('scrypt$'), `expected scrypt$ prefix, got ${stored.slice(0, 20)}`);
    assert.equal(verifyPassword('newpassword', stored), true);
    assert.equal(verifyPassword('wrong', stored), false);
  });

  it('runtime override wins over env plaintext password', () => {
    config.dashboardPassword = 'env-password';
    setRuntimeDashboardPassword('runtime-password');
    const stored = getEffectiveDashboardPasswordStored();
    // verifyPassword on the runtime hash must accept runtime-password
    assert.equal(verifyPassword('runtime-password', stored), true);
    // but reject the env one
    assert.equal(verifyPassword('env-password', stored), false);
  });

  it('clearing runtime falls back to env plaintext', () => {
    config.dashboardPassword = 'env-password';
    setRuntimeDashboardPassword('runtime-password');
    setRuntimeDashboardPassword('');
    const stored = getEffectiveDashboardPasswordStored();
    assert.equal(stored, 'env-password');
    assert.equal(verifyPassword('env-password', stored), true);
  });
});
