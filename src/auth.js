/**
 * Multi-account authentication pool for Codeium/Windsurf.
 *
 * Features:
 *   - Multiple accounts with round-robin load balancing
 *   - Account health tracking (error count, auto-disable)
 *   - Dynamic add/remove via API
 *   - Token-based registration via api.codeium.com
 *   - Optional sticky sessions (STICKY_SESSION_ENABLED=1) for multi-turn
 *     conversation continuity (#93, #133)
 */

import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { isStickyEnabled, getStickyBinding, setStickyBinding, clearStickyBinding } from './account/sticky-session.js';
import { isExperimentalEnabled, getDroughtThresholdPercent, getIpLockThreshold, getIpLockMs, getBackendSwitch, getBreakerTunable, getQuotaTunable } from './runtime-config.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { config, log } from './config.js';
import { safeAccountRef } from './log-safety.js';
import { renameSyncWithRetry } from './fs-atomic.js';
import { getEffectiveProxy } from './dashboard/proxy-config.js';
import { getTierModels, getModelKeysByEnum, MODELS, registerDiscoveredFreeModel } from './models.js';
import { FREE_REACHABLE_SELECTORS } from './devin-connect-models.js';
import { getLsAdmissionStatus, getLsMaintenanceRequests } from './langserver.js';
import { bumpConnect } from './devin-connect-metrics.js';

import { join } from 'path';
// accounts.json lives in the cluster-shared dir so add-account writes from
// one replica survive future restarts and are visible to every replica.
// See `src/config.js` (sharedDataDir vs dataDir) and issue #67.
const ACCOUNTS_FILE = join(config.sharedDataDir || config.dataDir, 'accounts.json');

// ─── Account pool ──────────────────────────────────────────

const accounts = [];
let _roundRobinIndex = 0;
let _bindHost = '0.0.0.0';

function accountInflight(account) {
  return Math.max(0, account?._inflight || 0);
}

function accountMaintenance(account) {
  return Math.max(0, account?._maintenance || 0);
}

function accountLsMaintenance(account) {
  if (!account?.id) return 0;
  try {
    return Math.max(0, getLsMaintenanceRequests(getEffectiveProxy(account.id) || null));
  } catch {
    return 0;
  }
}

function isAccountBusyForProbe(account) {
  return accountInflight(account) > 0 || accountMaintenance(account) > 0 || accountLsMaintenance(account) > 0;
}

function maintenanceBusyReason(account) {
  if (accountInflight(account) > 0) return 'account_inflight';
  if (accountMaintenance(account) > 0) return 'account_maintenance';
  if (accountLsMaintenance(account) > 0) return 'ls_maintenance';
  return '';
}

function shouldSkipBusyBackgroundMaintenance() {
  return process.env.WINDSURFAPI_BACKGROUND_MAINTENANCE_SKIP_BUSY !== '0';
}

function isAccountInMaintenance(account) {
  return accountMaintenance(account) > 0 || accountLsMaintenance(account) > 0;
}

function beginAccountMaintenance(account) {
  if (!account) return null;
  account._maintenance = accountMaintenance(account) + 1;
  account._maintenanceAt = Date.now();
  return { account };
}

function endAccountMaintenance(token) {
  const account = token?.account;
  if (!account) return;
  account._maintenance = Math.max(0, accountMaintenance(account) - 1);
  if (account._maintenance === 0) account._maintenanceAt = 0;
}

// Per-tier requests-per-minute limits. Used for both filter-by-cap and
// weighted selection (accounts with more headroom are preferred).
const TIER_RPM = { pro: 60, free: 10, unknown: 20, expired: 0 };
const RPM_WINDOW_MS = 60 * 1000;

// Monotonic per-process counter so two reservations landing in the same
// millisecond produce distinct `_rpmHistory` tokens. Without this,
// `refundReservation()` could remove the wrong reservation under
// concurrent traffic. The fractional offset stays well below 1ms so
// numerical comparisons against ms-based cutoffs still work as expected.
let reservationSeq = 0;
function nextReservationToken(now) {
  reservationSeq = (reservationSeq + 1) % 1000;
  return now + reservationSeq / 1000;
}

// Strict positive int env reader (mirrors the helper in client.js /
// conversation-pool.js). Used by the dynamic cloud probe path below; when
// this was missing the probe path crashed with "positiveIntEnv is not
// defined" on every refresh cycle and free-account model discovery
// silently stopped working.
function positiveIntEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function rpmLimitFor(account) {
  return TIER_RPM[account.tier || 'unknown'] ?? 20;
}

// v2.0.57 Fix 4 — quota headroom score. Reads the min of daily% and
// weekly% from the account's last refreshed credits snapshot. When both
// are unknown (probe never landed), assume 100 so unprobed accounts
// don't get demoted to last-pick. Returns 0..100.
export function quotaScore(account) {
  const c = account?.credits;
  if (!c || typeof c !== 'object') return 100;
  const d = typeof c.dailyPercent === 'number' ? c.dailyPercent : 100;
  const w = typeof c.weeklyPercent === 'number' ? c.weeklyPercent : 100;
  return Math.max(0, Math.min(100, Math.min(d, w)));
}

// v2.0.57 Fix 5 — drought mode. True iff every active account has
// weeklyPercent < threshold. Operators see this on the dashboard so
// they can buy more accounts / wait for reset rather than chasing
// individual rate-limit errors. v2.0.150: the threshold is now an operator
// tunable (runtime-config tunables.droughtThresholdPercent, default 5).

export function isDroughtMode() {
  const eligible = accounts.filter(a => a.status === 'active');
  if (!eligible.length) return false;
  const threshold = getDroughtThresholdPercent();
  let knownCount = 0;
  let droughtCount = 0;
  for (const a of eligible) {
    const c = a?.credits;
    const w = c && typeof c.weeklyPercent === 'number' ? c.weeklyPercent : null;
    if (w == null) continue;
    knownCount++;
    if (w < threshold) droughtCount++;
  }
  if (!knownCount) return false; // no quota data yet — assume not drought
  return droughtCount === knownCount;
}

// v2.0.58 — drought-mode premium-model gate. Default ON (changes
// behaviour but drought is exceptional, and operators reported wanting
// the proxy to stop wasting upstream calls when no quota remains).
// Toggle via env DROUGHT_RESTRICT_PREMIUM=0 to disable globally, or via
// the dashboard experimental flag `droughtRestrictPremium` (which the
// chat path reads through runtime-config).
function _droughtRestrictEnvDefault() {
  return process.env.DROUGHT_RESTRICT_PREMIUM !== '0';
}

export function isDroughtRestrictEnabled() {
  // env override wins; otherwise consult runtime-config (deferred import
  // to avoid the same load-order issue documented in validateApiKey).
  if (process.env.DROUGHT_RESTRICT_PREMIUM === '0') return false;
  if (process.env.DROUGHT_RESTRICT_PREMIUM === '1') return true;
  // No explicit env → use runtime-config default (true).
  if (_droughtRestrictResolver) {
    try { return !!_droughtRestrictResolver(); } catch { /* fall through */ }
  }
  return _droughtRestrictEnvDefault();
}

let _droughtRestrictResolver = null;
export function setDroughtRestrictResolver(fn) {
  _droughtRestrictResolver = typeof fn === 'function' ? fn : null;
}

/**
 * True when drought mode is active AND the operator has restriction
 * enabled AND the requested model is NOT in the free-tier allowlist.
 * Free-tier models keep running because they don't burn weekly quota
 * the way premium models do.
 */
export function isModelBlockedByDrought(modelKey) {
  if (!modelKey) return false;
  if (!isDroughtRestrictEnabled()) return false;
  if (!isDroughtMode()) return false;
  const freeModels = new Set(getTierModels('free'));
  return !freeModels.has(modelKey);
}

export function getDroughtSummary() {
  const eligible = accounts.filter(a => a.status === 'active');
  let lowestWeekly = null;
  let lowestDaily = null;
  let knownAccounts = 0;
  for (const a of eligible) {
    const c = a?.credits;
    if (!c) continue;
    knownAccounts++;
    if (typeof c.weeklyPercent === 'number') {
      lowestWeekly = lowestWeekly == null ? c.weeklyPercent : Math.min(lowestWeekly, c.weeklyPercent);
    }
    if (typeof c.dailyPercent === 'number') {
      lowestDaily = lowestDaily == null ? c.dailyPercent : Math.min(lowestDaily, c.dailyPercent);
    }
  }
  return {
    drought: isDroughtMode(),
    threshold: getDroughtThresholdPercent(),
    activeAccounts: eligible.length,
    knownAccounts,
    lowestWeeklyPercent: lowestWeekly,
    lowestDailyPercent: lowestDaily,
    restrictEnabled: isDroughtRestrictEnabled(),
    freeTierModels: getTierModels('free'),
  };
}

function pruneRpmHistory(account, now) {
  if (!account._rpmHistory) account._rpmHistory = [];
  const cutoff = now - RPM_WINDOW_MS;
  while (account._rpmHistory.length && account._rpmHistory[0] < cutoff) {
    account._rpmHistory.shift();
  }
  return account._rpmHistory.length;
}

// ─── C5: per-account rolling health window (persisted) ──────────────────────
// RPM history answers "is this account busy right now"; errorCount answers "is
// it disabled". Neither answers "how has this account BEHAVED over the last
// hour" — e.g. "currently active but threw 9 throttles in 40min", which is the
// signal for both smarter selection and incident triage. We keep a compact
// rolling window of outcome events per account. KEY DIFFERENCE from a pure
// in-memory counter (copilot2api): this is PERSISTED in accounts.json, so the
// picture survives a restart instead of resetting to all-healthy.
const HEALTH_WINDOW_MS = 60 * 60 * 1000;   // 1h rolling window
const HEALTH_MAX_EVENTS = 240;             // hard cap so a hot account can't bloat the file
// Event kinds kept short to minimize persisted size: o=ok e=error t=throttle c=capacity d=dead-token
const HEALTH_KINDS = new Set(['o', 'e', 't', 'c', 'd']);

function pruneHealthWindow(account, now) {
  if (!Array.isArray(account._health)) account._health = [];
  const cutoff = now - HEALTH_WINDOW_MS;
  // Events are appended in time order, so drop from the front until in-window.
  let drop = 0;
  while (drop < account._health.length && account._health[drop].t < cutoff) drop++;
  if (drop) account._health.splice(0, drop);
  // Defensive cap (e.g. clock skew or a burst): keep the most recent N.
  if (account._health.length > HEALTH_MAX_EVENTS) {
    account._health.splice(0, account._health.length - HEALTH_MAX_EVENTS);
  }
  return account._health;
}

// Record one outcome for an account. Persisted lazily (callers already save on
// status flips; the window itself is best-effort and rides the next save).
function recordHealthEvent(account, kind, now = Date.now()) {
  if (!account || !HEALTH_KINDS.has(kind)) return;
  pruneHealthWindow(account, now);
  account._health.push({ t: now, k: kind });
}

/** Summarize an account's last-hour health for metrics/selection (no secrets). */
function healthSummary(account, now = Date.now()) {
  const win = pruneHealthWindow(account, now);
  const out = { ok: 0, error: 0, throttle: 0, capacity: 0, dead: 0, total: win.length };
  const map = { o: 'ok', e: 'error', t: 'throttle', c: 'capacity', d: 'dead' };
  for (const ev of win) { const name = map[ev.k]; if (name) out[name]++; }
  return out;
}

// C2×C5: feed the rolling health window into SELECTION. An account that's
// currently throwing a burst of dead-tokens / errors / throttles should be
// softly de-prioritized for a short window — even while it's still 'active'
// with RPM headroom — instead of being hammered until it hard-fails (the
// copilot2api "smart" soft-cooldown idea, but driven by our persisted window).
// Failures decay naturally: only the last few minutes count, so a recovered
// account climbs back to full preference on its own. dead/error weigh heavier
// than throttle/capacity (the latter are often transient upstream load, not an
// account fault).
const RECENT_TROUBLE_WINDOW_MS = 5 * 60 * 1000;
function recentTroubleScore(account, now = Date.now()) {
  const win = account?._health;
  if (!Array.isArray(win) || win.length === 0) return 0;
  const cutoff = now - RECENT_TROUBLE_WINDOW_MS;
  let score = 0;
  // Walk from the newest end; events are time-ordered so we can stop early.
  for (let i = win.length - 1; i >= 0; i--) {
    const ev = win[i];
    if (ev.t < cutoff) break;
    if (ev.k === 'd' || ev.k === 'e') score += 3;
    else if (ev.k === 't' || ev.k === 'c') score += 1;
  }
  return score;
}

/** Public accessor: rolling-hour health for one account by apiKey. */
export function getAccountHealth(apiKey, now = Date.now()) {
  const account = accounts.find(a => a.apiKey === apiKey);
  return account ? healthSummary(account, now) : null;
}

/** Public accessor: rolling-hour health across the whole pool (triage/metrics). */
export function getPoolHealthWindow(now = Date.now()) {
  return accounts.map(a => {
    const rpmLimit = rpmLimitFor(a);
    const rpmUsed = pruneRpmHistory(a, now);
    // "saturated" = at/over 85% of the RPM soft-limit → the GlowGrid lights this
    // core on fire (KiroStudio-style). rpmLimit<=0 means unlimited → never hot.
    const saturated = rpmLimit > 0 && rpmUsed / rpmLimit >= 0.85;
    return {
      id: a.id,
      email: a.email,
      status: a.status,
      tier: a.tier,
      // in-flight request count drives the GlowGrid "busy" faster-breathe pulse.
      inflight: Math.max(0, a._inflight || 0),
      rpmUsed,
      rpmLimit,
      saturated,
      // hover-card / StatusBars fields (all free, no upstream call): last-used
      // timestamp, cumulative error count, and current transient states.
      lastUsed: a.lastUsed || 0,
      errorCount: a.errorCount || 0,
      rateLimited: !!(a.rateLimitedUntil && a.rateLimitedUntil > now),
      quotaCooled: !!(a.quotaResetAt && a.quotaResetAt > now),
      health: healthSummary(a, now),
    };
  });
}

/** Test seam: short-window trouble score used by selection de-prioritization. */
export function __recentTroubleScore(account, now = Date.now()) {
  return recentTroubleScore(account, now);
}

/** Test seam: is this account currently filtered out of selection for a model? */
export function __isRateLimitedForModel(account, modelKey = null, now = Date.now()) {
  return isRateLimitedForModel(account, modelKey, now);
}

/** Test seam: would tripping this account leave the pool with no usable account? */
export function __isLastUsableAccount(account, now = Date.now()) {
  return isLastUsableAccount(account, now);
}

// Serialize concurrent saveAccounts calls — multiple async paths
// (reportSuccess / markRateLimited / updateCapability / probe) can fire
// together; without a mutex the last writer wins on stale memory state.
let _saveInFlight = false;
let _savePending = false;
function _serializeAccounts() {
  return accounts.map(a => ({
    id: a.id, email: a.email, apiKey: a.apiKey,
    apiServerUrl: a.apiServerUrl, method: a.method,
    status: a.status, addedAt: a.addedAt,
    // AP-RISK-1: half-open recovery clock. Without persisting this an account
    // flipped to 'error' loses its since-timestamp on restart, so
    // maybeRecoverErrorAccount computes since=0 and bails forever — the pool
    // then shrinks monotonically across restarts. _errorAt is deliberately NOT
    // persisted: it's a transient streak-window field (reset on relogin/success).
    erroredAt: a.erroredAt || 0,
    tier: a.tier, tierManual: !!a.tierManual,
    capabilities: a.capabilities, lastProbed: a.lastProbed,
    credits: a.credits || null,
    blockedModels: a.blockedModels || [],
    refreshToken: a.refreshToken || '',
    // From GetUserStatus — the authoritative tier/entitlement snapshot.
    userStatus: a.userStatus || null,
    userStatusLastFetched: a.userStatusLastFetched || 0,
    // RB2/B2: quota-exhaustion cooldown deadline (own self-healing dimension,
    // separate from transient rateLimitedUntil). Persisted so a restart mid-
    // cooldown doesn't immediately re-select a dry account and eat a 402.
    quotaResetAt: a.quotaResetAt || 0,
    // v3.0.3: per-account on-demand spend policy. Persisted only when the
    // operator set an explicit override; null = inherit the global default.
    ...(typeof a.spendOnDemand === 'boolean' ? { spendOnDemand: a.spendOnDemand } : {}),
    ...(Number.isFinite(Number(a.onDemandReserve)) ? { onDemandReserve: Number(a.onDemandReserve) } : {}),
    // RB2/B1: exponential-backoff episode streak. Persisted as "memory" (not a
    // disable state) so a restart doesn't reset a repeat-offender's ladder to
    // zero; losing it is harmless (backoff just restarts) so it's best-effort.
    _breakerStreak: a._breakerStreak || 0,
    // C5: persisted rolling-hour health window (pruned at save time so the
    // file never carries stale/out-of-window events across restarts).
    _health: Array.isArray(a._health) ? pruneHealthWindow(a, Date.now()) : [],
  }));
}

