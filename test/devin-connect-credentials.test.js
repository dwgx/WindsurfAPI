import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import {
  getCredKey, isCredStoreEnabled,
  storeCredential, getCredential, hasCredential, deleteCredential,
  listCredentialEmails, __testing,
} from '../src/devin-connect-credentials.js';

// Each test gets an isolated cred file + key via a synthetic env object.
let dir;
function mkEnv(key = 'test-master-key-123') {
  return { DEVIN_CONNECT_CRED_KEY: key, DEVIN_CONNECT_CRED_FILE: join(dir, 'creds.json') };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wsapi-cred-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('credential store — gating', () => {
  it('is disabled when no master key is set', () => {
    assert.equal(isCredStoreEnabled({}), false);
    assert.equal(getCredKey({}), '');
    assert.equal(storeCredential('a@b.com', 'pw', {}), false);
    assert.equal(getCredential('a@b.com', {}), null);
    assert.equal(hasCredential('a@b.com', {}), false);
    assert.deepEqual(listCredentialEmails({}), []);
  });
  it('is enabled when a master key is present', () => {
    assert.equal(isCredStoreEnabled(mkEnv()), true);
  });
});

describe('credential store — roundtrip', () => {
  it('encrypts then decrypts back to the original password', () => {
    const env = mkEnv();
    assert.equal(storeCredential('User@Example.com', 's3cret-pw!', env), true);
    assert.equal(getCredential('user@example.com', env), 's3cret-pw!', 'email is case-insensitive');
    assert.equal(hasCredential('USER@EXAMPLE.COM', env), true);
    assert.deepEqual(listCredentialEmails(env), ['user@example.com']);
  });

  it('never persists the plaintext password on disk', () => {
    const env = mkEnv();
    storeCredential('a@b.com', 'PLAINTEXT_SENTINEL', env);
    const raw = readFileSync(join(dir, 'creds.json'), 'utf8');
    assert.ok(!raw.includes('PLAINTEXT_SENTINEL'), 'ciphertext must not contain the password');
    const rec = JSON.parse(raw).records['a@b.com'];
    assert.ok(rec.salt && rec.iv && rec.tag && rec.ct, 'has salt/iv/tag/ct');
  });

  it('produces different ciphertext for the same password (random salt+iv)', () => {
    const env = mkEnv();
    storeCredential('a@b.com', 'samepw', env);
    const ct1 = JSON.parse(readFileSync(join(dir, 'creds.json'), 'utf8')).records['a@b.com'].ct;
    storeCredential('a@b.com', 'samepw', env);
    const ct2 = JSON.parse(readFileSync(join(dir, 'creds.json'), 'utf8')).records['a@b.com'].ct;
    assert.notEqual(ct1, ct2);
    assert.equal(getCredential('a@b.com', env), 'samepw');
  });

  it('returns null for an unknown email', () => {
    assert.equal(getCredential('nobody@x.com', mkEnv()), null);
  });

  it('deletes a stored credential', () => {
    const env = mkEnv();
    storeCredential('a@b.com', 'pw', env);
    assert.equal(deleteCredential('a@b.com', env), true);
    assert.equal(hasCredential('a@b.com', env), false);
    assert.equal(deleteCredential('a@b.com', env), false, 'second delete is a no-op');
  });
});

describe('credential store — tamper / wrong key', () => {
  it('throws (fails closed) when decrypting with a different master key', () => {
    storeCredential('a@b.com', 'pw', mkEnv('key-one'));
    assert.throws(
      () => getCredential('a@b.com', { DEVIN_CONNECT_CRED_KEY: 'key-two', DEVIN_CONNECT_CRED_FILE: join(dir, 'creds.json') }),
      /unable to authenticate|bad decrypt|auth/i,
    );
  });

  it('throws when the ciphertext is tampered with', () => {
    const env = mkEnv();
    storeCredential('a@b.com', 'pw', env);
    const file = join(dir, 'creds.json');
    const store = JSON.parse(readFileSync(file, 'utf8'));
    // Flip a hex nibble in the ciphertext.
    const ct = store.records['a@b.com'].ct;
    store.records['a@b.com'].ct = (ct[0] === 'a' ? 'b' : 'a') + ct.slice(1);
    writeFileSync(file, JSON.stringify(store));
    assert.throws(() => getCredential('a@b.com', env), /auth|decrypt/i);
  });

  it('requires email and password to store', () => {
    const env = mkEnv();
    assert.throws(() => storeCredential('', 'pw', env), /required/);
    assert.throws(() => storeCredential('a@b.com', '', env), /required/);
  });
});

describe('credential store — derived key', () => {
  it('derives a 32-byte AES-256 key', () => {
    const k = __testing.deriveKey('master', Buffer.from('0123456789abcdef'));
    assert.equal(k.length, 32);
  });
});
