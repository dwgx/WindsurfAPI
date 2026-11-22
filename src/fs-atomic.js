/**
 * Atomic JSON file writer.
 *
 * The naive `writeFileSync(path, JSON.stringify(...))` truncates the
 * target file and then writes — if the process gets killed (SIGTERM
 * during docker stop, SIGKILL on OOM, panic-style crash) between the
 * truncate and the final write, the file is left empty or partial.
 * Next start, JSON.parse fails, the load() handler logs a warning and
 * silently falls back to defaults — user loses every persisted
 * setting, model-access list, proxy config, etc.
 *
 * Pattern: write the new contents to a unique sibling `${target}.*.tmp` first,
 * fsync(2) the tmp so the bytes actually reach disk, then `rename(2)` it onto
 * the target. rename is atomic on POSIX and replaces an existing target on
 * Windows (per Node's documented fs.renameSync behavior). A crash between the
 * durable tmp write and renameSync leaves the target intact; a crash after
 * renameSync leaves the (already-fsynced) new contents in place. Either way,
 * no truncated JSON and no rename-published-but-never-flushed tmp inode.
 *
 * Tmp file gets unlinked on write failure so repeated failures don't
 * leak garbage in DATA_DIR.
 *
 * Used by every dashboard config persister: model-access.json,
 * proxy.json, stats.json, runtime-config.json. accounts.json already
 * uses the same pattern hand-rolled in src/auth.js (kept inline there
 * because it has its own coalescing/_saveInFlight machinery).
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { renameSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY']);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

export function fsyncParentDirectorySync(targetPath) {
  let fd;
  try {
    fd = openSync(dirname(targetPath), 'r');
    fsyncSync(fd);
  } catch (err) {
    // Windows does not consistently allow directories to be opened/fsynced.
    // The file itself is still fsynced before rename; POSIX hosts, where the
    // directory-entry durability guarantee is available, must not silently
    // ignore a real fsync failure.
    if (process.platform === 'win32' && ['EACCES', 'EINVAL', 'EISDIR', 'EPERM'].includes(err?.code)) return;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function renameSyncWithRetry(sourcePath, targetPath, {
  attempts = 6,
  baseDelayMs = 10,
  rename = renameSync,
  fsyncParent = fsyncParentDirectorySync,
} = {}) {
  const maxAttempts = Math.max(1, attempts | 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rename(sourcePath, targetPath);
      break;
    } catch (err) {
      if (!RETRYABLE_RENAME_CODES.has(err?.code) || attempt === maxAttempts) throw err;
      sleepSync(baseDelayMs * attempt);
    }
  }
  // fsyncing the file before rename protects its contents; fsyncing the
  // containing directory protects the rename itself across power loss. This is
  // deliberately outside the retry loop: once rename succeeds, replaying it
  // after a directory-fsync error would operate on a source path that no longer
  // exists and misreport the already-published state.
  try {
    fsyncParent(targetPath);
  } catch (err) {
    // Callers may need to distinguish "rename never happened" from "the new
    // name is visible in this process but its directory entry could not be
    // proven power-loss durable". Never retry the rename in this state.
    err.renamePublished = true;
    err.renameTarget = targetPath;
    throw err;
  }
}

/**
 * Write bytes to `path` and fsync(2) before returning. A plain
 * writeFileSync + rename is atomic w.r.t. *other readers* (rename swaps the
 * inode), but the newly-written data may still sit in the OS page cache: a
 * power loss or kernel panic in the window after rename can leave the target
 * pointing at a tmp inode whose contents never reached the platter, i.e. a
 * zero-length or partial file. fsync forces the data out before we rename, so
 * the rename only ever publishes fully-durable contents. This is the
 * "temp → fsync → rename" durability guarantee (K7).
 */
export function writeFileSyncDurable(path, data, { mode = 0o600, write = writeSync } = {}) {
  const fd = openSync(path, 'w', mode);
  try {
    // writeSync may short-write: keep writing the remainder until the whole
    // buffer is flushed, and treat zero progress as an error so rename never
    // publishes a truncated snapshot.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (let offset = 0; offset < buf.length;) {
      const written = write(fd, buf, offset, buf.length - offset);
      if (written === 0) throw new Error(`fs-atomic: writeSync made no progress writing ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeJsonAtomic(targetPath, value, {
  spaces = 2,
  mode = 0o600,
  // Forwarded to renameSyncWithRetry. Defaults keep production behaviour
  // identical; a caller that needs to exercise the published-rename boundary
  // (rename succeeded, parent-directory sync failed) can inject a failing
  // fsyncParent without replacing the real rename.
  rename = renameSync,
  fsyncParent = fsyncParentDirectorySync,
  // Forwarded to writeFileSyncDurable so fault-injection tests can exercise
  // short writes without touching the real syscall.
  write = writeSync,
} = {}) {
  // mode defaults to 0600 (owner-only): these config files can carry the runtime
  // API key / dashboard password hash / upstream tokens, and must not be
  // world-readable by other users on a shared host. rename preserves the temp
  // file's mode, so it has to be set at creation. Callers can override for
  // non-sensitive files, but 0600 is the safe default.
  const tmp = `${targetPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSyncDurable(tmp, JSON.stringify(value, null, spaces), { mode, write });
    renameSyncWithRetry(tmp, targetPath, { rename, fsyncParent });
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ── Windows ACL hardening ──────────────────────────────────
//
// `mode: 0o600` is a POSIX contract; on Windows Node maps it (at best) to the
// read-only bit and the file keeps the ACL it inherits from its directory —
// `BUILTIN\Users:(RX)` and `NT AUTHORITY\Authenticated Users:(M)` on a default
// profile. accounts.json holds upstream tokens in cleartext and the packaged
// first-run .env holds the API key + dashboard password, so "owner-only" has to
// be enforced explicitly there.
//
// Best effort by design: a failed icacls must never fail the write that just
// succeeded (the bytes are already durable), but it must be LOUD — a silent
// failure is the same inherited-ACE exposure with a false sense of safety.
// `/inheritance:r` drops inherited ACEs (which is what Users/Authenticated
// Users get); `/grant:r <user>:(F)` leaves exactly one explicit owner ACE.
// Group names are deliberately not referenced — they are localized, while
// `/inheritance:r` works on every Windows locale.
const ACL_WARNED = new Set();

function defaultWindowsUser() {
  const username = process.env.USERNAME || userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${username}` : username;
}

export function restrictFileToOwnerSync(targetPath, {
  platform = process.platform,
  run = execFileSync,
  warn = (message) => console.warn(message),
  resolveUser = defaultWindowsUser,
} = {}) {
  if (platform !== 'win32') return { applied: false, reason: 'not-windows' };
  let user;
  try {
    user = resolveUser();
  } catch (err) {
    user = '';
    warn(`[fs] cannot resolve the current Windows user for ${targetPath}: ${err?.message || err}`);
  }
  if (!user) return { applied: false, reason: 'no-user' };
  try {
    run('icacls', [targetPath, '/inheritance:r', '/grant:r', `${user}:(F)`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return { applied: true, user };
  } catch (err) {
    const message = `[fs] could not restrict permissions on ${targetPath} (${err?.code || err?.message}); inherited Users/Authenticated Users access may remain`;
    // Saves repeat on a timer; one warning per path+reason is enough to be
    // actionable without turning a read-only install into a log flood.
    const key = `${targetPath}\0${err?.code || err?.message}`;
    if (!ACL_WARNED.has(key)) {
      ACL_WARNED.add(key);
      warn(message);
    }
    return { applied: false, reason: 'icacls-failed', error: err?.message };
  }
}
