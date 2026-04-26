/**
 * Multi-account authentication pool for Codeium/Windsurf.
 *
 * Features:
 *   - Multiple accounts with round-robin load balancing
 *   - Account health tracking (error count, auto-disable)
 *   - Dynamic add/remove via API
 *   - Token-based registration via api.codeium.com
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { config, log } from './config.js';
import { getEffectiveProxy } from './dashboard/proxy-config.js';
import { getTierModels, getModelKeysByEnum, MODELS, registerDiscoveredFreeModel } from './models.js';

import { join } from 'path';
const ACCOUNTS_FILE = join(config.dataDir, 'accounts.json');

// ─── Account pool ──────────────────────────────────────────

const accounts = [];
let _roundRobinIndex = 0;

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

function rpmLimitFor(account) {
  return TIER_RPM[account.tier || 'unknown'] ?? 20;
}

function pruneRpmHistory(account, now) {
  if (!account._rpmHistory) account._rpmHistory = [];
  const cutoff = now - RPM_WINDOW_MS;
  while (account._rpmHistory.length && account._rpmHistory[0] < cutoff) {
    account._rpmHistory.shift();
  }
  return account._rpmHistory.length;
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
    tier: a.tier, tierManual: !!a.tierManual,
    capabilities: a.capabilities, lastProbed: a.lastProbed,
    credits: a.credits || null,
    blockedModels: a.blockedModels || [],
    refreshToken: a.refreshToken || '',
    // From GetUserStatus — the authoritative tier/entitlement snapshot.
    userStatus: a.userStatus || null,
    userStatusLastFetched: a.userStatusLastFetched || 0,
  }));
}

function saveAccounts() {
  if (_saveInFlight) { _savePending = true; return; }
  _saveInFlight = true;
  const tempFile = ACCOUNTS_FILE + '.tmp';
  try {
    // Atomic write: write to .tmp then rename so a crash mid-write can't
    // leave accounts.json truncated/corrupt. Node's renameSync is atomic
    // on POSIX and replaces the target on Windows (fs.rename behavior).
    writeFileSync(tempFile, JSON.stringify(_serializeAccounts(), null, 2));
    renameSync(tempFile, ACCOUNTS_FILE);
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
  const tempFile = ACCOUNTS_FILE + '.shutdown.tmp';
  try {
    writeFileSync(tempFile, JSON.stringify(_serializeAccounts(), null, 2));
    renameSync(tempFile, ACCOUNTS_FILE);
  } catch (e) {
    log.error('Shutdown: failed to flush accounts:', e.message);
    try { unlinkSync(tempFile); } catch {}
  }
}

function loadAccounts() {
  try {
    if (!existsSync(ACCOUNTS_FILE)) return;
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    for (const a of data) {
      if (accounts.find(x => x.apiKey === a.apiKey)) continue;
      accounts.push({
        id: a.id || randomUUID().slice(0, 8),
        email: a.email, apiKey: a.apiKey,
        apiServerUrl: a.apiServerUrl || '',
        method: a.method || 'api_key',
        status: a.status || 'active',
        lastUsed: 0, errorCount: 0,
        refreshToken: a.refreshToken || '', expiresAt: 0, refreshTimer: null,
        addedAt: a.addedAt || Date.now(),
        tier: a.tier || 'unknown',
        capabilities: a.capabilities || {},
        lastProbed: a.lastProbed || 0,
        credits: a.credits || null,
        blockedModels: Array.isArray(a.blockedModels) ? a.blockedModels : [],
        tierManual: !!a.tierManual,
        userStatus: a.userStatus || null,
        userStatusLastFetched: a.userStatusLastFetched || 0,
      });
    }
    if (data.length > 0) log.info(`Loaded ${data.length} account(s) from disk`);
  } catch (e) {
    log.error('Failed to load accounts:', e.message);
  }
}

// ─── Dynamic model catalog from cloud ─────────────────────

async function fetchAndMergeModelCatalog() {
  // Use the first active account to fetch the catalog.
  const acct = accounts.find(a => a.status === 'active' && a.apiKey);
  if (!acct) {
    log.debug('No active account for model catalog fetch');
    return;
  }
  try {
    const { getCascadeModelConfigs } = await import('./windsurf-api.js');
    const { mergeCloudModels } = await import('./models.js');
    const proxy = getEffectiveProxy(acct.id) || null;
    const { configs } = await getCascadeModelConfigs(acct.apiKey, proxy);
    const added = mergeCloudModels(configs);
    log.info(`Model catalog: ${configs.length} cloud models, ${added} new entries merged`);
  } catch (e) {
    log.warn(`Model catalog fetch failed: ${e.message}`);
  }
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
export function addAccountByKey(apiKey, label = '') {
  const existing = accounts.find(a => a.apiKey === apiKey);
  if (existing) return existing;

  const account = {
    id: randomUUID().slice(0, 8),
    email: label || `key-${apiKey.slice(0, 8)}`,
    apiKey,
    apiServerUrl: '',
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
  accounts.push(account);
  saveAccounts();
  log.info(`Account added: ${account.id} (${account.email}) [api_key]`);
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
  accounts.push(account);
  saveAccounts();
  log.info(`Account added: ${account.id} (${account.email}) [token] server=${account.apiServerUrl}`);
  return account;
}

/**
 * Add account via email/password is not supported for direct Firebase login.
 * Use token-based auth instead: get a token from windsurf.com/show-auth-token
 */