function saveAccounts() {
  if (_saveInFlight) { _savePending = true; return; }
  _saveInFlight = true;
  const tempFile = `${ACCOUNTS_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    // Atomic write: write to a unique sibling tmp then rename so a crash
    // mid-write cannot leave accounts.json truncated/corrupt. The unique
    // tmp also prevents concurrent test/process saves from racing on the
    // same `${ACCOUNTS_FILE}.tmp` name.
    // 0600: accounts.json holds live upstream tokens (apiKey/refreshToken/
    // idToken) in cleartext — must not be world-readable on a shared host.
    writeFileSync(tempFile, JSON.stringify(_serializeAccounts(), null, 2), { mode: 0o600 });
    renameSyncWithRetry(tempFile, ACCOUNTS_FILE);
  } catch (e) {
    log.error('Failed to save accounts:', e.message);
    try { unlinkSync(tempFile); } catch {}
  } finally {
    _saveInFlight = false;
    if (_savePending) { _savePending = false; setImmediate(saveAccounts); }
  }
}

/**
 * Synchronous last-resort flush for the shutdown path. Bypasses the
 * _saveInFlight mutex (any queued async save would be killed by
 * process.exit before it finished anyway). Tolerates being called after
 * an in-flight save — the rename on top of a partial temp file is still
 * atomic.
 */
export function saveAccountsSync() {
  const tempFile = `${ACCOUNTS_FILE}.${process.pid}.shutdown.tmp`;
  try {
    // 0600: accounts.json holds live upstream tokens (apiKey/refreshToken/
    // idToken) in cleartext — must not be world-readable on a shared host.
    writeFileSync(tempFile, JSON.stringify(_serializeAccounts(), null, 2), { mode: 0o600 });
    renameSyncWithRetry(tempFile, ACCOUNTS_FILE);
  } catch (e) {
    log.error('Shutdown: failed to flush accounts:', e.message);
    try { unlinkSync(tempFile); } catch {}
  }
}

// Issue #67 — accounts.json used to live under `dataDir` which became
// per-replica when REPLICA_ISOLATE=1 shipped (commit 35700bb). Each
// docker-compose upgrade gets a fresh container HOSTNAME so the previous
// run's accounts ended up orphaned under a stale `replica-<old>/` subdir.
// On startup, if the shared accounts.json is missing but one or more
// replica-local copies exist, union them by apiKey and write into the
// shared path. Survives multiple stale subdirs across upgrade cycles.
//
// Pure-function form is exported so tests can drive it without booting
// the whole auth module against a real config.
export function migrateReplicaAccountsTo({ sharedDir, accountsFile, logger = log }) {
  if (existsSync(accountsFile)) return { migrated: 0, scanned: 0, skipped: true };
  let entries;
  try {
    entries = readdirSync(sharedDir).filter(n => n.startsWith('replica-'));
  } catch { return { migrated: 0, scanned: 0, skipped: true }; }
  if (!entries.length) return { migrated: 0, scanned: 0, skipped: true };
  const merged = new Map();
  let scanned = 0;
  for (const entry of entries) {
    const legacyPath = join(sharedDir, entry, 'accounts.json');
    if (!existsSync(legacyPath)) continue;
    scanned++;
    try {
      const data = JSON.parse(readFileSync(legacyPath, 'utf-8'));
      if (!Array.isArray(data)) continue;
      for (const a of data) {
        if (a?.apiKey && !merged.has(a.apiKey)) merged.set(a.apiKey, a);
      }
    } catch (e) {
      logger.warn?.(`Account migration: skipped ${legacyPath}: ${e.message}`);
    }
  }
  if (!merged.size) return { migrated: 0, scanned, skipped: false };
  const tempFile = accountsFile + '.migrate.tmp';
  try {
    writeFileSync(tempFile, JSON.stringify([...merged.values()], null, 2), { mode: 0o600 });
    renameSyncWithRetry(tempFile, accountsFile);
    logger.warn?.(`Migrated ${merged.size} account(s) from ${scanned} replica-* subdir(s) into ${accountsFile} (issue #67)`);
    return { migrated: merged.size, scanned, skipped: false };
  } catch (e) {
    logger.error?.(`Account migration write failed: ${e.message}`);
    try { unlinkSync(tempFile); } catch {}
    return { migrated: 0, scanned, skipped: false, error: e.message };
  }
}

// Rehydrate one persisted account record into a live in-memory account.
// Pure (aside from `now`, defaulted for testability) so the serialize→load
// round-trip can be exercised without touching disk or the dedup pass.
function _deserializeAccount(a, now = Date.now()) {
  const status = a.status || 'active';
  // AP-RISK-1: restore the half-open recovery clock. An older accounts.json
  // (written before erroredAt was persisted) has none, so an account already
  // in 'error' would recover with since=0 → never. Default it to load time so
  // it re-probes after the normal cooldown rather than staying disabled forever.
  const erroredAt = a.erroredAt || (status === 'error' ? now : 0);
  return {
    id: a.id || randomUUID().slice(0, 8),
    email: a.email, apiKey: a.apiKey,
    apiServerUrl: a.apiServerUrl || '',
    method: a.method || 'api_key',
    status,
    lastUsed: 0, errorCount: 0,
    refreshToken: a.refreshToken || '', expiresAt: 0, refreshTimer: null,
    addedAt: a.addedAt || now,
    erroredAt,
    tier: a.tier || 'unknown',
    capabilities: a.capabilities || {},
    lastProbed: a.lastProbed || 0,
    credits: a.credits || null,
    blockedModels: Array.isArray(a.blockedModels) ? a.blockedModels : [],
    tierManual: !!a.tierManual,
    userStatus: a.userStatus || null,
    userStatusLastFetched: a.userStatusLastFetched || 0,
    // RB2/B2 + B1: restore self-healing quota cooldown + backoff memory.
    quotaResetAt: a.quotaResetAt || 0,
    // v3.0.3: per-account on-demand spend policy overrides (null = inherit the
    // global runtime-config default). Only persisted when explicitly set.
    spendOnDemand: typeof a.spendOnDemand === 'boolean' ? a.spendOnDemand : null,
    onDemandReserve: Number.isFinite(Number(a.onDemandReserve)) ? Number(a.onDemandReserve) : null,
    _breakerStreak: a._breakerStreak || 0,
    // C5: restore the rolling health window; drop anything already out of
    // the 1h window at load so a long-stopped process starts clean.
    _health: Array.isArray(a._health)
      ? a._health.filter(e => e && typeof e.t === 'number' && now - e.t < HEALTH_WINDOW_MS && HEALTH_KINDS.has(e.k))
      : [],
  };
}

function loadAccounts() {
  try {
    migrateReplicaAccountsTo({
      sharedDir: config.sharedDataDir || config.dataDir,
      accountsFile: ACCOUNTS_FILE,
    });
    if (!existsSync(ACCOUNTS_FILE)) return;
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    for (const a of data) {
      if (accounts.find(x => x.apiKey === a.apiKey)) continue;
      accounts.push(_deserializeAccount(a));
    }
    if (data.length > 0) log.info(`Loaded ${data.length} account(s) from disk`);
  } catch (e) {
    log.error('Failed to load accounts:', e.message);
  }
}

// Test seams: exercise the serialize→load round-trip without disk/dedup.
export function __serializeAccounts() { return _serializeAccounts(); }
export function __deserializeAccount(a, now = Date.now()) { return _deserializeAccount(a, now); }
export function __maybeRecoverErrorAccount(account, now = Date.now()) {
  return maybeRecoverErrorAccount(account, now);
}

// ─── Dynamic model catalog from cloud ─────────────────────

// Tracks whether the cloud model catalog has been successfully merged at
// least once since startup. When false, trySyncModelCatalog() will fire
// off a fetch whenever an account becomes active — covering the case where
// the startup fetch was skipped because no active account existed yet.
let _modelCatalogSynced = false;
// Coalesces concurrent calls so multiple simultaneous status transitions
// (e.g. bulk-add accounts) only trigger one fetch.
let _modelCatalogSyncPromise = null;

async function fetchAndMergeModelCatalog() {
  // Use the first active account to fetch the catalog.
  const acct = accounts.find(a => a.status === 'active' && a.apiKey);
  if (!acct) {
    log.debug('No active account for model catalog fetch');
    return false;
  }
  try {
    const { getCascadeModelConfigs } = await import('./windsurf-api.js');
    const { mergeCloudModels } = await import('./models.js');
    const proxy = getEffectiveProxy(acct.id) || null;
    const { configs } = await getCascadeModelConfigs(acct.apiKey, proxy);
    const added = mergeCloudModels(configs);
    _modelCatalogSynced = true;
    log.info(`Model catalog: ${configs.length} cloud models, ${added} new entries merged`);
    // Also refresh the DEVIN_CONNECT selector catalog (audit 2026-07-12): the
    // committed snapshot never live-synced, so upstream-added selectors
    // (qwen-3/glm-5/kimi/deepseek/minimax) were 400'd by the strict gate despite
    // being runnable. GetCliModelConfigs is the connect-namespace source (distinct
    // from Cascade's GetCascadeModelConfigs above). Best-effort + isolated: a
    // connect-catalog failure must not fail the Cascade merge (already succeeded).
    try {
      const { fetchCatalog } = await import('./devin-connect-catalog.js');
      const { setLiveCatalogSelectors } = await import('./devin-connect-models.js');
      const connectModels = await fetchCatalog({ token: acct.apiKey });
      setLiveCatalogSelectors(connectModels);
      log.info(`DEVIN_CONNECT live catalog: ${connectModels.length} selectors merged into resolver`);
    } catch (ce) {
      log.warn(`DEVIN_CONNECT catalog sync failed (snapshot fallback stays in effect): ${ce.message}`);
    }
    return true;
  } catch (e) {
    log.warn(`Model catalog fetch failed: ${e.message}`);
    return false;
  }
}

/**
 * Fire-and-forget: trigger a cloud model catalog sync if one hasn't succeeded
 * yet and at least one active account exists. Safe to call from any account
 * status transition path — coalesces concurrent calls into a single fetch.
 */
export function trySyncModelCatalog() {
  if (_modelCatalogSynced) return;
  if (_modelCatalogSyncPromise) return;
  const acct = accounts.find(a => a.status === 'active' && a.apiKey);
  if (!acct) return;
  _modelCatalogSyncPromise = fetchAndMergeModelCatalog()
    .catch(e => log.warn(`trySyncModelCatalog: ${e.message}`))
    .finally(() => { _modelCatalogSyncPromise = null; });
}

async function registerWithCodeium(idToken) {
  const { WindsurfClient } = await import('./client.js');
  const client = new WindsurfClient('', 0, '');
  const result = await client.registerUser(idToken);
  return result; // { apiKey, name, apiServerUrl }
}

// ─── Account management ───────────────────────────────────

/**
 * Add account via API key.
 */
export function addAccountByKey(apiKey, label = '', apiServerUrl = '') {
  const existing = accounts.find(a => a.apiKey === apiKey);
  if (existing) {
    if (apiServerUrl && !existing.apiServerUrl) {
      existing.apiServerUrl = apiServerUrl;
      saveAccounts();
    }
    return existing;
  }

  const account = {
    id: randomUUID().slice(0, 8),
    email: label || `key-${apiKey.slice(0, 8)}`,
    apiKey,
    apiServerUrl: apiServerUrl || '',
    method: 'api_key',
    status: 'active',
    lastUsed: 0,
    errorCount: 0,
    refreshToken: '',
    expiresAt: 0,
    refreshTimer: null,
    addedAt: Date.now(),
    tier: 'unknown',
    capabilities: {},
    lastProbed: 0,
    blockedModels: [],
  };
  account.credits = null;
  seedNewAccountBaseline(account); // RB2/T3a: avoid a batch all-first-picked
  accounts.push(account);
  saveAccounts();
  log.info(`Account added: ${safeAccountRef(account)} [api_key]`);
  trySyncModelCatalog();
  return account;
}

/**
 * Add account via auth token.
 */
export async function addAccountByToken(token, label = '') {
  const reg = await registerWithCodeium(token);
  const existing = accounts.find(a => a.apiKey === reg.apiKey);
  if (existing) return existing;

  const account = {
    id: randomUUID().slice(0, 8),
    email: label || reg.name || `token-${reg.apiKey.slice(0, 8)}`,
    apiKey: reg.apiKey,
    apiServerUrl: reg.apiServerUrl || '',
    method: 'token',
    status: 'active',
    lastUsed: 0,
    errorCount: 0,
    refreshToken: '',
    expiresAt: 0,
    refreshTimer: null,
    addedAt: Date.now(),
    tier: 'unknown',
    capabilities: {},
    lastProbed: 0,
    blockedModels: [],
    credits: null,
  };
  seedNewAccountBaseline(account); // RB2/T3a
  accounts.push(account);
  saveAccounts();
  log.info(`Account added: ${safeAccountRef(account)} [token] server=${account.apiServerUrl}`);
  trySyncModelCatalog();
  return account;
}

/**
 * Add account via email/password.
 *
 * Reuses the same Windsurf login pipeline the dashboard's
 * `processWindsurfLogin` uses: probe Auth1 vs Firebase via
 * CheckUserLoginMethod (with /_devin-auth/connections fallback), then
 * register a Codeium api_key. Refresh token (Firebase path) is persisted
 * so the background renewal loop in checkAndRefreshTokens picks it up.
 */
export async function addAccountByEmail(email, password) {
  if (!email || !password) {
    throw new Error('email and password required');
  }
  const emailKey = String(email).trim().toLowerCase();
  const { windsurfLogin } = await import('./dashboard/windsurf-login.js');
  const result = await windsurfLogin(email, password, null);
  if (!result?.apiKey) {
    throw new Error('Login succeeded but no apiKey returned');
  }
  const label = result.name || email;
  const existingByEmail = accounts.find(a => String(a.email || '').trim().toLowerCase() === emailKey);
  const account = existingByEmail || addAccountByKey(result.apiKey, label);
  if (existingByEmail) {
    account.apiKey = result.apiKey;
    if (account.status === 'error') account.status = 'active';
    account.errorCount = 0;
  }
  if (account.email !== label) {
    account.email = label;
  }
  account.method = 'email';
  if (result.apiServerUrl && !account.apiServerUrl) {
    account.apiServerUrl = result.apiServerUrl;
  }
  if (result.refreshToken || result.idToken) {
    setAccountTokens(account.id, {
      refreshToken: result.refreshToken || '',
      idToken: result.idToken || '',
    });
  }
  // Persist the password (encrypted) so a dead session_id can be auto-recovered
  // via re-login. No-op unless DEVIN_CONNECT_CRED_KEY is set. Best-effort: a
  // store failure must not break the login that already succeeded.
  try {
    const { storeCredential, isCredStoreEnabled } = await import('./devin-connect-credentials.js');
    if (isCredStoreEnabled()) storeCredential(email, password);
  } catch (e) {
    log.warn(`could not persist credential for re-login: ${e.message}`);
  }
  saveAccounts();
  log.info(`Account added via email: ${safeAccountRef(account)}`);
  trySyncModelCatalog();
  return account;
}

/**
 * Per-account blocklist: hide specific models from this account so the
 * selector won't route matching requests here. Useful when one key has
 * burned its claude quota but still serves gpt just fine.
 */
export function setAccountBlockedModels(id, blockedModels) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  account.blockedModels = Array.isArray(blockedModels) ? blockedModels.slice() : [];
  saveAccounts();
  log.info(`Account ${id} blockedModels updated: ${account.blockedModels.length} blocked`);
  return true;
}

/**
 * Resolve whether `modelKey` is callable on this account.
 *
 * Two-stage decision:
 *   1. blocklist always wins (manual operator override)
 *   2. if GetUserStatus has filled `capabilities[key].reason='user_status'`
 *      that's the upstream-authoritative answer (cascade_allowed_models_config)
 *      — trust it directly, regardless of static tier table
 *   3. otherwise fall back to the tier static allowlist (UID-only models,
 *      pre-status accounts, unknown tier)
 *
 * Without step 2, free accounts that Windsurf actually entitles to
 * GLM/SWE/Kimi via the upstream allowlist still route through the
 * `MODEL_TIER_ACCESS.free` static table (gemini-only) and get denied
 * at selector time even though `account.capabilities` already says yes.
 */
export function isModelAllowedForAccount(account, modelKey) {
  const blocked = account.blockedModels || [];
  if (blocked.includes(modelKey)) return false;
  // tierManual is the operator escape hatch: when set, trust the manual
  // tier table over GetUserStatus's per-account allowlist. Useful when
  // probe-based detection misclassified a Pro/Trial account as free
  // (issue #8) and the operator manually flips it back to Pro.
  if (!account.tierManual) {
    // GetUserStatus writes both arms — `user_status` for allowed and
    // `not_entitled` for denied — into capabilities, keyed by enum.
    // Either reason means the upstream allowlist has already spoken.
    const cap = account.capabilities?.[modelKey];
    if (cap?.reason === 'user_status' || cap?.reason === 'not_entitled') {
      return cap.ok === true;
    }
  }
  const tierModels = getTierModels(account.tier || 'unknown');
  return tierModels.includes(modelKey);
}

// Connect-namespace entitlement. `selector` is the RESOLVED canonical selector
// (resolveConnectSelector output), NOT a catalog/MODELS key — so this must NOT
// reuse isModelAllowedForAccount (that filter is MODELS-namespace and returns
// false for every connect selector, even on a pro account, which is exactly why
// the connect path historically skipped model-aware selection). fable etc. have
// no enum, so per-account entitlement here is tier-bucket-grained: free accounts
// can only run FREE_REACHABLE_SELECTORS; paid selectors need a paid (or not-yet-
// probed 'unknown') account. Prevents routing a paid selector to a free account,
// which the upstream rejects as permission_denied (surfaced as a 529).
export function isConnectSelectorAllowedForAccount(account, selector) {
  if (!selector) return true;                       // no selector → no filter (back-compat)
  const blocked = account.blockedModels || [];
  if (blocked.includes(selector)) return false;     // operator blocklist (best-effort)
  if (FREE_REACHABLE_SELECTORS.has(selector)) return true; // free-reachable → any account
  const bucket = tierBucket(account.tier);
  // Paid selector: require a paid bucket. 'unknown' (unprobed new account) is
  // allowed — it self-heals to 'free' after a probe, then gets blocked here on
  // the next request, matching MODEL_TIER_ACCESS.unknown's optimistic policy.
  return bucket === 'pro' || bucket === 'unknown';
}

// True if at least one active account is entitled to this connect selector.
export function hasConnectEntitledAccount(selector) {
  return accounts.some(a => a.status === 'active' && isConnectSelectorAllowedForAccount(a, selector));
}

/** List of model keys this account is currently allowed to call. */
export function getAvailableModelsForAccount(account) {
  const blocked = new Set(account.blockedModels || []);
  const tierModels = getTierModels(account.tier || 'unknown');
  // Manual tier override or no GetUserStatus yet → tier static table.
  if (account.tierManual || !account.userStatusLastFetched || !account.capabilities) {
    return tierModels.filter(m => !blocked.has(m));
  }
  // After GetUserStatus: per-account allowlist is authoritative for every
  // enum-keyed catalog entry; UID-only entries (no enum) fall back to tier.
  const allowed = [];
  for (const [key, info] of Object.entries(MODELS)) {
    if (blocked.has(key)) continue;
    if (info.enumValue && info.enumValue > 0) {
      const cap = account.capabilities[key];
      if (cap?.reason === 'user_status' && cap.ok === true) allowed.push(key);
    } else if (tierModels.includes(key)) {
      allowed.push(key);
    }
  }
  return allowed;
}

/**
 * Set account status (active, disabled, error).
 */
export function setAccountStatus(id, status) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  account.status = status;
  if (status === 'active') account.errorCount = 0;
  saveAccounts();
  log.info(`Account ${id} status set to ${status}`);
  if (status === 'active') trySyncModelCatalog();
  return true;
}

/**
 * Reset error count for an account.
 */
export function resetAccountErrors(id) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  account.errorCount = 0;
  account.status = 'active';
  saveAccounts();
  log.info(`Account ${id} errors reset`);
  trySyncModelCatalog();
  return true;
}

/**
 * Update account label.
 */
export function updateAccountLabel(id, label) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  account.email = label;
  saveAccounts();
  return true;
}

/**
 * Persist tokens (apiKey / refreshToken / idToken) onto an account.
 * Fields with undefined are left unchanged. Always flushes to disk so the
 * rotation survives a restart even if the caller never saves explicitly.
 */
