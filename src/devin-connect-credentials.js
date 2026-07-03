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
import { bumpConnect, __registerCredHealth } from './devin-connect-metrics.js';

// Bump the repair counter without letting a metrics hiccup break a cred read.
function bumpCredRepaired() {
  try { bumpConnect('cred_store_repaired'); } catch { /* metrics are best-effort */ }
}

function credFilePath(env = process.env) {
  return env.DEVIN_CONNECT_CRED_FILE
    || join(config.sharedDataDir || config.dataDir, 'accounts.creds.json');
}
const SCRYPT_KEYLEN = 32;             // AES-256
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const ALGO = 'aes-256-gcm';
const FILE_VERSION = 1;

// Decrypt-failure signal. A GCM auth-tag mismatch means the master key is wrong
// (rotated/typo'd) or the record is tampered — and because every record is
// keyed off the SAME master key, a wrong key fails IDENTICALLY for the whole
// fleet, silently disabling all auto-relogin. We surface that as a counter +
// last-error so ops/observability can alarm on it instead of it hiding in a
// per-account warn. Distinct from "credential absent", which is normal.
let _decryptFailures = 0;
let _lastDecryptError = null;
export function getCredHealth() {
  return { decryptFailures: _decryptFailures, lastDecryptError: _lastDecryptError };
}
export function resetCredHealth() { _decryptFailures = 0; _lastDecryptError = null; }

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

// A stored record is { salt, iv, tag, ct } with all values lowercase hex. We
// validate shape before trusting a salvaged record so regex recovery can't
// inject garbage that later throws deep in the cipher.
function isValidRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  for (const f of ['salt', 'iv', 'tag', 'ct']) {
    if (typeof rec[f] !== 'string' || !/^[0-9a-fA-F]+$/.test(rec[f]) || rec[f].length === 0) return false;
  }
  return true;
}

// Tier 2: best-effort repair of a structurally-broken JSON wrapper before
// giving up. Handles the common real-world corruptions: a UTF-8 BOM, a trailing
// comma, and a half-written file truncated mid-object (crash/disk-full between
// write and rename, or a botched manual edit) — recover the largest prefix that
// closes cleanly at the last balanced `}`.
function tryRepairJson(text) {
  let s = String(text).replace(/^﻿/, '').trim();
  // Truncate to the last closing brace so a tail-truncated file still parses
  // its complete records.
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace !== -1) s = s.slice(0, lastBrace + 1);
  // Drop a dangling comma before the closing brace(s).
  s = s.replace(/,\s*(}|])/g, '$1');
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && typeof parsed.records === 'object') return parsed;
  } catch { /* fall through to tier 3 */ }
  return null;
}

// Tier 3: the JSON wrapper is unsalvageable, but every record is an independent
// encrypted blob. Scan the raw text for `"<email>": { salt, iv, tag, ct }`
// fragments and rebuild the records map one entry at a time, keeping only those
// that pass shape validation. One mangled record is dropped; the rest survive.
function salvageRecordsByRegex(text) {
  const records = {};
  // Match an email-ish key followed by an object literal containing the four
  // hex fields in any order. Non-greedy object body, capped to avoid runaway.
  const entryRe = /"([^"\n]+?)"\s*:\s*\{([^{}]{0,4000}?)\}/g;
  const fieldRe = (name) => new RegExp(`"${name}"\\s*:\\s*"([0-9a-fA-F]+)"`);
  let m;
  while ((m = entryRe.exec(text)) !== null) {
    const key = m[1];
    const body = m[2];
    const rec = {};
    let ok = true;
    for (const f of ['salt', 'iv', 'tag', 'ct']) {
      const fm = body.match(fieldRe(f));
      if (!fm) { ok = false; break; }
      rec[f] = fm[1];
    }
    if (ok && isValidRecord(rec) && key !== 'records' && key !== 'v') records[key] = rec;
  }
  return records;
}

// Read the credential store with three resilience tiers so a single corrupt
// byte can't silently wipe the whole fleet's relogin credentials:
//   1. JSON.parse (normal path)
//   2. JSON repair (BOM / trailing comma / tail-truncation) then parse
//   3. per-record regex salvage from the raw text
// Any tier beyond (1) bumps cred_store_repaired + logs, and re-persists the
// recovered store once (self-heal) so the next read is clean again.
function readStore(env = process.env) {
  if (!existsSync(credFilePath(env))) return { v: FILE_VERSION, records: {} };
  let raw;
  try {
    raw = readFileSync(credFilePath(env), 'utf8');
  } catch (e) {
    log.warn(`credential store unreadable (${e.message}); treating as empty`);
    return { v: FILE_VERSION, records: {} };
  }

  // Tier 1 — clean parse.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.records === 'object') {
      return { v: parsed.v || FILE_VERSION, records: parsed.records || {} };
    }
    // Parsed but wrong shape — fall through to salvage from the raw text.
  } catch { /* fall through to repair */ }

  // Tier 2 — repair the JSON wrapper.
  const repaired = tryRepairJson(raw);
  if (repaired) {
    const recovered = { v: repaired.v || FILE_VERSION, records: repaired.records || {} };
    const n = Object.keys(recovered.records).length;
    log.error(`credential store JSON was corrupt; repaired wrapper and recovered ${n} record(s). Re-persisting clean copy.`);
    bumpCredRepaired();
    try { writeStore(recovered, env); } catch (e) { log.warn(`credential store self-heal write failed: ${e.message}`); }
    return recovered;
  }

  // Tier 3 — per-record regex salvage.
  const salvaged = salvageRecordsByRegex(raw);
  const n = Object.keys(salvaged).length;
  const recovered = { v: FILE_VERSION, records: salvaged };
  log.error(`credential store JSON unrepairable; regex-salvaged ${n} intact record(s) from the raw file. Re-persisting clean copy.`);
  bumpCredRepaired();
  if (n > 0) {
    try { writeStore(recovered, env); } catch (e) { log.warn(`credential store self-heal write failed: ${e.message}`); }
  }
  return recovered;
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

  try {
    const aesKey = deriveKey(masterKey, Buffer.from(rec.salt, 'hex'));
    const decipher = createDecipheriv(ALGO, aesKey, Buffer.from(rec.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'hex'));
    const pt = Buffer.concat([decipher.update(Buffer.from(rec.ct, 'hex')), decipher.final()]);
    // A successful decrypt proves the key is right — clear any stale alarm.
    if (_decryptFailures > 0) { _decryptFailures = 0; _lastDecryptError = null; }
    return pt.toString('utf8');
  } catch (e) {
    // Wrong/rotated master key or tampered record — fleet-wide self-heal is now
    // broken. Track it loudly (counter + a single error-level line) so it can be
    // alarmed on, instead of vanishing into a per-account debug warn. Re-throw so
    // the caller still treats this as "credential unusable", not "absent".
    _decryptFailures += 1;
    _lastDecryptError = e.message;
    log.error(`DEVIN_CONNECT credential decrypt FAILED (wrong/rotated DEVIN_CONNECT_CRED_KEY or tampered store?) — auto-relogin is DISABLED until fixed. failures=${_decryptFailures}`);
    throw e;
  }
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

export const __testing = { credFilePath, deriveKey, normalizeEmail, tryRepairJson, salvageRecordsByRegex, isValidRecord, readStore };

// Surface decrypt health through the central connect-metrics endpoint without a
// static import cycle (metrics → credentials → config → ...). Registered at
// import time; the metrics module calls back into getCredHealth on demand.
__registerCredHealth(getCredHealth);
