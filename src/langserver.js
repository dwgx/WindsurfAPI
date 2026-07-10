/**
 * Language server pool manager.
 * Spawns multiple LS instances — one per unique outbound proxy (plus a default
 * no-proxy instance). Accounts are routed to the LS instance matching their
 * configured proxy so that each upstream Codeium request goes out through the
 * right egress IP. Also avoids the LS state-pollution bug where switching
 * accounts within a single LS session causes workspace setup streams to be
 * canceled.
 */

import { spawn, execSync } from 'child_process';
import { mkdirSync, readFileSync } from 'fs';
import { existsSync } from 'fs';
import http2 from 'http2';
import net from 'net';
import { randomUUID } from 'crypto';
import { freemem, totalmem } from 'os';
import { posix, resolve } from 'path';
import { log } from './config.js';
import { closeSessionForPort } from './grpc.js';

const DEFAULT_BINARY = '/opt/windsurf/language_server_linux_x64';
const DEFAULT_PORT = 42100;
const DEFAULT_CSRF = 'windsurf-api-csrf-fixed-token';
const DEFAULT_API_URL = 'https://server.self-serve.windsurf.com';
const DEFAULT_LINUX_DATA_ROOT = '/opt/windsurf/data';

// v2.0.96: cap LS pool size to prevent memory blowup (#174).
// v2.0.99+: make the default adaptive. Current LS builds can consume
// ~500-600MB RSS including the child worker, so a fixed default of 20 is
// unsafe on 2GB VPSes. Operators with large machines can still override.
const DEFAULT_LS_RSS_ESTIMATE_BYTES = 700 * 1024 * 1024;
const RSS_SNAPSHOT_TTL_MS = 5000;

function positiveIntEnv(name, fallback, min = 0) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function bytesEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|k|mb|mib|m|gb|gib|g)?$/i);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  const unit = (m[2] || 'b').toLowerCase();
  const mul = unit === 'gb' || unit === 'gib' || unit === 'g' ? 1024 ** 3
    : unit === 'mb' || unit === 'mib' || unit === 'm' ? 1024 ** 2
      : unit === 'kb' || unit === 'kib' || unit === 'k' ? 1024
        : 1;
  return Math.floor(n * mul);
}

export function detectMemoryLimitBytes(readFile = readFileSync, hostTotalBytes = totalmem()) {
  const candidates = [];
  const readLimit = (path) => {
    try {
      const raw = String(readFile(path, 'utf-8')).trim();
      if (!raw || raw === 'max') return;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) candidates.push(n);
    } catch {}
  };
  readLimit('/sys/fs/cgroup/memory.max');
  readLimit('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const hostTotal = Number(hostTotalBytes) || 0;
  const sane = candidates
    // cgroup v1 often reports absurd sentinel values when unlimited.
    .filter(n => n < 1_000_000_000_000_000)
    .filter(n => hostTotal <= 0 || n <= hostTotal);
  return sane.length ? Math.min(...sane) : hostTotal;
}