/**
 * Manually force an account's tier. Used when automatic probing mis-
 * classifies an account — e.g. 14-day Pro trials whose planName doesn't
 * match our regex, or accounts whose initial probe was blocked by an
 * upstream bug and now carry a stale "free" tag even though the real
 * subscription is Pro.
 */
export function setAccountTier(id, tier) {
  if (!['pro', 'free', 'unknown', 'expired'].includes(tier)) return false;
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  account.tier = tier;
  account.tierManual = true;
  saveAccounts();
  log.info(`Account ${id} tier manually set to ${tier}`);
  return true;
}

export function setAccountTokens(id, { apiKey, refreshToken, idToken } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  if (apiKey != null) account.apiKey = apiKey;
  if (refreshToken != null) account.refreshToken = refreshToken;
  if (idToken != null) account.idToken = idToken;
  saveAccounts();
  return true;
}

// Per-account re-login throttle: a dead session_id will reject EVERY in-flight
// request at once, so without a cooldown a burst of UNAUTHORIZED would fire a
// login storm against the upstream. We allow one re-login attempt per account
// per cooldown window and de-dupe concurrent attempts onto a single promise.
const RELOGIN_COOLDOWN_MS = 60 * 1000;
const _reloginState = new Map(); // id → { lastAttempt, inflight }

// C4: global re-login concurrency gate. Per-account inflight coalescing + the
// 60s cooldown already stop ONE account from re-logging in a storm. But when a
// whole batch of tokens dies at once (upstream session purge, a network blip,
// process restart against many stale tokens), each DIFFERENT account would fire
// a full heavy Auth1 login in parallel — a relogin stampede that can itself
// trip upstream anti-abuse and bury the box in concurrent logins. This caps the
// number of *simultaneous* real logins fleet-wide; excess callers queue (FIFO)
// for a freed slot rather than all hammering the upstream at once.
const RELOGIN_MAX_CONCURRENT = () => {
  const n = Number(process.env.DEVIN_CONNECT_RELOGIN_MAX_CONCURRENT);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
};
let _reloginActive = 0;
const _reloginWaiters = [];
function acquireReloginSlot() {
  if (_reloginActive < RELOGIN_MAX_CONCURRENT()) {
    _reloginActive += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => _reloginWaiters.push(resolve));
}
function releaseReloginSlot() {
  const next = _reloginWaiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter — active count stays the same.
    next();
  } else {
    _reloginActive = Math.max(0, _reloginActive - 1);
  }
}

// Test seam: override the login impl + credential getter so re-login logic can
// be exercised without real network / a real encrypted store. null → use the
// real windsurfLogin + devin-connect-credentials.
let _reloginDeps = null;
export function __setReloginDeps(deps) { _reloginDeps = deps; }

/** Test seam: clear the re-login throttle between cases. */
export function __resetReloginState() {
  _reloginState.clear();
  _reloginActive = 0;
  _reloginWaiters.length = 0;
}

/** Test/observability seam: current global re-login gate state. */
export function __reloginGateState() {
  return { active: _reloginActive, waiting: _reloginWaiters.length, max: RELOGIN_MAX_CONCURRENT() };
}

/**
 * Recover a dead DEVIN_CONNECT session token by performing a fresh Auth1
 * email/password login and swapping in the new session token.
 *
 * The session token (account.apiKey, `devin-session-token$...`) is an opaque
 * server-side session_id with no expiry/refresh — once the server retires it,
 * the ONLY way back is a full re-login. This requires the account's password
 * to be in the encrypted credential store (DEVIN_CONNECT_CRED_KEY set) and
 * DEVIN_CONNECT_AUTO_RELOGIN=1. Without either, this is a no-op returning false.
 *
 * Throttled + de-duped per account so a burst of UNAUTHORIZED can't trigger a
 * login storm. Returns the new apiKey on success, false otherwise.
 *
 * @param {string} id account id
 * @param {object} [opts]
 * @param {boolean} [opts.force] bypass the cooldown (e.g. liveness-probe driven)
 */
export async function reLoginAccount(id, { force = false } = {}) {
  if (!getBackendSwitch('autoRelogin')) return false;
  const account = accounts.find(a => a.id === id);
  if (!account) return false;

  const { isCredStoreEnabled, getCredential } = _reloginDeps
    || await import('./devin-connect-credentials.js');
  if (!isCredStoreEnabled()) return false;

  const state = _reloginState.get(id) || { lastAttempt: 0, inflight: null };
  if (state.inflight) return state.inflight; // coalesce concurrent callers
  const now = Date.now();
  if (!force && now - state.lastAttempt < RELOGIN_COOLDOWN_MS) {
    log.debug(`re-login ${safeAccountRef(account)} skipped: cooldown`);
    return false;
  }

  const attempt = (async () => {
    let password;
    try {
      password = getCredential(account.email);
    } catch (e) {
      // Wrong key / tampered record — credential unusable, not absent.
      log.warn(`re-login ${safeAccountRef(account)}: credential unusable (${e.message})`);
      return false;
    }
    if (!password) {
      log.debug(`re-login ${safeAccountRef(account)} skipped: no stored credential`);
      return false;
    }
    // Hold a global slot only around the heavy Auth1 login network call so a
    // mass token-death event can't launch an unbounded login stampede.
    await acquireReloginSlot();
    try {
      const proxy = getEffectiveProxy(account.id) || null;
      const { windsurfLogin } = _reloginDeps || await import('./dashboard/windsurf-login.js');
      const result = await windsurfLogin(account.email, password, proxy);
      if (!result?.apiKey) throw new Error('login returned no apiKey');
      account.apiKey = result.apiKey;
      if (result.refreshToken) account.refreshToken = result.refreshToken;
      account.status = 'active';
      account.errorCount = 0;
      account._errorAt = 0;
      account._reloginAt = Date.now();
      saveAccounts();
      log.info(`re-login OK: ${safeAccountRef(account)} → fresh session token`);
      bumpConnect('relogin_ok');
      return result.apiKey;
    } catch (e) {
      log.warn(`re-login ${safeAccountRef(account)} failed: ${e.message}`);
      bumpConnect('relogin_fail');
      return false;
    } finally {
      releaseReloginSlot();
    }
  })();

  state.lastAttempt = now;
  state.inflight = attempt;
  _reloginState.set(id, state);
  try {
    return await attempt;
  } finally {
    const s = _reloginState.get(id);
    if (s) s.inflight = null;
  }
}

/**
 * Liveness-probe a DEVIN_CONNECT account's session token (zero-billable
 * GetUserStatus) and recover it pre-emptively if it's dead.
 *
 * The point is to catch a retired session_id BEFORE a user request lands on it:
 * a dead token marks the account 'error' and, if auto-relogin is configured,
 * triggers a re-login so the next request lands on a fresh token.
 *
 * @param {string} id account id
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{alive:boolean, recovered?:boolean, code?:string}>}
 */
export async function probeAndRecoverConnectAccount(id, { signal } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return { alive: false, code: 'NO_ACCOUNT' };

  const { checkSessionLiveness } = (_reloginDeps && _reloginDeps.checkSessionLiveness)
    ? _reloginDeps
    : await import('./devin-connect-catalog.js');
  const result = await checkSessionLiveness({ token: account.apiKey, signal });
  if (result.alive) {
    // A previously-errored account that now probes alive is healthy again.
    if (account.status === 'error') {
      account.status = 'active';
      account.errorCount = 0;
      account._errorAt = 0;
      saveAccounts();
      log.info(`liveness probe: ${safeAccountRef(account)} recovered to active`);
    }
    return { alive: true };
  }

  // Only a genuine auth death warrants pre-emptive recovery; a transient
  // rate-limit or 5xx is not the session_id dying.
  if (result.code === 'UNAUTHORIZED') {
    log.warn(`liveness probe: ${safeAccountRef(account)} session token DEAD (${result.code})`);
    reportError(account.apiKey);
    const fresh = await reLoginAccount(id, { force: true }).catch(() => false);
    if (fresh) bumpConnect('liveness_recovered');
    return { alive: false, recovered: Boolean(fresh), code: result.code };
  }
  return { alive: false, code: result.code };
}

/**
 * Remove an account by ID.
 */
export function removeAccount(id) {
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return false;
  const account = accounts[idx];
  accounts.splice(idx, 1);
  saveAccounts();
  // Drop any Cascade conversations owned by this key so future requests
  // don't try to resume on an account that no longer exists.
  import('./conversation-pool.js').then(m => m.invalidateFor({ apiKey: account.apiKey })).catch(() => {});
  log.info(`Account removed: ${safeAccountRef(account)}`);
  return true;
}

// ─── Account selection (tier-weighted RPM) ─────────────────

/**
 * Pick the next available account based on per-tier RPM headroom.
 *
 * Strategy:
 *   1. Keep only active, non-excluded, non-rate-limited accounts.
 *   2. Drop accounts whose 60s request count already equals their tier cap.
 *   3. Pick the account with the highest remaining-ratio (most idle).
 *   4. Record the selection timestamp on that account's sliding window.
 *
 * Returns null when every account is temporarily full — callers should
 * wait a moment and retry (see handlers/chat.js queue loop).
 */

// L2 (2026-07-10): degraded-serve fallback. When the hard filter leaves ZERO
// candidates, this picks the "least-bad" account to serve anyway rather than
// returning null → 429. This is KiroStudio's "全池 unusable 也挑最不坏的一个"
// philosophy: in a small pool a TRANSIENT throttle on the only account should
// degrade service, not black it out.
//
// STRICT scope — only a TRANSIENT `rateLimitedUntil` cooldown qualifies. We do
// NOT fall back onto:
//   - quotaResetAt (real dry-well: serving it earns a 402, not degraded success)
//   - status !== 'active' (dead/errored/banned — a real fault, respect the breaker)
//   - tier/selector-ineligible (would earn an upstream permission_denied → 529)
//   - RPM-exhausted (would compound the very rate limit we're bleeding from)
//   - excludeKeys (already tried this request)
// Among the transient-cooled survivors we pick the SHORTEST remaining cooldown —
// the one closest to self-healing, most likely to succeed right now. Default OFF
// (degradedServeEnabled) so behaviour is byte-identical until an operator opts in.
function pickDegradedFallback(now, excludeKeys, modelKey, connectSelector) {
  let best = null;
  let bestUntil = Infinity;
  for (const a of accounts) {
    if (a.status !== 'active') continue;                       // real fault — respect breaker
    if (excludeKeys.includes(a.apiKey)) continue;              // already tried
    if (isAccountInMaintenance(a)) continue;
    if (a.quotaResetAt && a.quotaResetAt > now) continue;      // dry-well, not transient
    if (rpmLimitFor(a) <= 0) continue;                         // expired tier
    if (pruneRpmHistory(a, now) >= rpmLimitFor(a)) continue;   // RPM full — don't compound
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    if (connectSelector && !isConnectSelectorAllowedForAccount(a, connectSelector)) continue;
    // Must be gated ONLY by a transient throttle (global or per-model). If it has
    // no cooldown at all it would have passed the hard filter — so its presence
    // here means the caller already returned it; skip (defensive).
    const globalUntil = (a.rateLimitedUntil && a.rateLimitedUntil > now) ? a.rateLimitedUntil : 0;
    const modelUntil = (modelKey && a._modelRateLimits?.[modelKey] > now) ? a._modelRateLimits[modelKey] : 0;
    const until = Math.max(globalUntil, modelUntil);
    if (!until) continue; // not transiently cooled → not our case
    if (until < bestUntil) { bestUntil = until; best = a; }
  }
  return best;
}

export function getApiKey(excludeKeys = [], modelKey = null, callerKey = null, connectSelector = null) {
  const now = Date.now();

  // ── Sticky session: prefer the account from the last turn ────────
  // When enabled, this keeps multi-turn conversations on the same upstream
  // account so the cascade_id from the previous turn is still valid.
  // Falls through to normal selection if the bound account is unavailable.
  if (callerKey && isStickyEnabled()) {
    log.info('[sticky] CHECK callerKey=%s model=%s enabled=%s', (callerKey || '(none)').slice(0, 50), modelKey || '(none)', isStickyEnabled());
    const bound = getStickyBinding(callerKey, modelKey);
    if (bound) {
      const acct = accounts.find(a => a.id === bound.accountId && a.status === 'active' && a.apiKey === bound.apiKey);
      if (acct) {
        const limit = rpmLimitFor(acct);
        const used = pruneRpmHistory(acct, now);
        if (limit > 0 && used < limit && !isRateLimitedForModel(acct, modelKey, now) && !isAccountInMaintenance(acct)) {
          if ((!modelKey || isModelAllowedForAccount(acct, modelKey))
              && (!connectSelector || isConnectSelectorAllowedForAccount(acct, connectSelector))) {
            const reservationTimestamp = nextReservationToken(now);
            acct._rpmHistory.push(reservationTimestamp);
            acct.lastUsed = now;
            acct._inflight = (acct._inflight || 0) + 1;
            acct._inflightAt = Date.now();
            return {
              id: acct.id, email: acct.email, apiKey: acct.apiKey,
              apiServerUrl: acct.apiServerUrl || '',
              proxy: getEffectiveProxy(acct.id) || null,
              reservationTimestamp,
              _sticky: true,
            };
          }
        }
      }
      // Bound account is no longer usable
      if (isExperimentalEnabled('stickyNoFallback')) {
        log.info('[sticky] NO-FALLBACK callerKey=%s model=%s — bound account unavailable, refusing to rotate',
          (callerKey || '').slice(0, 50), modelKey || '(none)');
        return null;
      }
      // Clear it so the next call falls through to normal selection instead of looping.
      clearStickyBinding(callerKey, modelKey);
    }
  } else {
    log.info('[sticky] SKIP-CHECK callerKey=%s enabled=%s', (callerKey ? callerKey.slice(0, 30) : String(callerKey)), isStickyEnabled());
  }

  const candidates = [];
  for (const a of accounts) {
    maybeRecoverErrorAccount(a, now); // AP-RISK-1: half-open trial after TTL
    if (a.status !== 'active') continue;
    if (excludeKeys.includes(a.apiKey)) continue;
    if (isAccountInMaintenance(a)) continue;
    if (isRateLimitedForModel(a, modelKey, now)) continue;
    const limit = rpmLimitFor(a);
    if (limit <= 0) continue; // expired tier
    const used = pruneRpmHistory(a, now);
    if (used >= limit) continue;
    // Tier entitlement + per-account blocklist filter
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    if (connectSelector && !isConnectSelectorAllowedForAccount(a, connectSelector)) continue;
    candidates.push({ account: a, used, limit });
  }
  if (candidates.length === 0) {
    // L2: hard filter left nothing. Before returning null → 429, try a degraded
    // serve on the least-bad transiently-cooled account (opt-in). This is the
    // architectural replacement for the isLastUsableAccount exemption patch: it
    // covers the single-account pool AND any pool where every entitled account is
    // momentarily throttled, without a special-case "last account" rule.
    if (degradedServeEnabled()) {
      const fallback = pickDegradedFallback(now, excludeKeys, modelKey, connectSelector);
      if (fallback) {
        const reservationTimestamp = nextReservationToken(now);
        fallback._rpmHistory.push(reservationTimestamp);
        fallback.lastUsed = now;
        fallback._inflight = (fallback._inflight || 0) + 1;
        fallback._inflightAt = now;
        const remainMs = Math.max(0, (fallback.rateLimitedUntil || 0) - now,
          (modelKey && fallback._modelRateLimits?.[modelKey]) ? fallback._modelRateLimits[modelKey] - now : 0);
        log.warn(`getApiKey: pool fully throttled — DEGRADED serve on ${safeAccountRef(fallback)} (shortest cooldown ${Math.ceil(remainMs / 1000)}s remaining) instead of 429`);
        return {
          id: fallback.id, email: fallback.email, apiKey: fallback.apiKey,
          apiServerUrl: fallback.apiServerUrl || '',
          proxy: getEffectiveProxy(fallback.id) || null,
          reservationTimestamp,
          _degraded: true,
        };
      }
    }
    return null;
  }

  // Pick the account with the fewest in-flight requests first (so a burst
  // of concurrent calls spreads across accounts instead of piling onto a
  // single one that still has RPM headroom — see issue #37). Then prefer
  // accounts with the highest quota headroom (v2.0.57 Fix 4 — predictive
  // pre-warming reads min(daily%, weekly%) so a Trial about to roll over
  // doesn't keep getting picked over a healthier account). Then RPM
  // remaining-ratio. Finally least-recently-used.
  candidates.sort((x, y) => {
    const ix = accountInflight(x.account) + accountMaintenance(x.account);
    const iy = accountInflight(y.account) + accountMaintenance(y.account);
    if (ix !== iy) return ix - iy;
    // C2×C5 — soft de-prioritize an account that's wobbling RIGHT NOW (recent
    // dead-token/error burst) even though it's still 'active' with headroom.
    // Bucketed so minor noise (a single throttle) doesn't override quota/LRU
    // fairness; only a real trouble cluster (bucket ≥ 1, i.e. score ≥ 3 ≈ one
    // hard failure) demotes the account. Decays out of the 5-min window on its
    // own. Healthy accounts score 0 → no effect on existing ordering.
    const tx = Math.floor(recentTroubleScore(x.account, now) / 3);
    const ty = Math.floor(recentTroubleScore(y.account, now) / 3);
    if (tx !== ty) return tx - ty;
    const qx = quotaScore(x.account);
    const qy = quotaScore(y.account);
    // Bucket the score so we don't churn across small noise (e.g. 41 vs
    // 42). 5%-wide buckets keep the LRU rotation intact when both are
    // healthy and only kick in when one account is materially lower.
    const bx = Math.floor(qx / 5);
    const by = Math.floor(qy / 5);
    if (bx !== by) return by - bx;
    const rx = (x.limit - x.used) / x.limit;
    const ry = (y.limit - y.used) / y.limit;
    if (ry !== rx) return ry - rx;
    return (x.account.lastUsed || 0) - (y.account.lastUsed || 0);
  });

  // ── Tiebreaker: user-aware account sharding ─────────────────────
  //
  // Level 1 — strict pinning (stickyBindByUserOnly + stickyNoFallback):
  //   When both flags are on the user wants per-user account isolation
  //   with zero cross-contamination.  Skip all health-metric comparison
  //   and deterministically pin each caller to a fixed account slot from
  //   the very first request, regardless of quota / RPM / tier
  //   differences.  Once pinned, stickyNoFallback prevents the request
  //   from ever rotating to another account.
  //
  // Level 2 — soft sharding (the two flags are NOT both on):
  //   Only re-shard candidates when the top two are genuinely tied on
  //   every health metric.  This avoids overriding legitimate
  //   load-balancing when one account is clearly healthier.
  if (callerKey && candidates.length > 1) {
    const strictPin = isExperimentalEnabled('stickyBindByUserOnly') && isExperimentalEnabled('stickyNoFallback');
    let doShard = false;
    if (strictPin) {
      doShard = true;
    } else {
      const first = candidates[0];
      const second = candidates[1];
      const ix0 = accountInflight(first.account) + accountMaintenance(first.account);
      const iy0 = accountInflight(second.account) + accountMaintenance(second.account);
      const qx0 = Math.floor(quotaScore(first.account) / 5);
      const qy0 = Math.floor(quotaScore(second.account) / 5);
      const rx0 = (first.limit - first.used) / first.limit || 0;
      const ry0 = (second.limit - second.used) / second.limit || 0;
      doShard =
        ix0 === iy0 && qx0 === qy0 && rx0 === ry0 &&
        (first.account.lastUsed || 0) === (second.account.lastUsed || 0);
    }
    if (doShard) {
      const hash = createHash('sha256').update(callerKey).digest();
      const bucket = hash.readUInt32BE(0) % candidates.length;
      if (bucket > 0) {
        const chosen = candidates[bucket];
        candidates[bucket] = candidates[0];
        candidates[0] = chosen;
      }
    }
  }

  const { account } = candidates[0];
  const reservationTimestamp = nextReservationToken(now);
  account._rpmHistory.push(reservationTimestamp);
  account.lastUsed = now;
  account._inflight = (account._inflight || 0) + 1;
  account._inflightAt = now;
  // v2.0.57 Fix 4 — predictive pre-warming. When the chosen account is
  // running out of quota, fire-and-forget warm up the next-best
  // candidate so its LS / cascade pool is ready when the chosen one
  // hits zero on the next call. Throttled per-account to once per 30s
  // so a long burst of low-quota requests doesn't slam ensureLsForAccount.
  if (candidates.length >= 2 && quotaScore(account) < getDroughtThresholdPercent() * 2) {
    schedulePrewarm(candidates[1].account);
  }
  return {
    id: account.id, email: account.email, apiKey: account.apiKey,
    apiServerUrl: account.apiServerUrl || '',
    proxy: getEffectiveProxy(account.id) || null,
    reservationTimestamp,
  };
}