export async function addAccountByEmail(email, password) {
  throw new Error('Direct email/password login is not supported. Use token-based auth: get token from windsurf.com, then POST /auth/login {"token":"..."}');
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
 * Resolve whether `modelKey` is callable on this account:
 *   tier entitlement ∩ (models.js catalog) − account.blockedModels
 */
export function isModelAllowedForAccount(account, modelKey) {
  const tierModels = getTierModels(account.tier || 'unknown');
  if (!tierModels.includes(modelKey)) return false;
  const blocked = account.blockedModels || [];
  if (blocked.includes(modelKey)) return false;
  return true;
}

/** List of model keys this account is currently allowed to call. */
export function getAvailableModelsForAccount(account) {
  const tierModels = getTierModels(account.tier || 'unknown');
  const blocked = new Set(account.blockedModels || []);
  return tierModels.filter(m => !blocked.has(m));
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
  log.info(`Account removed: ${id} (${account.email})`);
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
export function getApiKey(excludeKeys = [], modelKey = null) {
  const now = Date.now();
  const candidates = [];
  for (const a of accounts) {
    if (a.status !== 'active') continue;
    if (excludeKeys.includes(a.apiKey)) continue;
    if (isRateLimitedForModel(a, modelKey, now)) continue;
    const limit = rpmLimitFor(a);
    if (limit <= 0) continue; // expired tier
    const used = pruneRpmHistory(a, now);
    if (used >= limit) continue;
    // Tier entitlement + per-account blocklist filter
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    candidates.push({ account: a, used, limit });
  }
  if (candidates.length === 0) return null;

  // Pick the account with the fewest in-flight requests first (so a burst
  // of concurrent calls spreads across accounts instead of piling onto a
  // single one that still has RPM headroom — see issue #37). Then prefer
  // accounts with the highest remaining-ratio, finally least-recently-used.
  candidates.sort((x, y) => {
    const ix = x.account._inflight || 0;
    const iy = y.account._inflight || 0;
    if (ix !== iy) return ix - iy;
    const rx = (x.limit - x.used) / x.limit;
    const ry = (y.limit - y.used) / y.limit;
    if (ry !== rx) return ry - rx;
    return (x.account.lastUsed || 0) - (y.account.lastUsed || 0);
  });

  const { account } = candidates[0];
  const reservationTimestamp = nextReservationToken(now);
  account._rpmHistory.push(reservationTimestamp);
  account.lastUsed = now;
  account._inflight = (account._inflight || 0) + 1;
  return {
    id: account.id, email: account.email, apiKey: account.apiKey,
    apiServerUrl: account.apiServerUrl || '',
    proxy: getEffectiveProxy(account.id) || null,
    reservationTimestamp,
  };
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
  a._inflight = Math.max(0, (a._inflight || 0) - 1);
}

/**
 * Try to re-check-out a specific account by apiKey, applying the same
 * rate-limit / status guards as getApiKey(). Used by the conversation pool
 * when a pool hit requires routing back to the exact account that owns the
 * upstream cascade_id — if that account is momentarily unavailable we fall
 * back to a fresh cascade on a different account instead of queuing.
 */
export function acquireAccountByKey(apiKey, modelKey = null) {
  const now = Date.now();
  const a = accounts.find(x => x.apiKey === apiKey);
  if (!a) return null;
  if (a.status !== 'active') return null;
  if (isRateLimitedForModel(a, modelKey, now)) return null;
  const limit = rpmLimitFor(a);
  if (limit <= 0) return null;
  const used = pruneRpmHistory(a, now);
  if (used >= limit) return null;
  if (modelKey && !isModelAllowedForAccount(a, modelKey)) return null;
  const reservationTimestamp = nextReservationToken(now);
  a._rpmHistory.push(reservationTimestamp);
  a.lastUsed = now;
  a._inflight = (a._inflight || 0) + 1;
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
  } catch (e) {
    log.error(`Failed to start LS for account ${accountId}: ${e.message}`);
  }
}

/**
 * Mark an account as rate-limited for a duration (default 5 min).
 * When `modelKey` is provided, only that model is blocked on this account —
 * other models remain routable. When omitted, the entire account is blocked
 * (legacy behaviour, used by generic 429 responses).
 */
export function markRateLimited(apiKey, durationMs = 5 * 60 * 1000, modelKey = null) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  const safeMs = Math.max(1000, Number(durationMs) || 0);
  const until = Date.now() + safeMs;
  if (modelKey) {
    if (!account._modelRateLimits) account._modelRateLimits = {};
    account._modelRateLimits[modelKey] = Math.max(account._modelRateLimits[modelKey] || 0, until);
    log.warn(`Account ${account.id} (${account.email}) rate-limited on ${modelKey} for ${Math.round(safeMs / 60000)} min`);
  } else {
    account.rateLimitedUntil = Math.max(account.rateLimitedUntil || 0, until);
    log.warn(`Account ${account.id} (${account.email}) rate-limited (all models) for ${Math.round(safeMs / 60000)} min`);
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
 * Check if an account is rate-limited for a specific model.
 */
function isRateLimitedForModel(account, modelKey, now) {
  // Global rate limit
  if (account.rateLimitedUntil && account.rateLimitedUntil > now) return true;
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
 */
export function reportError(apiKey) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  account.errorCount++;
  if (account.errorCount >= 3) {
    account.status = 'error';
    log.warn(`Account ${account.id} (${account.email}) disabled after ${account.errorCount} errors`);
  }
}

/**
 * Reset error count for an API key (call on success).
 */
export function reportSuccess(apiKey) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  if (account.errorCount > 0) {
    account.errorCount = 0;
    account.status = 'active';
  }
  account.internalErrorStreak = 0;
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
  account.internalErrorStreak = (account.internalErrorStreak || 0) + 1;
  if (account.internalErrorStreak >= 2) {
    account.rateLimitedUntil = Date.now() + 5 * 60 * 1000;
    log.warn(`Account ${account.id} (${account.email}) quarantined 5min after ${account.internalErrorStreak} consecutive upstream internal errors`);
  }
}

// ─── Status ────────────────────────────────────────────────

/**
 * Check if every eligible account is currently rate-limited for a given model.
 * Returns { allLimited, retryAfterMs } — callers can use retryAfterMs to set
 * a Retry-After header for 429 responses.
 */
export function isAllRateLimited(modelKey) {
  const now = Date.now();
  let soonestExpiry = Infinity;
  let anyEligible = false;
  for (const a of accounts) {
    if (a.status !== 'active') continue;
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    anyEligible = true;
    if (!isRateLimitedForModel(a, modelKey, now)) return { allLimited: false };
    // Track the soonest expiry across both global and per-model limits
    if (a.rateLimitedUntil && a.rateLimitedUntil > now) {
      soonestExpiry = Math.min(soonestExpiry, a.rateLimitedUntil);
    }
    if (modelKey && a._modelRateLimits?.[modelKey] > now) {
      soonestExpiry = Math.min(soonestExpiry, a._modelRateLimits[modelKey]);
    }
  }
  if (!anyEligible) return { allLimited: false };
  const retryAfterMs = soonestExpiry === Infinity ? 60000 : Math.max(1000, soonestExpiry - now);
  return { allLimited: true, retryAfterMs };
}

export function isAllTemporarilyUnavailable(modelKey) {
  const now = Date.now();
  let anyEligible = false;
  let soonestExpiry = Infinity;

  for (const a of accounts) {
    if (a.status !== 'active') continue;
    const limit = rpmLimitFor(a);
    if (limit <= 0) continue;
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    anyEligible = true;

    if (a.rateLimitedUntil && a.rateLimitedUntil > now) {
      soonestExpiry = Math.min(soonestExpiry, a.rateLimitedUntil);
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

function serializeAccount(a, now, includeSecrets = false) {
  const rpmLimit = rpmLimitFor(a);
  const rpmUsed = pruneRpmHistory(a, now);
  const out = {
    id: a.id,
    email: a.email,
    method: a.method,
    status: a.status,
    errorCount: a.errorCount,
    lastUsed: a.lastUsed ? new Date(a.lastUsed).toISOString() : null,
    addedAt: new Date(a.addedAt).toISOString(),
    keyPrefix: a.apiKey.slice(0, 8) + '...',
    tier: a.tier || 'unknown',
    capabilities: a.capabilities || {},
    lastProbed: a.lastProbed || 0,
    rateLimitedUntil: a.rateLimitedUntil || 0,
    rateLimited: !!(a.rateLimitedUntil && a.rateLimitedUntil > now),
    modelRateLimits: a._modelRateLimits ? Object.fromEntries(
      Object.entries(a._modelRateLimits).filter(([, v]) => v > now)
    ) : {},
    rpmUsed,
    rpmLimit,
    credits: a.credits || null,
    blockedModels: a.blockedModels || [],
    availableModels: getAvailableModelsForAccount(a),
    tierModels: getTierModels(a.tier || 'unknown'),
    userStatus: a.userStatus || null,
    userStatusLastFetched: a.userStatusLastFetched || 0,
  };
  if (includeSecrets) {
    out.apiKey = a.apiKey;
    out.refreshToken = a.refreshToken || '';
    out.idToken = a.idToken || '';
  }
  return out;
}

export function getAccountList(options = {}) {
  const includeSecrets = !!options.includeSecrets;
  const now = Date.now();
  return accounts.map(a => serializeAccount(a, now, includeSecrets));
}

export function getAccountById(id, options = {}) {
  const includeSecrets = !!options.includeSecrets;
  const account = accounts.find(a => a.id === id);
  if (!account) return null;
  return serializeAccount(account, Date.now(), includeSecrets);
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
    // Tier hint: if the plan info is explicit, prefer it over capability probing.
    // Trial / individual accounts also count as pro — Windsurf returns
    // "INDIVIDUAL" / "TRIAL" / similar for paid-tier trials (issue #8 follow-up:
    // motto1's 14-day Pro trial was misclassified as free because planName
    // wasn't "Pro").
    const pn = status.planName || '';
    if (/pro|teams|enterprise|trial|individual|premium|paid/i.test(pn)) {
      if (account.tier !== 'pro') account.tier = 'pro';
    } else if (/free/i.test(pn)) {
      if (account.tier === 'unknown') account.tier = 'free';
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

export async function refreshAllCredits() {
  const results = [];
  for (const a of accounts) {
    if (a.status !== 'active') continue;
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
export async function fetchUserStatus(id) {
  const account = accounts.find(a => a.id === id);
  if (!account) return null;

  const { WindsurfClient } = await import('./client.js');
  const { ensureLs, getLsFor } = await import('./langserver.js');
  const proxy = getEffectiveProxy(account.id) || null;
  await ensureLs(proxy);
  const ls = getLsFor(proxy);
  if (!ls) { log.warn(`No LS for GetUserStatus on ${account.id}`); return null; }

  const client = new WindsurfClient(account.apiKey, ls.port, ls.csrfToken);
  let status;
  try {
    status = await client.getUserStatus();
  } catch (err) {
    log.warn(`GetUserStatus ${account.id} (${account.email}) failed: ${err.message}`);
    return null;
  }

  // Apply to account — authoritative tier + entitlement snapshot.
  const prevTier = account.tier;
  account.tier = status.tierName;
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
    log.info(`Tier change ${account.id} (${account.email}): ${prevTier} → ${account.tier} (plan="${status.planName}", ${status.allowedModels.length} allowed models)`);
  } else {
    log.info(`UserStatus ${account.id} (${account.email}): tier=${account.tier} plan="${status.planName}" allowed=${status.allowedModels.length}`);
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
let _probeInFlight = false;

export async function probeAccount(id) {
  if (_probeInFlight) {
    log.info(`Probe skipped for ${id}: another probe is already running`);
    return null;
  }
  _probeInFlight = true;
  try {
  const account = accounts.find(a => a.id === id);
  if (!account) return null;

  // ── Step 1: authoritative tier via GetUserStatus ──
  const status = await fetchUserStatus(id);

  const { WindsurfClient } = await import('./client.js');
  const { getModelInfo } = await import('./models.js');
  const { ensureLs, getLsFor } = await import('./langserver.js');

  const proxy = getEffectiveProxy(account.id) || null;
  await ensureLs(proxy);
  const ls = getLsFor(proxy);
  if (!ls) { log.error(`No LS available for account ${account.id}`); return null; }
  const port = ls.port;
  const csrf = ls.csrfToken;

  // ── Step 2: canary probe, skipping models already classified by GetUserStatus ──
  // When allowlist is available we only need to probe UID-only models (no enum,
  // so server can't include them in allowlist) to get their actual status.
  const needsProbe = PROBE_CANARIES.filter(key => {
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
    log.info(`Probing account ${account.id} (${account.email}) across ${needsProbe.length} canary models (GetUserStatus ${status ? 'OK' : 'unavailable'})`);

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
  // Probe models from the live cloud catalog that aren't in PROBE_CANARIES
  // and haven't been classified yet. This discovers models available to free
  // accounts beyond the hardcoded FREE_TIER_MODELS list.
  try {
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
      log.info(`Dynamic cloud probe: ${cloudCandidates.length} candidates for ${account.email} (cap=${MAX_CLOUD_PROBES})`);
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
  if (status) account.tier = status.tierName;

  account.lastProbed = Date.now();
  saveAccounts();
  log.info(`Probe complete for ${account.id}: tier=${account.tier}${status ? ` plan="${status.planName}"` : ''}`);
  return { tier: account.tier, capabilities: account.capabilities };
  } finally {
    _probeInFlight = false;
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

export function validateApiKey(key) {
  if (!config.apiKey) return true;
  return key === config.apiKey;
}

export function isLocalBindHost(bindHost) {
  const host = String(bindHost || '').trim().toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isWildcardBindHost(bindHost) {
  const host = String(bindHost || '').trim().toLowerCase();
  return !host || host === '0.0.0.0' || host === '::' || host === '[::]';
}

export function isExternalBindHost(bindHost) {
  if (isWildcardBindHost(bindHost)) return true;
  return !isLocalBindHost(bindHost);
}

export function shouldRejectInsecureExternalBind(bindHost, apiKey = config.apiKey, dashboardPassword = config.dashboardPassword) {
  return isExternalBindHost(bindHost) && !apiKey && !dashboardPassword;
}

export function canAccessVerboseHealth(key, configuredApiKey = config.apiKey) {
  if (!configuredApiKey) return false;
  return key === configuredApiKey;
}

export function shouldEmitNoAuthWarning(bindHost, hasKey) {
  if (hasKey) return false;
  return isExternalBindHost(bindHost);
}

export function emitNoAuthWarnings(bindHost = '0.0.0.0') {
  const apiOpen = shouldEmitNoAuthWarning(bindHost, !!config.apiKey);
  const dashboardOpen = shouldEmitNoAuthWarning(bindHost, !!(config.dashboardPassword || config.apiKey));
  if (!apiOpen && !dashboardOpen) return;
  const lines = [
    '+------------------------------------------------------------------+',
    '| WARNING: AUTHENTICATION IS NOT CONFIGURED                        |',
    '| 警告：当前服务未配置访问认证                                      |',
    '|                                                                  |',
    '| This server is listening beyond localhost. Set API_KEY before     |',
    '| exposing REST APIs, and set DASHBOARD_PASSWORD for dashboard      |',
    '| write operations.                                                |',
    '| 服务正在非本机地址监听。公网/内网暴露前请配置 API_KEY，并为        |',
    '| Dashboard 写接口配置 DASHBOARD_PASSWORD。                         |',
    '+------------------------------------------------------------------+',
  ];
  for (const line of lines) log.warn(line);
}

// ─── Firebase token refresh ──────────────────────────────────

/**
 * Refresh Firebase tokens for all accounts that have a stored refreshToken.
 * Re-registers with Codeium to get a fresh API key and updates the account.
 */
async function refreshAllFirebaseTokens() {
  const { refreshFirebaseToken, reRegisterWithCodeium } = await import('./dashboard/windsurf-login.js');
  for (const a of accounts) {
    if (a.status !== 'active' || !a.refreshToken) continue;
    try {
      const proxy = getEffectiveProxy(a.id) || null;
      const { idToken, refreshToken: newRefresh } = await refreshFirebaseToken(a.refreshToken, proxy);
      a.refreshToken = newRefresh;
      // Re-register to get a fresh API key (may be the same key)
      const { apiKey } = await reRegisterWithCodeium(idToken, proxy);
      if (apiKey && apiKey !== a.apiKey) {
        log.info(`Firebase refresh: ${a.email} got new API key`);
        a.apiKey = apiKey;
      }
      saveAccounts();
    } catch (e) {
      log.warn(`Firebase refresh ${a.email} failed: ${e.message}`);
    }
  }
}

// ─── Init from .env ────────────────────────────────────────

export async function initAuth() {
  // Load persisted accounts first
  loadAccounts();

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
      try { await probeAccount(a.id); }
      catch (e) { log.warn(`Scheduled probe ${a.id} failed: ${e.message}`); }
    }
  }, REPROBE_INTERVAL).unref?.();

  // Periodic credit refresh (every 15 min). First run is fire-and-forget so
  // startup isn't blocked by cloud round-trips.
  const CREDIT_INTERVAL = 15 * 60 * 1000;
  refreshAllCredits().catch(e => log.warn(`Initial credit refresh: ${e.message}`));
  setInterval(() => {
    refreshAllCredits().catch(e => log.warn(`Scheduled credit refresh: ${e.message}`));
  }, CREDIT_INTERVAL).unref?.();

  // Fetch live model catalog from cloud and merge into hardcoded catalog.
  // Fire-and-forget — the hardcoded catalog is sufficient until this completes.
  fetchAndMergeModelCatalog().catch(e => log.warn(`Model catalog fetch: ${e.message}`));

  // Periodic Firebase token refresh (every 50 min). Firebase ID tokens expire
  // after 60 min; refreshing at 50 keeps a comfortable margin.
  const TOKEN_REFRESH_INTERVAL = 50 * 60 * 1000;
  refreshAllFirebaseTokens().catch(e => log.warn(`Initial token refresh: ${e.message}`));
  setInterval(() => {
    refreshAllFirebaseTokens().catch(e => log.warn(`Scheduled token refresh: ${e.message}`));
  }, TOKEN_REFRESH_INTERVAL).unref?.();

  // Warm up an LS instance for each account's configured proxy so the first
  // chat request doesn't pay the spawn cost.
  const { ensureLs } = await import('./langserver.js');
  const uniqueProxies = new Map();
  for (const a of accounts) {
    const p = getEffectiveProxy(a.id);
    const k = p ? `${p.host}:${p.port}` : 'default';
    if (!uniqueProxies.has(k)) uniqueProxies.set(k, p || null);
  }
  for (const p of uniqueProxies.values()) {
    try { await ensureLs(p); }
    catch (e) { log.warn(`LS warmup failed: ${e.message}`); }
  }

  const counts = getAccountCount();
  if (counts.total > 0) {
    log.info(`Auth pool: ${counts.active} active, ${counts.error} error, ${counts.total} total`);
  } else {
    log.warn('No accounts configured. Add via POST /auth/login');
  }
}