export function detectMemoryCurrentBytes(readFile = readFileSync) {
  for (const path of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try {
      const raw = String(readFile(path, 'utf-8')).trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch {}
  }
  return null;
}

export function detectHostMemAvailableBytes(readFile = readFileSync, fallback = freemem()) {
  try {
    const raw = String(readFile('/proc/meminfo', 'utf-8'));
    const m = raw.match(/^MemAvailable:\s+(\d+)\s+kB/im);
    if (m) return parseInt(m[1], 10) * 1024;
  } catch {}
  const n = Number(fallback);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function estimateDefaultMaxLsInstances(totalBytes = totalmem(), perInstanceBytes = DEFAULT_LS_RSS_ESTIMATE_BYTES) {
  const total = Number(totalBytes) || 0;
  const per = Number(perInstanceBytes) || DEFAULT_LS_RSS_ESTIMATE_BYTES;
  if (total <= 0 || per <= 0) return 2;
  // Keep one slot for the default LS plus one proxy slot. The default LS is
  // warmed on startup and is intentionally not LRU-evicted, so returning 1 on
  // tiny cgroups would make every proxied account fail with LS_POOL_EXHAUSTED.
  return Math.max(2, Math.min(20, Math.floor(total / per)));
}
const MAX_LS_INSTANCES = (() => {
  const n = parseInt(process.env.LS_MAX_INSTANCES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : estimateDefaultMaxLsInstances(detectMemoryLimitBytes());
})();
const LS_POOL_WAIT_MS = positiveIntEnv('LS_POOL_WAIT_MS', 30_000, 0);
const LS_MEMORY_GUARD_ENABLED = process.env.LS_MEMORY_GUARD !== '0';
const LS_SPAWN_MIN_AVAILABLE_BYTES_RAW = String(process.env.LS_SPAWN_MIN_AVAILABLE_BYTES || '').trim();
const LS_SPAWN_MIN_AVAILABLE_BYTES_EXPLICIT = !!LS_SPAWN_MIN_AVAILABLE_BYTES_RAW;
const LS_SPAWN_MIN_AVAILABLE_BYTES = bytesEnv('LS_SPAWN_MIN_AVAILABLE_BYTES', DEFAULT_LS_RSS_ESTIMATE_BYTES);
const LS_OBSERVED_RSS_MIN_BYTES = bytesEnv('LS_OBSERVED_RSS_MIN_BYTES', 384 * 1024 * 1024);
const LS_OBSERVED_RSS_MARGIN_PERCENT = positiveIntEnv('LS_OBSERVED_RSS_MARGIN_PERCENT', 35, 0);

const LS_IDLE_TTL_MS = (() => {
  const n = parseInt(process.env.LS_IDLE_TTL_MS || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 20 * 60 * 1000;
})();
const LS_IDLE_SWEEP_MS = (() => {
  const n = parseInt(process.env.LS_IDLE_SWEEP_MS || '', 10);
  if (Number.isFinite(n) && n > 0) return n;
  return LS_IDLE_TTL_MS > 0 ? Math.max(60_000, Math.min(5 * 60_000, Math.floor(LS_IDLE_TTL_MS / 2))) : 0;
})();

// Auto-restart configuration (env-overridable)
const AUTO_RESTART_ENABLED = process.env.LS_AUTO_RESTART !== '0'; // default: on
const AUTO_RESTART_MAX_RETRIES = (() => {
  const n = parseInt(process.env.LS_AUTO_RESTART_MAX_RETRIES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();
const AUTO_RESTART_BASE_DELAY_MS = (() => {
  const n = parseInt(process.env.LS_AUTO_RESTART_BASE_DELAY_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
})();

// Pool: key -> { process, port, csrfToken, proxy, startedAt, ready }
const _pool = new Map();
const _maintenanceUses = new Map();
// In-flight Promise map so two concurrent ensureLs(proxy) calls for the
// same key share one spawn + readiness wait. Without this, both callers
// would each spawn an LS process, race on the port, and leave an orphan.
const _pending = new Map();
// key -> monotonically increasing admission sequence. These reservations are
// counted by capacity/memory guards before the LS placeholder reaches _pool.
const _pendingStartSeq = new Map();
// Evicted processes are kept as reservations until the OS confirms exit.
// This prevents transient RSS spikes where old and new LS workers overlap.
const _stopping = new Map();
let _startAdmissionQueue = Promise.resolve();
// Track concrete LS processes being shut down intentionally so the exit
// handler doesn't fire an auto-restart for them. This must be per-process,
// not per-key: restartLsForProxy() can spawn a new same-key LS before the
// old process emits exit.
const _intentionalShutdownProcs = new WeakSet();
let _nextPort = DEFAULT_PORT + 1;
let _binaryPath = DEFAULT_BINARY;
let _apiServerUrl = DEFAULT_API_URL;
let _idleSweepTimer = null;
let _rssSnapshot = { at: 0, pidKey: '', byRootPid: new Map() };
let _nextPendingStartSeq = 1;
const _admissionStats = {
  startAttempts: 0,
  startSuccesses: 0,
  startFailures: 0,
  poolWaits: 0,
  memoryWaits: 0,
  poolExhausted: 0,
  memoryGuardBlocks: 0,
  evictions: 0,
  lastAttempt: null,
  lastSuccess: null,
  lastFailure: null,
  lastWait: null,
  lastEviction: null,
};

function lsPoolExhaustedError(message) {
  const err = new Error(message);
  err.code = 'LS_POOL_EXHAUSTED';
  err.status = 503;
  err.type = 'ls_pool_exhausted';
  err.isResourceExhausted = true;
  return err;
}

// v2.0.71 (#119 follow-up): heuristic to recognise sticky-IP proxy
// usernames. Common providers embed a session/IP token inside the
// username so the same host:port serves many distinct egress IPs:
//   ipwo:        username_sid_xxxxxxx
//   lunaproxy:   user-zone-residential-session-xxx
//   smartproxy:  spxxxxx-session-xxx-stickyXX
//   bright data: brd-customer-xxx-zone-xxx[-session-xxx]
//   oxylabs:     customer-xxxxx-cc-xxx[-sessid-xxx]
// Match any of these and segregate LS automatically. Falls back to
// host:port when the username doesn't fit the pattern (avoids
// LS-per-account memory blow up for static-IP proxies that intentionally
// share an egress).
//
// v2.0.79 (audit M-1) — original regex only caught usernames that
// contained an explicit session token (`_sid_`, `-session-`, `+ws_`).
// Bright Data and Oxylabs username schemas don't always include the
// session token (some plans use a stable username + rotating egress
// per-request, but the upstream still treats the username itself as
// the routing fingerprint). Those usernames look like:
//   brd-customer-hl_abc123-zone-residential
//   customer-myuser-cc-US-country-US
// They'd hash to the same proxyKey as a static-IP shared username
// (because there's no `session` token), so the LS pool would lump
// every account behind that proxy onto one shared LS instance, which
// is what wnfilm and 0a00 reported in #118 — "30 minute rate-limit
// even though I have 31 trial accounts behind it". Widen the regex
// to also catch `brd-customer-` prefix and `customer-...-cc-` /
// `customer-...-zone-` patterns. Static-IP proxies whose username is
// a bare login (no provider-specific markers) still skip
// segregation, so memory stays bounded.
// v2.0.93: expanded sticky detection. Any proxy username with a provider-
// specific token, session marker, or non-trivial structure gets its own LS.
// This catches more providers (iproyal, webshare, proxy-seller, etc) and
// reduces cross-account LS sharing which triggers upstream rate limits.
const STICKY_USER_RE = /(?:[_-](?:sid|session|sessid|sticky|sess|token|res|rotating|sticky|ip[_-]?[0-9])|[+]ws_|^brd-customer-|^customer-|^user-|^res-|^sticky-|-zone-[a-z]+|-cc-[a-z]{2}|-country-|-state-|-city-|-session-|-sess-|-sticky-|-res-|-rotating-)/i;
function isStickyUsername(u) {
  if (typeof u !== 'string' || u.length < 4) return false;
  return STICKY_USER_RE.test(u);
}

function proxyKey(proxy) {
  if (!proxy || !proxy.host) return 'default';
  // Sanitize to [A-Za-z0-9_] — the key flows into a filesystem path
  // (`${LS_DATA_DIR}/${key}`) and a shell-quoted mkdir, so strip any
  // special character that could slip past execSync's naive quoting.
  const safeHost = proxy.host.replace(/[^a-zA-Z0-9]/g, '_');
  const safePort = String(proxy.port || 8080).replace(/[^0-9]/g, '');
  let key = `px_${safeHost}_${safePort}`;
  // v2.0.68/v2.0.71 (#119 CharwinYAO): sticky-IP proxy services (ipwo,
  // lunaproxy, smartproxy, oxylabs, bright data) embed a per-IP session
  // id inside the username. Default behaviour pools all sticky sessions
  // onto one LS instance (host:port identical) so multiple accounts
  // share one LS sessionId / Windsurf fingerprint, tripping upstream's
  // 30-min rate limit even though egress IPs differ.
  //
  // Auto-on (v2.0.71): username matches a known sticky session pattern
  // (`_sid_`, `-session-`, `-sticky`, `-sessid-`, `+ws_`) → segregate.
  // Static-IP proxies don't carry these markers so memory stays bounded.
  // Operator can force-on (`WINDSURFAPI_LS_PER_PROXY_USER=1`) to
  // segregate every distinct username, or force-off (`=0`) to disable.
  let segregateByUser = false;
  if (process.env.WINDSURFAPI_LS_PER_PROXY_USER === '0') {
    segregateByUser = false;
  } else if (process.env.WINDSURFAPI_LS_PER_PROXY_USER === '1') {
    segregateByUser = !!proxy.username;
  } else if (proxy.username && isStickyUsername(proxy.username)) {
    segregateByUser = true;
  }
  if (segregateByUser) {
    // Cap user portion at 32 chars to keep filesystem paths sane on
    // Windows where MAX_PATH still bites; sticky session ids are
    // typically <16 chars anyway.
    const safeUser = String(proxy.username).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
    if (safeUser) key += `_u${safeUser}`;
  }
  return key;
}

function publicLsKey(key) {
  const s = String(key || '');
  const m = s.match(/^(px_.+_[0-9]+)_u[A-Za-z0-9_]{1,32}$/);
  return m ? `${m[1]}_u_redacted` : s;
}

export function defaultLsDataRoot(platform = process.platform, home = process.env.HOME) {
  return platform === 'darwin'
    ? posix.join(home || '.', '.windsurf', 'data')
    : DEFAULT_LINUX_DATA_ROOT;
}

function dataDirForKey(key) {
  const root = process.env.LS_DATA_DIR
    ? resolve(process.cwd(), process.env.LS_DATA_DIR)
    : defaultLsDataRoot();
  return `${root}/${key}`;
}

function proxyUrl(proxy) {
  if (!proxy || !proxy.host) return null;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `http://${auth}${proxy.host}:${proxy.port || 8080}`;
}

function touchEntry(entry) {
  if (!entry) return;
  const now = Date.now();
  entry.lastUsedAt = now;
  entry._evictAt = now;
}

function markIntentionalShutdown(entryOrProc) {
  const proc = entryOrProc?.process || entryOrProc;
  if (proc && typeof proc === 'object') _intentionalShutdownProcs.add(proc);
}

function isIntentionalShutdown(proc) {
  return !!proc && _intentionalShutdownProcs.has(proc);
}

function clearIntentionalShutdown(proc) {
  try { if (proc) _intentionalShutdownProcs.delete(proc); } catch {}
}

function keyByPort(port) {
  for (const [key, entry] of _pool) {
    if (entry?.port === port) return key;
  }
  return '';
}

export function beginLsUse(port) {
  const entry = getLsEntryByPort(port);
  if (!entry) return null;
  const key = keyByPort(port);
  if (key && (_maintenanceUses.get(key) || 0) > 0) return null;
  entry.activeRequests = (entry.activeRequests || 0) + 1;
  touchEntry(entry);
  return entry;
}

export function endLsUse(port) {
  const entry = getLsEntryByPort(port);
  if (!entry) return;
  entry.activeRequests = Math.max(0, (entry.activeRequests || 0) - 1);
  touchEntry(entry);
}

export function beginLsMaintenanceUse(port) {
  const entry = getLsEntryByPort(port);
  if (!entry) return null;
  if ((entry.activeRequests || 0) > 0) return null;
  const key = keyByPort(port);
  if (!key) return null;
  if ((_maintenanceUses.get(key) || 0) > 0) return null;
  _maintenanceUses.set(key, (_maintenanceUses.get(key) || 0) + 1);
  touchEntry(entry);
  return { key, port, generation: entry.generation };
}

export function endLsMaintenanceUse(token) {
  const key = token?.key || '';
  if (!key) return;
  const n = (_maintenanceUses.get(key) || 0) - 1;
  if (n > 0) _maintenanceUses.set(key, n);
  else _maintenanceUses.delete(key);
  const entry = _pool.get(key);
  if (entry) touchEntry(entry);
}

export function getLsMaintenanceRequests(proxy = null) {
  return _maintenanceUses.get(proxyKey(proxy)) || 0;
}

function invalidateEntryForShutdown(entry) {
  if (!entry?.port) return;
  closeSessionForPort(entry.port);
  import('./conversation-pool.js')
    .then(m => m.invalidateFor({ lsPort: entry.port, lsGeneration: entry.generation }))
    .catch(() => {});
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function admissionEvent(fields = {}) {
  const at = Date.now();
  return { at, atIso: new Date(at).toISOString(), ...fields };
}

function safeAdmissionMessage(err) {
  const s = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
  return s.length > 320 ? `${s.slice(0, 317)}...` : s;
}

function cloneAdmissionEvent(event) {
  if (!event) return null;
  const copy = { ...event };
  if (copy.memoryGuard) copy.memoryGuard = { ...copy.memoryGuard };
  return copy;
}

function admissionStatsSnapshot() {
  return {
    startAttempts: _admissionStats.startAttempts,
    startSuccesses: _admissionStats.startSuccesses,
    startFailures: _admissionStats.startFailures,
    poolWaits: _admissionStats.poolWaits,
    memoryWaits: _admissionStats.memoryWaits,
    poolExhausted: _admissionStats.poolExhausted,
    memoryGuardBlocks: _admissionStats.memoryGuardBlocks,
    evictions: _admissionStats.evictions,
    lastAttempt: cloneAdmissionEvent(_admissionStats.lastAttempt),
    lastSuccess: cloneAdmissionEvent(_admissionStats.lastSuccess),
    lastFailure: cloneAdmissionEvent(_admissionStats.lastFailure),
    lastWait: cloneAdmissionEvent(_admissionStats.lastWait),
    lastEviction: cloneAdmissionEvent(_admissionStats.lastEviction),
  };
}

function recordAdmissionWait(kind, key, extra = {}) {
  if (kind === 'pool_capacity') _admissionStats.poolWaits++;
  if (kind === 'memory_guard') _admissionStats.memoryWaits++;
  _admissionStats.lastWait = admissionEvent({ kind, key: publicLsKey(key), ...extra });
}

function recordAdmissionFailure(kind, key, err, extra = {}) {
  if (kind === 'pool_capacity') _admissionStats.poolExhausted++;
  if (kind === 'memory_guard') _admissionStats.memoryGuardBlocks++;
  const errorType = err?.type || (err?.code === 'LS_MEMORY_GUARD' ? 'ls_memory_guard' : null) || (err?.code === 'LS_POOL_EXHAUSTED' ? 'ls_pool_exhausted' : null) || 'ls_start_failed';
  _admissionStats.lastFailure = admissionEvent({
    kind,
    key: publicLsKey(key),
    errorType,
    code: err?.code || null,
    message: safeAdmissionMessage(err),
    ...extra,
  });
}

function recordStartAttempt(key, extra = {}) {
  _admissionStats.startAttempts++;
  _admissionStats.lastAttempt = admissionEvent({ key: publicLsKey(key), ...extra });
}

function recordStartSuccess(key, extra = {}) {
  _admissionStats.startSuccesses++;
  _admissionStats.lastSuccess = admissionEvent({ key: publicLsKey(key), ...extra });
}

function recordStartFailure(key, err, extra = {}) {
  _admissionStats.startFailures++;
  recordAdmissionFailure('start_failed', key, err, extra);
}

async function waitPortReadyOrProcessExit(proc, port, timeoutMs) {
  let cleanup = () => {};
  const procFailure = new Promise((resolve, reject) => {
    try {
      const onError = (err) => reject(err);
      const onExit = (code, signal) => {
        reject(new Error(`LS process exited before ready: code=${code} signal=${signal}`));
      };
      proc.once('error', onError);
      proc.once('exit', onExit);
      cleanup = () => {
        try { proc.off?.('error', onError); } catch {}
        try { proc.off?.('exit', onExit); } catch {}
      };
    } catch (e) {
      reject(e);
    }
  });
  try {
    return await Promise.race([waitPortReady(port, timeoutMs), procFailure]);
  } finally {
    cleanup();
  }
}

function withStartAdmissionLock(fn) {
  const prev = _startAdmissionQueue;
  let release;
  _startAdmissionQueue = new Promise(resolve => { release = resolve; });
  return (async () => {
    try { await prev; } catch {}
    try { return await fn(); }
    finally { release(); }
  })();
}

function poolOccupancy() {
  return _pool.size + _stopping.size;
}

function pendingStartReservationCount({ excludeKey = '', beforeSeq = Infinity } = {}) {
  let count = 0;
  for (const [key, seq] of _pendingStartSeq) {
    if (key === excludeKey) continue;
    if (_pool.has(key)) continue;
    if (seq < beforeSeq) count++;
  }
  return count;
}

function poolOccupancyWithPendingReservations(opts = {}) {
  return poolOccupancy() + pendingStartReservationCount(opts);
}

function activeSpawnReservationCount(opts = {}) {
  const { excludeKey = '', beforeSeq = Infinity } = typeof opts === 'string'
    ? { excludeKey: opts, beforeSeq: Infinity }
    : opts;
  let count = 0;
  for (const [key, entry] of _pool) {
    if (key === excludeKey) continue;
    if (entry && !entry.ready) count++;
  }
  count += pendingStartReservationCount({ excludeKey, beforeSeq });
  return count;
}

export function hasLsPoolCapacityForStart(effectiveOccupancy, maxInstances = MAX_LS_INSTANCES, evictableSlots = 0) {
  const effective = Math.max(0, Number(effectiveOccupancy) || 0);
  const max = Math.max(1, Number(maxInstances) || 1);
  const evictable = Math.max(0, Number(evictableSlots) || 0);
  return effective < max || effective - evictable < max;
}

const LS_EVICT_READY_GRACE_MS = positiveIntEnv('LS_EVICT_READY_GRACE_MS', 5000, 0);

function getIdleNonDefaultEvictionCandidates() {
  const candidates = [];
  const now = Date.now();
  for (const [k, e] of _pool) {
    if (k === 'default') continue;
    if (!e?.ready) continue;
    if ((e.activeRequests || 0) > 0) continue;
    if ((_maintenanceUses.get(k) || 0) > 0) continue;
    if (e.readyAt && now - e.readyAt < LS_EVICT_READY_GRACE_MS) continue;
    const at = e.lastUsedAt || e._evictAt || e.startedAt || 0;
    candidates.push({
      key: k,
      entry: e,
      at,
      idleMs: e?.lastUsedAt ? Math.max(0, now - e.lastUsedAt) : null,
    });
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates;
}

function findIdleNonDefaultEvictionCandidate() {
  return getIdleNonDefaultEvictionCandidates()[0] || null;
}

function countIdleNonDefaultEvictionCandidates() {
  return getIdleNonDefaultEvictionCandidates().length;
}

async function waitProcessExit(proc, timeoutMs) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return 'already_exited';
  return new Promise(resolve => {
    let settled = false;
    const done = (how) => {
      if (settled) return;
      settled = true;
      try { proc.off?.('exit', onExit); } catch {}
      clearTimeout(timer);
      resolve(how);
    };
    const onExit = () => done('exited');
    try { proc.once('exit', onExit); } catch { return done('no_listener'); }
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    try { timer.unref?.(); } catch {}
  });
}

async function evictLruIdleNonDefault() {
  const candidate = findIdleNonDefaultEvictionCandidate();
  if (!candidate) return null;
  const { key: lruKey, entry: evicted } = candidate;
  _stopping.set(lruKey, { at: Date.now(), pid: evicted?.process?.pid || null, reason: 'evicted' });
  _pool.delete(lruKey);
  _maintenanceUses.delete(lruKey);
  markIntentionalShutdown(evicted);
  invalidateEntryForShutdown(evicted);
  try { evicted?.process?.kill('SIGTERM'); } catch {}
  let how = await waitProcessExit(evicted?.process, 1500);
  if (how === 'timeout') {
    try { evicted?.process?.kill('SIGKILL'); } catch {}
    how = await waitProcessExit(evicted?.process, 500);
  }
  _stopping.delete(lruKey);
  _admissionStats.evictions++;
  _admissionStats.lastEviction = admissionEvent({
    key: publicLsKey(lruKey),
    pid: evicted?.process?.pid || null,
    exit: how,
    startedAt: evicted?.startedAt || null,
  });
  log.warn(`LS pool at cap (${MAX_LS_INSTANCES}), evicted LRU instance ${lruKey} (${how}; started ${evicted?.startedAt ? new Date(evicted.startedAt).toISOString() : '?'})`);
  if (!lruKey) return null;
  return lruKey;
}

function hasIdleNonDefaultInstance() {
  return !!findIdleNonDefaultEvictionCandidate();
}

function memoryGuardSnapshot() {
  const limit = detectMemoryLimitBytes();
  const current = detectMemoryCurrentBytes();
  const cgroupAvailableBytes = Number.isFinite(limit) && Number.isFinite(current)
    ? Math.max(0, limit - current)
    : null;
  const hostAvailableBytes = detectHostMemAvailableBytes();
  const candidates = [cgroupAvailableBytes, hostAvailableBytes]
    .filter(n => Number.isFinite(n) && n >= 0);
  return {
    enabled: LS_MEMORY_GUARD_ENABLED,
    configuredMinAvailableBytes: LS_SPAWN_MIN_AVAILABLE_BYTES,
    cgroupAvailableBytes,
    hostAvailableBytes,
    availableBytes: candidates.length ? Math.min(...candidates) : null,
  };
}

function observedLsRssEstimateBytes(now = Date.now()) {
  const rssByRootPid = collectTrackedRssSnapshot(now);
  const samples = [];
  for (const entry of _pool.values()) {
    if (!entry?.ready) continue;
    const pid = entry.process?.pid;
    const rssBytes = pid ? rssByRootPid.get(pid)?.rssBytes : null;
    if (Number.isFinite(rssBytes) && rssBytes > 0) samples.push(rssBytes);
  }
  if (!samples.length) return null;
  const maxObserved = Math.max(...samples);
  const withMargin = Math.ceil(maxObserved * (100 + LS_OBSERVED_RSS_MARGIN_PERCENT) / 100);
  return Math.max(LS_OBSERVED_RSS_MIN_BYTES, withMargin);
}

function effectiveLsSpawnEstimate(now = Date.now()) {
  const observedRssEstimateBytes = observedLsRssEstimateBytes(now);
  if (LS_SPAWN_MIN_AVAILABLE_BYTES_EXPLICIT) {
    return {
      estimateBytes: LS_SPAWN_MIN_AVAILABLE_BYTES,
      minAvailableBytes: LS_SPAWN_MIN_AVAILABLE_BYTES,
      source: 'env',
      observedRssEstimateBytes,
    };
  }
  if (Number.isFinite(observedRssEstimateBytes) && observedRssEstimateBytes > 0) {
    return {
      estimateBytes: observedRssEstimateBytes,
      minAvailableBytes: observedRssEstimateBytes,
      source: 'observed_rss',
      observedRssEstimateBytes,
    };
  }
  return {
    estimateBytes: DEFAULT_LS_RSS_ESTIMATE_BYTES,
    minAvailableBytes: DEFAULT_LS_RSS_ESTIMATE_BYTES,
    source: 'default_estimate',
    observedRssEstimateBytes: null,
  };
}

export function getLsMemoryGuardStatus({ reservedStarts = 0 } = {}) {
  const snap = memoryGuardSnapshot();
  const spawnEstimate = effectiveLsSpawnEstimate();
  const availableBytes = snap.availableBytes == null
    ? null
    : Math.max(0, snap.availableBytes - (Math.max(0, reservedStarts) * spawnEstimate.estimateBytes));
  return {
    ...snap,
    reservedStarts,
    minAvailableBytes: spawnEstimate.minAvailableBytes,
    estimatedRssBytesPerInstance: spawnEstimate.estimateBytes,
    observedRssEstimateBytes: spawnEstimate.observedRssEstimateBytes,
    minAvailableBytesSource: spawnEstimate.source,
    observedRssMinBytes: LS_OBSERVED_RSS_MIN_BYTES,
    observedRssMarginPercent: LS_OBSERVED_RSS_MARGIN_PERCENT,
    availableBytes,
    okToSpawn: !snap.enabled || availableBytes == null || availableBytes >= spawnEstimate.minAvailableBytes,
  };
}

function getLsPoolSummary(now = Date.now()) {
  let ready = 0;
  let starting = 0;
  let activeRequests = 0;
  let nonDefaultInstances = 0;
  let defaultRunning = false;
  for (const [key, entry] of _pool) {
    if (key === 'default') defaultRunning = true;
    else nonDefaultInstances++;
    if (entry?.ready) ready++;
    else starting++;
    activeRequests += entry?.activeRequests || 0;
  }
  let maintenanceRequests = 0;
  for (const n of _maintenanceUses.values()) maintenanceRequests += Math.max(0, n || 0);
  const pendingKeys = Array.from(_pending.keys()).map(publicLsKey);
  const stoppingInstances = Array.from(_stopping.entries()).map(([key, entry]) => ({
    key: publicLsKey(key),
    pid: entry?.pid || null,
    reason: entry?.reason || null,
    at: entry?.at || null,
    ageMs: entry?.at ? Math.max(0, now - entry.at) : null,
  }));
  const evictionCandidate = findIdleNonDefaultEvictionCandidate();
  const evictionCandidateCount = countIdleNonDefaultEvictionCandidates();
  const occupancy = poolOccupancy();
  const reservedPendingStarts = pendingStartReservationCount();
  const effectiveOccupancy = occupancy + reservedPendingStarts;
  const memoryGuard = getLsMemoryGuardStatus({ reservedStarts: activeSpawnReservationCount() });
  const poolHasCapacity = hasLsPoolCapacityForStart(effectiveOccupancy, MAX_LS_INSTANCES, evictionCandidateCount);
  const memoryOk = memoryGuard.okToSpawn || memoryGuard.availableBytes == null || !LS_MEMORY_GUARD_ENABLED;
  const blockReason = !memoryOk
    ? 'memory_guard'
    : !poolHasCapacity
      ? 'pool_full_no_idle'
      : null;
  return {
    size: _pool.size,
    occupancy,
    effectiveOccupancy,
    maxInstances: MAX_LS_INSTANCES,
    ready,
    starting,
    pending: _pending.size,
    reservedPendingStarts,
    pendingKeys,
    stopping: _stopping.size,
    stoppingInstances,
    activeRequests,
    maintenanceRequests,
    nonDefaultInstances,
    defaultRunning,
    idleEvictable: !!evictionCandidate,
    idleEvictableCount: evictionCandidateCount,
    evictionCandidateKey: evictionCandidate?.key ? publicLsKey(evictionCandidate.key) : null,
    canStartNewNonDefault: !blockReason,
    blockReason,
    memoryGuard,
  };
}

export function getLsAdmissionStatus(proxy = null) {
  const key = proxyKey(proxy);
  const existing = _pool.get(key);
  const pending = _pending.has(key);
  const occupancy = poolOccupancy();
  const effectiveOccupancy = poolOccupancyWithPendingReservations({ excludeKey: key });
  const evictionCandidate = findIdleNonDefaultEvictionCandidate();
  const evictionCandidateCount = countIdleNonDefaultEvictionCandidates();
  const memoryGuard = getLsMemoryGuardStatus({ reservedStarts: activeSpawnReservationCount({ excludeKey: key }) });
  if (existing?.ready) {
    const maintenanceRequests = _maintenanceUses.get(key) || 0;
    return {
      ok: true,
      wouldStart: false,
      errorType: null,
      reason: 'already_running',
      key,
      poolSize: occupancy,
      effectivePoolSize: effectiveOccupancy,
      maxInstances: MAX_LS_INSTANCES,
      pending,
      port: existing.port || null,
      generation: existing.generation || null,
      activeRequests: existing.activeRequests || 0,
      maintenanceRequests,
      memoryGuard,
    };
  }
  if (pending) {
    return {
      ok: true,
      wouldStart: false,
      errorType: null,
      reason: 'start_pending',
      key,
      poolSize: occupancy,
      effectivePoolSize: effectiveOccupancy,
      maxInstances: MAX_LS_INSTANCES,
      pending,
      memoryGuard,
    };
  }
  if (key !== 'default' && LS_MEMORY_GUARD_ENABLED && memoryGuard.availableBytes != null && !memoryGuard.okToSpawn) {
    return {
      ok: false,
      wouldStart: true,
      errorType: 'ls_memory_guard',
      reason: 'memory_guard',
      key,
      poolSize: occupancy,
      effectivePoolSize: effectiveOccupancy,
      maxInstances: MAX_LS_INSTANCES,
      pending,
      memoryGuard,
    };
  }
  if (key !== 'default' && !hasLsPoolCapacityForStart(effectiveOccupancy, MAX_LS_INSTANCES, evictionCandidateCount)) {
    return {
      ok: false,
      wouldStart: true,
      errorType: 'ls_pool_exhausted',
      reason: 'pool_full_no_idle',
      key,
      poolSize: occupancy,
      effectivePoolSize: effectiveOccupancy,
      maxInstances: MAX_LS_INSTANCES,
      pending,
      memoryGuard,
    };
  }
  return {
    ok: true,
    wouldStart: true,
    errorType: null,
    reason: 'can_start',
    key,
    poolSize: occupancy,
    effectivePoolSize: effectiveOccupancy,
    maxInstances: MAX_LS_INSTANCES,
    pending,
    poolFull: effectiveOccupancy >= MAX_LS_INSTANCES,
    willEvict: key !== 'default' && effectiveOccupancy >= MAX_LS_INSTANCES && !!evictionCandidate,
    idleEvictableCount: evictionCandidateCount,
    evictionCandidateKey: key !== 'default' && effectiveOccupancy >= MAX_LS_INSTANCES ? evictionCandidate?.key || null : null,
    memoryGuard,
  };
}

async function waitForPoolCapacity(key, pendingStartSeq = Infinity) {
  const start = Date.now();
  let logged = false;
  while (poolOccupancyWithPendingReservations({ excludeKey: key, beforeSeq: pendingStartSeq }) >= MAX_LS_INSTANCES) {
    if (await evictLruIdleNonDefault()) continue;
    const remaining = LS_POOL_WAIT_MS - (Date.now() - start);
    if (remaining <= 0) {
      const err = lsPoolExhaustedError(`LS pool at cap (${MAX_LS_INSTANCES}) and no idle non-default instance became evictable within ${LS_POOL_WAIT_MS}ms`);
      recordAdmissionFailure('pool_capacity', key, err, {
        poolSize: poolOccupancy(),
        effectivePoolSize: poolOccupancyWithPendingReservations({ excludeKey: key, beforeSeq: pendingStartSeq }),
        maxInstances: MAX_LS_INSTANCES,
      });
      throw err;
    }
    if (!logged) {
      logged = true;
      recordAdmissionWait('pool_capacity', key, {
        poolSize: poolOccupancy(),
        effectivePoolSize: poolOccupancyWithPendingReservations({ excludeKey: key, beforeSeq: pendingStartSeq }),
        maxInstances: MAX_LS_INSTANCES,
        waitMs: LS_POOL_WAIT_MS,
      });
      log.info(`LS pool at cap (${MAX_LS_INSTANCES}); waiting up to ${LS_POOL_WAIT_MS}ms for an active non-default instance to go idle`);
    }
    await delay(Math.min(500, remaining));
    const existing = _pool.get(key);
    if (existing?.ready) return;
  }
}

function isDefaultBootstrapStart(key) {
  return key === 'default' && poolOccupancy() === 0;
}

async function waitForMemoryHeadroom(key, pendingStartSeq = Infinity) {
  // Bootstrap exception: if no LS exists yet, allow the default instance to
  // start so low-memory single-replica deployments do not fail closed before
  // we have an observed RSS estimate. Once any LS/stopping reservation exists,
  // default is guarded like every other instance.
  if (isDefaultBootstrapStart(key)) return;
  if (!LS_MEMORY_GUARD_ENABLED) return;
  const start = Date.now();
  let logged = false;
  while (true) {
    const snap = getLsMemoryGuardStatus({
      reservedStarts: activeSpawnReservationCount({ excludeKey: key, beforeSeq: pendingStartSeq }),
    });
    if (snap.availableBytes == null || snap.availableBytes >= snap.minAvailableBytes) return;
    const remaining = LS_POOL_WAIT_MS - (Date.now() - start);
    if (remaining <= 0) {
      const err = lsPoolExhaustedError(`LS memory guard blocked new instance ${key}: available=${snap.availableBytes} min=${snap.minAvailableBytes}`);
      err.type = 'ls_memory_guard';
      err.code = 'LS_MEMORY_GUARD';
      recordAdmissionFailure('memory_guard', key, err, { memoryGuard: snap });
      throw err;
    }
    if (!logged) {
      logged = true;
      recordAdmissionWait('memory_guard', key, { memoryGuard: snap, waitMs: LS_POOL_WAIT_MS });
      log.info(`LS memory guard delaying ${key}: available=${snap.availableBytes} min=${snap.minAvailableBytes}`);
    }
    await delay(Math.min(500, remaining));
  }
}

export function sweepIdleLanguageServers(now = Date.now()) {
  if (!LS_IDLE_TTL_MS) return { scanned: _pool.size, stopped: 0, ttlMs: LS_IDLE_TTL_MS };
  let stopped = 0;
  for (const [key, entry] of _pool) {
    if (key === 'default') continue;
    if (!entry?.ready) continue;
    if ((entry.activeRequests || 0) > 0) continue;
    if ((_maintenanceUses.get(key) || 0) > 0) continue;
    const last = entry.lastUsedAt || entry.startedAt || now;
    if (now - last < LS_IDLE_TTL_MS) continue;
    markIntentionalShutdown(entry);
    try { entry.process?.kill('SIGTERM'); } catch {}
    invalidateEntryForShutdown(entry);
    _pool.delete(key);
    stopped++;
    log.info(`LS idle reaper stopped ${key} after ${Math.round((now - last) / 1000)}s idle`);
  }
  return { scanned: _pool.size + stopped, stopped, ttlMs: LS_IDLE_TTL_MS };
}

function ensureIdleSweeper() {
  if (_idleSweepTimer || !LS_IDLE_SWEEP_MS) return;
  _idleSweepTimer = setInterval(() => {
    try { sweepIdleLanguageServers(); } catch (e) { log.warn(`LS idle reaper: ${e.message}`); }
  }, LS_IDLE_SWEEP_MS);
  try { _idleSweepTimer.unref(); } catch {}
}

function collectTrackedRssSnapshot(now = Date.now()) {
  const trackedPids = new Set();
  for (const entry of _pool.values()) {
    const pid = entry?.process?.pid;
    if (Number.isInteger(pid) && pid > 0) trackedPids.add(pid);
  }
  const pidKey = [...trackedPids].sort((a, b) => a - b).join(',');
  if (!trackedPids.size) {
    _rssSnapshot = { at: now, pidKey, byRootPid: new Map() };
    return _rssSnapshot.byRootPid;
  }
  if (_rssSnapshot.pidKey === pidKey && now - _rssSnapshot.at < RSS_SNAPSHOT_TTL_MS) return _rssSnapshot.byRootPid;
  if (process.platform === 'win32') {
    _rssSnapshot = { at: now, pidKey, byRootPid: new Map() };
    return _rssSnapshot.byRootPid;
  }

  try {
    const out = execSync('ps -e -o pid=,ppid=,rss=', { timeout: 3000, encoding: 'utf-8' });
    const childrenByParent = new Map();
    const rssByPid = new Map();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const ppid = parseInt(m[2], 10);
      const rssKb = parseInt(m[3], 10);
      rssByPid.set(pid, rssKb);
      if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
      childrenByParent.get(ppid).push(pid);
    }

    const byRootPid = new Map();
    for (const rootPid of trackedPids) {
      let rssKb = 0;
      let processCount = 0;
      const seen = new Set();
      const stack = [rootPid];
      while (stack.length) {
        const pid = stack.pop();
        if (!Number.isInteger(pid) || seen.has(pid)) continue;
        seen.add(pid);
        if (rssByPid.has(pid)) {
          rssKb += rssByPid.get(pid) || 0;
          processCount++;
        }
        for (const child of (childrenByParent.get(pid) || [])) stack.push(child);
      }
      if (processCount > 0) byRootPid.set(rootPid, {
        rssKb,
        rssBytes: rssKb * 1024,
        processCount,
      });
    }
    _rssSnapshot = { at: now, pidKey, byRootPid };
  } catch (e) {
    _rssSnapshot = { at: now, pidKey, byRootPid: new Map() };
    log.debug(`LS RSS snapshot unavailable: ${e.message}`);
  }
  return _rssSnapshot.byRootPid;
}

function lsStatusConfig() {
  const memoryGuard = getLsMemoryGuardStatus();
  return {
    maxInstances: MAX_LS_INSTANCES,
    poolWaitMs: LS_POOL_WAIT_MS,
    idleTtlMs: LS_IDLE_TTL_MS,
    idleSweepMs: LS_IDLE_SWEEP_MS,
    estimatedRssBytesPerInstance: DEFAULT_LS_RSS_ESTIMATE_BYTES,
    effectiveEstimatedRssBytesPerInstance: memoryGuard.estimatedRssBytesPerInstance,
    systemMemoryBytes: totalmem(),
    detectedMemoryLimitBytes: detectMemoryLimitBytes(),
    memoryGuard,
  };
}

export function shouldPrewarmDefaultLs() {
  return process.env.LS_PREWARM_DEFAULT !== '0' && MAX_LS_INSTANCES > 1;
}

export function classifyLanguageServerStderr(line) {
  const s = String(line || '').trim();
  if (!s) return 'debug';
  if (/(?:^|\s)E\d{4}\s|\b(?:FATAL|PANIC|CRITICAL|ERROR|ERR)\b/i.test(s)) return 'error';
  if (/(?:^|\s)W\d{4}\s|\b(?:WARN|WARNING)\b/i.test(s)) return 'warn';
  if (/\b(?:failed|failure|exception|denied|refused|timed?\s*out|not found|cannot|could not|invalid|unavailable|crash|segmentation fault)\b/i.test(s)) return 'warn';
  return 'info';
}

// Pass only what the LS binary actually needs to its child env. Forwarding
// the full process.env exposed unrelated proxy secrets / build env / CI
// tokens to a binary we don't fully control. Allowlist covers HOME (asset
// paths), PATH (subprocess discovery), LANG/locale, TMPDIR, and the proxy
// vars that the LS reads to dial out.
const LS_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  // SSL trust roots — without these LS can fail to verify the upstream
  // Codeium endpoint on hardened hosts.
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];

export function buildLanguageServerEnv(source = process.env, options = {}) {
  const env = {};
  for (const key of LS_ENV_ALLOWLIST) {
    if (source[key] != null && source[key] !== '') env[key] = source[key];
  }
  // Fall back to /root only when HOME isn't already set (e.g. a systemd
  // unit without User=). VPS deployments already have HOME in env; forcing
  // /root broke macOS/Windows dev runs where LS expects the real $HOME.
  if (!env.HOME) env.HOME = source.HOME || '/root';
  const pUrl = options.proxyUrl || null;
  if (pUrl) {
    env.HTTPS_PROXY = pUrl;
    env.HTTP_PROXY = pUrl;
    env.https_proxy = pUrl;
    env.http_proxy = pUrl;
  }
  return env;
}

export function redactProxyUrl(urlOrProxy) {
  if (!urlOrProxy) return 'none';
  if (typeof urlOrProxy === 'object') {
    const host = urlOrProxy.host || '';
    const port = urlOrProxy.port || 8080;
    return `${host}:${port}${urlOrProxy.username ? ' (auth=true)' : ''}`;
  }
  try {
    const u = new URL(String(urlOrProxy));
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}${u.username || u.password ? ' (auth=true)' : ''}`;
  } catch {
    return String(urlOrProxy).replace(/\/\/([^:@/\s]+):([^@/\s]*)@/g, '//***:***@');
  }
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy(); resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

export function probeLanguageServerPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const client = http2.connect(`http://localhost:${port}`);
    let settled = false;
    let req = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req?.close(); } catch {}
      try { client.close(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.on('error', () => finish(false));
    client.on('connect', () => {
      try {
        req = client.request({
          ':method': 'GET',
          ':path': '/exa.language_server_pb.LanguageServerService/GetUserStatus',
          'x-codeium-csrf-token': DEFAULT_CSRF,
        });
        req.on('response', (headers) => {
          const contentType = String(headers['content-type'] || '').toLowerCase();
          const server = String(headers.server || '').toLowerCase();
          const hasGrpcStatus = headers['grpc-status'] != null || headers['grpc-message'] != null;
          const looksLikeLs = hasGrpcStatus
            || contentType.includes('grpc')
            || contentType.includes('connect')
            || /grpc|connect/.test(server);
          finish(looksLikeLs);
        });
        req.on('error', () => finish(false));
        req.on('end', () => finish(false));
        req.end();
      } catch {
        finish(false);
      }
    });
  });
}

async function waitPortReady(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const client = http2.connect(`http://localhost:${port}`);
        const timer = setTimeout(() => { try { client.close(); } catch {} reject(new Error('timeout')); }, 2000);
        client.on('connect', () => { clearTimeout(timer); client.close(); resolve(); });
        client.on('error', (e) => { clearTimeout(timer); try { client.close(); } catch {} reject(e); });
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`LS port ${port} not ready after ${timeoutMs}ms`);
}

/**
 * Spawn an LS instance for the given proxy (or no-proxy default).
 * Idempotent — returns the existing entry if one is already running.
 */
export async function ensureLs(proxy = null) {
  ensureIdleSweeper();
  const key = proxyKey(proxy);
  const existing = _pool.get(key);
  if (existing && existing.ready) {
    touchEntry(existing);
    return existing;
  }

  // Coalesce concurrent callers onto a single spawn. The chat handlers
  // call ensureLs(acct.proxy) on every request; before this guard, a burst
  // of requests for a never-seen proxy would spawn N LS processes that
  // all tried to bind the same _nextPort.
  const pending = _pending.get(key);
  if (pending) return pending;

  const pendingStartSeq = _nextPendingStartSeq++;
  _pendingStartSeq.set(key, pendingStartSeq);
  const promise = (async () => {
    let entry = null;
    let reservedByThisCall = false;
    let attemptedStart = false;
    await withStartAdmissionLock(async () => {
      await waitForPoolCapacity(key, pendingStartSeq);
      await waitForMemoryHeadroom(key, pendingStartSeq);
      const nowExisting = _pool.get(key);
      if (nowExisting?.ready) {
        touchEntry(nowExisting);
        entry = nowExisting;
        return;
      }
      entry = nowExisting || {
        key,
        proxy,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        activeRequests: 0,
        ready: false,
        generation: randomUUID(),
        workspaceInit: null,
        sessionId: null,
      };
      if (!nowExisting) {
        reservedByThisCall = true;
        _pool.set(key, entry);
      }
    });
    if (entry?.ready) return entry;

    try {
      attemptedStart = true;
      recordStartAttempt(key, { poolSize: poolOccupancy(), maxInstances: MAX_LS_INSTANCES, reservedByThisCall });
      const isDefault = key === 'default';
      let port = isDefault ? DEFAULT_PORT : _nextPort++;

    // If something is already listening on the default port, NEVER adopt
    // blindly — even a probe-based gRPC signature is spoofable by any local
    // process serving HTTP/2 with a `server: *grpc*` header (verified). The
    // adoption flow used to send account API keys to whatever was listening,
    // which is unacceptable for a public-facing proxy. Instead, walk to the
    // next free port and spawn a fresh LS there. Operator gives up the
    // post-crash "adopt the orphan" convenience; in exchange, a malicious or
    // accidental local process can no longer receive credentials.
    if (isDefault && await isPortInUse(port)) {
      log.warn(`LS default port ${port} already in use; starting LS on next free port instead of adopting (security)`);
      do {
        port = _nextPort++;
      } while (await isPortInUse(port));
    }

    // Non-default ports: skip anything already bound. A PM2 restart can
    // race the old LS's TCP teardown — if we spawn while the dying
    // process still owns 42101, waitPortReady would succeed by connecting
    // to the corpse and every request would hang. Advance _nextPort until
    // we find a free slot.
    if (!isDefault) {
      let tries = 0;
      while (await isPortInUse(port)) {
        if (++tries > 50) throw new Error(`No free port for LS in range starting ${DEFAULT_PORT + 1}`);
        log.debug(`LS port ${port} busy, advancing`);
        port = _nextPort++;
      }
    }

    const dataDir = dataDirForKey(key);
    try { mkdirSync(`${dataDir}/db`, { recursive: true }); } catch (e) { log.warn(`mkdirSync ${dataDir}/db: ${e.message}`); }

    const args = [
      `--api_server_url=${_apiServerUrl}`,
      `--server_port=${port}`,
      `--csrf_token=${DEFAULT_CSRF}`,
      `--register_user_url=https://api.codeium.com/register_user/`,
      `--codeium_dir=${dataDir}`,
      `--database_dir=${dataDir}/db`,
      '--detect_proxy=false',
    ];

    const pUrl = proxyUrl(proxy);
    const env = buildLanguageServerEnv(process.env, { proxyUrl: pUrl });

    // One-shot readable warning when the LS binary is missing — the generic
    // ENOENT from spawn leaves users guessing which file is expected.
    if (!existsSync(_binaryPath)) {
      log.error(
        `Language server binary not found at ${_binaryPath}. ` +
        `Install it with:  bash install-ls.sh  (or set LS_BINARY_PATH env var)`
      );
    }

    log.info(`Starting LS instance key=${key} port=${port} proxy=${redactProxyUrl(pUrl)}`);

    const proc = spawn(_binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    proc.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        if (/ERROR|error/.test(line)) log.error(`[LS:${key}] ${line}`);
        else log.debug(`[LS:${key}] ${line}`);
      }
    });
    proc.stderr.on('data', (data) => {
      const lines = data.toString().trim().split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        const level = classifyLanguageServerStderr(line);
        log[level](`[LS:${key}:stderr] ${line}`);
      }
    });
    proc.on('exit', (code, signal) => {
      log.warn(`LS instance ${key} exited: code=${code} signal=${signal}`);
      const current = _pool.get(key);
      const ownsEntry = current?.process === proc;
      const intentionalExit = isIntentionalShutdown(proc);
      if (!intentionalExit) {
        _admissionStats.lastFailure = admissionEvent({
          kind: 'process_exit',
          key: publicLsKey(key),
          errorType: 'ls_process_exit',
          code,
          signal,
          port,
          pid: proc.pid || null,
        });
      }
      if (code === 1) {
        log.error('LS crashed on startup. Common causes:');
        log.error('  1. Binary incompatible with this OS/arch — re-download with: bash install-ls.sh');
        log.error('  2. Missing glibc/libstdc++ — run: ldd ' + _binaryPath + ' | grep "not found"');
        log.error('  3. Binary corrupted — delete and re-download: rm ' + _binaryPath + ' && bash install-ls.sh');
        log.error('  4. Port already in use — check: lsof -i :' + port);
      }
      const gone = ownsEntry ? current : null;
      const goneGen = gone?.generation;
      const gonePort = gone?.port;
      if (ownsEntry) {
        _pool.delete(key);
        _maintenanceUses.delete(key);
      } else {
        log.debug(`Ignoring stale LS exit for ${key}; pool entry belongs to a newer generation`);
      }
      if (gonePort) {
        closeSessionForPort(gonePort);
        import('./conversation-pool.js').then(m => m.invalidateFor({ lsPort: gonePort, lsGeneration: goneGen })).catch(() => {});
      }

      // Auto-restart: respawn the LS after a brief backoff so pending
      // requests don't fail with ECONNRESET. Respects the retry cap and
      // tracks per-key restart attempts to avoid infinite loops on
      // permanent errors (e.g. missing binary, incompatible arch).
      // Skip when the exit was intentional (stopLanguageServer / restartLsForProxy).
      if (AUTO_RESTART_ENABLED && gone && !intentionalExit) {
        scheduleLsRestart(key, gone.proxy, gonePort);
      }
      clearIntentionalShutdown(proc);
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOEXEC') {
        const os = process.platform;
        log.error(
          `LS binary is not executable on this platform (${os}). ` +
          `The binary at ${_binaryPath} is likely built for a different OS/arch. ` +
          (os === 'darwin'
            ? 'You need the macOS build: copy language_server_macos_arm (Apple Silicon) or language_server_macos_x64 (Intel) from your Windsurf desktop app.'
            : os === 'win32'
              ? 'LS binary only runs on Linux. Use WSL2 or a Linux VM.'
              : `Ensure the binary matches your arch: ${process.arch}`)
        );
      } else {
        log.error(`LS instance ${key} spawn error: ${err.message}`);
      }
      if (_pool.get(key)?.process === proc) {
        _pool.delete(key);
        _maintenanceUses.delete(key);
      }
    });

    Object.assign(entry, {
      process: proc, port, csrfToken: DEFAULT_CSRF,
      proxy, lastUsedAt: Date.now(), activeRequests: entry.activeRequests || 0, ready: false,
      // v2.0.25 LOW-1: per-spawn UUID so the conversation pool can tell a
      // new LS that landed on the same port apart from the dead one. Used
      // by checkout(expected={lsGeneration}) and invalidateFor({lsGeneration}).
      generation: entry.generation || randomUUID(),
      // One-shot Cascade workspace init promise. cascadeChat() awaits this so
      // the heavy InitializePanelState / AddTrackedWorkspace / UpdateWorkspaceTrust
      // trio only runs once per LS lifetime instead of once per request.
      workspaceInit: entry.workspaceInit || null,
      sessionId: entry.sessionId || null,
    });

      try {
        await waitPortReadyOrProcessExit(proc, port, 25000);
        entry.ready = true;
        entry.readyAt = Date.now();
        touchEntry(entry);
        recordStartSuccess(key, { port, pid: proc.pid || null, readyMs: entry.readyAt - entry.startedAt });
        log.info(`LS instance ${key} ready on port ${port}`);
      } catch (err) {
        log.error(`LS instance ${key} failed to become ready: ${err.message}`);
      try { proc.kill('SIGKILL'); } catch {}
      if (_pool.get(key)?.process === proc) {
        _pool.delete(key);
        _maintenanceUses.delete(key);
      }
      _stopping.delete(key);
      throw err;
      }
    return entry;
    } catch (err) {
      if (reservedByThisCall && _pool.get(key) === entry && !entry?.process) {
        _pool.delete(key);
      }
      if (attemptedStart) recordStartFailure(key, err, { port: entry?.port || null, pid: entry?.process?.pid || null });
      throw err;
    }
  })();

  _pending.set(key, promise);
  try {
    return await promise;
  } finally {
    _pending.delete(key);
    _pendingStartSeq.delete(key);
  }
}

/**
 * Stop and remove the LS instance associated with a given proxy.
 * Used when a proxy is reassigned so the old egress no longer exists.
 */
export async function restartLsForProxy(proxy) {
  const key = proxyKey(proxy);
  const entry = _pool.get(key);
  if (!entry) return ensureLs(proxy);
  markIntentionalShutdown(entry);  // prevent auto-restart
  _stopping.set(key, { at: Date.now(), pid: entry?.process?.pid || null, reason: 'restart' });
  _pool.delete(key);
  _maintenanceUses.delete(key);
  if (entry?.port) {
    // v2.0.25 LOW-1: same-port LS replacement opens a window where stale
    // pool entries from the old LS could resume against the new LS's
    // session. Close the cached HTTP/2 session and invalidate this LS's
    // generation in the conversation pool synchronously, then spawn fresh.
    closeSessionForPort(entry.port);
    try {
      const m = await import('./conversation-pool.js');
      m.invalidateFor({ lsPort: entry.port, lsGeneration: entry.generation });
    } catch {}
  }
  try { entry?.process?.kill('SIGTERM'); } catch {}
  let how = await waitProcessExit(entry?.process, 1500);
  if (how === 'timeout') {
    try { entry?.process?.kill('SIGKILL'); } catch {}
    how = await waitProcessExit(entry?.process, 500);
  }
  _stopping.delete(key);
  log.info(`LS instance ${key} stopped for restart (${how})`);
  return ensureLs(proxy);
}

/**
 * Get the LS entry matching a proxy, or null if it hasn't been spawned.
 * Callers should `await ensureLs(proxy)` first — don't silently fall back
 * to the default LS, because that sends the request through the wrong
 * egress IP (Codeium will see the wrong source, invalidate the session,
 * and falsely mark the account expired).
 */
export function getLsFor(proxy) {
  const entry = _pool.get(proxyKey(proxy));
  if (entry) touchEntry(entry);
  return entry || null;
}

// ─── Auto-restart ─────────────────────────────────────────────

const _restartAttempts = new Map();

function scheduleLsRestart(key, proxy, oldPort) {
  const attempts = (_restartAttempts.get(key) || 0) + 1;
  if (attempts > AUTO_RESTART_MAX_RETRIES) {
    log.error(`LS auto-restart: ${key} exceeded max retries (${AUTO_RESTART_MAX_RETRIES}), giving up`);
    _restartAttempts.delete(key);
    return;
  }

  const delay = AUTO_RESTART_BASE_DELAY_MS * Math.pow(2, attempts - 1);
  _restartAttempts.set(key, attempts);

  log.info(`LS auto-restart: scheduling ${key} restart #${attempts} in ${delay}ms`);

  setTimeout(async () => {
    try {
      await ensureLs(proxy);
      _restartAttempts.delete(key);
      log.info(`LS auto-restart: ${key} restarted successfully (attempt #${attempts})`);
    } catch (err) {
      log.error(`LS auto-restart: ${key} restart #${attempts} failed: ${err.message}`);
      if (attempts < AUTO_RESTART_MAX_RETRIES) {
        scheduleLsRestart(key, proxy, oldPort);
      }
    }
  }, delay).unref();
}

export function getRestartStats() {
  const stats = {};
  for (const [key, attempts] of _restartAttempts) {
    stats[key] = attempts;
  }
  return stats;
}

/**
 * Look up an LS pool entry by its gRPC port. Used by WindsurfClient so it
 * can attach per-LS state (one-shot cascade workspace init, persistent
 * sessionId) without plumbing the entry through every call site.
 */
export function getLsEntryByPort(port) {
  for (const entry of _pool.values()) {
    if (entry.port === port) return entry;
  }
  return null;
}

/**
 * Iterate over live LS pool keys. Used by the dashboard binary-update
 * endpoint to restart every spawned instance after install-ls.sh
 * replaces the binary on disk.
 */
export function _poolKeys() {
  return [..._pool.keys()];
}

/**
 * Recover the proxy descriptor for a given pool key. Returns null for
 * the default no-proxy entry.
 */
export function getProxyByKey(key) {
  const entry = _pool.get(key);
  return entry?.proxy || null;
}

// ─── Backward-compat API ───────────────────────────────────

export function getLsPort() {
  return _pool.get('default')?.port || DEFAULT_PORT;
}
export function getCsrfToken() {
  return _pool.get('default')?.csrfToken || DEFAULT_CSRF;
}

export function configureLanguageServer(opts = {}) {
  _binaryPath = opts.binaryPath || process.env.LS_BINARY_PATH || _binaryPath;
  _apiServerUrl = opts.apiServerUrl || process.env.CODEIUM_API_URL || _apiServerUrl;
}

/**
 * Legacy entry point used by index.js — starts the default (no-proxy) LS.
 */
export async function startLanguageServer(opts = {}) {
  configureLanguageServer(opts);
  const def = await ensureLs(null);
  return { port: def.port, csrfToken: def.csrfToken };
}

/**
 * v2.0.85 (#127 123cek): scan host process table for orphan
 * `language_server_linux_x64` instances left over from previous runs
 * (e.g. self-update via `process.exit()` skipped the SIGTERM hook,
 * or a supervisor SIGKILL killed us before stopLanguageServer could run) and
 * kill them. Keeps long-running supervised deployments from accumulating
 * dead LS processes that hold their pool ports.
 *
 * Limited to processes whose argv[0] matches our `_binaryPath` (or
 * the legacy DEFAULT_BINARY) so unrelated `language_server_linux_x64`
 * binaries on the same host (rare) are not touched. No-op on Windows
 * since the LS binary is Linux-only there.
 *
 * Skips itself: PIDs we currently track in `_pool` (none yet at
 * startup, but called also from /self-update before exit).
 *
 * Best-effort: any error is logged but doesn't block startup.
 */
export function cleanupOrphanLanguageServers() {
  if (process.platform === 'win32') return { scanned: 0, killed: 0 };
  let scanned = 0;
  let killed = 0;
  const ourPids = new Set();
  for (const entry of _pool.values()) {
    if (entry?.process?.pid) ourPids.add(entry.process.pid);
  }
  const targetBinaries = new Set([_binaryPath, DEFAULT_BINARY]);
  try {
    // -e: every process; -o pid,args: pid + full argv (so we can match
    // the binary path). Cap output at a few hundred lines via head; LS
    // pids are typically small clusters, not thousands.
    const out = execSync('ps -e -o pid=,args=', { timeout: 3000, encoding: 'utf-8' });
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const argv = m[2];
      // Match either the configured binary path OR the default path.
      // v2.0.88 (audit L-1): anchor the match to argv[0] so we don't
      // SIGTERM a `grep language_server_linux_x64` or a monitoring
      // agent whose argv mentions our binary path elsewhere.
      const argv0 = argv.split(/\s+/, 1)[0];
      let isOurs = false;
      for (const bin of targetBinaries) {
        if (bin && argv0 === bin) { isOurs = true; break; }
      }
      if (!isOurs) continue;
      scanned++;
      if (ourPids.has(pid)) continue;
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
        killed++;
        log.info(`Killed orphan LS pid=${pid} (${argv.slice(0, 80)}...)`);
      } catch (e) {
        if (e.code !== 'ESRCH') log.warn(`Could not kill orphan LS pid=${pid}: ${e.message}`);
      }
    }
  } catch (e) {
    log.warn(`cleanupOrphanLanguageServers: ${e.message}`);
  }
  return { scanned, killed };
}

