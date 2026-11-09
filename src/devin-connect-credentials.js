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

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, openSync, closeSync, unlinkSync, realpathSync, readdirSync, statSync, existsSync, linkSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, randomUUID } from 'crypto';
import { hostname } from 'os';
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
// AES-GCM's tag is fixed at 128 bits by this format's writer (`getAuthTag()`), and the
// read path must require exactly that: node otherwise accepts any shorter tag present in
// the file, which turns a truncation into an accepted credential rather than a tamper.
const GCM_TAG_BYTES = 16;

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
  const key = getCredKey(env);
  if (key.length === 0) return false;
  // S6-F5: any non-empty key used to enable the store — `DEVIN_CONNECT_CRED_KEY=x`
  // silently wrapped records under a trivially brute-forceable KEK. Below the
  // floor the store reports disabled; a loud error names exactly why.
  if (key.length < MIN_CRED_KEY_CHARS) {
    if (!_shortKeyWarned) {
      _shortKeyWarned = true;
      log.error(`DEVIN_CONNECT_CRED_KEY is ${key.length} chars (< ${MIN_CRED_KEY_CHARS}) — too weak as a key-encryption key; credential store DISABLED. Set a longer key or unset it.`);
    }
    return false;
  }
  return true;
}

export const MIN_CRED_KEY_CHARS = 16;
let _shortKeyWarned = false;

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
  const records = Object.create(null);
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

// Synchronous callers already run to completion on one event loop. This guard
// also rejects reentrant calls; returning success for queued work would break
// the existing boolean/throw API and lose persistence errors at its callers.
const _saveInFlight = new Set();
// file → the claim INSTANCE this process holds. The instance, not the path, is
// the lock, so a release can only give back the exact claim that was taken.
const _heldClaims = new Map();
const NO_IGNORED = new Set();

function credentialStoreError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function credentialStoreBusy() {
  return credentialStoreError('ERR_CRED_STORE_BUSY');
}

function canonicalCredFile(env) {
  const file = resolve(credFilePath(env));
  return join(realpathSync(dirname(file)), basename(file));
}

// ─── The store lock: a permanent sentinel plus unique claim INSTANCES ───────
//
//   <store>.lock            permanent sentinel at the fixed pre-v2 path:
//                             • a regular file — a fresh store
//                             • a directory holding format.json — a migrated one
//   <store>.lock.claims/    retained coordination directory
//     claim-<host>-<pid>-<token>/     one immutable claim per writer
//
// WHY THE SENTINEL IS A FILE FOR A FRESH STORE. <store>.lock used to be a
// directory that had to be created and then stamped, so a failure between those
// two steps (crash, ENOSPC) left a lock nothing could read and every later save
// was fenced forever (2026-09-17 review, P2). The sentinel is now published by
// hard-linking a fully prepared file: the path is either absent or complete, and
// there is no window in which a created-but-uninitialized lock exists. A pre-v2
// writer cannot take the path either — its mkdir fails on an existing path, and
// its release rmdir cannot remove a file — so after the first new-format writer
// no pre-v2 writer can hold this lock again (its own reclaim then finds no
// owner.json and refuses).
//
// WHY A PRE-V2 DIRECTORY IS KEPT, NEVER RENAMED AND NEVER EMPTIED. An old-version
// reclaimer may still be running: it reads the stamp, judges the owner dead,
// pauses, then deletes by PATH. If this code renamed or removed that directory —
// or left it empty — the paused reclaimer would delete whatever replaced it,
// which is exactly the P1 this change removes. So the directory stays at its path
// forever: the migrator first holds a uniquely named guard INSIDE it (an old
// reclaimer's rmdir then fails with ENOTEMPTY even after it unlinks the stamp)
// and only ever installs a permanent format.json inside it. A directory without
// that marker is refused however old it looks: a paused pre-v2 writer between its
// mkdir and its stamp is indistinguishable from a leftover, and elapsed time is
// not proof of death.
//
// CLAIMS ARE INSTANCES. The identity IS the directory name (host, pid, random
// token), so a reclaim can only delete the exact instance whose writer it proved
// dead by ESRCH on this host; claim and release both name an instance rather than
// a shared path. The claims directory is read AFTER this writer's claim exists:
// two writers can both be past their read only if each missed the other's claim,
// which requires the second claim to be created after the first read — but then
// the second read is later still and sees the first claim. A live claim is never
// removed, so the loser reads BUSY.
//
// LIMITS, stated rather than implied: only ESRCH on this host proves a pid is
// gone, so a recycled pid — and any foreign host — stays conservatively BUSY until
// an operator removes that instance; worker threads share a pid, so a claim is per
// process, not per thread; a pre-v2 directory left empty by a crash between mkdir
// and stamp is an explicitly irrecoverable legacy boundary (refused, operator
// action required); and this trusts local-filesystem readdir/mkdir/link
// visibility, the same assumption the old mkdir-based lock already made.
const LOCK_FORMAT = 2;
const LOCK_MARKER = JSON.stringify({ v: LOCK_FORMAT });
const FORMAT_FILE = 'format.json';
const LEGACY_OWNER_FILE = 'owner.json';
const CLAIM_PREFIX = 'claim-';
const CLAIM_ATTEMPTS = 3;

