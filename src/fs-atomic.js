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
 * then `rename(2)` it onto the target. rename is atomic on POSIX and
 * replaces an existing target on Windows (per Node's documented
 * fs.renameSync behavior). A crash between writeFileSync(tmp) and
 * renameSync leaves the target intact; a crash after renameSync
 * leaves the new contents in place. Either way, no truncated JSON.
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
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY']);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

export function renameSyncWithRetry(sourcePath, targetPath, { attempts = 6, baseDelayMs = 10 } = {}) {
  const maxAttempts = Math.max(1, attempts | 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      renameSync(sourcePath, targetPath);
      return;
    } catch (err) {
      if (!RETRYABLE_RENAME_CODES.has(err?.code) || attempt === maxAttempts) throw err;
      sleepSync(baseDelayMs * attempt);
    }
  }
}

export function writeJsonAtomic(targetPath, value, { spaces = 2, mode = 0o600 } = {}) {
  // mode defaults to 0600 (owner-only): these config files can carry the runtime
  // API key / dashboard password hash / upstream tokens, and must not be
  // world-readable by other users on a shared host. rename preserves the temp
  // file's mode, so it has to be set at creation. Callers can override for
  // non-sensitive files, but 0600 is the safe default.
  const tmp = `${targetPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, spaces), { mode });
    renameSyncWithRetry(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}