export function stopLanguageServer() {
  // v2.0.25 LOW-1: tear down ALL conversation pool entries pinned to LSes
  // we're about to kill, so the dashboard restart path doesn't leak dead
  // cascade ids into the next LS's session window.
  const portsToClose = [];
  for (const [key, entry] of _pool) {
    markIntentionalShutdown(entry);  // prevent auto-restart
    _stopping.set(key, { at: Date.now(), pid: entry?.process?.pid || null, reason: 'stop' });
    try { entry.process?.kill('SIGTERM'); } catch {}
    if (entry?.port) portsToClose.push({ port: entry.port, generation: entry.generation });
    log.info(`LS instance ${key} stopped`);
  }
  _pool.clear();
  _maintenanceUses.clear();
  if (portsToClose.length) {
    import('./conversation-pool.js').then(m => {
      for (const p of portsToClose) {
        closeSessionForPort(p.port);
        m.invalidateFor({ lsPort: p.port, lsGeneration: p.generation });
      }
    }).catch(() => {});
  }
  setTimeout(() => {
    for (const [key, entry] of _stopping) {
      if (entry?.reason === 'stop') _stopping.delete(key);
    }
  }, 2500).unref?.();
}

/**
 * v2.0.88 (audit H-4): like `stopLanguageServer` but waits for each
 * spawned LS process to actually exit (capped per-process timeout)
 * before returning. Used by `dashboard /self-update` so `process.exit`
 * doesn't fire while children still hold their ports — preventing
 * orphan LS processes that would otherwise win a port-conflict race
 * against the freshly-restarted parent.
 *
 * Per-process wait cap defaults to 1.5s; total wait for many LSes is
 * bounded by Promise.allSettled. SIGKILL fallback if SIGTERM doesn't
 * land within the cap.
 */