const PREWARM_COOLDOWN_MS = 30_000;
function schedulePrewarm(nextAccount) {
  if (!nextAccount) return;
  const now = Date.now();
  if (nextAccount._prewarmAt && now - nextAccount._prewarmAt < PREWARM_COOLDOWN_MS) return;
  const admission = getLsAdmissionForAccount(nextAccount.id);
  if (!admission.ok || admission.reason !== 'already_running' || (admission.activeRequests || 0) > 0 || (admission.maintenanceRequests || 0) > 0) {
    log.debug(`Prewarm ${nextAccount.id} skipped: ${admission.errorType || admission.reason} (wouldStart=${!!admission.wouldStart}, ls=${admission.key || '?'})`);
    return;
  }
  nextAccount._prewarmAt = now;
  // ensureLsForAccount already triggers a cascade warmup; we only need to
  // kick it off without awaiting.
  Promise.resolve().then(() => ensureLsForAccount(nextAccount.id)).then(r => {
    if (!r?.ok) {
      log.debug(`Prewarm ${nextAccount.id} failed: ${r?.errorType || 'ls_start_failed'} ${r?.error || ''}`.trim());
    }
  }).catch(e => {
    log.debug(`Prewarm ${nextAccount.id} failed: ${e?.message || e}`);
  });
  log.info(`Prewarm: chosen account is low on quota (score ${quotaScore(accounts.find(a => a.id === nextAccount.id) || nextAccount).toFixed(0)}); warming up next candidate ${nextAccount.id}`);
}

/**
 * Decrement the in-flight counter for an account after a chat request
 * finishes (success OR failure). Callers MUST pair every successful
 * getApiKey/acquireAccountByKey with a releaseAccount in finally, or the
 * in-flight balancing will drift and the account will look permanently busy.
 */
export function releaseAccount(apiKey) {
  if (!apiKey) return;
  const a = accounts.find(x => x.apiKey === apiKey);
  if (!a) return;
  _releaseAccountObj(a);
}

// REF-1 (audit P1): release the in-flight slot by the IMMUTABLE account.id
// instead of the mutable apiKey. A background re-login (reLoginAccount) swaps
// account.apiKey in place, so a caller holding a pre-relogin snapshot key would
// miss the account entirely on release (accounts.find(apiKey===oldKey) →
// undefined) and leak an in-flight slot forever — permanently deprioritising a
// healthy account in getApiKey's inflight-ascending sort (#165 re-manifest).
export function releaseAccountById(id) {
  if (!id) return;
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  _releaseAccountObj(a);
}

function _releaseAccountObj(a) {
  a._inflight = Math.max(0, (a._inflight || 0) - 1);
  // R2: keep _inflightAt tracking the NEWEST activity. When a request completes
  // while others are still in flight, refresh the timestamp so those survivors
  // aren't judged stale off the oldest acquire. When the account goes fully idle,
  // clear it so a future leaked slot is measured from ITS acquire, not a stale one.
  if (a._inflight === 0) a._inflightAt = 0;
  else a._inflightAt = Date.now();
}

// REF-1/REF-2: resolve the account's CURRENT (live) apiKey from its immutable
// id. finalize/health-report call sites hold a snapshot apiKey captured at
// acquire time; if a re-login re-keyed the account since, that snapshot is
// stale and every mark*/report* lookup (accounts.find(apiKey===snapshot))
// silently no-ops. Resolving through the id first keeps cooldown/health
// reporting landing on the right account; falls back to the snapshot key when
// the id is unknown (env-token path) so behaviour is unchanged there.
export function currentApiKeyForId(id, fallback = '') {
  if (!id) return fallback;
  const a = accounts.find(x => x.id === id);
  return a?.apiKey || fallback;
}

// v2.0.96: safety net — auto-reset stale inflight counters that weren't
// decremented due to connection drops, crashes, or missed finally blocks.
// Without this a single leaked inflight permanently deprioritises an
// account in getApiKey's sort order (fixes #165).
//
// R2: the threshold MUST exceed the longest legitimate request lifetime, or a
// normal long stream/ACP session gets its counter wrongly zeroed mid-flight —
// making a busy account read as idle in getApiKey's sort and oversubscribing it.
// The absolute upstream deadline is DEVIN_CONNECT_TIMEOUT_MS (default 600s), so a
// leaked slot can't outlive that by much; we take max(that + 5min margin, 15min)
// as the floor. `_inflightAt` is also refreshed on release (see releaseAccount) so
// it tracks the NEWEST activity, not the first acquire — a steady stream of short
// requests keeps the account "fresh" and only a genuinely abandoned slot ages out.
const INFLIGHT_STALE_FLOOR_MS = 15 * 60_000;
function inflightStaleMs() {
  const deadline = Number(process.env.DEVIN_CONNECT_TIMEOUT_MS) || 600_000;
  return Math.max(deadline + 5 * 60_000, INFLIGHT_STALE_FLOOR_MS);
}
let _inflightCleanupTimer = null;
// One sweep of the stale-inflight safety net. Extracted from the interval so R2
// is unit-testable without waiting 60s. Only resets slots older than the
// deadline-derived threshold — a legitimately long in-flight request is spared.
function runInflightCleanup(now = Date.now()) {
  const staleMs = inflightStaleMs();
  let reset = 0;
  for (const a of accounts) {
    if ((a._inflight || 0) > 0 && a._inflightAt && (now - a._inflightAt) > staleMs) {
      log.warn(`Account ${safeAccountRef(a)} inflight=${a._inflight} stale >${Math.round((now - a._inflightAt) / 1000)}s (>${Math.round(staleMs / 1000)}s cap), auto-resetting`);
      a._inflight = 0;
      a._inflightAt = 0;
      reset++;
    }
  }
  return reset;
}
function startInflightCleanup() {
  if (_inflightCleanupTimer) return;
  _inflightCleanupTimer = setInterval(() => runInflightCleanup(), 60_000).unref();
}

// Test seams: run one cleanup pass deterministically, and read the current
// deadline-derived stale threshold, without touching the 60s interval.
export function __runInflightCleanup(now = Date.now()) { return runInflightCleanup(now); }
export function __inflightStaleMs() { return inflightStaleMs(); }

/**
 * Try to re-check-out a specific account by apiKey, applying the same
 * rate-limit / status guards as getApiKey(). Used by the conversation pool
 * when a pool hit requires routing back to the exact account that owns the
 * upstream cascade_id — if that account is momentarily unavailable we fall
 * back to a fresh cascade on a different account instead of queuing.
 */
export function acquireAccountByKey(apiKey, modelKey = null, connectSelector = null) {
  const now = Date.now();
  const a = accounts.find(x => x.apiKey === apiKey);
  if (!a) return null;
  if (a.status !== 'active') return null;
  if (isAccountInMaintenance(a)) return null;
  if (isRateLimitedForModel(a, modelKey, now)) return null;
  const limit = rpmLimitFor(a);
  if (limit <= 0) return null;
  const used = pruneRpmHistory(a, now);
  if (used >= limit) return null;
  if (modelKey && !isModelAllowedForAccount(a, modelKey)) return null;
  if (connectSelector && !isConnectSelectorAllowedForAccount(a, connectSelector)) return null;
  const reservationTimestamp = nextReservationToken(now);
  a._rpmHistory.push(reservationTimestamp);
  a.lastUsed = now;
  a._inflight = (a._inflight || 0) + 1;
  a._inflightAt = now;
  return {
    id: a.id, email: a.email, apiKey: a.apiKey,
    apiServerUrl: a.apiServerUrl || '',
    proxy: getEffectiveProxy(a.id) || null,
    reservationTimestamp,
  };
}

/**
 * Explain why a pinned account cannot be used right now. Used by strict
 * Cascade reuse mode, where switching accounts would lose server-side
 * conversation context.
 */
export function getAccountAvailability(apiKey, modelKey = null) {
  const now = Date.now();
  const a = accounts.find(x => x.apiKey === apiKey);
  if (!a) return { available: false, reason: 'missing', retryAfterMs: 60_000 };
  if (a.status !== 'active') return { available: false, reason: `status:${a.status}`, retryAfterMs: 60_000 };

  if (a.rateLimitedUntil && a.rateLimitedUntil > now) {
    return { available: false, reason: 'rate_limited', retryAfterMs: Math.max(1000, a.rateLimitedUntil - now) };
  }
  // R6: the quota dimension (quotaResetAt) is account-wide and self-healing, kept
  // separate from the transient rateLimitedUntil. isRateLimitedForModel already
  // gates selection on it, so the availability VIEW must report it too — otherwise
  // a quota-dry account (whether cooled by a live 402 or a proactive snapshot)
  // reads as `available` here while selection quietly skips it (the inconsistency
  // R6 closes). Reported distinctly from a transient throttle for observability.
  if (a.quotaResetAt && a.quotaResetAt > now) {
    return { available: false, reason: 'quota_exhausted', retryAfterMs: Math.max(1000, a.quotaResetAt - now) };
  }
  if (modelKey && a._modelRateLimits) {
    const until = a._modelRateLimits[modelKey];
    if (until && until > now) {
      return { available: false, reason: 'model_rate_limited', retryAfterMs: Math.max(1000, until - now) };
    }
    if (until && until <= now) delete a._modelRateLimits[modelKey];
  }

  const limit = rpmLimitFor(a);
  if (limit <= 0) return { available: false, reason: 'tier_expired', retryAfterMs: 60_000 };
  const used = pruneRpmHistory(a, now);
  if (used >= limit) {
    const oldest = a._rpmHistory?.[0] || now;
    return { available: false, reason: 'rpm_full', retryAfterMs: Math.max(1000, oldest + RPM_WINDOW_MS - now) };
  }
  if (modelKey && !isModelAllowedForAccount(a, modelKey)) {
    return { available: false, reason: 'model_not_available', retryAfterMs: 60_000 };
  }
  return { available: true, reason: 'available', retryAfterMs: 0 };
}

/**
 * Snapshot of per-account RPM usage, for dashboard display.
 */
export function getRpmStats() {
  const now = Date.now();
  const out = {};
  for (const a of accounts) {
    const limit = rpmLimitFor(a);
    const used = pruneRpmHistory(a, now);
    out[a.id] = { used, limit, tier: a.tier || 'unknown' };
  }
  return out;
}

/**
 * Ensure an LS instance exists for an account's proxy.
 * Used on startup and after adding new accounts so chat requests don't race
 * the first-time LS spawn.
 */
export async function ensureLsForAccount(accountId) {
  const { ensureLs } = await import('./langserver.js');
  const account = accounts.find(a => a.id === accountId);
  if (!account) {
    return {
      ok: false,
      accountId,
      errorType: 'account_not_found',
      error: 'Account not found',
    };
  }
  const proxy = getEffectiveProxy(accountId) || null;
  try {
    const ls = await ensureLs(proxy);
    // Pre-warm the Cascade workspace init so the first real request on this
    // LS doesn't pay the 3-roundtrip setup cost. Fire-and-forget — chat
    // requests still await the same Promise if it hasn't finished yet.
    if (ls && account?.apiKey) {
      const { WindsurfClient } = await import('./client.js');
      const client = new WindsurfClient(account.apiKey, ls.port, ls.csrfToken);
      client.warmupCascade().catch(e => log.warn(`Cascade warmup failed: ${e.message}`));
    }
    return {
      ok: true,
      accountId,
      lsKey: ls?.key || null,
      port: ls?.port || null,
      proxy: proxy ? `${proxy.host}:${proxy.port || 8080}` : null,
    };
  } catch (e) {
    log.error(`Failed to start LS for account ${accountId}: ${e.message}`);
    return {
      ok: false,
      accountId,
      errorType: e?.type || e?.code || 'ls_start_failed',
      error: e?.message || String(e),
      proxy: proxy ? `${proxy.host}:${proxy.port || 8080}` : null,
    };
  }
}

export function getLsAdmissionForAccount(accountId) {
  const account = accounts.find(a => a.id === accountId);
  if (!account) {
    return {
      ok: false,
      accountId,
      errorType: 'account_not_found',
      reason: 'account_not_found',
    };
  }
  const proxy = getEffectiveProxy(accountId) || null;
  const admission = getLsAdmissionStatus(proxy);
  return { accountId, ...admission };
}

function residentProbeSkip(account, admission = getLsAdmissionForAccount(account.id)) {
  const busyReason = isAccountBusyForProbe(account) ? 'account_busy' : null;
  if (!admission.ok || admission.reason !== 'already_running' || (admission.activeRequests || 0) > 0 || (admission.maintenanceRequests || 0) > 0 || busyReason) {
    return {
      skipped: true,
      reason: busyReason || admission.errorType || admission.reason || 'ls_not_idle_resident',
      tier: account.tier || 'unknown',
      capabilities: account.capabilities || {},
      admission,
    };
  }
  return null;
}

/**
 * Mark an account as rate-limited for a duration (default 5 min).
 * When `modelKey` is provided, only that model is blocked on this account —
 * other models remain routable. When omitted, the entire account is blocked
 * (legacy behaviour, used by generic 429 responses).
 */
export function markRateLimited(apiKey, durationMs = 5 * 60 * 1000, modelKey = null, healthKind = 't') {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  recordHealthEvent(account, healthKind);
  const safeMs = Math.max(1000, Number(durationMs) || 0);
  const until = Date.now() + safeMs;
  if (modelKey) {
    if (!account._modelRateLimits) account._modelRateLimits = {};
    account._modelRateLimits[modelKey] = Math.max(account._modelRateLimits[modelKey] || 0, until);
    log.warn(`Account ${safeAccountRef(account)} rate-limited on ${modelKey} for ${Math.round(safeMs / 60000)} min`);
  } else {
    account.rateLimitedUntil = Math.max(account.rateLimitedUntil || 0, until);
    log.warn(`Account ${safeAccountRef(account)} rate-limited (all models) for ${Math.round(safeMs / 60000)} min`);
  }
}

export function refundReservation(apiKey, timestamp) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return false;
  if (!Number.isFinite(timestamp)) return false;
  if ((account._inflight || 0) <= 0) return false;
  pruneRpmHistory(account, Date.now());
  const idx = account._rpmHistory?.lastIndexOf(timestamp) ?? -1;
  if (idx === -1) return false;
  account._rpmHistory.splice(idx, 1);
  return true;
}

/**
 * AP-RISK-1: half-open recovery for error'd accounts. An account disabled by
 * a transient error streak (status='error') has no other path back to 'active'
 * — it's never selected, so it never gets a success to clear it, so the pool
 * shrinks monotonically under upstream wobble. After a cooldown TTL we flip it
 * back to 'active' for a half-open trial: the next request either succeeds
 * (reportSuccess clears errorCount) or fails (reportError re-disables it).
 * 'banned' accounts are intentionally NOT auto-recovered — those stay manual.
 */
function errorRecoveryTtlMs() { return getBreakerTunable('errorRecoveryMs'); }

// ─── RB2/B1: account-level exponential backoff knobs ────────────────────────
// transient-first: this backoff ONLY stretches the SELF-HEALING cooldown of an
// account that keeps re-entering the 'error' streak. It writes to the existing
// rateLimitedUntil (expires on its own) and is hard-capped at breakerMaxMs(), so
// a wobbling account is ALWAYS eligible again after the cap — there is no path
// from here to a permanent disable. Transients (CAPACITY/UPSTREAM_INTERNAL/
// RATE_LIMITED) never reach reportError at all (chat.js routes them elsewhere),
// so they can never be escalated by this ladder.
function breakerEnabled() { return getBreakerTunable('breakerEnabled'); }
// Default base = the half-open recovery TTL (breakerBaseMs resolves to
// errorRecoveryMs when unset), so a FIRST error episode behaves exactly like
// today; only repeated episodes escalate beyond this.
function breakerBaseMs() { return getBreakerTunable('breakerBaseMs'); }
function breakerFactor() { return getBreakerTunable('breakerFactor'); }
// Hard ceiling on the backoff. NEVER "permanent" — 60min default. The account
// re-enters the candidate pool the moment this expires.
function breakerMaxMs() { return getBreakerTunable('breakerMaxMs'); }

// ─── RB2/T3: new-credential thunderstorm grace window ───────────────────────
// A freshly-added account hasn't earned a behavioural track record. While it's
// within this grace window we (a) seed its LRU position at pool-median instead
// of "oldest" so a batch isn't all first-picked at once (see addAccount*), and
// (b) exempt it from the exponential backoff escalation so transient onboarding
// wobble can't be ramped into long lockouts. Set the window to 0 to disable T3b.
function newAccountGraceMs() { return getBreakerTunable('newAccountGraceMs'); }
function isNewAccount(account, now = Date.now()) {
  const added = account?.addedAt || 0;
  if (!added) return false;
  return (now - added) < newAccountGraceMs();
}

