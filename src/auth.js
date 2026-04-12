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
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config, log } from './config.js';
import { getEffectiveProxy } from './dashboard/proxy-config.js';
import { getTierModels } from './models.js';

import { join } from 'path';
const ACCOUNTS_FILE = join(process.cwd(), 'accounts.json');

// ─── Account pool ──────────────────────────────────────────

const accounts = [];
let _roundRobinIndex = 0;

// Per-tier requests-per-minute limits. Used for both filter-by-cap and
// weighted selection (accounts with more headroom are preferred).
const TIER_RPM = { pro: 60, free: 10, unknown: 20, expired: 0 };
const RPM_WINDOW_MS = 60 * 1000;

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

function saveAccounts() {
  try {
    const data = accounts.map(a => ({
      id: a.id, email: a.email, apiKey: a.apiKey,
      apiServerUrl: a.apiServerUrl, method: a.method,
      status: a.status, addedAt: a.addedAt,
      tier: a.tier, capabilities: a.capabilities, lastProbed: a.lastProbed,
      credits: a.credits || null,
      blockedModels: a.blockedModels || [],
    }));
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log.error('Failed to save accounts:', e.message);
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
        refreshToken: '', expiresAt: 0, refreshTimer: null,
        addedAt: a.addedAt || Date.now(),
        tier: a.tier || 'unknown',
        capabilities: a.capabilities || {},
        lastProbed: a.lastProbed || 0,
        credits: a.credits || null,
        blockedModels: Array.isArray(a.blockedModels) ? a.blockedModels : [],
      });
    }
    if (data.length > 0) log.info(`Loaded ${data.length} account(s) from disk`);
  } catch (e) {
    log.error('Failed to load accounts:', e.message);
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
    if (a.rateLimitedUntil && a.rateLimitedUntil > now) continue;
    const limit = rpmLimitFor(a);
    if (limit <= 0) continue; // expired tier
    const used = pruneRpmHistory(a, now);
    if (used >= limit) continue;
    // Tier entitlement + per-account blocklist filter
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    candidates.push({ account: a, used, limit });
  }
  if (candidates.length === 0) return null;

  // Pick the account with the highest remaining ratio. Ties broken by
  // least-recently-used so a burst spreads across accounts evenly.
  candidates.sort((x, y) => {
    const rx = (x.limit - x.used) / x.limit;
    const ry = (y.limit - y.used) / y.limit;
    if (ry !== rx) return ry - rx;
    return (x.account.lastUsed || 0) - (y.account.lastUsed || 0);
  });

  const { account } = candidates[0];
  account._rpmHistory.push(now);
  account.lastUsed = now;
  return {
    id: account.id, email: account.email, apiKey: account.apiKey,
    apiServerUrl: account.apiServerUrl || '',
    proxy: getEffectiveProxy(account.id) || null,
  };
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
  if (a.rateLimitedUntil && a.rateLimitedUntil > now) return null;
  const limit = rpmLimitFor(a);
  if (limit <= 0) return null;
  const used = pruneRpmHistory(a, now);
  if (used >= limit) return null;
  if (modelKey && !isModelAllowedForAccount(a, modelKey)) return null;
  a._rpmHistory.push(now);
  a.lastUsed = now;
  return {
    id: a.id, email: a.email, apiKey: a.apiKey,
    apiServerUrl: a.apiServerUrl || '',
    proxy: getEffectiveProxy(a.id) || null,
  };
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
 * Mark an account as rate-limited for a duration (default 1 hour).
 * The account stays 'active' but is skipped until the cooldown expires.
 */
export function markRateLimited(apiKey, durationMs = 60 * 60 * 1000) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  account.rateLimitedUntil = Date.now() + durationMs;
  log.warn(`Account ${account.id} (${account.email}) rate-limited for ${Math.round(durationMs / 60000)} min`);
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

export function isAuthenticated() {
  return accounts.some(a => a.status === 'active');
}

export function getAccountList() {
  const now = Date.now();
  return accounts.map(a => {
    const rpmLimit = rpmLimitFor(a);
    const rpmUsed = pruneRpmHistory(a, now);
    return {
      id: a.id,
      email: a.email,
      method: a.method,
      status: a.status,
      errorCount: a.errorCount,
      lastUsed: a.lastUsed ? new Date(a.lastUsed).toISOString() : null,
      addedAt: new Date(a.addedAt).toISOString(),
      keyPrefix: a.apiKey.slice(0, 8) + '...',
      apiKey: a.apiKey,
      tier: a.tier || 'unknown',
      capabilities: a.capabilities || {},
      lastProbed: a.lastProbed || 0,
      rateLimitedUntil: a.rateLimitedUntil || 0,
      rateLimited: !!(a.rateLimitedUntil && a.rateLimitedUntil > now),
      rpmUsed,
      rpmLimit,
      credits: a.credits || null,
      blockedModels: a.blockedModels || [],
      availableModels: getAvailableModelsForAccount(a),
      tierModels: getTierModels(a.tier || 'unknown'),
    };
  });
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
    if (status.planName && /pro|teams|enterprise/i.test(status.planName)) {
      if (account.tier !== 'pro') account.tier = 'pro';
    } else if (/free/i.test(status.planName || '')) {
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
  account.tier = inferTier(account.capabilities);
  saveAccounts();
}

/**
 * Infer subscription tier from which canary models work.
 */
function inferTier(caps) {
  const works = (m) => caps[m]?.ok === true;
  if (works('claude-opus-4.6') || works('claude-sonnet-4.6')) return 'pro';
  if (works('gemini-2.5-flash') || works('gpt-4o-mini')) return 'free';
  // If everything we tried failed
  const checked = Object.keys(caps);
  if (checked.length > 0 && checked.every(m => caps[m].ok === false)) return 'expired';
  return 'unknown';
}

/**
 * Probe an account's model capabilities by sending tiny canary requests.
 * Returns updated capabilities map.
 */
export async function probeAccount(id) {
  const account = accounts.find(a => a.id === id);
  if (!account) return null;

  const { WindsurfClient } = await import('./client.js');
  const { getModelInfo } = await import('./models.js');
  const { ensureLs, getLsFor } = await import('./langserver.js');

  const canaries = ['gpt-4o-mini', 'gemini-2.5-flash', 'claude-sonnet-4.6', 'claude-opus-4.6'];
  const proxy = getEffectiveProxy(account.id) || null;
  await ensureLs(proxy);
  const ls = getLsFor(proxy);
  if (!ls) { log.error(`No LS available for account ${account.id}`); return null; }
  const port = ls.port;
  const csrf = ls.csrfToken;

  log.info(`Probing account ${account.id} (${account.email}) across ${canaries.length} models`);

  for (const modelKey of canaries) {
    const info = getModelInfo(modelKey);
    if (!info) continue;
    const useCascade = !!(info.modelUid && info.enumValue === 0);
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

  account.lastProbed = Date.now();
  saveAccounts();
  log.info(`Probe complete for ${account.id}: tier=${account.tier}`);
  return { tier: account.tier, capabilities: account.capabilities };
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