export async function stopLanguageServerAndWait({ perProcessTimeoutMs = 1500 } = {}) {
  const procs = [];
  const portsToClose = [];
  for (const [key, entry] of _pool) {
    if (entry?.process) procs.push({ key, proc: entry.process });
    if (entry?.port) portsToClose.push({ port: entry.port, generation: entry.generation });
    _stopping.set(key, { at: Date.now(), pid: entry?.process?.pid || null, reason: 'stop_wait' });
    markIntentionalShutdown(entry);
  }
  _pool.clear();
  _maintenanceUses.clear();
  await Promise.allSettled(procs.map(({ key, proc }) => new Promise((resolve) => {
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      _stopping.delete(key);
      log.info(`LS instance ${key} stopped (${how})`);
      resolve();
    };
    try { proc.once('exit', () => finish('exited')); } catch {}
    try { proc.kill('SIGTERM'); } catch (e) { finish(`kill failed: ${e.message}`); return; }
    setTimeout(() => {
      if (settled) return;
      try { proc.kill('SIGKILL'); } catch {}
      finish(`SIGKILL after ${perProcessTimeoutMs}ms`);
    }, perProcessTimeoutMs).unref();
  })));
  if (portsToClose.length) {
    try {
      const m = await import('./conversation-pool.js');
      for (const p of portsToClose) {
        closeSessionForPort(p.port);
        m.invalidateFor({ lsPort: p.port, lsGeneration: p.generation });
      }
    } catch {}
  }
}