// ─── LB: last-account breaker exemption ─────────────────────────────────────
// The breaker (reportError status='error' flip + reportInternalError 5min
// quarantine) has no notion of pool size. In a single-account deployment — the
// common self-hosted case — tripping the ONLY usable account takes the whole
// proxy down: every request then 529s ("All accounts rate-limited") until the
// cooldown expires, so one malformed request or one bad model selector
// self-inflicts a total outage. When an account IS the last one still usable,
// keeping it in rotation (and returning its real upstream error) is strictly
// better than guaranteeing 100% failure: a degraded single account can still
// serve the requests it's able to. The streak counters keep advancing, so the
// moment a second usable account exists the normal breaker resumes with full
// history — this only suppresses the terminal REMOVAL, nothing else.
// Set WINDSURFAPI_LAST_ACCOUNT_EXEMPT=0 to restore the strict trip-always behaviour.
function lastAccountExemptEnabled() { return getBreakerTunable('lastAccountExempt'); }
// L2: opt-in degraded-serve when the whole entitled pool is transiently throttled.
function degradedServeEnabled() { return getBreakerTunable('degradedServe'); }
// True when `account` is the last one that would still be selectable, FOR THE
// CAPABILITY TIER IT SERVES, if we took it out of rotation.
//
// TIER-AWARE (2026-07-10 fix): the old version was tier/selector-blind — ANY
// active, non-cooled peer counted as a fallback, so a healthy FREE peer made a
// PRO account "not the last usable" and let the breaker quarantine it. But a
// free peer CANNOT serve a paid selector (isConnectSelectorAllowedForAccount),
// so quarantining the sole pro account produced a pool-wide blackout for every
// paid model (opus/sonnet): the connect preflight isAllRateLimited(null,
// paidSelector) saw only the (now-cooled) pro account as eligible → 429. That
// is exactly the Claude-Code 1ms-429 lockout (see docs-internal/workflow-results/
// PLAN-429-MITIGATION). A peer only counts as a real fallback when it can serve
// AT LEAST what `account` serves — i.e. its tier bucket is same-or-higher.
//
// Bucket rank: pro(2) > unknown(1) > free(0) > expired(-1, never a fallback). A
// peer counts as a fallback only when its rank is >= this account's rank, i.e. it
// can serve at least the same capability tier. Consequences:
//   - a PRO account is "the last usable" the moment no OTHER active, non-cooled
//     peer is ALSO pro — a free OR unknown peer does NOT rescue it. An unknown
//     peer is only OPTIMISTICALLY paid-capable (it self-heals to free or pro on
//     the next probe); betting the sole known-pro account's quarantine on an
//     unprobed peer is exactly how paid selectors get blacked out, so we keep the
//     definitely-paid account in rotation (degraded-but-serving > gamble).
//   - a FREE account is not the last whenever any healthy peer of ANY paid-capable
//     or free tier exists (pro/unknown/free all serve free-reachable selectors).
//   - two same-tier peers (e.g. unknown+unknown) are mutual fallbacks → breaker
//     trips normally, exactly as before this fix.
// Object identity (a !== account) is immune to a mid-flight re-login re-keying.
function tierBucketRank(tier) {
  switch (tierBucket(tier)) {
    case 'pro': return 2;
    case 'unknown': return 1;
    case 'free': return 0;
    default: return -1; // expired / anything else — never a capability fallback
  }
}
function isLastUsableAccount(account, now = Date.now()) {
  if (!account) return false;
  const ownRank = tierBucketRank(account.tier);
  for (const a of accounts) {
    if (a === account) continue;
    if (a.status !== 'active') continue;
    if (isRateLimitedForModel(a, null, now)) continue;
    // Only a peer that can serve AT LEAST what `account` serves is a real
    // fallback (same-or-higher tier bucket). A lower-tier peer (e.g. free when
    // `account` is pro) cannot cover this account's paid selectors, so it does
    // NOT disqualify `account` from the single-account exemption.
    if (tierBucketRank(a.tier) >= ownRank) return false;
  }
  return true;
}

// RB2/T3a: stop a freshly-added account (or a BATCH added together) from being
// first-picked by every initial request. A new account defaults to lastUsed=0,
// which the getApiKey LRU tiebreaker reads as "oldest → most preferred"; a batch
// all at 0 also ties perfectly, collapsing onto sharding-hash dispersion. We
// seed lastUsed at the pool's MEDIAN (so the newcomer sits at "average
// freshness", neither first-picked nor discriminated against) plus a small
// per-account jitter so a batch de-synchronizes instead of tying.
//
// Pure ordering change — zero new cooldown/disable, so there is no self-healing
// concern (worst case is a slightly different pick order). When the pool has no
// running history (empty / all lastUsed=0, e.g. fresh boot or unit tests) we
// leave lastUsed=0 untouched so existing behaviour is unchanged. Toggle off via
// WINDSURFAPI_NEW_ACCOUNT_BASELINE=0.
function newAccountBaselineEnabled() { return getBreakerTunable('newAccountBaseline'); }
function _poolMedianLastUsed() {
  const vals = accounts
    .filter(a => a.status === 'active' && (a.lastUsed || 0) > 0)
    .map(a => a.lastUsed)
    .sort((x, y) => x - y);
  if (!vals.length) return 0;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
}
function seedNewAccountBaseline(account) {
  if (!account || !newAccountBaselineEnabled()) return;
  const median = _poolMedianLastUsed();
  if (median <= 0) return; // no running pool to balance against → leave as-is
  // Small jitter (0..30s) below the median so a batch added at once doesn't all
  // tie on the same value, while still keeping newcomers near "average freshness".
  account.lastUsed = Math.max(0, median - Math.floor(Math.random() * 30_000));
}

// ─── RB2/B2: quota-exhaustion closed-loop knobs ─────────────────────────────
// transient-first: a quota dry-well is a real account-level condition, but the
// cooldown lives on its OWN self-healing dimension (account.quotaResetAt) that
// (a) expires on its own and (b) is cleared the instant a later refresh sees
// the balance recover. There is NO permanent disable here — Windsurf quota
// refills on a weekly/daily cycle.
// v3.0.3: these three now resolve through runtime-config (override → env →
// historical default) so an operator can hot-flip them from Settings without a
// redeploy. getQuotaTunable replicates the original env guard exactly, so an
// env-only deploy behaves byte-identically to the pre-migration constants.
function quotaCooldownEnabled() { return getQuotaTunable('cooldownEnabled'); }
function quotaCooldownMs() { return getQuotaTunable('cooldownMs'); }
function quotaDryThreshold() { return getQuotaTunable('dryThreshold'); }

// Resolve the effective on-demand spend policy for one account. Per-account
// override (account.spendOnDemand / account.onDemandReserve) wins; otherwise the
// global runtime-config default. spendOnDemand=false means "when the included
// quota is dry, do NOT burn the prepaid $ balance — cool the account". reserve
// is a floor: the balance must exceed it for the account to keep serving, so it
// is never spent all the way to zero.
function resolveSpendPolicy(account) {
  const spendOverride = account?.spendOnDemand;
  const spend = typeof spendOverride === 'boolean'
    ? spendOverride
    : getQuotaTunable('spendOnDemand');
  const reserveOverride = Number(account?.onDemandReserve);
  const reserve = Number.isFinite(reserveOverride) && reserveOverride >= 0
    ? reserveOverride
    : getQuotaTunable('onDemandReserveUsd');
  return { spend, reserve };
}

/**
 * RB2/B2+B3+B6: react to a freshly-refreshed credits snapshot. Extracted from
 * refreshCredits so the dry/recover decision is unit-testable without mocking
 * the GetUserStatus network call. Self-healing both ways: a dry account is
 * cooled on quotaResetAt (auto-expires); a recovered account is uncooled
 * immediately. Kept off the transient rateLimitedUntil dimension (B6) so a
 * quota cooldown and a transient blip never clobber one another.
 */
export function applyQuotaSnapshot(account, weeklyPercent, now = Date.now()) {
  if (!account || !quotaCooldownEnabled()) return;
  const w = typeof weeklyPercent === 'number' ? weeklyPercent : null;
  if (w === null) return; // unknown balance → never cool (don't punish unprobed)
  // On-demand override: an account whose included weekly quota is dry but that
  // still holds a spendable on-demand ($) balance can keep serving on the
  // prepaid pool — usage just bills to that balance. Whether we DO that is now a
  // policy (spendOnDemand, global default or per-account) plus a reserve floor
  // so the balance is never burned to zero. Cooling a still-spendable account
  // would waste the balance the operator paid for (and, on a small pool, take
  // the model fully offline). Only the included-quota dry signal drives the
  // cooldown; a real on-demand exhaustion surfaces separately as a live
  // QUOTA_EXHAUSTED (markQuotaExhausted). Defaults (spend=true, reserve=0)
  // reproduce the pre-policy 52e255f behaviour exactly (zero regression).
  const { spend, reserve } = resolveSpendPolicy(account);
  const onDemand = Number(account.credits?.balance);
  const hasSpendableBalance = spend && Number.isFinite(onDemand) && onDemand > reserve;
  if (w <= quotaDryThreshold() && !hasSpendableBalance) {
    const alreadyCooled = account.quotaResetAt && account.quotaResetAt > now;
    account.quotaResetAt = now + quotaCooldownMs();
    if (!alreadyCooled) {
      bumpConnect('quota_exhausted');
      log.warn(`Account ${safeAccountRef(account)} quota dry (weekly ${w}%) — quota cooldown ${Math.round(quotaCooldownMs() / 60000)}m (self-healing)`);
    }
  } else if (account.quotaResetAt) {
    // Recovered included quota OR a spendable on-demand balance under the active
    // policy → clear ONLY the quota dimension, never the transient one.
    account.quotaResetAt = 0;
    log.info(`Account ${safeAccountRef(account)} quota recovered (weekly ${w}%) — quota cooldown cleared`);
  }
}

/**
 * Operator-set per-account on-demand spend policy. Governs whether this account
 * keeps serving off its prepaid $ balance once the included weekly quota is dry.
 *   spendOnDemand: true (always burn) | false (stop when dry) | null (inherit
 *     the global runtime-config default)
 *   reserve: a $ floor kept in reserve (>0), or null to inherit the global
 *     default. Setting to '' / null clears the per-account override.
 * Only the provided keys are touched, so the dashboard can PATCH either alone.
 */
export function setAccountSpendPolicy(id, { spendOnDemand, reserve } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  if (spendOnDemand !== undefined) {
    account.spendOnDemand = typeof spendOnDemand === 'boolean' ? spendOnDemand : null;
  }
  if (reserve !== undefined) {
    if (reserve === null || reserve === '') {
      account.onDemandReserve = null;
    } else {
      const n = Number(reserve);
      if (Number.isFinite(n) && n >= 0) account.onDemandReserve = n;
    }
  }
  saveAccounts();
  log.info(`Account ${safeAccountRef(account)} spend policy: spendOnDemand=${account.spendOnDemand ?? 'inherit'} reserve=${account.onDemandReserve ?? 'inherit'}`);
  return true;
}

// Expose the RESOLVED effective policy + a human-readable quota state for the
// dashboard, so an operator can see at a glance whether a dry account is
// currently burning balance, cooled, or fine. Pure read — no mutation.
export function getAccountSpendState(account, now = Date.now()) {
  const { spend, reserve } = resolveSpendPolicy(account);
  const balance = Number(account?.credits?.balance);
  const hasBalance = Number.isFinite(balance);
  const cooled = !!(account?.quotaResetAt && account.quotaResetAt > now);
  let state;
  if (cooled) state = 'cooled';                                   // quota dry + not spendable → cooled
  else if (spend && hasBalance && balance > reserve) state = 'spending'; // may burn balance
  else if (!spend) state = 'stop-when-dry';                       // policy forbids burning
  else state = 'ok';                                              // quota healthy / unprobed
  return {
    spendOnDemand: spend,
    reserve,
    spendOverride: typeof account?.spendOnDemand === 'boolean' ? account.spendOnDemand : null,
    reserveOverride: Number.isFinite(Number(account?.onDemandReserve)) ? Number(account.onDemandReserve) : null,
    balance: hasBalance ? balance : null,
    cooled,
    quotaResetAt: cooled ? account.quotaResetAt : 0,
    state,
  };
}

/**
 * R6: cool an account that returned a live QUOTA_EXHAUSTED on the SAME quota
 * dimension a proactive credits snapshot uses (account.quotaResetAt), not the
 * transient rateLimitedUntil. Both a reactive 402 and a proactive snapshot now
 * converge on one self-healing dimension, so isRateLimitedForModel's quota check
 * (auth.js) sees them identically and a later balance-recovery snapshot clears
 * either. Previously chat.js wrote a live 402 to rateLimitedUntil while snapshots
 * wrote quotaResetAt — a Math.max let them coexist, but the two dimensions could
 * silently disagree on when the account was usable again (consistency bug).
 * Honors WINDSURFAPI_QUOTA_COOLDOWN=0 (disable) and the shared cooldown default.
 */
export function markQuotaExhausted(apiKey, durationMs = null, now = Date.now()) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account || !quotaCooldownEnabled()) return;
  // 't' (throttle) not 'd' (dead): a quota dry-well is self-healing, so it should
  // de-prioritize selection the same light amount the old markRateLimited path did
  // — R6 changes only the cooldown DIMENSION, not the health weighting.
  recordHealthEvent(account, 't');
  const ms = Number.isFinite(durationMs) && durationMs >= 1000 ? durationMs : quotaCooldownMs();
  const alreadyCooled = account.quotaResetAt && account.quotaResetAt > now;
  account.quotaResetAt = Math.max(account.quotaResetAt || 0, now + ms);
  if (!alreadyCooled) {
    log.warn(`Account ${safeAccountRef(account)} QUOTA_EXHAUSTED (live 402) — quota cooldown ${Math.round(ms / 60000)}m (self-healing)`);
  }
}

function maybeRecoverErrorAccount(account, now) {
  if (!account || account.status !== 'error') return;
  const since = account.erroredAt || account._errorAt || 0;
  if (!since || (now - since) < errorRecoveryTtlMs()) return;
  account.status = 'active';
  account.errorCount = 0;
  log.info(`Account ${safeAccountRef(account)} half-open recovery after ${Math.round((now - since) / 60000)}m in error state`);
  trySyncModelCatalog();
}

/**
 * Check if an account is rate-limited for a specific model.
 */
function isRateLimitedForModel(account, modelKey, now) {
  // Global rate limit (transient dimension — short cooldowns)
  if (account.rateLimitedUntil && account.rateLimitedUntil > now) return true;
  // RB2/B6: quota dimension — a long, self-healing cooldown kept SEPARATE from
  // the transient rateLimitedUntil so the two never clobber one another. It
  // expires on its own and is cleared early when a refresh sees the balance
  // recover (applyQuotaSnapshot). Account-wide (quota refills per billing
  // cycle, not per model), so it applies regardless of modelKey.
  if (account.quotaResetAt && account.quotaResetAt > now) return true;
  // Per-model rate limit
  if (modelKey && account._modelRateLimits) {
    const until = account._modelRateLimits[modelKey];
    if (until && until > now) return true;
    // Clean up expired entries
    if (until && until <= now) delete account._modelRateLimits[modelKey];
  }
  return false;
}

/**
 * Report an error for an API key (increment error count, auto-disable).
 *
 * The error streak is time-windowed (mirroring reportBanSignal): three auth
 * failures spread across hours — e.g. transient "unauthenticated" blips during
 * a Windsurf deploy — must NOT permanently disable a healthy key. Only three
 * failures inside `windowMs` (with no success resetting them) disable it.
 */
export function reportError(apiKey, { windowMs = getBreakerTunable('errorWindowMs') } = {}) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  const now = Date.now();
  recordHealthEvent(account, 'e', now);
  const last = account._errorAt || 0;
  // A stale streak (older than the window) starts over rather than carrying
  // a months-old failure count into a fresh blip.
  account.errorCount = (now - last < windowMs) ? (account.errorCount || 0) + 1 : 1;
  account._errorAt = now;
  if (account.errorCount >= getBreakerTunable('errorStreakThreshold') && account.status !== 'error') {
    // LB: never take the LAST usable account out of rotation. errorCount keeps
    // climbing above, so the moment a healthy peer exists the next error flips
    // it normally with full history — this only defers the terminal removal in a
    // single-account pool, where disabling means a guaranteed pool-wide 529.
    if (lastAccountExemptEnabled() && isLastUsableAccount(account, now)) {
      log.warn(`Account ${safeAccountRef(account)} hit ${account.errorCount} errors in ${Math.round(windowMs / 60000)}m but is the LAST usable account — kept in rotation (single-account exemption); surfacing upstream errors instead of a pool-wide 529`);
      return;
    }
    account.status = 'error';
    account.erroredAt = now;
    // RB2/B1: account-level EXPONENTIAL BACKOFF. Each consecutive error EPISODE
    // (a half-open trial that fails again — see maybeRecoverErrorAccount +
    // reportSuccess clearing _breakerStreak) lengthens the self-healing cooldown
    // base * factor^(streak-1), HARD-CAPPED at breakerMaxMs() (60min default).
    //
    // transient-first: this only stretches an EXISTING self-healing cooldown —
    // it writes the existing rateLimitedUntil (auto-expires) alongside the
    // status='error' half-open path, so there are TWO independent recovery
    // routes and NO permanent disable. Capped → a wobbling account is always
    // eligible again after the cap. Transients never reach reportError, so they
    // can't be escalated here.
    //
    // streak 1 applies NO extra cooldown (base==recovery TTL, the half-open path
    // already governs that window) so first-episode behaviour matches today;
    // only repeat offenders (streak >= 2) get pushed further out. New accounts
    // (T3b) are exempt from escalation so onboarding wobble can't ramp up.
    account._breakerStreak = (account._breakerStreak || 0) + 1;
    if (breakerEnabled() && account._breakerStreak >= getBreakerTunable('breakerStreakStart') && !isNewAccount(account, now)) {
      const raw = breakerBaseMs() * Math.pow(breakerFactor(), account._breakerStreak - 1);
      const cooldown = Math.min(raw, breakerMaxMs());
      account.rateLimitedUntil = Math.max(account.rateLimitedUntil || 0, now + cooldown);
      log.warn(`Account ${safeAccountRef(account)} backoff streak=${account._breakerStreak} → cooldown ${Math.round(cooldown / 60000)}m (capped ${Math.round(breakerMaxMs() / 60000)}m, self-healing)`);
    }
    // AP-BUG-1: persist the status flip so a restart doesn't resurrect a
    // known-bad key (reportBanSignal already saves on its flip; this mirrors
    // it). Only saves when the status actually changes, not on every error.
    saveAccounts();
    log.warn(`Account ${safeAccountRef(account)} disabled after ${account.errorCount} errors in ${Math.round(windowMs / 60000)}m`);
  }
}

