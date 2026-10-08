/** Optional disk limits for the application's dated JSONL logs. Single writer per directory. */
import { mkdir, readdir, lstat, appendFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;
const LOG_NAME = /^(app|error)-(\d{4}-\d{2}-\d{2})(?:-(\d{6,}))?\.jsonl$/;

export function readLogPolicy(env = process.env) {
  const limit = (raw, scale = 1) => {
    if (raw == null || String(raw).trim() === '') return 0;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * scale)
      ? value * scale : 0;
  };
  return {
    retentionDays: limit(env.LOG_RETENTION_DAYS),
    maxFileBytes: limit(env.LOG_MAX_FILE_MB, MB),
    maxTotalBytes: limit(env.LOG_MAX_TOTAL_MB, MB),
  };
}

function ownedLog(name) {
  const match = LOG_NAME.exec(name);
  if (!match) return null;
  const time = Date.parse(`${match[2]}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== match[2]) return null;
  const sequence = Number(match[3] || 0);
  if (!Number.isSafeInteger(sequence)) return null;
  return { name, kind: match[1], day: match[2], time, sequence };
}

/** Writes and cleanup share one queue, so a file is never removed during our append. */
export function createLogFileWriter({ dir, retentionDays = 0, maxFileBytes = 0,
  maxTotalBytes = 0, now = Date.now, onError = () => {} }) {
  let pending = Promise.resolve();
  let initialized = false;
  let totalBytes = 0;
  let retentionMidnight = null;
  const files = new Map();
  const current = new Map();
  const sequences = new Map();

  function enqueue(operation) {
    pending = pending.then(operation).catch(error => {
      // Re-read sizes after any partial write or failed cleanup before trying again.
      initialized = false;
      try { onError(error); } catch {}
    });
    return pending;
  }

  async function refresh() {
    initialized = false;
    await mkdir(dir, { recursive: true });
    const found = new Map();
    let bytes = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = ownedLog(entry.name);
      if (!file || !entry.isFile()) continue; // Never follow links or recurse into subdirectories.
      const stat = await lstat(join(dir, file.name));
      if (!stat.isFile()) continue;
      found.set(file.name, { ...file, size: stat.size });
      bytes += stat.size;
      const key = `${file.kind}-${file.day}`;
      sequences.set(key, Math.max(sequences.get(key) || 0, file.sequence));
    }
    files.clear();
    for (const [name, file] of found) files.set(name, file);
    const today = new Date(now()).toISOString().slice(0, 10);
    for (const key of sequences.keys()) {
      if (!key.endsWith(`-${today}`)) sequences.delete(key);
    }
    totalBytes = bytes;
    retentionMidnight = null;
    initialized = true;
  }

  async function remove(file) {
    try {
      const stat = await lstat(join(dir, file.name));
      if (!stat.isFile()) throw new Error('log path is no longer a regular file');
      await unlink(join(dir, file.name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    totalBytes -= file.size;
    files.delete(file.name);
  }

  function oldestFirst() {
    return [...files.values()].sort((a, b) => a.time - b.time || a.sequence - b.sequence
      || a.name.localeCompare(b.name));
  }

  async function prune(requiredBytes = 0) {
    const midnight = Math.floor(now() / DAY_MS) * DAY_MS;
    const checkRetention = retentionDays > 0 && retentionMidnight !== midnight;
    if (!checkRetention && !(maxTotalBytes > 0 && totalBytes + requiredBytes > maxTotalBytes)) return;
    // N days includes today's UTC file and the previous N-1 calendar days.
    for (const file of oldestFirst()) {
      const expired = checkRetention && file.time < midnight - (retentionDays - 1) * DAY_MS;
      const overBudget = maxTotalBytes > 0 && totalBytes + requiredBytes > maxTotalBytes;
      if (expired || overBudget) await remove(file);
    }
    retentionMidnight = midnight;
  }

  async function append(kind, line) {
    if (!initialized) await refresh();
    const size = Buffer.byteLength(line);
    if ((maxFileBytes > 0 && size > maxFileBytes) || (maxTotalBytes > 0 && size > maxTotalBytes)) {
      throw new Error('log entry exceeds disk limit'); // Keep JSONL intact; memory/SSE/console still receive it.
    }
    await prune(size);
    const day = new Date(now()).toISOString().slice(0, 10);
    const key = `${kind}-${day}`;
    let file = files.get(current.get(kind));
    if (!file || file.day !== day) {
      file = [...files.values()].filter(f => f.kind === kind && f.day === day)
        .sort((a, b) => b.sequence - a.sequence)[0];
    }
    if (!file || (maxFileBytes > 0 && file.size + size > maxFileBytes)) {
      const sequence = file || sequences.has(key) ? (sequences.get(key) || 0) + 1 : 0;
      sequences.set(key, sequence);
      const suffix = sequence ? `-${String(sequence).padStart(6, '0')}` : '';
      file = { name: `${key}${suffix}.jsonl`, kind, day, time: Date.parse(`${day}T00:00:00Z`), sequence, size: 0 };
    }
    const path = join(dir, file.name);
    // An existing symlink/directory with an owned filename is not permission to overwrite it.
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) throw new Error('log path is not a regular file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await appendFile(path, line);
    file.size += size;
    totalBytes += size;
    files.set(file.name, file);
    current.set(kind, file.name);
  }

  function cleanup() {
    return enqueue(async () => { await refresh(); await prune(); });
  }

  cleanup(); // Clean an existing installation even before the first new log entry.
  const timer = setInterval(cleanup, 60 * 60 * 1000);
  timer.unref?.();
  return {
    write(level, line) {
      return enqueue(async () => {
        await append('app', line);
        if (level === 'warn' || level === 'error') await append('error', line);
      });
    },
    cleanup,
    flush: () => pending,
    async close() { clearInterval(timer); await pending; },
  };
}