export function isLanguageServerRunning() {
  return _pool.size > 0;
}

export async function waitForReady(/* timeoutMs */) {
  const def = _pool.get('default');
  if (!def) throw new Error('default LS not initialized');
  if (def.ready) return true;
  await waitPortReady(def.port, 20000);
  def.ready = true;
  return true;
}

export function getLsStatus() {
  const def = _pool.get('default');
  const now = Date.now();
  const rssByRootPid = collectTrackedRssSnapshot(now);
  const pool = getLsPoolSummary(now);
  const admissionStats = admissionStatsSnapshot();
  const instances = Array.from(_pool.entries()).map(([key, e]) => {
    const pid = e.process?.pid || null;
    const rss = pid ? rssByRootPid.get(pid) : null;
    const lastUsedAt = e.lastUsedAt || e.startedAt || null;
    return {
      key, port: e.port,
      pid,
      proxy: e.proxy ? `${e.proxy.host}:${e.proxy.port}` : null,
      startedAt: e.startedAt,
      lastUsedAt,
      idleMs: lastUsedAt ? Math.max(0, now - lastUsedAt) : null,
      activeRequests: e.activeRequests || 0,
      ready: e.ready,
      rssKb: rss?.rssKb ?? null,
      rssBytes: rss?.rssBytes ?? null,
      processCount: rss?.processCount ?? null,
    };
  });
  const totalRssBytes = instances.reduce((n, i) => n + (Number.isFinite(i.rssBytes) ? i.rssBytes : 0), 0);
  return {
    running: _pool.size > 0,
    pid: def?.process?.pid || null,
    port: def?.port || DEFAULT_PORT,
    startedAt: def?.startedAt || null,
    restartCount: 0,
    ...lsStatusConfig(),
    totalRssBytes: totalRssBytes || null,
    pool,
    admissionStats,
    instances,
  };
}
