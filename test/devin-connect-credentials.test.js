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

describe('credential store — corruption resilience (C6)', () => {
  // Seed two real records, then corrupt the file in different ways and assert
  // the resilient reader still recovers the intact credentials. A single bad
  // byte must NOT wipe the whole fleet's relogin credentials.
  function seedTwo(env) {
    storeCredential('alice@example.com', 'alice-pw', env);
    storeCredential('bob@example.com', 'bob-pw', env);
  }

  it('recovers complete records from a file truncated mid-write', () => {
    const env = mkEnv();
    seedTwo(env);
    const file = join(dir, 'creds.json');
    const raw = readFileSync(file, 'utf8');
    // Simulate a crash mid-write: chop the file partway through the 2nd record.
    // The truncation leaves an unterminated string + unbalanced braces, so JSON
    // repair can't help — per-record salvage (tier 3) recovers alice intact.
    const cut = raw.indexOf('bob@example.com') + 30;
    writeFileSync(file, raw.slice(0, cut));
    // alice's record is complete and must survive; bob's was truncated.
    assert.equal(getCredential('alice@example.com', env), 'alice-pw');
    // Self-heal: the file is now clean JSON again on re-read.
    const healed = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(healed.records['alice@example.com']);
  });

  it('tier 2: strips a UTF-8 BOM and a trailing comma', () => {
    const env = mkEnv();
    storeCredential('alice@example.com', 'alice-pw', env);
    const file = join(dir, 'creds.json');
    const raw = readFileSync(file, 'utf8');
    // Prepend a BOM and inject a trailing comma before the final brace.
    const broken = '﻿' + raw.replace(/\}\s*\}\s*$/, '},}');
    writeFileSync(file, broken);
    assert.equal(getCredential('alice@example.com', env), 'alice-pw');
  });

  it('tier 3: regex-salvages intact records when the JSON wrapper is unrepairable', () => {
    const env = mkEnv();
    seedTwo(env);
    const file = join(dir, 'creds.json');
    const raw = readFileSync(file, 'utf8');
    // Mangle the wrapper beyond JSON repair (garbage prefix + broken structure)
    // but leave both record bodies textually intact.
    const broken = 'GARBAGE!!!{{{ not json at all \n' + raw.replace(/^\s*\{/, '');
    writeFileSync(file, broken);
    // Both records' { salt, iv, tag, ct } blobs are intact → both recover.
    assert.equal(getCredential('alice@example.com', env), 'alice-pw');
    assert.equal(getCredential('bob@example.com', env), 'bob-pw');
  });

  it('tier 3: drops only the mangled record, keeps the rest', () => {
    const env = mkEnv();
    seedTwo(env);
    const file = join(dir, 'creds.json');
    const raw = readFileSync(file, 'utf8');
    // Corrupt bob's ct field (odd-out hex) and break the wrapper so we hit tier 3.
    let broken = raw.replace(/("bob@example\.com"\s*:\s*\{[^}]*"ct"\s*:\s*")[0-9a-f]+/, '$1ZZZ_not_hex');
    broken = 'noise\n' + broken.replace(/^\s*\{/, '');
    writeFileSync(file, broken);
    assert.equal(getCredential('alice@example.com', env), 'alice-pw', 'intact record survives');
    assert.equal(hasCredential('bob@example.com', env), false, 'mangled record is dropped, not poisoning the store');
  });

  it('tryRepairJson fixes a trailing comma and tail garbage; returns null when hopeless', () => {
    const good = '{ "v": 1, "records": { "a@x.com": { "salt": "aa", "iv": "bb", "tag": "cc", "ct": "dd" } }, }';
    const repaired = __testing.tryRepairJson(good);
    assert.ok(repaired && repaired.records['a@x.com'], 'trailing comma repaired (tier 2)');
    // Trailing garbage after the last brace is dropped.
    assert.ok(__testing.tryRepairJson('{ "v": 1, "records": {} } GARBAGE TAIL'), 'tail after last brace dropped');
    // No closing brace at all → unrepairable (caller falls through to tier 3).
    assert.equal(__testing.tryRepairJson('{ "records": { "a": '), null);
  });

  it('salvageRecordsByRegex validates hex shape and skips wrapper keys', () => {
    const text = `{ "v": 1, "records": {
      "good@x.com": { "salt": "aa", "iv": "bb", "tag": "cc", "ct": "dd" },
      "bad@x.com": { "salt": "nothex", "iv": "bb", "tag": "cc", "ct": "dd" }
    } }`;
    const out = __testing.salvageRecordsByRegex(text);
    assert.ok(out['good@x.com']);
    assert.equal(out['bad@x.com'], undefined, 'non-hex field rejected');
    assert.equal(out['records'], undefined, 'wrapper key never treated as a record');
    assert.equal(out['v'], undefined);
  });

  it('an unrecoverable empty file reads as an empty store (no throw)', () => {
    const env = mkEnv();
    writeFileSync(join(dir, 'creds.json'), 'totally unparseable @@@@ no records here');
    assert.deepEqual(listCredentialEmails(env), []);
  });
});