/**
 * Reset error count for an API key (call on success).
 */
export function reportSuccess(apiKey) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  recordHealthEvent(account, 'o');
  if (account.errorCount > 0) {
    account.errorCount = 0;
    account.status = 'active';
    trySyncModelCatalog();
  }
  account.internalErrorStreak = 0;
  // RB2/B1: a genuine success ends the error-episode chain → reset the
  // exponential-backoff streak so a recovered account starts the ladder from
  // scratch next time (key self-healing guarantee: good behaviour fully clears
  // the penalty, the backoff is never sticky).
  if (account._breakerStreak) account._breakerStreak = 0;
  // v2.0.56: any successful chat clears the ban-signal streak — Windsurf's
  // "Authentication failed" can fire transiently during deploys, so we
  // only mark banned when the streak isn't broken by a real success.
  if (account._banSignalCount) {
    account._banSignalCount = 0;
    account._banSignalAt = 0;
  }
}

/**
 * Report an upstream "internal error occurred (error ID: ...)" from Windsurf.
 * These are account-specific backend errors — a given key will keep hitting
 * them until we stop using it. Quarantine the key for 5 minutes after 2
 * consecutive hits so we stop burning user-visible retries on a dead key.
 */
export function reportInternalError(apiKey) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  recordHealthEvent(account, 'e');
  account.internalErrorStreak = (account.internalErrorStreak || 0) + 1;
  if (account.internalErrorStreak >= getBreakerTunable('internalErrorThreshold')) {
    const now = Date.now();
    // LB: never quarantine the LAST usable account — in a single-account pool a
    // quarantine is a total outage (every request 529s). The streak
    // stays elevated, so once a healthy peer exists the next hit quarantines
    // normally. A degraded sole account serving what it can beats guaranteed
    // pool-wide failure.
    if (lastAccountExemptEnabled() && isLastUsableAccount(account, now)) {
      log.warn(`Account ${safeAccountRef(account)} hit ${account.internalErrorStreak} consecutive upstream internal errors but is the LAST usable account — NOT quarantined (single-account exemption)`);
      return;
    }
    account.rateLimitedUntil = now + getBreakerTunable('internalQuarantineMs');
    log.warn(`Account ${safeAccountRef(account)} quarantined after ${account.internalErrorStreak} consecutive upstream internal errors`);
  }
}

/**
 * C5: record that an account's session token came back dead (UNAUTHORIZED on a
 * failover hop). Status handling lives in the failover/relogin path; this only
 * feeds the rolling health window so "how many dead-token hits in the last
 * hour" is visible per account.
 */
export function reportDeadToken(apiKey) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  recordHealthEvent(account, 'd');
}

// v2.0.56 (windsurf-assistant-pub inspiration): suspect-ban detection.
// Match upstream error text against the patterns Windsurf actually
// returns when an account is suspended / disabled / blocked at the
// account level (NOT model-level rate limits, which are handled by
// markRateLimited above). When a ban signal lands twice on the same
// account within 30 min we promote it to permanent disable so the pool
// doesn't keep handing out a known-dead key.
// Patterns ride a bounded `[^.\n]{0,40}` gap so "Your account has been
// suspended" matches without enabling .* / .+ ReDoS surfaces. Order is
// most-specific-first.
const BAN_PATTERNS = [
  // "account_suspended" / "account-disabled" / "user_banned" — common API
  // error codes returned as snake/kebab strings. Match the full token.
  /\b(?:account|user|email|api[_-]?key)[_-](?:suspend(?:ed)?|disabled|banned|revoked|terminated|deactivated|locked|closed)\b/i,
  // "Your account has been suspended" / "Account banned by upstream" /
  // "User suspended due to abuse" — a noun + bounded gap + verb form.
  /\baccount\b[^.\n]{0,40}\b(?:suspend(?:ed)?|disabled|banned|terminated|deactivated|locked|closed)\b/i,
  /\b(?:user|email)\b[^.\n]{0,40}\b(?:suspend(?:ed)?|disabled|banned|terminated)\b/i,
  /\bsubscription\b[^.\n]{0,40}\b(?:cancel(?:led|ed)?|terminated|expired|invalid)\b/i,
  /\bauthentication\b[^.\n]{0,40}\b(?:failed|invalid|denied|revoked)\b/i,
  /\binvalid\s+api[_\s-]?key\b/i,
  /\bapi[_\s-]?key\b[^.\n]{0,40}\b(?:revoked|disabled|expired|invalid)\b/i,
  /\bunauthorized\b[^.\n]{0,40}\b(?:account|key|credential|exist)\b/i,
  // CN forms — windsurf zh error pages occasionally surface these
  /账号(?:已)?(?:停用|封禁|禁用|冻结|注销|关闭)/,
  /(?:用户|邮箱)(?:已)?(?:停用|封禁|禁用)/,
  /订阅(?:已)?(?:取消|过期|失效)/,
];

export function looksLikeBanSignal(message) {
  if (typeof message !== 'string' || !message) return false;
  return BAN_PATTERNS.some(p => p.test(message));
}

/**
 * Report a ban-shaped upstream error. Two hits within `windowMs` (default
 * 30 min) flip the account to status='banned' and clear in-flight reuse
 * so it stops getting selected. Single hits are logged but not acted on
 * — Windsurf occasionally returns "Authentication failed" transiently
 * during deploys.
 */
export function reportBanSignal(apiKey, message, { windowMs = 30 * 60 * 1000 } = {}) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return false;
  const now = Date.now();
  const last = account._banSignalAt || 0;
  account._banSignalAt = now;
  account._banSignalCount = (now - last < windowMs) ? (account._banSignalCount || 0) + 1 : 1;
  account._banSignalLastMessage = String(message || '').slice(0, 240);
  log.warn(`Account ${safeAccountRef(account)} emitted ban-shaped error #${account._banSignalCount}: "${account._banSignalLastMessage}"`);
  if (account._banSignalCount >= 2) {
    account.status = 'banned';
    account.bannedAt = now;
    account.bannedReason = account._banSignalLastMessage;
    saveAccounts();
    log.error(`Account ${safeAccountRef(account)} marked BANNED after ${account._banSignalCount} ban-shaped errors`);
    // Drop any cascade-pool entries owned by this key.
    import('./conversation-pool.js').then(m => m.invalidateFor({ apiKey })).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Reset the ban-signal streak (e.g. after a successful chat). Also clears
 * status='banned' iff the operator explicitly resets the account.
 */
export function clearBanSignals(apiKey) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  account._banSignalAt = 0;
  account._banSignalCount = 0;
}

// ─── Status ────────────────────────────────────────────────

/**
 * Check if every eligible account is currently rate-limited for a given model.
 * Returns { allLimited, retryAfterMs } — callers can use retryAfterMs to set
 * a Retry-After header for 429 responses.
 */
export function isAllRateLimited(modelKey, connectSelector = null) {
  const now = Date.now();
  let soonestExpiry = Infinity;
  let anyEligible = false;
  for (const a of accounts) {
    if (a.status !== 'active') continue;
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    if (connectSelector && !isConnectSelectorAllowedForAccount(a, connectSelector)) continue;
    anyEligible = true;
    if (!isRateLimitedForModel(a, modelKey, now)) return { allLimited: false };
    // Track the soonest expiry across both global and per-model limits
    if (a.rateLimitedUntil && a.rateLimitedUntil > now) {
      soonestExpiry = Math.min(soonestExpiry, a.rateLimitedUntil);
    }
    // RB2/B2: a quota cooldown also gates this account → include its deadline so
    // Retry-After reflects when the soonest account actually frees up (else a
    // quota-only-cooled pool would always report the conservative 60s default).
    if (a.quotaResetAt && a.quotaResetAt > now) {
      soonestExpiry = Math.min(soonestExpiry, a.quotaResetAt);
    }
    if (modelKey && a._modelRateLimits?.[modelKey] > now) {
      soonestExpiry = Math.min(soonestExpiry, a._modelRateLimits[modelKey]);
    }
  }
  if (!anyEligible) return { allLimited: false };
  const retryAfterMs = soonestExpiry === Infinity ? 60000 : Math.max(1000, soonestExpiry - now);
  return { allLimited: true, retryAfterMs };
}

export function isAllTemporarilyUnavailable(modelKey, connectSelector = null) {
  const now = Date.now();
  let anyEligible = false;
  let soonestExpiry = Infinity;

  for (const a of accounts) {
    if (a.status !== 'active') continue;
    const limit = rpmLimitFor(a);
    if (limit <= 0) continue;
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    if (connectSelector && !isConnectSelectorAllowedForAccount(a, connectSelector)) continue;
    anyEligible = true;

    if (a.rateLimitedUntil && a.rateLimitedUntil > now) {
      soonestExpiry = Math.min(soonestExpiry, a.rateLimitedUntil);
      continue;
    }

    // RB2/B2: a quota-cooled account is also unavailable for selection (getApiKey
    // filters it via isRateLimitedForModel) — treat it as such here too, else
    // this would falsely report the account as available.
    if (a.quotaResetAt && a.quotaResetAt > now) {
      soonestExpiry = Math.min(soonestExpiry, a.quotaResetAt);
      continue;
    }

    if (modelKey && a._modelRateLimits) {
      const until = a._modelRateLimits[modelKey];
      if (until && until > now) {
        soonestExpiry = Math.min(soonestExpiry, until);
        continue;
      }
      if (until && until <= now) delete a._modelRateLimits[modelKey];
    }

    const used = pruneRpmHistory(a, now);
    if (used >= limit) {
      const oldest = a._rpmHistory?.[0];
      // RPM window has a precise expiry — use it directly. The 30s floor
      // only applies when no precise expiry exists (strict-reuse busy
      // without per-account rate-limit data).
      soonestExpiry = Math.min(
        soonestExpiry,
        oldest ? oldest + RPM_WINDOW_MS : now + 30_000
      );
      continue;
    }

    return { allUnavailable: false, retryAfterMs: null };
  }

  if (!anyEligible) return { allUnavailable: false, retryAfterMs: null };
  const retryAfterMs = soonestExpiry === Infinity ? 30_000 : Math.max(1000, soonestExpiry - now);
  return { allUnavailable: true, retryAfterMs };
}

export function isAuthenticated() {
  return accounts.some(a => a.status === 'active');
}

export function maskApiKey(key = '') {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 12) return `${s.slice(0, 4)}...`;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

function accountUserStatusSummary(userStatus) {
  if (!userStatus) return null;
  const { allowedModels, ...rest } = userStatus;
  return {
    ...rest,
    allowedModelCount: Array.isArray(allowedModels) ? allowedModels.length : 0,
  };
}

function publicAccount(a, now, { view = 'full' } = {}) {
  const rpmLimit = rpmLimitFor(a);
  const rpmUsed = pruneRpmHistory(a, now);
  const tierModels = getTierModels(a.tier || 'unknown');
  const cr = a.credits || null;
  const base = {
    id: a.id,
    email: a.email,
    method: a.method,
    status: a.status,
    errorCount: a.errorCount,
    lastUsed: a.lastUsed ? new Date(a.lastUsed).toISOString() : null,
    addedAt: new Date(a.addedAt).toISOString(),
    keyPrefix: a.apiKey.slice(0, 8) + '...',
    apiKey_masked: maskApiKey(a.apiKey),
    tier: a.tier || 'unknown',
    lastProbed: a.lastProbed || 0,
    rateLimitedUntil: a.rateLimitedUntil || 0,
    rateLimited: !!(a.rateLimitedUntil && a.rateLimitedUntil > now),
    rpmUsed,
    rpmLimit,
    credits: cr,
    blockedModelCount: (a.blockedModels || []).length,
    tierModelCount: tierModels.length,
    userStatus: accountUserStatusSummary(a.userStatus),
    userStatusLastFetched: a.userStatusLastFetched || 0,
    balance: cr?.balance ?? null,
    periodStart: cr?.periodStart ?? null,
    periodEnd: cr?.periodEnd ?? null,
  };
  if (view === 'summary') return base;

  const proxy = getEffectiveProxy(a.id) || null;
  const lsAdmission = getLsAdmissionStatus(proxy);
  return {
    ...base,
    capabilities: a.capabilities || {},
    modelRateLimits: a._modelRateLimits ? Object.fromEntries(
      Object.entries(a._modelRateLimits).filter(([, v]) => v > now)
    ) : {},
    blockedModels: a.blockedModels || [],
    availableModels: getAvailableModelsForAccount(a),
    tierModels,
    // v3.0.3: resolved on-demand spend policy + live quota state for the panel.
    spendState: getAccountSpendState(a, now),
    userStatus: a.userStatus || null,
    lsAdmission: {
      ok: lsAdmission.ok,
      reason: lsAdmission.reason,
      errorType: lsAdmission.errorType,
      key: lsAdmission.key,
      wouldStart: lsAdmission.wouldStart,
      poolSize: lsAdmission.poolSize,
      effectivePoolSize: lsAdmission.effectivePoolSize,
      maxInstances: lsAdmission.maxInstances,
      pending: !!lsAdmission.pending,
      poolFull: !!lsAdmission.poolFull,
      willEvict: !!lsAdmission.willEvict,
      idleEvictableCount: lsAdmission.idleEvictableCount || 0,
      evictionCandidateKey: lsAdmission.evictionCandidateKey || null,
      memoryGuard: {
        okToSpawn: lsAdmission.memoryGuard?.okToSpawn ?? null,
        availableBytes: lsAdmission.memoryGuard?.availableBytes ?? null,
        minAvailableBytes: lsAdmission.memoryGuard?.minAvailableBytes ?? null,
        estimatedRssBytesPerInstance: lsAdmission.memoryGuard?.estimatedRssBytesPerInstance ?? null,
        observedRssEstimateBytes: lsAdmission.memoryGuard?.observedRssEstimateBytes ?? null,
        minAvailableBytesSource: lsAdmission.memoryGuard?.minAvailableBytesSource ?? null,
        reservedStarts: lsAdmission.memoryGuard?.reservedStarts ?? null,
      },
    },
  };
}

// Fold every raw tier value into one of the 4 dashboard buckets. Any paid-ish
// tier (pro / enterprise / teams / trial / premium / …) reads as "pro"; free
// stays free, expired stays expired, and empty/unrecognized is "unknown". Keep
// the accepted set in sync with setAccountTier's manual whitelist.
export function tierBucket(tier) {
  const t = String(tier || '').toLowerCase().trim();
  if (t === 'free') return 'free';
  if (t === 'expired') return 'expired';
  if (t === '' || t === 'unknown') return 'unknown';
  return 'pro';
}

export function getAccountList({ view = 'full', offset = 0, limit = Infinity, filter = '', tier = '' } = {}) {
  const now = Date.now();
  let list = accounts;
  if (filter === 'flagged') {
    list = list.filter(a => a.status === 'error' || (a.errorCount || 0) > 0 || (a.rateLimitedUntil && a.rateLimitedUntil > now));
  }
  if (tier) {
    list = list.filter(a => tierBucket(a.tier) === tier);
  }
  const start = Math.max(0, Number.isFinite(offset) ? offset : 0);
  const end = Number.isFinite(limit) ? start + Math.max(0, limit) : undefined;
  return list.slice(start, end).map(a => publicAccount(a, now, { view }));
}

export function getAccountPublic(id, { view = 'full' } = {}) {
  const account = accounts.find(a => a.id === id);
  return account ? publicAccount(account, Date.now(), { view }) : null;
}

export function getAccountListStats() {
  const now = Date.now();
  let flagged = 0;
  let rateLimited = 0;
  let disabled = 0;
  const byTier = { pro: 0, free: 0, unknown: 0, expired: 0 };
  let balanceTotal = 0;
  let balanceAccounts = 0;
  for (const account of accounts) {
    const isRateLimited = !!(account.rateLimitedUntil && account.rateLimitedUntil > now);
    if (isRateLimited) rateLimited++;
    if (account.status !== 'active') disabled++;
    if (account.status === 'error' || (account.errorCount || 0) > 0 || isRateLimited) flagged++;
    byTier[tierBucket(account.tier)]++;
    // On-demand prepaid balance ($) — only Teams/paid accounts carry it. Sum for
    // a pool total. NOTE: Teams share one balance, so multiple accounts in the
    // same team over-count; surfaced with a caveat until we have a team id to dedupe.
    const bal = account?.credits?.balance;
    if (typeof bal === 'number' && Number.isFinite(bal)) { balanceTotal += bal; balanceAccounts++; }
  }
  return {
    ...getAccountCount(),
    flagged,
    rateLimited,
    disabled,
    byTier,
    balanceTotal,
    balanceAccounts,
  };
}

export function getAccountInternal(id) {
  return accounts.find(a => a.id === id) || null;
}

/**
 * Fetch live credit balance + plan info from server.codeium.com and stash it
 * on the account. Used by manual refresh and by the 15-minute background loop.
 * Errors are returned in-band so the dashboard can show them without throwing.
 */
export async function refreshCredits(id) {
  const account = accounts.find(a => a.id === id);
  if (!account) return { ok: false, error: 'Account not found' };
  try {
    const { getUserStatus } = await import('./windsurf-api.js');
    const proxy = getEffectiveProxy(account.id) || null;
    const status = await getUserStatus(account.apiKey, proxy);
    // Drop the huge raw payload before persisting — keep it only in memory for
    // downstream callers (e.g. model catalog cache) to inspect once.
    const { raw, ...persist } = status;
    account.credits = persist;
    // B: on-demand balance + billing period. The REST getUserStatus `raw` is a
    // PARSED JSON object, not protobuf bytes — feeding it to decodeUserStatusFull
    // (a byte parser) always returned empty, so the on-demand balance never
    // surfaced. Decode balance from the protobuf GetUserStatus instead, whose
    // bytes carry it at the calibrated field #1.13.16 (paid-verified 2026-07-06).
    // fetchUserStatus is a FREE read-only RPC (no chat / no billing fire).
    try {
      const { fetchUserStatus } = await import('./devin-connect-catalog.js');
      const billing = await fetchUserStatus({ token: account.apiKey });
      if (billing) {
        if (billing.balance != null) account.credits.balance = billing.balance;
        if (billing.periodStart) account.credits.periodStart = billing.periodStart;
        if (billing.periodEnd) account.credits.periodEnd = billing.periodEnd;
      }
    } catch (billingErr) {
      log.warn(`refreshCredits ${id}: billing decode failed: ${billingErr.message}`);
    }
    // RB2/B2+B3+B6: react to the fresh balance snapshot. A dry account is
    // pre-cooled on its own quotaResetAt dimension (so getApiKey stops handing
    // it out to eat 402s) and a recovered account is uncooled immediately. This
    // rides the existing 15-min refreshAllCredits timer (B3) — no new timer.
    // Self-healing and NEVER permanent (see applyQuotaSnapshot).
    applyQuotaSnapshot(account, persist.weeklyPercent);
    // Tier hint: if the plan info is explicit, prefer it over capability probing.
    // Trial / individual accounts also count as pro — Windsurf returns
    // "INDIVIDUAL" / "TRIAL" / similar for paid-tier trials (issue #8 follow-up:
    // motto1's 14-day Pro trial was misclassified as free because planName
    // wasn't "Pro").
    const pn = status.planName || '';
    if (!account.tierManual) {
      // Don't clobber an operator-set tier (tierManual). isModelAllowedForAccount
      // trusts account.tier when tierManual is set, so overwriting it here would
      // silently defeat the manual escape hatch (#8).
      if (/pro|teams|enterprise|trial|individual|premium|paid/i.test(pn)) {
        if (account.tier !== 'pro') account.tier = 'pro';
      } else if (/free/i.test(pn)) {
        if (account.tier === 'unknown') account.tier = 'free';
      }
    }
    saveAccounts();
    // Surface the raw response once so the caller can decide whether to mine
    // the bundled model catalog from it.
    return { ok: true, credits: persist, raw };
  } catch (e) {
    const msg = e.message || String(e);
    log.warn(`refreshCredits ${id} failed: ${msg}`);
    // Stash the error on the account so the dashboard can show "last refresh
    // failed" without losing the previously successful snapshot.
    if (account.credits) account.credits.lastError = msg;
    else account.credits = { lastError: msg, fetchedAt: Date.now() };
    return { ok: false, error: msg };
  }
}

