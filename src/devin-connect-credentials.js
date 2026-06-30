/**
 * DEVIN_CONNECT credential store — encrypted email/password at rest.
 *
 * WHY THIS EXISTS: the DEVIN_CONNECT session token (account.apiKey,
 * `devin-session-token$<JWT>`) is an opaque server-side session_id with NO
 * expiry claim and NO refresh path (Auth1 login returns hasRefresh:false). When
 * the server retires that session_id, the account goes permanently 'error' with
 * no recovery — a single point of failure for the whole DEVIN_CONNECT surface.
 *
 * The ONLY way to mint a fresh session token is a full email/password Auth1
 * login (windsurfLogin). So to auto-recover, we must hold the password. This
 * module keeps those credentials encrypted at rest with AES-256-GCM under a key
 * derived from the operator-supplied DEVIN_CONNECT_CRED_KEY.
 *
 * SECURITY POSTURE:
 *   - OFF by default: no DEVIN_CONNECT_CRED_KEY → store is disabled, nothing is
 *     written or read. Auto-relogin simply never triggers.
 *   - Key never touches disk; only the AES-GCM ciphertext + per-record salt/iv
 *     /authTag are persisted (accounts.creds.json, gitignored).
 *   - Plaintext passwords are NEVER logged. Callers reference records by email.
 *   - Tampering or a wrong key fails closed (GCM auth tag mismatch → throw).
 *
 * File shape (accounts.creds.json):
 *   { "v": 1, "records": { "<email-lower>": { salt, iv, tag, ct } } }   (all hex)
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'crypto';
import { config, log } from './config.js';

function credFilePath(env = process.env) {
  return env.DEVIN_CONNECT_CRED_FILE
    || join(config.sharedDataDir || config.dataDir, 'accounts.creds.json');
}
const SCRYPT_KEYLEN = 32;             // AES-256
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const ALGO = 'aes-256-gcm';
const FILE_VERSION = 1;

/** Resolve the master key material from env. Empty → store disabled. */
export function getCredKey(env = process.env) {
  return String(env.DEVIN_CONNECT_CRED_KEY || '').trim();
}

/** True when credential storage is enabled (a master key is configured). */
export function isCredStoreEnabled(env = process.env) {
  return getCredKey(env).length > 0;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Derive a per-record AES key from the master key + record salt. */
function deriveKey(masterKey, salt) {
  return scryptSync(masterKey, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
}

function readStore(env = process.env) {
  if (!existsSync(credFilePath(env))) return { v: FILE_VERSION, records: {} };
  try {
    const parsed = JSON.parse(readFileSync(credFilePath(env), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object') {
      return { v: FILE_VERSION, records: {} };
    }
    return { v: parsed.v || FILE_VERSION, records: parsed.records || {} };
  } catch (e) {
    log.warn(`credential store unreadable (${e.message}); treating as empty`);
    return { v: FILE_VERSION, records: {} };
  }
}

function writeStore(store, env = process.env) {
  // Atomic write: tmp + rename so a crash mid-write can't truncate the store.
  const tmp = `${credFilePath(env)}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, credFilePath(env));
}

/**
 * Encrypt and persist a password for an email. No-op (returns false) when the
 * store is disabled. Plaintext is never logged.
 */
export function storeCredential(email, password, env = process.env) {
  const masterKey = getCredKey(env);
  if (!masterKey) return false;
  const key = normalizeEmail(email);
  if (!key || !password) throw new Error('storeCredential: email and password required');

  const salt = randomBytes(16);
  const iv = randomBytes(12); // 96-bit nonce, GCM standard
  const aesKey = deriveKey(masterKey, salt);
  const cipher = createCipheriv(ALGO, aesKey, iv);
  const ct = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const store = readStore(env);
  store.records[key] = {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ct: ct.toString('hex'),
  };
  writeStore(store, env);
  log.info(`credential stored for ${key.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
  return true;
}

/** True if an encrypted credential exists for this email (no decryption). */
export function hasCredential(email, env = process.env) {
  if (!isCredStoreEnabled(env)) return false;
  return Boolean(readStore(env).records[normalizeEmail(email)]);
}

/**
 * Decrypt and return the stored password for an email, or null when absent /
 * store disabled. Throws on a wrong key or tampered record (GCM auth failure) —
 * callers should treat that as "credential unusable", not "absent".
 */
export function getCredential(email, env = process.env) {
  const masterKey = getCredKey(env);
  if (!masterKey) return null;
  const rec = readStore(env).records[normalizeEmail(email)];
  if (!rec) return null;

  const aesKey = deriveKey(masterKey, Buffer.from(rec.salt, 'hex'));
  const decipher = createDecipheriv(ALGO, aesKey, Buffer.from(rec.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(rec.tag, 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(rec.ct, 'hex')), decipher.final()]);
  return pt.toString('utf8');
}

/** Remove a stored credential. Returns true if a record was deleted. */
export function deleteCredential(email, env = process.env) {
  if (!isCredStoreEnabled(env)) return false;
  const store = readStore(env);
  const key = normalizeEmail(email);
  if (!store.records[key]) return false;
  delete store.records[key];
  writeStore(store, env);
  return true;
}

/** List emails with stored credentials (for ops/diagnostics; no secrets). */
export function listCredentialEmails(env = process.env) {
  if (!isCredStoreEnabled(env)) return [];
  return Object.keys(readStore(env).records);
}

export const __testing = { credFilePath, deriveKey, normalizeEmail };