// Hex, not the raw name: it survives any hostname character and compares exactly.
function hostTag(host = hostname()) {
  return Buffer.from(String(host), 'utf8').toString('hex');
}

function sentinelPath(file) {
  return `${file}.lock`;
}

function claimsPath(file) {
  return `${file}.lock.claims`;
}

function claimName(token = randomUUID().replace(/-/g, '')) {
  return `${CLAIM_PREFIX}${hostTag()}-${process.pid}-${token}`;
}

// Anything this module did not create parses to null, and callers must treat
// null as an occupant they cannot prove dead — never as something reclaimable.
function parseClaim(name) {
  if (typeof name !== 'string' || !name.startsWith(CLAIM_PREFIX)) return null;
  const parts = name.slice(CLAIM_PREFIX.length).split('-');
  if (parts.length !== 3) return null;
  const [host, pid, token] = parts;
  if (!/^[0-9a-f]{2,512}$/.test(host)) return null;
  if (!/^[1-9][0-9]{0,9}$/.test(pid)) return null;
  if (!/^[0-9a-f]{16,64}$/.test(token)) return null;
  return { host, pid: Number(pid), token, name };
}

// 'dead' = this host provably cannot be running that writer any more. 'live' and
// 'unknown' both fence the store; 'unknown' is another host, or an errno that
// proves nothing (EPERM), or a pid this process is not allowed to check.
function claimState(claim) {
  if (claim.host !== hostTag()) return 'unknown';
  try {
    process.kill(claim.pid, 0);
    return 'live';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

// Remove one claim INSTANCE: the name is the identity, so this can only delete the
// exact instance the caller proved dead. An instance is a leaf — a directory, or
// the staging file of a claim that was published but never completed.
function removeInstance(dir, name) {
  const target = join(dir, name);
  let info;
  try { info = statSync(target); } catch { return true; }          // already gone
  if (info.isFile()) {
    try { unlinkSync(target); return true; } catch { return false; }
  }
  if (!info.isDirectory()) return false;
  let entries;
  try { entries = readdirSync(target, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (!entry.isFile()) return false;
    try { unlinkSync(join(target, entry.name)); } catch { return false; }
  }
  try { rmdirSync(target); return true; } catch { return false; }
}

// Read a coordination directory and clean up only what is provably dead. Returns
// the first entry that blocks this writer, or null. `ignored` names members the
// caller already understands (the sentinel's own files).
function sweepInstances(dir, ownName, ignored) {
  let blocker = null;
  for (const entry of readdirSync(dir)) {
    if (entry === ownName || ignored.has(entry)) continue;
    const instance = parseClaim(entry);
    if (!instance || claimState(instance) !== 'dead') { if (!blocker) blocker = entry; continue; }
    if (removeInstance(dir, entry)) log.warn(`credential store lock reclaimed from a dead writer (pid ${instance.pid})`);
    else log.warn(`credential store: dead lock instance ${entry} could not be removed; it fences nothing`);
  }
  return blocker;
}

function releaseInstance(dir, name) {
  try { rmdirSync(join(dir, name)); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return true;                     // already gone, nothing to give back
    // A completed rename remains committed; a surviving claim instance fences
    // later writes exactly as long as this process can still publish.
    log.error(`credential store lock release failed (${error.code || 'UNKNOWN'}); writes remain fenced`);
    return false;
  }
}

function markerState(dir) {
  let raw;
  try { raw = readFileSync(join(dir, FORMAT_FILE), 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? 'absent' : 'broken'; }
  try { return JSON.parse(raw)?.v === LOCK_FORMAT ? 'ok' : 'broken'; }
  catch { return 'broken'; }
}

// Pre-v2 stamp: the only legacy ownership this code understands. Anything
// unreadable, foreign or malformed parses to null and is refused instead of
// stolen. Never an age rule: a paused pre-v2 writer can still resume and publish,
// so only the OS may call it dead.
function parseLegacyOwner(dir) {
  let owner;
  try { owner = JSON.parse(readFileSync(join(dir, LEGACY_OWNER_FILE), 'utf8')); }
  catch { return null; }
  if (!owner || typeof owner.host !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
  return { host: owner.host, pid: owner.pid };
}

// 'dead' | 'live' | 'unknown' for an already-parsed stamp. A null/absent stamp is
// 'unknown' — absence is never evidence of death.
function legacyOwnerState(owner) {
  if (!owner) return 'unknown';
  if (owner.host !== hostname()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'live';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

// Publish the fresh-store sentinel ATOMICALLY: the marker is fully prepared inside
// the claims directory and then hard-linked to the sentinel path, so that path is
// either absent or complete. EEXIST means somebody else published first (or a
// pre-v2 directory appeared) and the caller re-reads; every other failure leaves
// the sentinel path untouched and is reported as itself.
function publishSentinel(lock, claims) {
  const staged = join(claims, claimName());
  try {
    writeFileSync(staged, LOCK_MARKER, { mode: 0o600, flag: 'wx' });
    try { linkSync(staged, lock); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    try { unlinkSync(staged); } catch { /* best effort */ }
  }
}

// Install the permanent marker INSIDE a pre-v2 directory. It is staged under a
// claim-shaped name first, so a writer that dies mid-install is reclaimed as a
// provably dead instance instead of becoming an unreadable artifact; the rename
// then makes it visible. From this moment rmdir on the directory always fails.
function installLegacyMarker(dir) {
  const staged = join(dir, claimName());
  try {
    writeFileSync(staged, LOCK_MARKER, { mode: 0o600, flag: 'wx' });
    renameSync(staged, join(dir, FORMAT_FILE));
  } catch (error) {
    try { unlinkSync(staged); } catch { /* best effort */ }
    throw error;
  }
}

// A pre-v2 directory is migrated IN PLACE: this code never renames, removes or
// vacates it. The permanent marker is installed BEFORE the dead stamp is deleted,
// so a fault in this code alone (crash, ENOSPC, EIO) leaves either the untouched
// stamp or [format.json, owner.json] — both retryable, and neither empty.
//
// MIXED-VERSION BOUNDARY. A pre-v2 reclaimer running concurrently can unlink the
// stamp it judged dead at any moment, including after this migrator revalidated
// it. If the marker install then fails, releasing the guard leaves an ordinary
// empty pre-v2 directory: this code never adopts one, so later writes read BUSY
// until an operator removes it. That is the narrow residual of running beside an
// old writer; it never widens what this code accepts, and with no old reclaimer
// involved the dead stamp survives such a fault and the retry completes.
function migrateLegacyDir(lock) {
  const before = readdirSync(lock);
  for (const entry of before) {
    if (entry === LEGACY_OWNER_FILE || entry === FORMAT_FILE || parseClaim(entry)) continue;
    throw credentialStoreBusy();
  }
  if (before.length === 0) {
    // A pre-v2 writer between its mkdir and its stamp looks exactly like this, and
    // how long it paused cannot be observed. Refuse — an operator decides.
    throw credentialStoreBusy();
  }
  const marker = markerState(lock);
  if (marker === 'broken') throw credentialStoreBusy();
  if (marker === 'ok') {
    // Already migrated: the marker is the permanent barrier, so only a leftover
    // dead stamp and the litter of a crashed migrator may need clearing.
    if (existsSync(join(lock, LEGACY_OWNER_FILE))) {
      const owner = parseLegacyOwner(lock);
      if (legacyOwnerState(owner) !== 'dead') throw credentialStoreBusy();
      try { unlinkSync(join(lock, LEGACY_OWNER_FILE)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (sweepInstances(lock, null, new Set([FORMAT_FILE]))) throw credentialStoreBusy();
    return;
  }
  const hadStamp = before.includes(LEGACY_OWNER_FILE);
  const stampBefore = hadStamp ? parseLegacyOwner(lock) : null;
  if (hadStamp && legacyOwnerState(stampBefore) !== 'dead') throw credentialStoreBusy();
  // Hold a unique, nonempty barrier INSIDE this exact directory before touching the
  // shared stamp: an old reclaimer's rmdir now fails (ENOTEMPTY) even after it
  // unlinks the stamp, so the directory instance cannot be vacated under us.
  const guard = claimName();
  mkdirSync(join(lock, guard), { mode: 0o700 });
  try {
    if (sweepInstances(lock, guard, new Set([LEGACY_OWNER_FILE]))) throw credentialStoreBusy();
    // Revalidate AFTER the barrier, and only against the identity judged dead above.
    // A stamp that is gone proves nothing — an old reclaimer may have removed it, or
    // an old writer may have replaced the whole directory with one it is about to
    // stamp — so absence is always BUSY, never death. A different owner is refused
    // too: this writer never verified that one.
    const stampNow = parseLegacyOwner(lock);
    if (!stampNow) throw credentialStoreBusy();
    if (!stampBefore || stampNow.host !== stampBefore.host || stampNow.pid !== stampBefore.pid) throw credentialStoreBusy();
    if (legacyOwnerState(stampNow) !== 'dead') throw credentialStoreBusy();
    // Permanent barrier first, shared stamp second.
    installLegacyMarker(lock);
    try { unlinkSync(join(lock, LEGACY_OWNER_FILE)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    log.warn('credential store lock upgraded in place: a dead pre-v2 stamp was removed');
  } finally {
    // The guard is always handed back. In the paths this code drives, the
    // directory stays non-empty without it (the marker, or the untouched stamp);
    // if a concurrent pre-v2 reclaimer removed the stamp and the marker install
    // then failed, this leaves an empty pre-v2 directory, which the next attempt
    // refuses (BUSY, operator recovery) instead of adopting it.
    releaseInstance(lock, guard);
  }
}

function ensureClaimsDir(claims) {
  try { mkdirSync(claims, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!statSync(claims).isDirectory()) throw credentialStoreBusy();
}

// Occupy the store's fixed sentinel path with something a pre-v2 writer can
// neither create nor delete, or refuse. Everything unknown is a refusal.
function openSentinel(lock, claims) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let info = null;
    try { info = statSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info === null) { publishSentinel(lock, claims); continue; }
    if (info.isDirectory()) { migrateLegacyDir(lock); return; }
    if (!info.isFile()) throw credentialStoreBusy();
    let raw;
    try { raw = readFileSync(lock, 'utf8'); } catch { throw credentialStoreBusy(); }
    try { if (JSON.parse(raw)?.v === LOCK_FORMAT) return; } catch { /* not a marker this code wrote */ }
    throw credentialStoreBusy();
  }
  throw credentialStoreBusy();                  // the path never settled: fail closed
}

// Take the store lock: publish this writer's claim instance, then read the claims
// directory to find out whether anybody else is live. Contention reads as BUSY —
// the caller must not write, and no live claim is ever touched.
function acquireClaim(file) {
  const claims = claimsPath(file);
  let name = null;
  for (let tries = 0; tries < CLAIM_ATTEMPTS && !name; tries++) {
    const candidate = claimName();
    try { mkdirSync(join(claims, candidate), { mode: 0o700 }); name = candidate; }
    catch (error) {
      // Only a token collision is expected to be EEXIST; anything else (ENOSPC
      // included) created nothing, so it is reported as itself, not as BUSY.
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (!name) throw credentialStoreBusy();
  const claim = { dir: claims, name, path: join(claims, name) };
  let blocker;
  try {
    blocker = sweepInstances(claims, name, NO_IGNORED);   // the read AFTER the claim is the exclusion
  } catch (error) {
    // A failed read must not leak this writer's own instance: it would fence every
    // later call from this process until it exits.
    releaseInstance(claims, name);
    throw error;
  }
  if (blocker) {
    releaseInstance(claims, name);
    log.warn(`credential store lock held elsewhere (${blocker}); refusing to write`);
    throw credentialStoreBusy();
  }
  return claim;
}

// Last check before publishing. This writer must still hold its own claim INSTANCE
// and no live/unknown occupant may share the claims directory. That read is the
// serialisation point: of two writers that both reach it, the later one sees the
// earlier one's claim (a live writer never gives its claim up) and refuses, so
// they cannot both publish. Provably dead instances are ignored — they cannot
// publish anything. Scope: this refuses under coherent local-filesystem semantics
// and relies on every protocol participant never deleting a live claim instance;
// it is not a defence against an external agent that removes one anyway, and no
// check can make an arbitrary external removal of a live claim safe.
function assertExclusive(file) {
  const claim = _heldClaims.get(file);
  if (!claim) throw credentialStoreError('ERR_CRED_STORE_UNLOCKED');
  if (!existsSync(claim.path)) throw credentialStoreBusy();
  if (sweepInstances(claim.dir, claim.name, NO_IGNORED)) throw credentialStoreBusy();
}

function withStoreLock(env, operation) {
  const file = canonicalCredFile(env);
  if (_saveInFlight.has(file)) throw credentialStoreBusy();
  _saveInFlight.add(file);
  let claim = null;
  try {
    const claims = claimsPath(file);
    ensureClaimsDir(claims);
    openSentinel(sentinelPath(file), claims);
    claim = acquireClaim(file);
    _heldClaims.set(file, claim);
    return operation({ ...env, DEVIN_CONNECT_CRED_FILE: file });
  } finally {
    if (claim) {
      _heldClaims.delete(file);
      releaseInstance(claim.dir, claim.name);
    }
    _saveInFlight.delete(file);
  }
}

function copyRecordMap(records) {
  return Object.assign(Object.create(null), records || {});
}

function isStoreShape(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.records && typeof value.records === 'object' && !Array.isArray(value.records);
}

function readSnapshot(env) {
  let raw;
  try {
    raw = readFileSync(credFilePath(env));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { store: { v: FILE_VERSION, records: copyRecordMap() }, raw: null, corrupt: false };
  }
  const text = raw.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (isStoreShape(parsed)) {
      return { store: { v: parsed.v || FILE_VERSION, records: copyRecordMap(parsed.records) }, raw, corrupt: false };
    }
  } catch { /* Inspect both recovery tiers without modifying the source. */ }

  const repaired = tryRepairJson(text);
  const salvaged = salvageRecordsByRegex(text);
  // Tier 2 can recover only a prefix. Always include intact tier-3 records
  // outside that prefix instead of publishing the smaller successful tier.
  const records = copyRecordMap(salvaged);
  if (isStoreShape(repaired)) Object.assign(records, repaired.records);
  return { store: { v: repaired?.v || FILE_VERSION, records }, raw, corrupt: true };
}

function assertRecordSetPreserved(before, after, removed = []) {
  const allowedRemovals = new Set(removed);
  for (const key of Object.keys(before)) {
    if (!allowedRemovals.has(key) && !Object.hasOwn(after, key)) {
      throw credentialStoreError('ERR_CRED_STORE_RECORD_LOSS');
    }
  }
}

function preserveCorruptSource(snapshot, env) {
  if (!snapshot.corrupt || snapshot.raw === null) return;
  const backup = `${credFilePath(env)}.corrupt.${process.pid}.${randomUUID()}.bak`;
  // Preserve the original bytes, not a UTF-8 roundtrip or a salvaged subset.
  // Failure must abort publication. Backups are never automatically merged
  // later: without tombstones that would resurrect deliberate deletions.
  writeFileSync(backup, snapshot.raw, { mode: 0o600, flag: 'wx' });
}

function writeStore(store, env = process.env) {
  const file = credFilePath(env);
  if (!_saveInFlight.has(file)) throw credentialStoreError('ERR_CRED_STORE_UNLOCKED');
  // Ownership is an instance, not a path: if this writer's claim is gone, or a
  // live competitor appeared since the lock was taken, the snapshot read below
  // (or already read) may be superseded, and publishing it would drop the
  // winner's records. Never publish without the exclusive instance.
  assertExclusive(file);
  // Match auth.js:617-622 and fs-atomic.js:111-121. Exclusive creation also
  // turns an improbable random-name collision into an error, not truncation.
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let fd;
  let owned = false;
  let published = false;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    owned = true;
    writeFileSync(fd, JSON.stringify(store, null, 2));
    closeSync(fd);
    fd = undefined;
    // The temp file is written; re-check ownership right before the rename that
    // publishes it. A claim lost during the write must refuse here, not publish.
    assertExclusive(file);
    renameSync(tmp, file);
    published = true;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch (error) { log.error(`credential store tmp close failed (${error.code || 'UNKNOWN'})`); }
    }
    if (owned && !published) {
      try { unlinkSync(tmp); }
      catch (error) {
        if (error.code !== 'ENOENT') log.error(`credential store tmp cleanup failed (${error.code || 'UNKNOWN'})`);
      }
    }
  }
}

function commitSnapshot(snapshot, next, env, removed = []) {
  assertRecordSetPreserved(snapshot.store.records, next.records, removed);
  preserveCorruptSource(snapshot, env);
  writeStore(next, env);
  if (snapshot.corrupt) {
    bumpCredRepaired();
    log.error(`credential store repaired; original bytes retained; published ${Object.keys(next.records).length} record(s)`);
  }
}

function readStore(env = process.env) {
  const first = readSnapshot(env);
  if (!first.corrupt) return first.store;
  if (Object.keys(first.store.records).length === 0) {
    bumpCredRepaired();
    log.error('credential store unrepairable; no intact records; source retained without overwrite');
    return first.store;
  }
  try {
    return withStoreLock(env, lockedEnv => {
      // Another writer may have published or deleted records since the first
      // read. Never heal from that stale snapshot, even if it has more keys.
      const current = readSnapshot(lockedEnv);
      if (current.corrupt && Object.keys(current.store.records).length > 0) {
        commitSnapshot(current, current.store, lockedEnv);
      }
      return current.store;
    });
  } catch (error) {
    bumpCredRepaired();
    log.warn(`credential store repair deferred (${error.code || 'UNKNOWN'}); source not overwritten by this reader`);
    return first.store;
  }
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

  withStoreLock(env, lockedEnv => {
    const snapshot = readSnapshot(lockedEnv);
    const store = { v: snapshot.store.v, records: copyRecordMap(snapshot.store.records) };
    store.records[key] = {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ct: ct.toString('hex'),
    };
    commitSnapshot(snapshot, store, lockedEnv);
  });
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
    // GCM's authentication strength is the tag length, and the writer always stores
    // the full 128-bit tag (`getAuthTag()`). Without an explicit `authTagLength`,
    // node accepts a SHORTER tag from the file and authenticates against it — so a
    // store whose tag was truncated to 4 bytes still returned the password, with only
    // a DEP0182 warning, and a tamper that shortens the tag was not detected. The
    // length is part of this file format, so it is checked here rather than inferred.
    const tagHex = rec.tag;
    if (typeof tagHex !== 'string' || tagHex.length !== GCM_TAG_BYTES * 2) {
      throw new Error(`credential record tag is not the ${GCM_TAG_BYTES}-byte GCM tag this format writes`);
    }
    const tag = Buffer.from(tagHex, 'hex');
    if (tag.length !== GCM_TAG_BYTES) {
      throw new Error(`credential record tag is not the ${GCM_TAG_BYTES}-byte GCM tag this format writes`);
    }
    const decipher = createDecipheriv(ALGO, aesKey, Buffer.from(rec.iv, 'hex'), { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(tag);
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
  const key = normalizeEmail(email);
  return withStoreLock(env, lockedEnv => {
    const snapshot = readSnapshot(lockedEnv);
    if (!Object.hasOwn(snapshot.store.records, key)) return false;
    const store = { v: snapshot.store.v, records: copyRecordMap(snapshot.store.records) };
    delete store.records[key];
    commitSnapshot(snapshot, store, lockedEnv, [key]);
    return true;
  });
}

/** List emails with stored credentials (for ops/diagnostics; no secrets). */
export function listCredentialEmails(env = process.env) {
  if (!isCredStoreEnabled(env)) return [];
  return Object.keys(readStore(env).records);
}

export const __testing = { credFilePath, deriveKey, normalizeEmail, tryRepairJson, salvageRecordsByRegex, isValidRecord, readStore, assertRecordSetPreserved, sentinelPath, claimsPath, claimName, parseClaim, claimState, removeInstance, parseLegacyOwner, legacyOwnerState, markerState, migrateLegacyDir, openSentinel, acquireClaim, releaseInstance, sweepInstances };

// Surface decrypt health through the central connect-metrics endpoint without a
// static import cycle (metrics → credentials → config → ...). Registered at
// import time; the metrics module calls back into getCredHealth on demand.
__registerCredHealth(getCredHealth);