export async function refreshAllCredits({ skipBusy = false } = {}) {
  const results = [];
  for (const a of accounts) {
    if (a.status !== 'active') continue;
    if (skipBusy) {
      const busyReason = maintenanceBusyReason(a);
      if (busyReason) {
        results.push({ id: a.id, email: a.email, ok: false, skipped: true, reason: busyReason });
        continue;
      }
    }
    const r = await refreshCredits(a.id);
    results.push({ id: a.id, email: a.email, ok: r.ok, error: r.error });
  }
  return results;
}

/**
 * Update the capability of an account for a specific model.
 * reason: 'success' | 'model_error' | 'rate_limit' | 'transport_error'
 */
export function updateCapability(apiKey, modelKey, ok, reason = '') {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  if (!account.capabilities) account.capabilities = {};
  // Don't overwrite a confirmed failure with a transient error
  if (reason === 'transport_error') return;
  // rate_limit is temporary — don't mark as permanently failed
  if (!ok && reason === 'rate_limit') return;
  account.capabilities[modelKey] = {
    ok,
    lastCheck: Date.now(),
    reason,
  };
  if (ok && (account.tier === 'free' || account.tier === 'unknown')) {
    registerDiscoveredFreeModel(modelKey);
  }
  // Only infer tier when we have no authoritative source. GetUserStatus
  // (userStatusLastFetched) and manual override (tierManual) are both
  // authoritative; inferTier only looks at canary model capabilities and
  // would otherwise demote a Pro/Trial account back to 'free' as soon as
  // a non-premium model (e.g. gemini-2.5-flash, gpt-4o-mini) succeeds.
  if (!account.tierManual && !account.userStatusLastFetched) {
    account.tier = inferTier(account.capabilities);
  }
  saveAccounts();
}

/**
 * Infer subscription tier from which canary models work. Fallback only —
 * probeAccount prefers GetUserStatus which returns the authoritative tier.
 */
function inferTier(caps) {
  const works = (m) => caps[m]?.ok === true;
  if (works('claude-opus-4.6') || works('claude-sonnet-4.6')) return 'pro';
  if (works('gemini-2.5-flash') || works('gpt-4o-mini')) return 'free';
  const checked = Object.keys(caps);
  if (checked.length > 0 && checked.every(m => caps[m].ok === false)) return 'expired';
  return 'unknown';
}

/**
 * Fetch authoritative user status from the LS → account fields.
 * Returns the parsed UserStatus object on success, null on failure.
 */
export async function fetchUserStatus(id, { allowLsStart = true } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return null;

  const { WindsurfClient } = await import('./client.js');
  const { ensureLs, getLsFor } = await import('./langserver.js');
  const proxy = getEffectiveProxy(account.id) || null;
  if (!allowLsStart) {
    const admission = getLsAdmissionForAccount(account.id);
    const skipped = residentProbeSkip(account, admission);
    if (skipped) {
      log.debug(`GetUserStatus ${account.id} skipped: ${skipped.reason} (wouldStart=${!!admission?.wouldStart}, ls=${admission?.key || '?'})`);
      return null;
    }
  }
  if (allowLsStart) await ensureLs(proxy);
  const ls = getLsFor(proxy);
  if (!ls) { log.warn(`No LS for GetUserStatus on ${account.id}`); return null; }

  const client = new WindsurfClient(account.apiKey, ls.port, ls.csrfToken);
  let status;
  try {
    status = await client.getUserStatus();
  } catch (err) {
    log.warn(`GetUserStatus ${safeAccountRef(account)} failed: ${err.message}`);
    return null;
  }

  // Apply to account — authoritative tier + entitlement snapshot.
  const prevTier = account.tier;
  // tierManual is the operator escape hatch (#8): don't let GetUserStatus
  // overwrite a manually-set tier. The entitlement snapshot below still
  // updates regardless (isModelAllowedForAccount ignores capabilities under
  // tierManual anyway).
  if (!account.tierManual) account.tier = status.tierName;
  account.userStatus = {
    teamsTier: status.teamsTier,
    pro: status.pro,
    planName: status.planName,
    email: status.email,
    displayName: status.displayName,
    teamId: status.teamId,
    isTeams: status.isTeams,
    isEnterprise: status.isEnterprise,
    hasPaidFeatures: status.hasPaidFeatures,
    trialEndMs: status.trialEndMs,
    promptCreditsUsed: status.userUsedPromptCredits,
    flowCreditsUsed: status.userUsedFlowCredits,
    monthlyPromptCredits: status.monthlyPromptCredits,
    monthlyFlowCredits: status.monthlyFlowCredits,
    maxPremiumChatMessages: status.maxPremiumChatMessages,
    allowedModels: status.allowedModels,
  };
  account.userStatusLastFetched = Date.now();
  if (status.email && !account.email.includes('@')) account.email = status.email;

  // Mark every cascade-allowed enum as capable; every catalog enum NOT in the
  // allowlist as not-entitled. Pure-UID models (no enum) are left to the
  // canary probe since the server returns allowlists by enum only.
  if (status.allowedModels.length > 0) {
    if (!account.capabilities) account.capabilities = {};
    const allowedEnums = new Set(status.allowedModels.map(m => m.modelEnum).filter(e => e > 0));
    for (const [key, info] of Object.entries(MODELS)) {
      if (!info.enumValue || info.enumValue <= 0) continue;
      if (allowedEnums.has(info.enumValue)) {
        account.capabilities[key] = { ok: true, lastCheck: Date.now(), reason: 'user_status' };
      } else {
        const prev = account.capabilities[key];
        if (!prev || prev.reason !== 'success') {
          // Respect a previously-validated success (can happen if allowlist is
          // cascade-only while the model was reached via legacy endpoint).
          account.capabilities[key] = { ok: false, lastCheck: Date.now(), reason: 'not_entitled' };
        }
      }
    }
  }

  if (prevTier !== account.tier) {
    log.info(`Tier change ${safeAccountRef(account)}: ${prevTier} → ${account.tier} (plan="${status.planName}", ${status.allowedModels.length} allowed models)`);
  } else {
    log.info(`UserStatus ${safeAccountRef(account)}: tier=${account.tier} plan="${status.planName}" allowed=${status.allowedModels.length}`);
  }
  saveAccounts();
  return status;
}

// Expanded canary set — one representative per routing path / provider family.
// Order matters: free-tier models first so tier can be inferred early even if
// later requests rate-limit. modelUid-only entries cover the 4.6 series since
// GetUserStatus's allowlist is enum-keyed.
// Only probe cheap/non-rate-limited models. Claude models burn Trial quota
// fast (2-3 req/hr) — GetUserStatus enum allowlist already covers them.
const PROBE_CANARIES = [
  'gemini-2.5-flash',
  'gemini-3.0-flash',
];

// Billable-canary gate. Steps 2 & 3 of the probe send REAL cascadeChat('hi')
// calls — each one spends the account's prompt credits. GetUserStatus (Step 1)
// is free and authoritative for every enum-keyed model, so the canary is only
// needed to classify UID-only models and discover free-tier extras. A live
// incident (2026-06-29) showed a force-probe canary sweep flipping a working
// free account to "expired" by exhausting its allowance. Default OFF: probing
// never spends credit unless the operator explicitly opts in (env=1) or a
// caller passes { canary: true } (e.g. dashboard "deep probe").
function probeCanaryDefault() {
  return process.env.WINDSURFAPI_PROBE_CANARY === '1';
}

/**
 * Probe an account's tier and model capabilities.
 *
 * Strategy (2026-04-21):
 *   1. GetUserStatus — authoritative tier + enum-keyed allowlist with credit
 *      multipliers + trial end time + credit usage. One RPC, no quota burn.
 *   2. Canary probe — fills in capabilities for modelUid-only models (claude
 *      4.6 series etc.) which don't appear in the enum allowlist, and serves
 *      as a fallback if GetUserStatus fails on this LS/account combo.
 */
// Per-account in-flight map. The previous global boolean serialized
// every probe globally, and the dashboard surfaced "skipped" the same
// way as "not found" -> users with N accounts saw N-1 fake "Account not
// found" toasts when they bulk-probed. Now each account has its own
// promise; a duplicate call on the same id returns the in-flight promise
// so the caller awaits the same result without firing a second probe.
const _probeInFlight = new Map();

export async function probeAccount(id, { allowLsStart = true, canary } = {}) {
  const existing = _probeInFlight.get(id);
  if (existing) return existing;

  const account = accounts.find(a => a.id === id);
  if (!account) return null;

  if (!allowLsStart) {
    const admission = getLsAdmissionForAccount(id);
    const skipped = residentProbeSkip(account, admission);
    if (skipped) return skipped;
  }

  const useCanary = canary ?? probeCanaryDefault();
  const promise = _probeAccountImpl(account, { allowLsStart, canary: useCanary }).finally(() => {
    _probeInFlight.delete(id);
  });
  _probeInFlight.set(id, promise);
  return promise;
}

async function _probeAccountImpl(account, { allowLsStart = true, canary } = {}) {
  const runCanary = canary ?? probeCanaryDefault();
  let accountMaintenanceToken = null;
  let lsMaintenanceToken = null;
  try {
    const { beginLsMaintenanceUse } = await import('./langserver.js');
    const preAdmission = getLsAdmissionForAccount(account.id);
    if (!allowLsStart) {
      const skipped = residentProbeSkip(account, preAdmission);
      if (skipped) return skipped;
    }
    if (preAdmission.reason === 'already_running' && preAdmission.port) {
      accountMaintenanceToken = beginAccountMaintenance(account);
      lsMaintenanceToken = beginLsMaintenanceUse(preAdmission.port);
      if (!lsMaintenanceToken) {
        endAccountMaintenance(accountMaintenanceToken);
        accountMaintenanceToken = null;
        return {
          skipped: true,
          reason: 'ls_not_idle_resident',
          tier: account.tier || 'unknown',
          capabilities: account.capabilities || {},
          admission: preAdmission,
        };
      }
    }

    // ── Step 1: authoritative tier via GetUserStatus ──
    const status = await fetchUserStatus(account.id, { allowLsStart });

  const { WindsurfClient } = await import('./client.js');
  const { getModelInfo } = await import('./models.js');
  const { ensureLs, getLsFor } = await import('./langserver.js');

  const proxy = getEffectiveProxy(account.id) || null;
  if (!allowLsStart) {
    const skipped = residentProbeSkip(account, getLsAdmissionForAccount(account.id));
    if (skipped) return skipped;
  }
  if (allowLsStart) await ensureLs(proxy);
  const ls = getLsFor(proxy);
  if (!ls) { log.error(`No LS available for account ${account.id}`); return null; }
  const port = ls.port;
  const csrf = ls.csrfToken;

  // ── Step 2: canary probe, skipping models already classified by GetUserStatus ──
  // BILLABLE: each cascadeChat below spends prompt credits. Off unless the
  // caller opted in (canary=true / WINDSURFAPI_PROBE_CANARY=1). GetUserStatus
  // already classified every enum-keyed model for free above.
  // When allowlist is available we only need to probe UID-only models (no enum,
  // so server can't include them in allowlist) to get their actual status.
  const needsProbe = !runCanary ? [] : PROBE_CANARIES.filter(key => {
    const info = getModelInfo(key);
    if (!info) return false;
    // If GetUserStatus already gave us a definitive answer, skip.
    if (status && info.enumValue > 0) {
      const cap = account.capabilities?.[key];
      if (cap && cap.reason === 'user_status') return false;
      if (cap && cap.reason === 'not_entitled') return false;
    }
    return true;
  });

  if (needsProbe.length > 0) {
    log.info(`Probing ${safeAccountRef(account)} across ${needsProbe.length} canary models (GetUserStatus ${status ? 'OK' : 'unavailable'})`);

    for (const modelKey of needsProbe) {
      const info = getModelInfo(modelKey);
      if (!info) continue;
      const useCascade = !!info.modelUid;
      const client = new WindsurfClient(account.apiKey, port, csrf);
      try {
        if (useCascade) {
          await client.cascadeChat([{ role: 'user', content: 'hi' }], info.enumValue, info.modelUid);
        } else {
          await client.rawGetChatMessage([{ role: 'user', content: 'hi' }], info.enumValue, info.modelUid);
        }
        updateCapability(account.apiKey, modelKey, true, 'success');
        log.info(`  ${modelKey}: OK`);
      } catch (err) {
        const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
        if (isRateLimit) {
          log.info(`  ${modelKey}: RATE_LIMITED (skipped)`);
        } else {
          updateCapability(account.apiKey, modelKey, false, 'model_error');
          log.info(`  ${modelKey}: FAIL (${err.message.slice(0, 80)})`);
        }
      }
    }
  }

  // ── Step 3: dynamic cloud candidate probe (#42) ──
  // BILLABLE: also gated behind the canary opt-in (see Step 2). Probe models
  // from the live cloud catalog that aren't in PROBE_CANARIES
  // and haven't been classified yet. This discovers models available to free
  // accounts beyond the hardcoded FREE_TIER_MODELS list.
  if (runCanary) try {
    const allModels = Object.keys(MODELS);
    const alreadyProbed = new Set([
      ...PROBE_CANARIES,
      ...Object.keys(account.capabilities || {}),
    ]);
    const MAX_CLOUD_PROBES = positiveIntEnv('MAX_CLOUD_PROBES', 10);
    const cloudCandidates = allModels.filter(k => {
      if (alreadyProbed.has(k)) return false;
      const info = getModelInfo(k);
      if (!info?.modelUid) return false;
      if (info.enumValue > 0 && status) return false;
      if ((info.credit || 1) > 2) return false;
      return true;
    }).slice(0, MAX_CLOUD_PROBES);

    if (cloudCandidates.length > 0) {
      log.info(`Dynamic cloud probe: ${cloudCandidates.length} candidates for ${safeAccountRef(account)} (cap=${MAX_CLOUD_PROBES})`);
      let rateLimited = false;
      for (const modelKey of cloudCandidates) {
        if (rateLimited) break;
        const info = getModelInfo(modelKey);
        if (!info) continue;
        const client = new WindsurfClient(account.apiKey, port, csrf);
        try {
          await client.cascadeChat([{ role: 'user', content: 'hi' }], info.enumValue, info.modelUid);
          updateCapability(account.apiKey, modelKey, true, 'cloud_probe');
          log.info(`  cloud ${modelKey}: OK`);
        } catch (err) {
          if (/rate limit|rate_limit|too many requests|quota/i.test(err.message)) {
            log.info(`  cloud ${modelKey}: RATE_LIMITED — stopping probe`);
            rateLimited = true;
          } else {
            updateCapability(account.apiKey, modelKey, false, 'cloud_probe');
            log.debug(`  cloud ${modelKey}: FAIL`);
          }
        }
      }
    }
  } catch (e) {
    log.warn(`Dynamic cloud probe failed: ${e.message}`);
  }

  // If GetUserStatus succeeded, its tier decision wins over the inferred one
  // (updateCapability rewrites tier via inferTier, so restore it afterwards).
  // Unless the operator pinned the tier manually (#8) — then leave it alone.
  if (status && !account.tierManual) account.tier = status.tierName;

  account.lastProbed = Date.now();
  saveAccounts();
  log.info(`Probe complete for ${account.id}: tier=${account.tier}${status ? ` plan="${status.planName}"` : ''}`);
  return { tier: account.tier, capabilities: account.capabilities };
  } catch (err) {
    log.error(`Probe failed for ${account.id}: ${err.message}`);
    throw err;
  } finally {
    try {
      const { endLsMaintenanceUse } = await import('./langserver.js');
      endLsMaintenanceUse(lsMaintenanceToken);
    } catch {}
    endAccountMaintenance(accountMaintenanceToken);
  }
}

export function getAccountCount() {
  return {
    total: accounts.length,
    active: accounts.filter(a => a.status === 'active').length,
    error: accounts.filter(a => a.status === 'error').length,
  };
}

// ─── Incoming request API key validation ───────────────────

export function configureBindHost(host) {
  _bindHost = String(host ?? '');
}

export function isLocalBindHost(bindHost = _bindHost) {
  const host = String(bindHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1 etc.) is also local.
  if (host.startsWith('::ffff:127.') || host === '::ffff:7f00:1') return true;
  return false;
}

export function safeEqualString(a, b) {
  // Hash-then-compare so the early-return on different lengths can't be
  // measured by a wall-clock attacker. SHA-256 of any input is 32 bytes,
  // so timingSafeEqual always sees equal-length buffers and runs in
  // constant time. The trailing `.length` check restores correctness for
  // the rare case where two distinct inputs collide on the digest (which
  // would still need a full preimage attack to construct).
  const sa = String(a);
  const sb = String(b);
  const left = createHash('sha256').update(sa, 'utf8').digest();
  const right = createHash('sha256').update(sb, 'utf8').digest();
  return timingSafeEqual(left, right) && sa.length === sb.length;
}

// v2.0.56: hook lets runtime-config (or future credential sources) supply
// a live API key. validateApiKey() falls through to config.apiKey when the
// hook is unset, which is the case during cold boot before runtime-config
// finishes loading. Set via setApiKeyResolver() from the credential module
// once it has parsed runtime-config.json.
let _apiKeyResolver = null;
export function setApiKeyResolver(fn) {
  _apiKeyResolver = typeof fn === 'function' ? fn : null;
}

export function validateApiKey(key) {
  let effectiveKey = config.apiKey;
  if (_apiKeyResolver) {
    try {
      const v = _apiKeyResolver();
      if (typeof v === 'string') effectiveKey = v;
    } catch { /* keep env fallback */ }
  }
  if (!effectiveKey) return isLocalBindHost(_bindHost);
  if (!key) return false;
  return safeEqualString(key, effectiveKey);
}

// ─── Brute-force lockout (v2.0.56, CLIProxyAPI-style) ─────────────────
// Track failed dashboard auth attempts per client IP. After
// `LOCKOUT_THRESHOLD` failures lock the IP for `LOCKOUT_DURATION_MS`.
// Idle entries get pruned every `LOCKOUT_CLEANUP_MS`.
//
// We export the helpers so the dashboard middleware can drive them and
// tests can probe behaviour. Numbers mirror CLIProxyAPI's defaults
// (5 failures / 30 min ban / 2h idle TTL / 1h cleanup interval).

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;
const LOCKOUT_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const LOCKOUT_CLEANUP_MS = 60 * 60 * 1000;
// LOCK-2 (audit P1, unauth-reachable): the per-IP lockout Map is reached
// BEFORE the API-key gate (dashboard auth failures), so an attacker who can
// present distinct source IPs (spoofed XFF pre-fix, IPv6 /64 rotation, a
// botnet) could grow this Map without bound and OOM the single process. Cap
// the number of tracked IPs and evict the oldest non-banned entry when full
// so distinct-IP floods can't exhaust memory — and can't wipe a live ban.
function _defaultLockoutMax() {
  const raw = Number(process.env.LOCKOUT_MAX_ENTRIES);
  return Number.isInteger(raw) && raw > 0 ? raw : 50000;
}
let _lockoutMaxEntries = _defaultLockoutMax();
// Bounded scan budget: how many leading (oldest) entries we may skip past
// while looking for an evictable (non-banned) one before giving up. Keeps
// the per-insert cost O(1) amortized even in the pathological all-banned case.
const _LOCKOUT_EVICT_SCAN_BUDGET = 64;
const _lockoutAttempts = new Map();

function _now() { return Date.now(); }

export function _resetLockoutForTests() { _lockoutAttempts.clear(); }

// Test seam: override the hard cap (returns the previous value) so the LOCK-2
// regression can prove the bound with a small map instead of allocating 50k.
export function __setLockoutMaxForTests(n) {
  const prev = _lockoutMaxEntries;
  _lockoutMaxEntries = Number.isInteger(n) && n > 0 ? n : _defaultLockoutMax();
  return prev;
}
export function __lockoutSizeForTests() { return _lockoutAttempts.size; }

// Reclaim one slot for a NEW ip when the Map is at capacity. Evicts the oldest
// (insertion-order) entry that is NOT under an active ban, so a distinct-IP
// flood stays memory-bounded without ever releasing a live lockout early.
// Returns true if a slot was freed. Bounded by _LOCKOUT_EVICT_SCAN_BUDGET.
function _evictLockoutForInsert(now) {
  let scanned = 0;
  for (const [ip, e] of _lockoutAttempts) {
    if (e.blockedUntil > now) {
      if (++scanned >= _LOCKOUT_EVICT_SCAN_BUDGET) break;
      continue;
    }
    _lockoutAttempts.delete(ip);
    return true;
  }
  return false;
}

export function getLockoutState(ip) {
  if (!ip) return { count: 0, blockedUntil: 0 };
  const e = _lockoutAttempts.get(ip);
  if (!e) return { count: 0, blockedUntil: 0 };
  return { count: e.count, blockedUntil: e.blockedUntil };
}

/**
 * Returns `{ blocked: bool, retryAfterMs: number, count: number }`. Call
 * BEFORE checking the password — if blocked, reject with 429 / 403 and
 * skip the comparison entirely so the lockout stays effective even when
 * the comparison itself is fast.
 */
export function checkLockout(ip) {
  if (!ip) return { blocked: false, retryAfterMs: 0, count: 0 };
  // Operator disabled the IP lockout (threshold 0) from Settings: release any
  // existing ban immediately instead of leaving it to expire naturally. Without
  // this, an operator who locked themselves out and then set 0 wouldn't get in
  // until the old ban aged out — contradicting the "0 = off" mental model.
  if (getIpLockThreshold() <= 0) {
    _lockoutAttempts.delete(ip);
    return { blocked: false, retryAfterMs: 0, count: 0 };
  }
  const e = _lockoutAttempts.get(ip);
  if (!e) return { blocked: false, retryAfterMs: 0, count: 0 };
  const now = _now();
  if (e.blockedUntil > now) {
    return { blocked: true, retryAfterMs: e.blockedUntil - now, count: e.count };
  }
  // Ban expired — reset to give the caller a fresh window. Don't delete
  // the record; failedAuthAttempt() may add to it again immediately.
  if (e.blockedUntil > 0 && e.blockedUntil <= now) {
    e.count = 0;
    e.blockedUntil = 0;
  }
  return { blocked: false, retryAfterMs: 0, count: e.count };
}

export function failedAuthAttempt(ip) {
  if (!ip) return { blocked: false, retryAfterMs: 0, count: 0 };
  // Operator can disable the IP lockout entirely (threshold 0) from Settings.
  const threshold = getIpLockThreshold();
  if (threshold <= 0) return { blocked: false, retryAfterMs: 0, count: 0 };
  const now = _now();
  let e = _lockoutAttempts.get(ip);
  if (!e) {
    // LOCK-2: enforce the hard cap before inserting a brand-new IP. If we're
    // at capacity, evict the oldest non-banned entry; if every slot is a live
    // ban (can't happen with a sane cap, but guard anyway) short-circuit and
    // don't create a record — the flood can't grow memory past the bound.
    if (_lockoutAttempts.size >= _lockoutMaxEntries && !_evictLockoutForInsert(now)) {
      return { blocked: false, retryAfterMs: 0, count: 0 };
    }
    e = { count: 0, blockedUntil: 0, lastActivity: now };
    _lockoutAttempts.set(ip, e);
  }
  e.count += 1;
  e.lastActivity = now;
  if (e.count >= threshold) {
    e.blockedUntil = now + getIpLockMs();
    e.count = 0; // reset counter so the next post-ban failure starts fresh
  }
  return {
    blocked: e.blockedUntil > now,
    retryAfterMs: e.blockedUntil > now ? e.blockedUntil - now : 0,
    count: e.count,
  };
}

export function successfulAuthAttempt(ip) {
  if (!ip) return;
  _lockoutAttempts.delete(ip);
}

function _purgeLockouts() {
  const now = _now();
  for (const [ip, e] of _lockoutAttempts) {
    // Keep active bans regardless of idle time.
    if (e.blockedUntil > now) continue;
    if (now - (e.lastActivity || 0) > LOCKOUT_IDLE_TTL_MS) {
      _lockoutAttempts.delete(ip);
    }
  }
}

setInterval(_purgeLockouts, LOCKOUT_CLEANUP_MS).unref?.();

export function shouldEmitNoAuthWarning(bindHost, hasKey) {
  if (hasKey) return false;
  if (isLocalBindHost(bindHost)) return false;
  const host = String(bindHost || '').trim().toLowerCase();
  if (host === '0.0.0.0' || host === '::') return true;
  return true;
}

export function emitNoAuthWarnings(bindHost = '0.0.0.0') {
  const apiOpen = shouldEmitNoAuthWarning(bindHost, !!config.apiKey);
  // v2.0.55 (audit H1): the dashboard write surface no longer trusts
  // config.apiKey as a fallback admin password on non-local binds, so
  // the warning fires whenever DASHBOARD_PASSWORD is missing in public
  // mode — even if API_KEY is set. Without the password the dashboard
  // fails closed (better than the old privilege-escalation), but the
  // operator still needs the warning so they explicitly configure one.
  const dashboardOpen = shouldEmitNoAuthWarning(bindHost, !!config.dashboardPassword);

  // audit #7: brute-force lockout keys on the client IP, which is the socket
  // peer unless TRUST_PROXY_X_FORWARDED_FOR=1. Behind a reverse proxy that
  // terminates on loopback (the documented homecloud openresty→127.0.0.1
  // topology) every request's peer IS 127.0.0.1, so ALL failed dashboard logins
  // collapse into one bucket — an attacker's 5 wrong passwords lock the single
  // loopback bucket and, because the lockout is checked BEFORE auth, the
  // operator can't even log in to clear it. Warn so they enable real per-client
  // IP attribution. (Not auto-enabled: trusting XFF blindly is itself spoofable,
  // so it stays an explicit opt-in with a configured hop count.)
  // Reuse the authoritative loopback classifier (handles ::ffff:127.* etc.)
  // instead of a second, narrower regex that could drift from it.
  if (isLocalBindHost(bindHost) && process.env.TRUST_PROXY_X_FORWARDED_FOR !== '1') {
    log.warn('AUTH: dashboard bound to loopback with X-Forwarded-For trust OFF. Behind a reverse proxy, brute-force lockout buckets all clients as 127.0.0.1 (one bad actor can lock everyone, including you). If a proxy fronts this, set TRUST_PROXY_X_FORWARDED_FOR=1 and TRUST_PROXY_HOPS=<n> so lockout keys on the real client IP.');
  }

  if (!apiOpen && !dashboardOpen) return;
  const lines = [
    '+------------------------------------------------------------------+',
    '| WARNING: AUTHENTICATION IS NOT CONFIGURED                        |',
    '| 警告：当前服务未配置访问认证                                      |',
    '|                                                                  |',
    '| This server is listening beyond localhost. Set API_KEY before     |',
    '| exposing REST APIs, and set DASHBOARD_PASSWORD for dashboard      |',
    '| write operations (v2.0.55: API_KEY no longer doubles as the       |',
    '| dashboard admin password on public binds — set both).             |',
    '| 服务正在非本机地址监听。公网/内网暴露前请配置 API_KEY，并为        |',
    '| Dashboard 写接口配置 DASHBOARD_PASSWORD（v2.0.55 起公网 bind 上    |',
    '| API_KEY 不再回落作为 Dashboard 密码 — 两个都必须显式配置）。      |',
    '+------------------------------------------------------------------+',
  ];
  for (const line of lines) log.warn(line);
}

// ─── Firebase token refresh ──────────────────────────────────

/**
 * Refresh Firebase tokens for all accounts that have a stored refreshToken.
 * Re-registers with Codeium to get a fresh API key and updates the account.
 */
async function refreshAllFirebaseTokens({ skipBusy = false } = {}) {
  const { refreshFirebaseToken, reRegisterWithCodeium } = await import('./dashboard/windsurf-login.js');
  for (const a of accounts) {
    if (a.status !== 'active' || !a.refreshToken) continue;
    if (skipBusy) {
      const busyReason = maintenanceBusyReason(a);
      if (busyReason) {
        log.debug(`Firebase refresh ${a.id} skipped: ${busyReason}`);
        continue;
      }
    }
    try {
      const proxy = getEffectiveProxy(a.id) || null;
      const { idToken, refreshToken: newRefresh } = await refreshFirebaseToken(a.refreshToken, proxy);
      a.refreshToken = newRefresh;
      // Re-register to get a fresh API key (may be the same key)
      const { apiKey } = await reRegisterWithCodeium(idToken, proxy);
      if (apiKey && apiKey !== a.apiKey) {
        log.info(`Firebase refresh: ${safeAccountRef(a)} got new API key`);
        a.apiKey = apiKey;
      }
      a._refreshFailStreak = 0;
      saveAccounts();
    } catch (e) {
      log.warn(`Firebase refresh ${safeAccountRef(a)} failed: ${e.message}`);
      // AP-RISK-4: a refresh failure means the stored token may be dead. If we
      // do nothing, the account stays 'active' and keeps getting selected with
      // a stale/expired key, burning user-visible failures. Count consecutive
      // failures and downgrade after a streak (a one-off network blip still
      // gets retried next cycle). A real success resets the streak above.
      a._refreshFailStreak = (a._refreshFailStreak || 0) + 1;
      if (a._refreshFailStreak >= 3 && a.status === 'active') {
        a.status = 'error';
        a.erroredAt = Date.now();
        saveAccounts();
        log.warn(`Account ${safeAccountRef(a)} downgraded to error after ${a._refreshFailStreak} consecutive Firebase refresh failures`);
      }
    }
  }
}

// ─── Init from .env ────────────────────────────────────────

export async function initAuth() {
  // Load persisted accounts first
  loadAccounts();

  // Safety net: auto-reset stale inflight counters (fixes #165)
  startInflightCleanup();

  const promises = [];

  // Load API keys from env (comma-separated)
  if (config.codeiumApiKey) {
    for (const key of config.codeiumApiKey.split(',').map(k => k.trim()).filter(Boolean)) {
      addAccountByKey(key);
    }
  }

  // Load auth tokens from env (comma-separated)
  if (config.codeiumAuthToken) {
    for (const token of config.codeiumAuthToken.split(',').map(t => t.trim()).filter(Boolean)) {
      promises.push(
        addAccountByToken(token).catch(err => log.error(`Token auth failed: ${err.message}`))
      );
    }
  }

  // Note: email/password login removed (Firebase API key not valid for direct login)
  // Use token-based auth instead

  if (promises.length > 0) await Promise.allSettled(promises);

  // Periodic re-probe so tier/capability info doesn't drift as quotas reset.
  const REPROBE_INTERVAL = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    for (const a of accounts) {
      if (a.status !== 'active') continue;
      const admission = getLsAdmissionForAccount(a.id);
      if (!admission.ok || admission.reason !== 'already_running' || (admission.activeRequests || 0) > 0 || (admission.maintenanceRequests || 0) > 0 || isAccountBusyForProbe(a)) {
        log.info(`Scheduled probe ${a.id} skipped: ${admission.errorType || admission.reason} (wouldStart=${!!admission.wouldStart}, ls=${admission.key || '?'})`);
        continue;
      }
      try { await probeAccount(a.id, { allowLsStart: false }); }
      catch (e) { log.warn(`Scheduled probe ${a.id} failed: ${e.message}`); }
    }
  }, REPROBE_INTERVAL).unref?.();

  // Periodic credit refresh (every 15 min). First run is fire-and-forget so
  // startup isn't blocked by cloud round-trips.
  const CREDIT_INTERVAL = 15 * 60 * 1000;
  const skipBusyMaintenance = shouldSkipBusyBackgroundMaintenance();
  refreshAllCredits({ skipBusy: skipBusyMaintenance }).catch(e => log.warn(`Initial credit refresh: ${e.message}`));
  setInterval(() => {
    refreshAllCredits({ skipBusy: skipBusyMaintenance }).catch(e => log.warn(`Scheduled credit refresh: ${e.message}`));
  }, CREDIT_INTERVAL).unref?.();

  // Fetch live model catalog from cloud and merge into hardcoded catalog.
  // Fire-and-forget — the hardcoded catalog is sufficient until this completes.
  // trySyncModelCatalog also fires again when the first account becomes active.
  trySyncModelCatalog();

  // Periodic Firebase token refresh (every 50 min). Firebase ID tokens expire
  // after 60 min; refreshing at 50 keeps a comfortable margin.
  const TOKEN_REFRESH_INTERVAL = 50 * 60 * 1000;
  refreshAllFirebaseTokens({ skipBusy: skipBusyMaintenance }).catch(e => log.warn(`Initial token refresh: ${e.message}`));
  setInterval(() => {
    refreshAllFirebaseTokens({ skipBusy: skipBusyMaintenance }).catch(e => log.warn(`Scheduled token refresh: ${e.message}`));
  }, TOKEN_REFRESH_INTERVAL).unref?.();

  // Periodic DEVIN_CONNECT session-token liveness sweep. The session_id has no
  // refresh path, so a zero-billable GetUserStatus probe is the only way to spot
  // a retired token before a user request hits it. Opt-in via
  // DEVIN_CONNECT_LIVENESS_PROBE=1 since it adds a periodic upstream call per
  // session-token account; pairs with DEVIN_CONNECT_AUTO_RELOGIN for recovery.
  if (String(process.env.DEVIN_CONNECT_LIVENESS_PROBE || '') === '1') {
    const LIVENESS_INTERVAL = Number(process.env.DEVIN_CONNECT_LIVENESS_INTERVAL_MS) || 10 * 60 * 1000;
    const sweep = async () => {
      for (const a of accounts) {
        if (!String(a.apiKey || '').startsWith('devin-session-token$')) continue;
        try { await probeAndRecoverConnectAccount(a.id); }
        catch (e) { log.warn(`Liveness sweep ${a.id} failed: ${e.message}`); }
      }
    };
    setInterval(() => { sweep().catch(e => log.warn(`Liveness sweep: ${e.message}`)); }, LIVENESS_INTERVAL).unref?.();
    log.info(`DEVIN_CONNECT liveness probe enabled (every ${Math.round(LIVENESS_INTERVAL / 60000)}m)`);
  }

  // Warm up the default LS so first chat avoids spawn cost. Proxy-specific
  // LS instances are on-demand by default: current LS builds can consume
  // ~500MB RSS including the child worker, so prewarming every proxy on a
  // small VPS can exhaust memory before any request arrives.
  //
  // DEVIN_CONNECT / DEVIN_ONLY are binary-less (pure HTTP to Devin cloud), so the
  // language server is never used — skip warmup to avoid the misleading "LS
  // instance spawn error / warmup failed" noise on every Devin-only startup.
  const lsBackendUnused = String(process.env.DEVIN_CONNECT || '').trim() === '1'
    || String(process.env.DEVIN_ONLY || '').trim() === '1';
  if (!lsBackendUnused) {
    const { ensureLs, shouldPrewarmDefaultLs } = await import('./langserver.js');
    const uniqueProxies = new Map();
    if (shouldPrewarmDefaultLs()) {
      uniqueProxies.set('default', null);
    }
    if (process.env.LS_PREWARM_PROXIES === '1') {
      for (const a of accounts) {
        const p = getEffectiveProxy(a.id);
        const k = p ? `${p.host}:${p.port}` : 'default';
        if (!uniqueProxies.has(k)) uniqueProxies.set(k, p || null);
      }
    }
    for (const p of uniqueProxies.values()) {
      try { await ensureLs(p); }
      catch (e) { log.warn(`LS warmup failed: ${e.message}`); }
    }
  }

  const counts = getAccountCount();
  if (counts.total > 0) {
    log.info(`Auth pool: ${counts.active} active, ${counts.error} error, ${counts.total} total`);
  } else {
    log.warn('No accounts configured. Add via POST /auth/login');
  }
}
