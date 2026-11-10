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

import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'crypto';
import { isStickyEnabled, getStickyBinding, peekStickyBinding, setStickyBinding, clearStickyBinding, noteStickyFallback } from './account/sticky-session.js';
import { isExperimentalEnabled, getDroughtThresholdPercent, getIpLockThreshold, getIpLockMs, getBackendSwitch, getBreakerTunable, getQuotaTunable } from './runtime-config.js';
import { readFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { config, log } from './config.js';
import { safeAccountRef } from './log-safety.js';
import { balanceGroupOf } from './org-identity.js';
import { renameSyncWithRetry, writeFileSyncDurable, restrictFileToOwnerSync } from './fs-atomic.js';
import { getEffectiveProxy } from './dashboard/proxy-config.js';
import {
  getTierModels,
  getModelKeysByEnum,
  MODELS,
  registerDiscoveredFreeModel,
  filterModelKeysByCloudCatalog,
  isModelAllowedByCloudCatalog,
  clearCloudModelCatalogs,
  mergeCloudCatalogSnapshot,
  removeCloudModelCatalog,
  forgetCloudModelCatalog,
  setActiveCloudCatalogAccounts,
  getCloudCostTierFreeSelectors,
  getCloudBillingSyncState,
  getCloudSelectorPricing,
  getCloudZeroRateSelectors,
  hasCloudCostTierData,
  mergeCloudCostTiers,
} from './models.js';
import {
  FREE_REACHABLE_SELECTORS,
  DROUGHT_SAFE_SELECTORS,
  setLiveCatalogSelectors,
  clearLiveCatalogSelectors,
  isConnectSelectorCatalogIndependent,
} from './devin-connect-models.js';
import { getLsAdmissionStatus, getLsMaintenanceRequests } from './langserver.js';
import { bumpConnect } from './devin-connect-metrics.js';
import { deleteCredential } from './devin-connect-credentials.js';
import { classifyToken, unwrapPastedSecret } from './dashboard/account-text-parser.js';

import { join } from 'path';
// accounts.json lives in the cluster-shared dir so add-account writes from
// one replica survive future restarts and are visible to every replica.
// See `src/config.js` (sharedDataDir vs dataDir) and issue #67.
const ACCOUNTS_FILE = join(config.sharedDataDir || config.dataDir, 'accounts.json');

// Bounded credit-snapshot ring, per account (DevinMap card 1). Declared here so
// the serializer can reference it regardless of module-evaluation order.
const CREDIT_LEDGER_CAP = 24;

// ─── Account pool ──────────────────────────────────────────

const accounts = [];
// PR #194: accounts filtered out by WAPI_ACCOUNTS_ONLY stay on disk. Without
// retaining the raw records, the next save would rewrite accounts.json with
// only this instance's slice and permanently delete every other port's account.
const filteredAccountRecords = [];
let _roundRobinIndex = 0;
let _bindHost = '0.0.0.0';

function accountInflight(account) {
  return Math.max(0, account?._inflight || 0);
}

// R-4 (RATE-RETRY audit): optional per-account in-flight hard cap. Default 0 =
// OFF (selection is byte-identical). Read per call so an operator can flip it
// without a restart; the existing stale-inflight sweep keeps a leaked counter
// from pinning an account out past the deadline-derived threshold.
function maxInflightPerAccount() {
  const raw = Number.parseInt(String(process.env.DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT ?? ''), 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

function isInflightCapped(account, cap) {
  return cap > 0 && accountInflight(account) >= cap;
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

// Minimum share of ACTIVE accounts whose weekly quota must actually be known
// before a pool-wide drought can be declared. Expressed as a strict majority:
// knownCount * 2 > activeCount.
//
// Why a floor exists at all: the loop below skips accounts with no numeric
// weeklyPercent, so `droughtCount === knownCount` used to mean "every account we
// happen to have data for is dry" while reading as "the pool is dry". refreshCredits
// writes `credits = { lastError, fetchedAt }` (no weeklyPercent) when GetUserStatus
// fails — the exact shape produced by an account whose subscription lookup errors
// while chat still works — so a 40-account pool with 39 failed refreshes and ONE dry
// account declared drought for the whole pool and demoted everyone to free models.
// Measured, before this floor:
//
//   1 dry + 39 refresh-failed             -> drought=true   (1/40 restricts the pool)
//   1 dry + 1 healthy + 38 refresh-failed -> drought=false  (one healthy suppresses it)
//   40 refresh-failed (none known)        -> drought=false
//   40 dry                                -> drought=true   (genuine)
//
// Why a STRICT majority and not a lower bar: the two error directions are not
// symmetric. A false positive restricts paying users to free models — immediate and
// user-visible. A false negative only lets the proxy keep attempting premium calls
// that fail anyway, which is the cost the feature was built to trim, not a
// correctness guarantee. So when coverage is thin, decline to claim drought.
const DROUGHT_MIN_KNOWN_SHARE_NUMERATOR = 1;
const DROUGHT_MIN_KNOWN_SHARE_DENOMINATOR = 2;

/**
 * Count the drought inputs over active accounts.
 *
 * `known` counts accounts with a numeric weeklyPercent — NOT accounts with a
 * credits object, which is a different and larger set (see getDroughtSummary).
 */
function tallyDroughtInputs() {
  const eligible = accounts.filter(a => a.status === 'active');
  const threshold = getDroughtThresholdPercent();
  let known = 0;
  let dry = 0;
  for (const a of eligible) {
    const c = a?.credits;
    const w = c && typeof c.weeklyPercent === 'number' ? c.weeklyPercent : null;
    if (w == null) continue;
    known++;
    if (w < threshold) dry++;
  }
  const coverageMet =
    known * DROUGHT_MIN_KNOWN_SHARE_DENOMINATOR >
    eligible.length * DROUGHT_MIN_KNOWN_SHARE_NUMERATOR;
  return { activeCount: eligible.length, known, dry, coverageMet, threshold };
}

export function isDroughtMode() {
  const { activeCount, known, dry, coverageMet } = tallyDroughtInputs();
  if (!activeCount) return false;
  if (!known) return false;      // no quota data yet — assume not drought
  if (!coverageMet) return false; // too few measured to speak for the pool
  return dry === known;
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
  // A restricted catalog may contain no free-tier models. In that case the
  // drought restriction cannot select a usable fallback, so leave the
  // account catalog as the authoritative policy.
  if (freeModels.size === 0) return false;
  return !freeModels.has(modelKey);
}

/**
 * Drought gate for the DEVIN_CONNECT namespace.
 *
 * Deliberately NOT isModelBlockedByDrought with a flag: the two functions judge
 * disjoint namespaces, and the MODELS-space one gives actively harmful answers
 * about connect selectors. Measured, on a drought-active pool:
 *
 *   isModelBlockedByDrought('swe-1-6-slow')     = true   ← the ONE free-reachable
 *                                                          connect selector
 *   isModelBlockedByDrought('gemini-2.5-flash') = false  ← connect cannot route to it
 *   isModelBlockedByDrought('TOTAL-GARBAGE')    = true   ← "not in the free table",
 *                                                          not "is premium"
 *
 * The two sets have zero overlap (all 20 connect selectors are MODELS keys, none
 * of them free-tier), so there is no accidentally-correct case: reusing the old
 * predicate blocks the only model that still runs during a drought and admits one
 * that cannot run at all.
 *
 * No empty-set fail-open branch here on purpose. The free set is now derived
 * (live cost tier → rate table → static fallback) rather than a frozen literal, but
 * every path still returns a Set or the documented fallback — never null — and
 * `isConnectSelectorCurrentlyFree` maps "no data" to false. So an empty set means
 * "the live catalogs say nothing here is free", which must BLOCK premium selectors,
 * not fail open. If a future source can return null to this gate, add the fail-open
 * THEN, together with a test that can actually reach it.
 */
export function isConnectSelectorBlockedByDrought(selector) {
  if (!selector) return false;
  if (!isDroughtRestrictEnabled()) return false;
  if (!isDroughtMode()) return false;
  // Weekly-quota-exempt paid selectors (#258). Separate from
  // FREE_REACHABLE_SELECTORS so unpaid accounts stay off swe-1-7 / glm-5-2.
  if (DROUGHT_SAFE_SELECTORS.has(selector)) return false;
  return !isConnectSelectorCurrentlyFree(selector);
}

/**
 * Selectors the upstream currently charges nothing for, across active accounts.
 *
 * Union of every active account's paired rate table, keeping only `rate === 0`.
 * Returns null when NO account has a usable table — distinct from an empty set,
 * because "we have no data" and "nothing is free" must be handled differently.
 */
export function getCurrentlyFreeConnectSelectors() {
  let sawTable = false;
  const free = new Set();
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    const table = account.credits?.rateTable;
    if (!table || Array.isArray(table)) continue;
    sawTable = true;
    for (const [selector, rate] of Object.entries(table)) {
      // Strictly zero. A tiny non-zero rate still bills, and treating it as free is
      // the exact failure that burns a user's quota.
      if (typeof rate === 'number' && rate === 0) free.add(selector);
    }
  }
  // The same statement in the other field: `creditMultiplier` on the catalog rows
  // the billing sync already fetches. Without this, a deployment whose accounts
  // never receive a GetUserStatus rate table (free plans) had NO rate-based free
  // evidence at all, and only a cost tier could ever mark a model free.
  const cloudZero = getCloudZeroRateSelectors();
  if (cloudZero) {
    sawTable = true;
    for (const selector of cloudZero) free.add(selector);
  }
  return sawTable ? free : null;
}

/**
 * Ordered degrade targets for an UNMAPPED DEVIN_CONNECT model name (#258 residual).
 *
 * `resolveConnectSelector` used to send every unmapped name to the frozen
 * `swe-1-6-slow`. On a deployment with a live catalog that selector does not
 * exist (measured 2026-10-22: absent from the 240-selector Connect catalog and
 * from availableModels, and answered with "Your daily usage quota has been
 * exhausted"), so a typo or a stale alias surfaced as a FAKE QUOTA ERROR that
 * pointed at the account instead of at the model name.
 *
 * The replacement is the live free set, in the order the chat path should try:
 *   1. selectors the account's `modelCostTier`/`promoStatus` marks free now
 *      (models.js — the only source that can express a plan-scoped promotion);
 *   2. selectors the paired rate table prices at exactly 0 (#235 rolling promo).
 * Both are then restricted to selectors a live catalog actually exposes: free
 * on paper and absent from the catalog is precisely the dead target this exists
 * to stop choosing. When no live catalog has arrived (cold start) nothing is
 * filtered, and `resolveConnectSelector` re-validates against its own snapshot.
 *
 * Ordering: unpaid-entitlement selectors first, because any account may run
 * them, then alphabetical so every replica in a fleet degrades to the same
 * model. Empty array = nothing is known to be free AND callable; the caller
 * must answer model_not_found rather than guess.
 */
export function getConnectFreeFallbackSelectors() {
  // `getConnectFreeSelectors` already merges the two live sources (cost tier,
  // then rate table) and applies the pricing projection. Its COLD-START answer
  // is the static whitelist, which `resolveConnectSelector` applies as its own
  // floor anyway — reporting it here would mislabel a frozen name as
  // live-derived, so that case returns "nothing live to say".
  if (!hasCloudCostTierData() && getCurrentlyFreeConnectSelectors() === null) return [];
  return getConnectFreeSelectors()
    // Free on paper and absent from the live catalog is exactly the dead target
    // this exists to stop choosing (`swe-1-6-slow`). Null membership (no live
    // catalog anywhere) is KEPT: the resolver re-validates against its own
    // authoritative set, which owns that decision.
    .filter((selector) => selector && connectSelectorCatalogMembership(selector) !== false)
    // Unpaid-entitlement selectors first — any account may run them — then
    // alphabetical, so every replica in a fleet degrades to the same model.
    .sort((a, b) => (
      (FREE_REACHABLE_SELECTORS.has(b) ? 1 : 0) - (FREE_REACHABLE_SELECTORS.has(a) ? 1 : 0)
      || a.localeCompare(b)
    ));
}

/**
 * Is this selector present in the accounts' live Connect catalogs?
 *
 * Tri-state on purpose: true (some account's live catalog has it), false (at least
 * one account has a live catalog and NONE has it), null (no live catalog anywhere —
 * cold start / failed sync, so absence proves nothing).
 *
 * This is what keeps the static FREE_REACHABLE floor honest. `swe-1-6-slow` was
 * advertised as reachable+free on a Pro deployment whose live catalog (240
 * selectors) and availableModels (374) both omit it; the selector 502s with "daily
 * usage quota has been exhausted". A static list cannot see that, a live catalog can.
 */
function connectSelectorCatalogMembership(selector) {
  if (!selector) return null;
  let sawRows = false;
  for (const rows of _connectCatalogRowsByAccount.values()) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    sawRows = true;
    const hit = rows.some((row) => (
      (typeof row === 'string' ? row : row?.selector)?.trim() === selector
    ));
    if (hit) return true;
  }
  return sawRows ? false : null;
}

/**
 * Pricing + catalog state for one connect selector.
 *
 * Sources, in order of authority:
 *   1. `modelCostTier` + `promoStatus` from the account's GetCascadeModelConfigs
 *      response (models.js keeps it per account). This is the ONLY source that can
 *      express a plan-scoped promotion: the live Pro account's rate table prices
 *      swe-2-medium at 6 credits, yet the catalog marks it MODEL_COST_TIER_FREE
 *      with a promo ending 2026-11-01, and six live calls left daily quota at 0.
 *   2. A zero credit rate — either `creditMultiplier` from that same catalog row
 *      (models.js) or the account's paired GetUserStatus rate table (rolling
 *      promotion, #235). The catalog row matters because a free account may never
 *      receive the GetUserStatus rate table at all.
 *   3. FREE_REACHABLE_SELECTORS — the documented static FALLBACK, used only when
 *      NEITHER live source has data anywhere for this deployment. It is deliberately NOT a
 *      union any more: a live catalog/rate table that omits a selector is evidence
 *      the static list is stale, and claiming "free" there is what told operators
 *      to pick the one selector that 502s.
 *
 * `freeNow` is tri-state: true, false (live data says it bills), null (no data).
 * `pricingFetchedAt`/`pricingStale` ride along so a badge built from a stopped
 * sync is visibly old instead of silently trusted.
 */
export function getConnectSelectorPricing(selector) {
  return pricingForSelector(selector, pricingContext());
}

/**
 * Pricing for MANY selectors in one pass.
 *
 * The per-selector entry point rebuilds the pool-wide free set and the freshness
 * stamp on every call; a card that annotates a few hundred model rows would do
 * that a few hundred times. Same answers, one snapshot of the inputs, so the rows
 * on one screen cannot disagree about whether a selector is free.
 */
export function getConnectPricingMap(selectors = []) {
  const ctx = pricingContext();
  const out = {};
  for (const selector of selectors || []) {
    if (typeof selector !== 'string' || !selector) continue;
    out[selector] = pricingForSelector(selector, ctx);
  }
  return out;
}

function pricingContext() {
  return { rateFree: getCurrentlyFreeConnectSelectors(), fresh: billingFreshness() };
}

function pricingForSelector(selector, ctx) {
  const inLiveCatalog = connectSelectorCatalogMembership(selector);
  const fresh = ctx.fresh;
  const blank = {
    freeNow: null,
    freeReason: null,
    costTier: null,
    promoEndsAt: null,
    promoLabel: null,
    rate: null,
    pricingFetchedAt: fresh.fetchedAt,
    pricingStale: fresh.stale,
    inLiveCatalog,
  };
  if (!selector) return blank;

  const cloud = getCloudSelectorPricing(selector);
  const rateFree = ctx.rateFree;
  const rateZero = rateFree ? rateFree.has(selector) : false;

  let freeNow = cloud.freeNow;
  let freeReason = cloud.freeReason;
  if (freeNow === null && rateFree) {
    // The synced catalog said nothing about this selector, but the account rate
    // tables are live and DO name a free set: silence is then evidence of "bills".
    freeNow = rateZero;
    freeReason = rateZero ? 'rate_zero' : null;
  } else if (freeNow === null && FREE_REACHABLE_SELECTORS.has(selector)) {
    freeNow = true;
    freeReason = 'fallback_whitelist';
  }

  return {
    freeNow,
    freeReason,
    costTier: cloud.costTier,
    promoEndsAt: cloud.promoEndsAt,
    promoLabel: cloud.promoLabel,
    rate: cloud.rate,
    pricingFetchedAt: cloud.fetchedAt && cloud.fetchedAt > (fresh.fetchedAt || 0)
      ? cloud.fetchedAt
      : fresh.fetchedAt,
    pricingStale: fresh.stale,
    inLiveCatalog,
  };
}

/**
 * Age of the newest live billing fact this deployment holds.
 *
 * Both sources count: the synced catalog rows (cost tier + credit rate) and the
 * per-account GetUserStatus rate tables, which carry their own fetch stamp. The
 * dashboard shows this next to a FREE badge so "free" from a sync that stopped
 * three days ago is not indistinguishable from one refreshed a minute ago.
 */
function billingFreshness(now = Date.now()) {
  const cloud = getCloudBillingSyncState(now);
  let fetchedAt = cloud.fetchedAt || 0;
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    const ts = Number(account.credits?.rateTableFetchedAt) || 0;
    if (ts > fetchedAt) fetchedAt = ts;
  }
  return {
    fetchedAt: fetchedAt || null,
    stale: fetchedAt > 0 && now - fetchedAt > cloud.staleAfterMs,
  };
}

/**
 * Is this connect selector free to call right now?
 *
 * Thin projection of getConnectSelectorPricing so every caller (drought gate,
 * devin cards, dashboard) agrees with the row the operator sees. No data → false:
 * absent billing evidence must never widen the free list.
 */
export function isConnectSelectorCurrentlyFree(selector) {
  if (!selector) return false;
  return getConnectSelectorPricing(selector).freeNow === true;
}

/**
 * The connect selectors this deployment can run without debiting quota.
 *
 * Cost-tier FREE rows first (the live catalog's own answer, promo-aware), then
 * rate-table zeros. Falls back to FREE_REACHABLE_SELECTORS only when NEITHER live
 * source exists anywhere — the cold-start / no-catalog case the static floor is for.
 */
export function getConnectFreeSelectors() {
  const costFree = getCloudCostTierFreeSelectors();
  const rateFree = getCurrentlyFreeConnectSelectors();
  if (costFree === null && rateFree === null) return [...FREE_REACHABLE_SELECTORS];
  const out = new Set();
  for (const selector of costFree || []) {
    if (isConnectSelectorCurrentlyFree(selector)) out.add(selector);
  }
  for (const selector of rateFree || []) {
    if (isConnectSelectorCurrentlyFree(selector)) out.add(selector);
  }
  return [...out];
}

export function getDroughtSummary({ env = process.env } = {}) {
  const eligible = accounts.filter(a => a.status === 'active');
  let lowestWeekly = null;
  let lowestDaily = null;
  // Accounts carrying ANY credits object — including a refresh that failed and
  // wrote only { lastError, fetchedAt }. This is the count the Dashboard banner
  // has always shown.
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
  const drought = isDroughtMode();
  const restrictEnabled = isDroughtRestrictEnabled();
  // Which namespace's free list applies depends on the ACTIVE backend, and that
  // must be read through getBackendSwitch rather than process.env.DEVIN_CONNECT:
  // the Dashboard can hot-switch devinConnect while the env var is unset, and
  // reading env directly reports the wrong namespace in exactly that case.
  //
  // Callers that serve a request (handleModels) pass their per-request env; the
  // Dashboard and /health call this with no argument and get process.env. The
  // arity difference is why the two used to disagree.
  const connectBackend = getBackendSwitch('devinConnect', env);
  // Same computed set the model panel shows (live cost tier → rate table →
  // documented static fallback). This used to be `[...FREE_REACHABLE_SELECTORS]`,
  // which on a Pro deployment reported the phantom `swe-1-6-slow` as the free list
  // while the three actually-free swe-2 selectors were invisible — and the drought
  // gate then blocked those three.
  const freeTierModels = connectBackend
    ? getConnectFreeSelectors()
    : getTierModels('free');
  // The drought decision's OWN inputs. Deliberately reported separately from
  // knownAccounts above: the two counts answer different questions and used to
  // share one name, so the banner could read "knownAccounts=40" while the
  // decision behind it rested on a single measured account.
  const tally = tallyDroughtInputs();
  return {
    drought,
    threshold: getDroughtThresholdPercent(),
    activeAccounts: eligible.length,
    knownAccounts,
    // Accounts with a numeric weeklyPercent — the set isDroughtMode actually counts.
    quotaKnownAccounts: tally.known,
    droughtAccounts: tally.dry,
    // False when too few accounts are measured to speak for the pool, in which
    // case `drought` is forced false regardless of what the measured ones say.
    coverageMet: tally.coverageMet,
    lowestWeeklyPercent: lowestWeekly,
    lowestDailyPercent: lowestDaily,
    restrictEnabled,
    freeTierModels,
    restrictionFailOpen: drought && restrictEnabled && freeTierModels.length === 0,
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

// Read-only twin of pruneRpmHistory's count. Admission probes (the selector
// latch asking "could a peer serve this?") must not prune the peer's ring just
// to answer a question — housekeeping belongs to the scheduler's own path.
function rpmHistoryCount(account, now) {
  const hist = account?._rpmHistory;
  if (!Array.isArray(hist) || hist.length === 0) return 0;
  const cutoff = now - RPM_WINDOW_MS;
  let first = 0;
  while (first < hist.length && hist[first] < cutoff) first++;
  return hist.length - first;
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

// Record one outcome for an account. Persisted lazily: the window itself is
// best-effort and rides the next save. This is the single common entry point
// for every hot-path mutation that doesn't force its own save (reportSuccess /
// markRateLimited / markQuotaExhausted / reportInternalError / reportDeadToken),
// so marking dirty here is enough for the periodic flush to eventually persist
// _health, quotaResetAt and streak state — replacing the old shutdown flush (K7).
function recordHealthEvent(account, kind, now = Date.now()) {
  if (!account || !HEALTH_KINDS.has(kind)) return;
  pruneHealthWindow(account, now);
  account._health.push({ t: now, k: kind });
  markDirty();
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

/** Test seam: would tripping this account leave the pool with no usable account
 *  FOR `selector`? Pass the selector to exercise the selector-aware exemption. */
export function __isLastUsableAccount(account, now = Date.now(), selector = null) {
  return isLastUsableAccount(account, now, selector);
}

// Serialize concurrent saveAccounts calls — multiple async paths
// (reportSuccess / markRateLimited / updateCapability / probe) can fire
// together; without a mutex the last writer wins on stale memory state.
let _saveInFlight = false;
let _savePending = false;

// K7: lazy state (rolling _health window, quotaResetAt, _breakerStreak) mutates
// on the hot path WITHOUT a save — those callers deliberately don't pay a
// synchronous disk write per request. The shutdown flush used to be the net
// that captured this state, which forced the "stop → wait → write accounts.json
// externally → start" deployment dance (an external write mid-run was clobbered
// by the shutdown rewrite). Instead we mark the pool dirty on those mutations
// and flush on a periodic timer, so the on-disk file trails memory by at most
// one interval and shutdown no longer has to write. A hard kill loses at most
// one interval of best-effort self-healing state (cooldowns re-establish on the
// next upstream signal) — an acceptable trade for removing the shutdown write.
let _dirty = false;
let _dirtyFlushTimer = null;
const DIRTY_FLUSH_INTERVAL_MS = 30_000;

/** Mark the pool as having unpersisted lazy state; the periodic timer flushes it. */
function markDirty() { _dirty = true; }

function flushDirty() {
  if (!_dirty) return;
  // The write's outcome owns the flag — saveAccounts clears it only after the
  // durable temp write AND the publish both succeeded, and re-arms it on failure.
  // Clearing here would swallow one transient EIO/ENOSPC: the 30s interval would
  // then never retry the batch, and it would reach disk only when some unrelated
  // mutation happened to mark the pool dirty again.
  saveAccounts();
}

function startDirtyFlush() {
  if (_dirtyFlushTimer) return;
  _dirtyFlushTimer = setInterval(() => flushDirty(), DIRTY_FLUSH_INTERVAL_MS).unref?.();
}

// Test seam: run one dirty-flush pass deterministically without the timer.
export function __flushDirtyAccounts() { flushDirty(); }
export function __isAccountsDirty() { return _dirty; }

// F4: transient rate-limit cooldowns are persisted so a restart mid-cooldown
// cannot immediately re-select a dry account. The latch is bounded and
// stale-safe at BOTH ends: only a finite future deadline is written, expired
// per-model keys are dropped, and every restored deadline is clamped to this
// maximum from load time. Without the clamp a corrupt/hand-edited accounts.json
// (or a large clock jump) could bench an account for years. 24h sits far above
// the transient windows this latch normally stores (5min default, 15s burst,
// 1h breaker cap) while still bounding a hostile file to one day.
export const RATE_LIMIT_PERSIST_MAX_MS = 24 * 60 * 60 * 1000;

// Normalize one persisted deadline: 0 unless it is a finite timestamp in the
// future, clamped so the remaining window can never exceed the persistence cap.
function sanitizeRateLimitDeadline(value, now) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= now) return 0;
  return Math.min(value, now + RATE_LIMIT_PERSIST_MAX_MS);
}

// Sanitize a per-model/per-selector cooldown map: drop empty keys and any
// value that is not a finite future deadline (already-expired entries must not
// bloat accounts.json across restarts).
function sanitizeModelRateLimits(map, now) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    if (!key) continue;
    const until = sanitizeRateLimitDeadline(value, now);
    if (until) out[key] = until;
  }
  return out;
}

// Optional numeric account setting with THREE states: an explicit number, or
// null = "no override, inherit the global default". Never coerce blindly:
// Number(null), Number('') and Number(false) are all 0, so the historical
// `Number.isFinite(Number(x))` guard silently turned inherit into an explicit
// zero (a configured global reserve of $25 became "spend to the last cent") and
// materialized it into accounts.json on the next save. Only a finite number or
// a non-empty numeric string is an override; everything else is absence.
function parseOptionalNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// v3.0.3: the serialized per-account spend-policy OVERRIDE. Empty when the
// account inherits the global default, so an untouched accounts.json keeps its
// previous shape and a restart cannot turn "inherit" into an explicit value.
function serializeSpendPolicy(a) {
  const reserve = parseOptionalNumber(a.onDemandReserve);
  return {
    ...(typeof a.spendOnDemand === 'boolean' ? { spendOnDemand: a.spendOnDemand } : {}),
    ...(reserve !== null ? { onDemandReserve: reserve } : {}),
  };
}

// F4: the serialized transient latch for one account. Empty when nothing is
// live, so an unaffected accounts.json keeps its previous shape.
function serializeRateLimitLatch(a, now) {
  const rateLimitedUntil = sanitizeRateLimitDeadline(a.rateLimitedUntil, now);
  const modelRateLimits = sanitizeModelRateLimits(a._modelRateLimits, now);
  return {
    ...(rateLimitedUntil ? { rateLimitedUntil } : {}),
    ...(Object.keys(modelRateLimits).length ? { _modelRateLimits: modelRateLimits } : {}),
  };
}

function _serializeAccounts() {
  const now = Date.now();
  const live = accounts.map(a => ({
    id: a.id, email: a.email, apiKey: a.apiKey,
    apiServerUrl: a.apiServerUrl, method: a.method,
    status: a.status, addedAt: a.addedAt,
    // Re-auth evidence (when/how the retired session token was confirmed dead).
    // `status === 'reauth'` is the bit; this only explains it. Written solely by
    // markNeedsReauth and dropped the moment the account re-enters rotation.
    ...(a.status === 'reauth' && a.reauth ? { reauth: a.reauth } : {}),
    // Which email the stored re-login credential is keyed by. The display email
    // is renameable (updateAccountLabel), so re-login and account removal must
    // not look the credential up by it.
    ...(a.credentialEmail ? { credentialEmail: a.credentialEmail } : {}),
    // AP-RISK-1: half-open recovery clock. Without persisting this an account
    // flipped to 'error' loses its since-timestamp on restart, so
    // maybeRecoverErrorAccount computes since=0 and bails forever — the pool
    // then shrinks monotonically across restarts. _errorAt is deliberately NOT
    // persisted: it's a transient streak-window field (reset on relogin/success).
    erroredAt: a.erroredAt || 0,
    tier: a.tier, tierManual: !!a.tierManual,
    // Plan-derived tier floor (refreshCredits planName). Persisted so a restart
    // cannot re-open the canary demotion window before the next credit refresh;
    // absent for accounts that never reported a plan name.
    ...(a.planTier ? { planTier: a.planTier } : {}),
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
    // V-18: provenance travels WITH a live deadline, so a restart cannot turn a
    // live-402 window into one a weekly snapshot is allowed to clear.
    ...(a.quotaResetAt > now && QUOTA_RESET_SOURCES.has(a.quotaResetSource)
      ? { quotaResetSource: a.quotaResetSource }
      : {}),
    // F4: transient rate-limit latch (account-wide + per-model/selector).
    // Persisted so a restart mid-cooldown doesn't immediately re-select the
    // account and eat another 429; expired entries are dropped at save time.
    ...serializeRateLimitLatch(a, now),
    // v3.0.3: per-account on-demand spend policy. Persisted only when the
    // operator set an explicit override; null = inherit the global default.
    ...serializeSpendPolicy(a),
    // RB2/B1: exponential-backoff episode streak. Persisted as "memory" (not a
    // disable state) so a restart doesn't reset a repeat-offender's ladder to
    // zero; losing it is harmless (backoff just restarts) so it's best-effort.
    _breakerStreak: a._breakerStreak || 0,
    // K8: persist the lifetime spend accumulator (monotonic across restarts).
    _totalSpend: a._totalSpend || { requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, creditCost: 0, acuCost: 0 },
    // DevinMap card 1: observed credit snapshots (bounded). Written only when a
    // refresh actually recorded one, so a default accounts.json keeps its shape.
    ...(Array.isArray(a._creditHistory) && a._creditHistory.length
      ? { _creditHistory: a._creditHistory.slice(-CREDIT_LEDGER_CAP) }
      : {}),
    // DevinMap card 3: when the upstream session key last changed. Absent for
    // accounts that were never rotated, so the default file is unchanged.
    ...(a.keyRotatedAt ? { keyRotatedAt: a.keyRotatedAt } : {}),
    // G2: the operator needs to know WHY an account is banned, not just that it
    // is. Persist the timestamp and the (sanitized at the payload boundary)
    // upstream message so a restart does not erase the only explanation.
    ...(a.status === 'banned' ? {
      bannedAt: a.bannedAt || a._banSignalAt || 0,
      bannedReason: a.bannedReason || a._banSignalLastMessage || '',
    } : {}),
    // C5: persisted rolling-hour health window (pruned at save time so the
    // file never carries stale/out-of-window events across restarts).
    _health: Array.isArray(a._health) ? pruneHealthWindow(a, Date.now()) : [],
    // Per-account stable device seed (opt-in stable-device mode). Persisted ONLY
    // when set, so accounts.json for a default (random-fingerprint) deployment is
    // byte-identical to before. The seed is the root material from which the
    // #31 ClientMetadata fingerprint (and, later, login UA) is derived; keeping
    // it stable per account makes the account present one consistent "device"
    // instead of a fresh random one every request. See devin-connect
    // deriveDeviceBytes + WINDSURFAPI_STABLE_DEVICE.
    ...(a.deviceSeed ? { deviceSeed: a.deviceSeed } : {}),
  }));
  const liveKeys = new Set(live.map(a => a.apiKey));
  const preserved = filteredAccountRecords.filter(a => a?.apiKey && !liveKeys.has(a.apiKey));
  return preserved.length ? [...live, ...preserved] : live;
}

function saveAccounts() {
  if (_saveInFlight) { _savePending = true; return; }
  _saveInFlight = true;
  const tempFile = `${ACCOUNTS_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    // Atomic + durable write: write to a unique sibling tmp, fsync it, then
    // rename so a crash mid-write cannot leave accounts.json truncated/corrupt
    // and a power loss can't publish an unflushed tmp inode (K7). The unique
    // tmp also prevents concurrent test/process saves from racing on the
    // same `${ACCOUNTS_FILE}.tmp` name.
    // 0600: accounts.json holds live upstream tokens (apiKey/refreshToken/
    // idToken) in cleartext — must not be world-readable on a shared host.
    writeFileSyncDurable(tempFile, JSON.stringify(_serializeAccounts(), null, 2), { mode: 0o600 });
    renameSyncWithRetry(tempFile, ACCOUNTS_FILE);
    // Windows ignores mode 0o600 and the renamed file inherits the directory
    // ACL (Users/Authenticated Users). Drop the inheritance best-effort; the
    // helper warns on failure and never throws past this point.
    restrictFileToOwnerSync(ACCOUNTS_FILE, { warn: (m) => log.warn(m) });
    // Only a persist that got this far captures the lazy state the dirty flag was
    // tracking. A throw from the directory fsync above leaves the pool dirty on
    // purpose even though the rename published (fs-atomic marks that error
    // renamePublished): the new name is visible here, the directory entry is not
    // proven durable, and the next flush rewrites memory into a FRESH temp file.
    _dirty = false;
  } catch (e) {
    log.error('Failed to save accounts:', e.message);
    // The failed attempt published nothing (or published bytes whose directory
    // entry could not be proven), so the batch is still unwritten: keep the retry
    // signal the periodic flush needs.
    _dirty = true;
    try { unlinkSync(tempFile); } catch {}
  } finally {
    _saveInFlight = false;
    if (_savePending) { _savePending = false; setImmediate(saveAccounts); }
  }
}

/**
 * Synchronous flush that bypasses the _saveInFlight mutex (any queued async
 * save would be killed by process.exit before it finished anyway). Tolerates
 * being called after an in-flight save — the rename on top of a partial temp
 * file is still atomic. Retained as a test seam and an explicit-flush escape
 * hatch; the shutdown path no longer calls it (K7: shutdown drains, it does not
 * write — the periodic dirty-flush keeps the on-disk file current instead).
 */
export function saveAccountsSync() {
  const tempFile = `${ACCOUNTS_FILE}.${process.pid}.shutdown.tmp`;
  try {
    // 0600: accounts.json holds live upstream tokens (apiKey/refreshToken/
    // idToken) in cleartext — must not be world-readable on a shared host.
    writeFileSyncDurable(tempFile, JSON.stringify(_serializeAccounts(), null, 2), { mode: 0o600 });
    renameSyncWithRetry(tempFile, ACCOUNTS_FILE);
    restrictFileToOwnerSync(ACCOUNTS_FILE, { warn: (m) => log.warn(m) });
    // Same rule as saveAccounts: the outcome of the write owns the flag, and a
    // throw after a published rename (renamePublished) still counts as "the
    // directory entry is not proven".
    _dirty = false;
  } catch (e) {
    log.error('Failed to flush accounts:', e.message);
    _dirty = true;
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
    writeFileSyncDurable(tempFile, JSON.stringify([...merged.values()], null, 2), { mode: 0o600 });
    renameSyncWithRetry(tempFile, accountsFile);
    restrictFileToOwnerSync(accountsFile, { warn: (m) => logger.warn?.(m) });
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
  const reauth = status === 'reauth' ? sanitizeReauthRecord(a.reauth) : null;
  return {
    id: a.id || randomUUID().slice(0, 8),
    email: a.email, apiKey: a.apiKey,
    apiServerUrl: a.apiServerUrl || '',
    method: a.method || 'api_key',
    status,
    // G2: restore the ban explanation across restarts. Only meaningful while
    // status === 'banned'; a manually re-enabled account clears both fields.
    bannedAt: Number.isFinite(a.bannedAt) ? a.bannedAt : 0,
    bannedReason: typeof a.bannedReason === 'string' ? a.bannedReason : '',
    // SessionReauth: restore the evidence behind `status === 'reauth'`. Only a
    // well-formed record survives; the STATUS is the bit, so a corrupt record
    // loses the explanation but never puts the account back in rotation.
    ...(reauth ? { reauth } : {}),
    credentialEmail: typeof a.credentialEmail === 'string' ? a.credentialEmail : '',
    lastUsed: 0, errorCount: 0,
    refreshToken: a.refreshToken || '', expiresAt: 0, refreshTimer: null,
    addedAt: a.addedAt || now,
    erroredAt,
    // DevinMap cards: restore the bounded credit ledger and the last key
    // rotation. Both are best-effort; a malformed row is dropped, never fatal.
    _creditHistory: Array.isArray(a._creditHistory)
      ? a._creditHistory
        .filter((row) => row && typeof row === 'object' && typeof row.ts === 'number')
        .slice(-CREDIT_LEDGER_CAP)
      : [],
    keyRotatedAt: Number.isFinite(a.keyRotatedAt) ? a.keyRotatedAt : 0,
    tier: a.tier || 'unknown',
    // Plan-derived tier floor; null for older accounts.json and for a plan the
    // upstream never named. Never defaulted to 'free' — unknown ≠ free.
    planTier: typeof a.planTier === 'string' ? a.planTier : null,
    capabilities: a.capabilities || {},
    lastProbed: a.lastProbed || 0,
    credits: a.credits || null,
    blockedModels: Array.isArray(a.blockedModels) ? a.blockedModels : [],
    tierManual: !!a.tierManual,
    userStatus: a.userStatus || null,
    userStatusLastFetched: a.userStatusLastFetched || 0,
    // RB2/B2 + B1: restore self-healing quota cooldown + backoff memory.
    quotaResetAt: a.quotaResetAt || 0,
    // V-18: an unrecorded provenance (older accounts.json) stays null — unknown
    // is never treated as "a snapshot wrote this", so the deadline is only
    // cleared by expiry. A source without a live deadline is meaningless.
    quotaResetSource: (a.quotaResetAt > now && QUOTA_RESET_SOURCES.has(a.quotaResetSource))
      ? a.quotaResetSource
      : null,
    // F4: restore the transient rate-limit latch. Same guard as save: only
    // finite future deadlines survive, clamped to the persistence cap; an
    // older accounts.json (written before these fields existed) loads clean.
    rateLimitedUntil: sanitizeRateLimitDeadline(a.rateLimitedUntil, now),
    _modelRateLimits: sanitizeModelRateLimits(a._modelRateLimits, now),
    // v3.0.3: per-account on-demand spend policy overrides (null = inherit the
    // global runtime-config default). Only persisted when explicitly set.
    spendOnDemand: typeof a.spendOnDemand === 'boolean' ? a.spendOnDemand : null,
    onDemandReserve: parseOptionalNumber(a.onDemandReserve),
    _breakerStreak: a._breakerStreak || 0,
    // K8: per-account lifetime spend accumulator. Monotonic, survives log
    // rotation and restarts. `?? 0` so an older accounts.json (written before
    // this field existed) loads as zero rather than NaN. Shape:
    // { requests, totalTokens, promptTokens, completionTokens, creditCost }.
    _totalSpend: (a._totalSpend && typeof a._totalSpend === 'object')
      ? {
          requests: Number(a._totalSpend.requests) || 0,
          totalTokens: Number(a._totalSpend.totalTokens) || 0,
          promptTokens: Number(a._totalSpend.promptTokens) || 0,
          completionTokens: Number(a._totalSpend.completionTokens) || 0,
          creditCost: Number(a._totalSpend.creditCost) || 0,
          acuCost: Number(a._totalSpend.acuCost) || 0,
        }
      : { requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, creditCost: 0, acuCost: 0 },
    // C5: restore the rolling health window; drop anything already out of
    // the 1h window at load so a long-stopped process starts clean.
    _health: Array.isArray(a._health)
      ? a._health.filter(e => e && typeof e.t === 'number' && now - e.t < HEALTH_WINDOW_MS && HEALTH_KINDS.has(e.k))
      : [],
    // Per-account stable device seed (opt-in). Restored as-is; undefined for
    // accounts that never had one (default random-fingerprint deployments).
    // Generation is lazy — ensureDeviceSeed mints one on first use only when
    // stable-device mode is enabled, so we don't stamp a seed onto every account
    // of a deployment that doesn't use the feature.
    deviceSeed: typeof a.deviceSeed === 'string' && a.deviceSeed ? a.deviceSeed : undefined,
  };
}

// Per-account stable device fingerprint mode. OFF by default: the #31
// ClientMetadata fingerprint stays per-request random (byte-identical to the
// historical behavior). Turn on with WINDSURFAPI_STABLE_DEVICE=1 to make each
// account present ONE stable device across requests (see the machine-id study —
// this is the "one account = one device" shape kiro.rs uses; whether it lowers
// ban/limit rates on the Devin upstream must be A/B'd on a real account).
export function isStableDeviceEnabled(env = process.env) {
  return String(env.WINDSURFAPI_STABLE_DEVICE || '') === '1';
}

// Return the account's stable device seed, minting + persisting one on first use.
// Only mints when stable-device mode is on; otherwise returns undefined so the
// wire layer falls back to per-request random (default byte-equivalent path).
// The seed is opaque root material (never sent upstream directly); the wire
// layer derives the actual 732-hex fingerprint from it. Lazy generation keeps
// accounts.json untouched for deployments that don't use the feature.
export function ensureDeviceSeed(account, env = process.env) {
  if (!account || !isStableDeviceEnabled(env)) return undefined;
  if (!account.deviceSeed) {
    account.deviceSeed = randomBytes(32).toString('hex');
    markDirty();
  }
  return account.deviceSeed;
}

// Per-instance account isolation (PR #194). Multi-port deployments share one
// accounts.json; without a filter, a port configured for account A can still
// acquire account B and bind it to A's sticky session. `WAPI_ACCOUNTS_ONLY`
// is a comma-separated list of emails or account ids. Unset/blank = no filter;
// a non-blank value with no tokens (e.g. ",") fails closed (loads nothing).
export function accountsOnlyFilter(env = process.env) {
  const raw = env.WAPI_ACCOUNTS_ONLY;
  if (raw == null || String(raw).trim() === '') return null;
  const tokens = String(raw).split(',').map(token => token.trim()).filter(Boolean);
  return new Set(tokens.map(token => token.toLowerCase()));
}

export function accountAllowedByFilter(account, filter) {
  if (!filter) return true;
  const email = typeof account?.email === 'string' ? account.email.trim().toLowerCase() : '';
  const id = typeof account?.id === 'string' ? account.id.trim().toLowerCase() : '';
  return (email !== '' && filter.has(email)) || (id !== '' && filter.has(id));
}

function loadAccounts() {
  try {
    migrateReplicaAccountsTo({
      sharedDir: config.sharedDataDir || config.dataDir,
      accountsFile: ACCOUNTS_FILE,
    });
    if (!existsSync(ACCOUNTS_FILE)) return;
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    const filter = accountsOnlyFilter();
    filteredAccountRecords.length = 0;
    let loaded = 0;
    let filtered = 0;
    for (const a of data) {
      if (accounts.find(x => x.apiKey === a.apiKey)) continue;
      const account = _deserializeAccount(a);
      if (!accountAllowedByFilter(account, filter)) {
        filtered++;
        if (a?.apiKey) filteredAccountRecords.push(a);
        log.debug(`Account ${safeAccountRef(account)} filtered out by WAPI_ACCOUNTS_ONLY`);
        continue;
      }
      accounts.push(account);
      loaded++;
    }
    if (data.length > 0) {
      log.info(`Loaded ${loaded} account(s) from disk${filter ? ` (WAPI_ACCOUNTS_ONLY; ${filtered} filtered)` : ''}`);
    }
    if (filter && loaded === 0 && data.length > 0) {
      log.warn('WAPI_ACCOUNTS_ONLY matched no accounts; the pool is empty');
    }
  } catch (e) {
    log.error('Failed to load accounts:', e.message);
  }
}

// Test seams: exercise the serialize→load round-trip without disk/dedup.
export function __serializeAccounts() { return _serializeAccounts(); }
export function __loadAccountsForTest() { loadAccounts(); }
export function __deserializeAccount(a, now = Date.now()) { return _deserializeAccount(a, now); }
export function __maybeRecoverErrorAccount(account, now = Date.now()) {
  return maybeRecoverErrorAccount(account, now);
}

// ─── Dynamic model catalog from cloud ─────────────────────

// Per-account synchronization state. Catalog responses are account-scoped, so
// mixed pools must not reuse the first active account's policy for every route.
const _modelCatalogSyncedKeys = new Map(); // account id → apiKey used for sync
const _modelCatalogSyncPromises = new Map(); // account id → { apiKey, promise }
const _modelCatalogRetryCancels = new Map(); // account id → cancel delayed confirmation
const _modelCatalogConfirmationAttemptKeys = new Map(); // account id → apiKey being confirmed
const MODEL_CATALOG_CONFIRM_RETRY_MS = 30_000;
// Connect live catalog, kept PER ACCOUNT and unioned on write.
//
// This used to be a single module-level boolean latch: the first active account
// to sync set it, and nothing ever cleared it, so adding a paid account to a
// free-only pool never refreshed the selector set. The union of what the pool can
// reach was therefore unobtainable from the live catalog — the paid account's
// selectors simply never arrived.
//
// De-latching alone would have been worse than the latch: setLiveCatalogSelectors
// CLEARS and repopulates, so a free account syncing after a paid one would shrink
// the live set back down. Hence per-account rows here, unioned before every write.
//
// Existence and entitlement are deliberately different questions. This union
// answers "does the upstream have this selector at all" — the pool-wide view. Who
// may CALL it stays per-account (isConnectSelectorAllowedForAccount → tier bucket).
const _connectCatalogRowsByAccount = new Map(); // account id → decoded catalog rows
const _connectCatalogSyncedKeys = new Map();    // account id → apiKey already synced
const _connectCatalogSyncedAt = new Map();       // account id → successful refresh timestamp
const _connectCatalogSyncPromises = new Map();  // account id → request identity { apiKey, promise }
const _connectCatalogRetryState = new Map();    // account id → { apiKey, failureCount, retryAt }
const DEFAULT_CONNECT_CATALOG_TTL_MS = 5 * 60 * 1000;
const CONNECT_CATALOG_RETRY_BASE_MS = 30 * 1000;
const CONNECT_CATALOG_RETRY_MAX_MS = 5 * 60 * 1000;
let _modelCatalogDeps = null;

/** Test seams for deterministic catalog synchronization without network calls. */
export function __setModelCatalogDeps(deps) {
  _modelCatalogDeps = deps;
}

// Same seam shape for the web-search exposure: ESM exports are non-configurable, so
// a test cannot monkey-patch windsurf-api.getWebSearchResults. Inject instead.
let _webSearchDeps = null;
export function __setWebSearchDeps(deps) {
  _webSearchDeps = deps;
}

export async function __waitForModelCatalogSync() {
  await Promise.allSettled(
    [..._modelCatalogSyncPromises.values()].map(({ promise }) => promise),
  );
  await Promise.allSettled(
    [..._connectCatalogSyncPromises.values()].map(({ promise }) => promise),
  );
}

function cancelModelCatalogRetry(accountId) {
  const cancel = _modelCatalogRetryCancels.get(accountId);
  _modelCatalogRetryCancels.delete(accountId);
  if (cancel) cancel();
}

// This is one delayed confirmation, not periodic catalog refresh. Ordinary
// sync triggers are coalesced while the timer is pending, and a mismatched
// confirmation does not self-schedule another polling cycle.
function scheduleModelCatalogRetry(accountId, apiKey) {
  if (_modelCatalogRetryCancels.has(accountId)) return;
  const retry = () => {
    _modelCatalogRetryCancels.delete(accountId);
    const account = accounts.find(a => (
      a.id === accountId
      && a.status === 'active'
      && a.apiKey === apiKey
    ));
    if (!account) return;
    _modelCatalogConfirmationAttemptKeys.set(accountId, apiKey);
    trySyncModelCatalog();
    if (!_modelCatalogSyncPromises.has(accountId)) {
      _modelCatalogConfirmationAttemptKeys.delete(accountId);
    }
  };

  if (_modelCatalogDeps?.scheduleCatalogRetry) {
    const cancel = _modelCatalogDeps.scheduleCatalogRetry(
      retry,
      MODEL_CATALOG_CONFIRM_RETRY_MS,
    );
    _modelCatalogRetryCancels.set(accountId, typeof cancel === 'function' ? cancel : () => {});
    return;
  }

  const timer = setTimeout(retry, MODEL_CATALOG_CONFIRM_RETRY_MS);
  timer.unref?.();
  _modelCatalogRetryCancels.set(accountId, () => clearTimeout(timer));
}

export function __resetModelCatalogState() {
  for (const accountId of [..._modelCatalogRetryCancels.keys()]) {
    cancelModelCatalogRetry(accountId);
  }
  _modelCatalogSyncedKeys.clear();
  _modelCatalogSyncPromises.clear();
  _modelCatalogConfirmationAttemptKeys.clear();
  _connectCatalogRowsByAccount.clear();
  _connectCatalogSyncedKeys.clear();
  _connectCatalogSyncedAt.clear();
  _connectCatalogSyncPromises.clear();
  _connectCatalogRetryState.clear();
  clearLiveCatalogSelectors();
  clearCloudModelCatalogs();
}

function activeModelCatalogAccounts() {
  return accounts.filter(a => a.status === 'active' && a.apiKey);
}

function reconcileModelCatalogAccounts() {
  const active = activeModelCatalogAccounts();
  const activeIds = new Set(active.map(a => a.id));
  setActiveCloudCatalogAccounts(activeIds);
  for (const accountId of _modelCatalogSyncedKeys.keys()) {
    if (activeIds.has(accountId)) continue;
    _modelCatalogSyncedKeys.delete(accountId);
    removeCloudModelCatalog(accountId);
  }
  for (const accountId of [..._modelCatalogRetryCancels.keys()]) {
    if (activeIds.has(accountId)) continue;
    cancelModelCatalogRetry(accountId);
    removeCloudModelCatalog(accountId);
  }
  // Same reconciliation for every part of the connect state machine. Looking only
  // at accepted rows misses the exact dangerous window: an account can leave the
  // active set while its FIRST request is still in flight, or while an empty/error
  // response has armed backoff. Both must lose their request identity immediately,
  // otherwise a same-key disable→enable cycle can revive the old request (ABA), and
  // a re-enabled account can inherit a cooldown from its previous lifecycle.
  const trackedConnectAccounts = new Set([
    ..._connectCatalogRowsByAccount.keys(),
    ..._connectCatalogSyncedKeys.keys(),
    ..._connectCatalogSyncedAt.keys(),
    ..._connectCatalogSyncPromises.keys(),
    ..._connectCatalogRetryState.keys(),
  ]);
  for (const accountId of trackedConnectAccounts) {
    if (activeIds.has(accountId)) continue;
    forgetConnectCatalogForAccount(accountId);
  }
  // A newly active account has no LKG rows yet. Publish that incompleteness
  // synchronously, before its async fetch settles, so another account's live
  // catalog cannot globally disable the newcomer's snapshot fallback.
  publishConnectCatalogUnion(active);
  return active;
}

function invalidateModelCatalogForAccount(accountId) {
  _modelCatalogSyncedKeys.delete(accountId);
  _modelCatalogConfirmationAttemptKeys.delete(accountId);
  cancelModelCatalogRetry(accountId);
  removeCloudModelCatalog(accountId);
  // The connect selector union is a separate namespace with its own per-account
  // rows. A key rotation or account removal has to withdraw that contribution as
  // well, or a departed account keeps widening pool-wide discovery.
  forgetConnectCatalogForAccount(accountId);
}

/** Union of every synced account's catalog rows, deduped by selector. */
function unionConnectCatalogRows() {
  const bySelector = new Map();
  for (const rows of _connectCatalogRowsByAccount.values()) {
    for (const row of rows || []) {
      const selector = typeof row === 'string' ? row : row?.selector;
      if (typeof selector !== 'string' || !selector.trim()) continue;
      // First writer wins so a later account can't downgrade a richer row
      // (label/provider) to a bare string for the same selector.
      if (!bySelector.has(selector.trim())) bySelector.set(selector.trim(), row);
    }
  }
  return [...bySelector.values()];
}

/**
 * The live catalog's EXPLICIT image capability for ONE account's selector row.
 *
 * `supports_images` is a forwarding policy about the account that will actually
 * serve the request, not a pool-wide discovery fact: two accounts can disagree
 * for the same selector (the catalog is account-scoped), and the first-writer
 * union is the wrong answer for both directions — one account's `true` would
 * forward an image to a `false` peer, and one account's `false` would strip a
 * valid image from a `true` peer depending only on sync order.
 *
 * Three-state on purpose, matching `getConnectSelectorImageCapability`:
 * `true`/`false` only when THIS account's row carries a boolean; `null` when
 * the account has no synced rows, the selector is absent, or the row stayed
 * silent. Unknown MUST forward — never read it as "no".
 *
 * @param {string} accountId
 * @param {string} selector resolved canonical selector
 * @returns {boolean|null}
 */
export function getConnectSelectorImageCapabilityForAccount(accountId, selector) {
  const key = String(selector || '').trim();
  if (!key || !accountId) return null;
  const rows = _connectCatalogRowsByAccount.get(accountId);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.trim() === key) return null;
      continue;
    }
    if (row?.selector !== key) continue;
    return typeof row.supportsImages === 'boolean' ? row.supportsImages : null;
  }
  return null;
}

/**
 * Publish the pool-wide live union together with whether the frozen snapshot is
 * still needed by any active account that lacks last-known-good rows.
 *
 * Live rows remain authoritative per account in isConnectSelectorAllowedForAccount.
 * The snapshot fallback only keeps selectors resolvable so an unsynced/failed
 * account can be considered by that separate entitlement gate.
 */
function publishConnectCatalogUnion(activeAccounts = activeModelCatalogAccounts()) {
  const union = unionConnectCatalogRows();
  const includeSnapshotFallback = activeAccounts.length === 0
    || activeAccounts.some(account => !_connectCatalogRowsByAccount.has(account.id));
  if (!union.length) {
    const clearLiveSelectors = _modelCatalogDeps?.clearLiveCatalogSelectors
      || clearLiveCatalogSelectors;
    clearLiveSelectors();
    return union;
  }
  const applyLiveSelectors = _modelCatalogDeps?.setLiveCatalogSelectors
    || setLiveCatalogSelectors;
  applyLiveSelectors(union, { includeSnapshotFallback });
  return union;
}

function connectCatalogNow() {
  return _modelCatalogDeps?.now?.() ?? Date.now();
}

function connectCatalogTtlMs(env = process.env) {
  const parsed = Number(env.DEVIN_CONNECT_CATALOG_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 10_000
    ? Math.floor(parsed)
    : DEFAULT_CONNECT_CATALOG_TTL_MS;
}

function connectCatalogPollMs(env = process.env) {
  const ttl = connectCatalogTtlMs(env);
  // Polling at exactly the TTL makes the first tick arrive just BEFORE expiry:
  // the initial fetch normally finishes after initAuth starts its timer, so a
  // five-minute TTL can otherwise refresh only on the ten-minute tick. This is
  // a cheap local eligibility check; trySyncConnectCatalog still makes no
  // network request until the successful snapshot is actually stale.
  return Math.max(1_000, Math.min(10_000, Math.floor(ttl / 2)));
}

function connectCatalogRetryJitterBasisPoints(accountId, apiKey) {
  const injected = _modelCatalogDeps?.connectCatalogRetryJitterBasisPoints;
  if (typeof injected === 'function') {
    const value = Number(injected({ accountId, apiKey }));
    if (Number.isFinite(value)) return Math.max(8_000, Math.min(10_000, Math.floor(value)));
  }

  // Stable FNV-1a over the credential identity spreads a fleet without using
  // Math.random or clock state. The value never leaves this module or logs the
  // credential; a key rotation naturally chooses a fresh schedule.
  const identity = String(apiKey || accountId || 'connect-catalog');
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return 8_000 + ((hash >>> 0) % 2_001);
}

function connectCatalogRetryDelayMs(failureCount, accountId, apiKey) {
  // Deterministic per-account jitter avoids a synchronized retry wave while
  // preserving replayable tests and a monotonic exponential ladder per key.
  // Cap the exponent before Math.pow so a permanently broken upstream cannot
  // overflow even though the final delay is capped much earlier.
  const exponent = Math.max(0, Math.min(30, failureCount - 1));
  const cappedDelay = Math.min(CONNECT_CATALOG_RETRY_MAX_MS,
    CONNECT_CATALOG_RETRY_BASE_MS * Math.pow(2, exponent));
  const jitterBasisPoints = connectCatalogRetryJitterBasisPoints(accountId, apiKey);
  return Math.max(1_000, Math.floor(cappedDelay * jitterBasisPoints / 10_000));
}

function recordConnectCatalogRetryFailure(accountId, apiKey) {
  const previous = _connectCatalogRetryState.get(accountId);
  const failureCount = previous?.apiKey === apiKey ? previous.failureCount + 1 : 1;
  const delayMs = connectCatalogRetryDelayMs(failureCount, accountId, apiKey);
  _connectCatalogRetryState.set(accountId, {
    apiKey,
    failureCount,
    retryAt: connectCatalogNow() + delayMs,
  });
  return { failureCount, delayMs };
}

function isCurrentConnectCatalogAttempt(accountId, apiKey, attempt) {
  // Account/key/status equality alone is not strong enough. After
  // active(A)→disabled→active(A), the old request sees the same values again and
  // would commit across the lifecycle boundary. The per-account attempt object is
  // replaced/deleted synchronously on every invalidation, making identity the ABA
  // guard while still allowing a fresh same-key request to start immediately.
  if (_connectCatalogSyncPromises.get(accountId) !== attempt) return false;
  return accounts.some((account) => (
    account.id === accountId
    && account.status === 'active'
    && account.apiKey === apiKey
  ));
}

function trySyncConnectCatalog(acct) {
  if (_modelCatalogDeps?.disableConnectSync) return;
  const now = connectCatalogNow();
  const sameKey = _connectCatalogSyncedKeys.get(acct.id) === acct.apiKey;
  const age = now - (_connectCatalogSyncedAt.get(acct.id) || 0);
  if (sameKey && age >= 0 && age < connectCatalogTtlMs()) return;
  const backoff = _connectCatalogRetryState.get(acct.id);
  if (backoff && backoff.apiKey !== acct.apiKey) {
    _connectCatalogRetryState.delete(acct.id);
  }
  if (backoff?.apiKey === acct.apiKey && now < backoff.retryAt) return;
  const inFlight = _connectCatalogSyncPromises.get(acct.id);
  if (inFlight?.apiKey === acct.apiKey) return inFlight.promise;
  const accountId = acct.id;
  const apiKey = acct.apiKey;
  const attempt = { apiKey, promise: null };
  // Publish the identity BEFORE invoking an injected fetch implementation. Test
  // seams (and real adapters) are allowed to throw synchronously; publishing first
  // means even that path can safely decide whether it is still current.
  _connectCatalogSyncPromises.set(accountId, attempt);
  const promise = (async () => {
    try {
      const { fetchCatalog } = _modelCatalogDeps?.fetchConnectCatalog
        ? { fetchCatalog: _modelCatalogDeps.fetchConnectCatalog }
        : await import('./devin-connect-catalog.js');
      const connectModels = await fetchCatalog({ token: apiKey });
      if (!isCurrentConnectCatalogAttempt(accountId, apiKey, attempt)) return;
      // Only record a NON-EMPTY response. An empty one is no data, and storing it
      // would let the union shrink — the same fail-open shape as the Cascade
      // empty-catalog defect (models.js mergeCloudCatalogSnapshot).
      const rows = Array.isArray(connectModels)
        ? connectModels.filter((row) => {
          const selector = typeof row === 'string' ? row : row?.selector;
          return typeof selector === 'string' && selector.trim();
        })
        : [];
      if (rows.length) {
        _connectCatalogRetryState.delete(accountId);
        _connectCatalogRowsByAccount.set(accountId, rows);
        _connectCatalogSyncedKeys.set(accountId, apiKey);
        _connectCatalogSyncedAt.set(accountId, connectCatalogNow());
        const union = publishConnectCatalogUnion();
        log.info(`DEVIN_CONNECT live catalog: account ${accountId} contributed ${rows.length} selectors, pool union now ${union.length}`);
      } else {
        const retry = recordConnectCatalogRetryFailure(accountId, apiKey);
        log.warn(`DEVIN_CONNECT catalog sync for ${accountId} returned no selectors — keeping the existing union; retry ${retry.failureCount} in ${retry.delayMs}ms`);
      }
    } catch (e) {
      if (!isCurrentConnectCatalogAttempt(accountId, apiKey, attempt)) return;
      const retry = recordConnectCatalogRetryFailure(accountId, apiKey);
      log.warn(`DEVIN_CONNECT catalog sync failed (snapshot fallback stays in effect; retry ${retry.failureCount} in ${retry.delayMs}ms): ${e.message}`);
    }
  })().finally(() => {
    const current = _connectCatalogSyncPromises.get(accountId);
    if (current === attempt) _connectCatalogSyncPromises.delete(accountId);
  });
  attempt.promise = promise;
  return promise;
}

/**
 * Drop one account's contribution and rebuild the union without it.
 *
 * Synchronous, and routed through the same _modelCatalogDeps seam the sync path
 * uses. An earlier version did a dynamic `import(...).then(...)` here, which was
 * wrong twice: the write landed after the caller returned (so a removal followed by
 * a read still saw the departed account's selectors), and it reached past the
 * injected seam to the real module.
 */
function forgetConnectCatalogForAccount(accountId) {
  _connectCatalogRowsByAccount.delete(accountId);
  _connectCatalogSyncedKeys.delete(accountId);
  _connectCatalogSyncedAt.delete(accountId);
  _connectCatalogSyncPromises.delete(accountId);
  _connectCatalogRetryState.delete(accountId);
  // Even an account that never produced rows affects policy: removing the last
  // unsynced/failed contributor can make the remaining live union fully
  // authoritative. Always republish instead of returning early on `had === false`.
  publishConnectCatalogUnion();
}

async function fetchAndMergeModelCatalog(accountId, apiKey) {
  const confirmationAttempt = _modelCatalogConfirmationAttemptKeys.get(accountId) === apiKey;
  _modelCatalogConfirmationAttemptKeys.delete(accountId);
  const acct = accounts.find(a => (
    a.id === accountId
    && a.status === 'active'
    && a.apiKey === apiKey
  ));
  if (!acct) return false;
  // The Connect selector catalog has its own RPC and namespace. Start that
  // synchronization independently so a quarantined or malformed Cascade
  // snapshot cannot delay Connect model discovery.
  trySyncConnectCatalog(acct);
  try {
    const { getCascadeModelConfigs } = _modelCatalogDeps?.getCascadeModelConfigs
      ? { getCascadeModelConfigs: _modelCatalogDeps.getCascadeModelConfigs }
      : await import('./windsurf-api.js');
    const { listModels } = await import('./models.js');
    const proxy = getEffectiveProxy(acct.id) || null;
    const result = await getCascadeModelConfigs(acct.apiKey, proxy);
    const current = accounts.find(a => (
      a.id === accountId
      && a.status === 'active'
      && a.apiKey === apiKey
    ));
    if (!current) return false;

    const snapshot = mergeCloudCatalogSnapshot(result?.configs, { accountId });
    if (!snapshot.accepted) {
      if (snapshot.reason === 'malformed') {
        // No delayed confirmation for a malformed body: there is nothing to
        // confirm. Leave the account unsynced (no pending retry) so the next
        // ordinary sync trigger re-fetches it — arming a timer here would make
        // trySyncModelCatalog skip the account while the timer is pending, which
        // DELAYS recovery rather than helping it. What made this branch dangerous
        // was never the cancel, it was that the merge wiped the account's
        // last-known-good on the way here; models.js now preserves it.
        cancelModelCatalogRetry(accountId);
        log.warn(`Model catalog returned malformed configs for ${safeAccountRef(acct)}; preserving the last-known-good view, will re-fetch on the next sync trigger`);
        return false;
      }
      if (snapshot.reason === 'empty_over_snapshot') {
        // The upstream returned no models at all for an account that HAS an
        // accepted catalog. models.js refuses to let that delete the filter (it
        // would fail open and re-advertise everything, #231's symptom, and via the
        // pool union it would drop the filter for every other account too). Same
        // handling as malformed: nothing to confirm, so leave the account unsynced
        // for the next ordinary trigger rather than arming a timer that would make
        // trySyncModelCatalog skip it meanwhile.
        cancelModelCatalogRetry(accountId);
        log.warn(`Model catalog for ${safeAccountRef(acct)} returned NO models while ${snapshot.baselineCount} were previously accepted; treating that as no data and keeping the last-known-good view. If this account genuinely lost its upstream restriction, set WINDSURFAPI_IGNORE_CLOUD_FILTER=1.`);
        return false;
      }
      // Keep re-checking while the candidate is unconfirmed. Arming the retry only
      // on the FIRST round meant a small-but-VARYING upstream stopped being
      // re-checked after one attempt, so the stale larger snapshot stayed
      // authoritative until some unrelated account-lifecycle event happened to
      // trigger another sync — and there is no periodic catalog refresh to fall back
      // on. The round budget in models.js bounds this polling; it never lowers the
      // bar for acceptance, so an upstream that keeps changing its answer is simply
      // never adopted (it has no stable answer to adopt).
      if (snapshot.recheckExhausted) {
        cancelModelCatalogRetry(accountId);
      } else {
        scheduleModelCatalogRetry(accountId, apiKey);
      }
      const baseline = snapshot.baselineSource === 'last_accepted'
        ? `the last accepted ${snapshot.baselineCount}`
        : `the static baseline of ${snapshot.baselineCount}`;
      const rounds = snapshot.quarantineRounds
        ? ` (unconfirmed round ${snapshot.quarantineRounds}/${snapshot.recheckRoundsMax})`
        : '';
      const nextStep = snapshot.recheckExhausted
        ? `the candidate has changed on every one of ${snapshot.quarantineRounds} rounds, so it is NOT being adopted; keeping the last-known-good view and stopping the re-check until the next ordinary sync trigger`
        : (confirmationAttempt
          ? `the delayed confirmation differed, so the candidate remains unconfirmed${rounds} and will be re-checked in ${MODEL_CATALOG_CONFIRM_RETRY_MS / 1000}s`
          : `retrying in ${MODEL_CATALOG_CONFIRM_RETRY_MS / 1000}s`);
      log.warn(`Model catalog for ${safeAccountRef(acct)} returned ${snapshot.receivedCount} unique models versus ${baseline}; preserving the current fail-open/last-known-good view and ${nextStep}`);
      return false;
    }

    cancelModelCatalogRetry(accountId);
    const configs = result.configs;
    const visible = listModels().length;
    _modelCatalogSyncedKeys.set(accountId, apiKey);
    log.info(`Model catalog for ${safeAccountRef(acct)}: ${configs.length} cloud models, ${snapshot.added} new entries merged, ${visible} pool models visible`);
    return true;
  } catch (e) {
    log.warn(`Model catalog fetch failed for ${safeAccountRef(acct)}: ${e.message}`);
    return false;
  }
}

/**
 * Fire-and-forget: synchronize every active account whose current API key has
 * not produced a catalog yet. Per-account promises coalesce concurrent status
 * transitions without blocking unrelated accounts.
 */
export function trySyncModelCatalog() {
  const active = trySyncConnectCatalogs();
  for (const acct of active) {
    if (_modelCatalogSyncedKeys.get(acct.id) === acct.apiKey) continue;
    if (_modelCatalogRetryCancels.has(acct.id)) continue;
    if (_modelCatalogSyncedKeys.has(acct.id)) {
      invalidateModelCatalogForAccount(acct.id);
    }
    const inFlight = _modelCatalogSyncPromises.get(acct.id);
    if (inFlight?.apiKey === acct.apiKey) continue;
    const apiKey = acct.apiKey;
    const promise = fetchAndMergeModelCatalog(acct.id, apiKey)
      .catch(e => log.warn(`trySyncModelCatalog: ${e.message}`))
      .finally(() => {
        const current = _modelCatalogSyncPromises.get(acct.id);
        if (current?.promise === promise) _modelCatalogSyncPromises.delete(acct.id);
      });
    _modelCatalogSyncPromises.set(acct.id, { apiKey, promise });
  }
}

function trySyncConnectCatalogs() {
  const active = reconcileModelCatalogAccounts();
  // Drive the Connect selector sync from HERE, not only from inside
  // fetchAndMergeModelCatalog. That function is gated by the Cascade per-key check
  // below, so once an account's Cascade catalog was recorded as synced, the connect
  // sync became unreachable for it — its own per-key eligibility was never
  // consulted. The two namespaces have independent RPCs and independent state, so
  // they need independent entry points; sharing one gate made the connect catalog
  // inherit the Cascade latch.
  for (const acct of active) trySyncConnectCatalog(acct);
  return active;
}

async function registerWithCodeium(idToken) {
  const { WindsurfClient } = await import('./client.js');
  const client = new WindsurfClient('', 0, '');
  const result = await client.registerUser(idToken);
  return result; // { apiKey, name, apiServerUrl }
}

// ─── Account management ───────────────────────────────────

// The label is stored into `email` and rendered into dashboard rows, batch
// results, the search corpus and log lines. The write took the string
// verbatim, so a caller-supplied label could carry C0/C1 controls (ANSI into
// the operator's terminal when a log line prints it), characters that break
// the markup contexts escapers don't reach, or a length that wedges the
// table. Printable Unicode is legitimate (non-ASCII names exist); control
// chars and a >128-char blob are not. Caller labels reject via a coded error
// so the API layer can return a 400 with a stable code instead of a silent
// no-op; upstream-derived names are sanitized instead — a hostile registry
// name must not turn a successful login into a 400 (S5).
const MAX_ACCOUNT_LABEL = 128;
// Boundary for text that lands in `account.email`/labels: C0/C1 controls
// (ANSI, forged log lines) AND the invisible/bidi format characters that let
// one label impersonate another on the dashboard (RLO U+202E can visually
// reverse "treppa-metsyS"-style text; ZWSP/BOM/SHY/invisible operators hide
// in plain sight). ZWJ/ZWNJ/LRM/RLM stay allowed — real RTL names and emoji
// sequences use them.
const LABEL_UNSAFE = /[\x00-\x1f\x7f-\x9f\xad\u034f\u180e\u200b\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const LABEL_UNSAFE_GLOBAL = /[\x00-\x1f\x7f-\x9f\xad\u034f\u180e\u200b\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function assertAccountLabel(label) {
  if (!label || label.length > MAX_ACCOUNT_LABEL || LABEL_UNSAFE.test(label)) {
    throw Object.assign(new Error('ERR_ACCOUNT_LABEL_INVALID'), {
      code: 'ERR_ACCOUNT_LABEL_INVALID', statusCode: 400,
    });
  }
}

export function sanitizeLabelText(value) {
  return String(value || '').replace(LABEL_UNSAFE_GLOBAL, '').trim().slice(0, MAX_ACCOUNT_LABEL);
}

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

  if (label != null && typeof label !== 'string') assertAccountLabel('');
  const callerLabel = typeof label === 'string' ? label.trim() : '';
  if (callerLabel) assertAccountLabel(callerLabel);
  const account = {
    id: randomUUID().slice(0, 8),
    email: callerLabel || `key-${apiKey.slice(0, 8)}`,
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
 * Add by whatever the dashboard/API caller pasted. A `devin-session-token$…`
 * IS the upstream apiKey — RegisterUser only accepts a Firebase idToken and
 * will 401 "failed to validate Devin token" if we send a session string
 * there (#257). The OAuth callback already classified; POST /accounts did not.
 */
export async function addAccountByPastedSecret(secret, label = '', apiServerUrl = '', opts = {}) {
  const value = unwrapPastedSecret(secret);
  if (!value) {
    const err = new Error('ERR_NO_TOKEN_IN_INPUT');
    err.code = 'ERR_NO_TOKEN_IN_INPUT';
    throw err;
  }
  const kind = classifyToken(value);
  // A devin-session-token$ IS the upstream apiKey. sk- pasted into the Auth
  // Token box is the same shape the API-key field would have stored.
  // auth1_ is a PostAuth intermediate (windsurf-login.js), not a pool key —
  // storing it as apiKey adds a dead row, and sending it to RegisterUser
  // is a confusing 400. Firebase JWTs stay on RegisterUser.
  if (kind === 'auth1') {
    const err = new Error('ERR_AUTH1_NOT_A_POOL_KEY');
    err.code = 'ERR_AUTH1_NOT_A_POOL_KEY';
    throw err;
  }
  if (kind === 'session' || value.startsWith('sk-')) {
    return addAccountByKey(value, label, apiServerUrl);
  }
  // The dashboard Type=API Key field (and batch-import kind=api_key) still
  // means "this is a pool key" for unclassified strings. Without this, a
  // short real apiKey would hit RegisterUser. auth1_ / JWT / session are
  // classified above and must not take this branch.
  if (opts && opts.unknownAsKey === true && kind === 'unknown') {
    return addAccountByKey(value, label, apiServerUrl);
  }
  return addAccountByToken(value, label);
}

/**
 * Add account via auth token.
 */
export async function addAccountByToken(token, label = '') {
  const reg = await registerWithCodeium(token);
  const existing = accounts.find(a => a.apiKey === reg.apiKey);
  if (existing) return existing;

  if (label != null && typeof label !== 'string') assertAccountLabel('');
  const callerLabel = typeof label === 'string' ? label.trim() : '';
  if (callerLabel) assertAccountLabel(callerLabel);
  const account = {
    id: randomUUID().slice(0, 8),
    email: callerLabel || sanitizeLabelText(reg.name) || `token-${reg.apiKey.slice(0, 8)}`,
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
  const label = sanitizeLabelText(result.name) || sanitizeLabelText(email) || email;
  const existingByEmail = accounts.find(a => String(a.email || '').trim().toLowerCase() === emailKey);
  const account = existingByEmail || addAccountByKey(result.apiKey, label);
  if (existingByEmail) {
    const apiKeyChanged = account.apiKey !== result.apiKey;
    const previousKey = account.apiKey;
    account.apiKey = result.apiKey;
    if (apiKeyChanged) {
      markKeyRotation(account, previousKey);
      invalidateModelCatalogForAccount(account.id);
      bumpUserJwtEpoch();
    }
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

// One verdict helper for both gates below — #159 was exactly those two gates
// disagreeing about which capability reasons count, so a model that routed
// fine was missing from availableModels (and, for UID-only models, the
// reverse). `user_status` is GetUserStatus's authoritative allowlist
// (cascade_allowed_models_config); `success` is written by updateCapability()
// after a real call completed; `not_entitled` is the allowlist's negative arm.
/**
 * Resolve one capability entry into a routing verdict.
 *
 *   true  → positive evidence the model is callable now
 *   false → authoritative negative evidence
 *   null  → no verdict; callers fall back to the tier static allowlist
 *
 * A measured `success` is live evidence only while it is at least as new as
 * the account's last GetUserStatus snapshot (`userStatusLastFetched`). A
 * success recorded before that snapshot was measured under a possibly
 * different entitlement — a Pro/trial success otherwise survives a downgrade
 * or trial expiry and keeps a free account listing and routing a premium model
 * the upstream has stopped entitling (wave-7 P2). For an enum-keyed model the
 * newer snapshot is also authoritative about omission, so a stale success is a
 * denial; GetUserStatus cannot classify UID-only models, so a stale success
 * there falls back to the tier table instead.
 */
function capabilityVerdict(account, modelKey) {
  const cap = account.capabilities?.[modelKey];
  if (!cap) return null;
  if (cap.reason === 'not_entitled') return false;
  if (cap.reason === 'user_status') return cap.ok === true;
  if (cap.reason === 'success') {
    if (cap.ok !== true) return false;
    const snapshotAt = account.userStatusLastFetched || 0;
    if ((cap.lastCheck || 0) >= snapshotAt) return true;
    return MODELS[modelKey]?.enumValue > 0 ? false : null;
  }
  return null;
}

/**
 * Resolve whether `modelKey` is callable on this account.
 *
 * Two-stage decision:
 *   1. blocklist always wins (manual operator override)
 *   2. if GetUserStatus has filled `capabilities[key].reason='user_status'`
 *      that's the upstream-authoritative answer (cascade_allowed_models_config)
 *      — trust it directly, regardless of static tier table. A measured
 *      `reason='success'` (the model has actually run on this account) is
 *      trusted only while it is fresh relative to that snapshot;
 *      `not_entitled` is the allowlist's negative arm.
 *   3. otherwise fall back to the tier static allowlist (UID-only models,
 *      pre-status accounts, unknown tier)
 *
 * Without step 2, free accounts that Windsurf actually entitles to
 * GLM/SWE/Kimi via the upstream allowlist still route through the
 * `MODEL_TIER_ACCESS.free` static table (gemini-only) and get denied
 * at selector time even though `account.capabilities` already says yes.
 */
export function isModelAllowedForAccount(account, modelKey) {
  // The candidate account's upstream catalog is the outermost gate.
  // Entitlements and manual tier overrides may narrow or widen within that
  // catalog, but must never re-enable a model omitted for this account.
  if (!isModelAllowedByCloudCatalog(modelKey, process.env, account.id)) return false;
  const blocked = account.blockedModels || [];
  if (blocked.includes(modelKey)) return false;
  // tierManual is the operator escape hatch: when set, trust the manual
  // tier table over GetUserStatus's per-account allowlist. Useful when
  // probe-based detection misclassified a Pro/Trial account as free
  // (issue #8) and the operator manually flips it back to Pro.
  if (!account.tierManual) {
    // GetUserStatus writes both arms — `user_status` for allowed and
    // `not_entitled` for denied — into capabilities, keyed by enum.
    // `success` is a live measurement, bounded by the snapshot freshness rule
    // in capabilityVerdict().
    const verdict = capabilityVerdict(account, modelKey);
    if (verdict !== null) return verdict;
  }
  const tierModels = getTierModels(account.tier || 'unknown', account.id);
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
  if (FREE_REACHABLE_SELECTORS.has(selector)) {
    // Unpaid-tier ENTITLEMENT floor — but existence still comes from the account's
    // own live catalog. `swe-1-6-slow` is admitted here for any account, and on a
    // measured Pro deployment it is in neither the 240-selector live catalog nor the
    // 374 availableModels, and 502s with "daily usage quota has been exhausted".
    // Returning true unconditionally made discovery synthesize it as
    // reachable+free, i.e. the one selector the dashboard called free was the one
    // that could not run. Empty/absent rows keep the old permissive answer: that is
    // the cold-start case the static floor exists for.
    const rows = _connectCatalogRowsByAccount.get(account.id);
    if (!Array.isArray(rows) || rows.length === 0) return true;
    return rows.some((row) => {
      const candidate = typeof row === 'string' ? row : row?.selector;
      return typeof candidate === 'string' && candidate.trim() === selector;
    });
  }
  const bucket = tierBucket(account.tier);
  // Paid selector: require a paid bucket. 'unknown' (unprobed new account) is
  // allowed — it self-heals to 'free' after a probe, then gets blocked here on
  // the next request, matching MODEL_TIER_ACCESS.unknown's optimistic policy.
  if (bucket !== 'pro' && bucket !== 'unknown') return false;

  // Some internal selectors are intentionally valid without appearing in
  // GetCliModelConfigs. Keep their historical tier gate, but do not subject them
  // to a catalog-membership test that can never succeed.
  if (isConnectSelectorCatalogIndependent(selector)) return true;

  // A successful non-empty GetCliModelConfigs response is authoritative for
  // THIS account. Paid tier alone is not proof that every selector in the frozen
  // snapshot still exists for it. Mixed pools expose the union (plus snapshot
  // fallback while any account lacks LKG rows), then this check keeps routing
  // within each synced account's own contribution.
  const rows = _connectCatalogRowsByAccount.get(account.id);
  if (!Array.isArray(rows) || rows.length === 0) return true;
  return rows.some((row) => {
    const candidate = typeof row === 'string' ? row : row?.selector;
    return typeof candidate === 'string' && candidate.trim() === selector;
  });
}

// ─── SELECTOR-SCOPED eligibility latch (account × canonical selector) ───────
//
// A DEVIN_CONNECT model can be retired for ONE account while that account's
// session token keeps serving every other selector: upstream answers
// `permission_denied` / HTTP 401 with "This model is no longer available for
// your account" (classified as SELECTOR_NOT_ELIGIBLE in devin-connect.js).
// That is a fact about the PAIR, so it must not touch status / errorCount /
// reauth — but it must also not be forgotten, or every later request for the
// selector pays one doomed upstream call on this account before failing over.
//
// Deliberately a THIRD dimension, separate from both existing ones:
//   - `_modelRateLimits` is a throttle: the dashboard renders it as
//     "capacity throttled", isRateLimitedForModel treats it as time-based
//     load-shedding, and CAPACITY/RATE_LIMITED write it. Reusing it here would
//     mislabel a permanent-ish entitlement fact as capacity pressure.
//   - `blockedModels` is durable OPERATOR intent and gates the catalog/UI
//     views; the upstream is not the operator, and this observation expires.
// It is in-memory only (not persisted): a restart re-probes the selector once,
// which is the conservative direction — the alternative would carry a stale
// "unavailable" verdict across an upstream catalog change.
//
// 30 minutes mirrors the CAPACITY selector cooldown's precedent (a hardcoded
// selector-scoped window written by finalizeConnectAccount) and is short
// enough that a re-enabled model comes back on its own. No operator knob: the
// latch can only ever affect one selector for one account and expires.
const SELECTOR_INELIGIBLE_TTL_MS = 30 * 60 * 1000;

/** Read-only form of the selector-latch test (no expired-entry cleanup). */
function isSelectorIneligibleAt(account, selector, now) {
  if (!account || !selector) return false;
  const until = account._selectorIneligible?.[selector];
  return !!until && until > now;
}

/** True when the upstream has told us THIS selector is not available to THIS account. */
export function isSelectorIneligible(account, selector, now = Date.now()) {
  if (!account || !selector) return false;
  if (isSelectorIneligibleAt(account, selector, now)) return true;
  // Self-heal: drop the expired entry so the map cannot grow across a long uptime.
  if (account._selectorIneligible?.[selector]) delete account._selectorIneligible[selector];
  return false;
}

// ─── Candidate admission: ONE predicate for scheduler and latch ─────────────
//
// "Would getApiKey hand this account the NEXT request for (modelKey,
// connectSelector)?" — the exact conjunction getApiKey's hard filter applies
// after error recovery and request-specific exclusions.
//
// Why it is shared: markSelectorIneligible used to re-implement a near-copy
// that checked entitlement/latch/cooldown/RPM but NOT the scheduler's
// maintenance filter or its per-account in-flight cap. It could therefore
// declare "a peer can take over" for a peer getApiKey would skip, latch the
// rejected account, and leave the pool EMPTY — every later request queued or
// failed (504) while the rejected account sat unselectable.
//
// Side-effect free by construction: read-only cooldown/latch/RPM checks, no
// reservation token, no _inflight bump, no maintenance slot, no pruning. The
// caller decides what to do with the answer; getApiKey still performs its own
// bookkeeping (reservation, counters) after admission.
function isAdmittedForRequest(account, {
  modelKey = null,
  connectSelector = null,
  now = Date.now(),
  inflightCap = maxInflightPerAccount(),
  excludeKeys = null,
} = {}) {
  if (!account || account.status !== 'active') return false;
  if (excludeKeys && excludeKeys.includes(account.apiKey)) return false;
  if (isAccountInMaintenance(account)) return false;
  if (isCooledForRequestReadOnly(account, modelKey, connectSelector, now)) return false;
  const limit = rpmLimitFor(account);
  if (limit <= 0) return false;
  if (rpmHistoryCount(account, now) >= limit) return false;
  if (isInflightCapped(account, inflightCap)) return false;
  if (modelKey && !isModelAllowedForAccount(account, modelKey)) return false;
  if (connectSelector && !isConnectSelectorAllowedForAccount(account, connectSelector)) return false;
  return true;
}

/**
 * Record that `selector` is not available for this account.
 *
 * LATCH ONLY WHEN A PEER COULD TAKE OVER — and only for the credential that
 * produced the verdict. `credentialCurrent` is the epoch test the caller
 * already computed (chat.js credentialEpochCurrent). A late denial from a
 * credential the pool has since replaced is evidence about the OLD epoch: it
 * may be counted, but writing it onto the account latches the NEW credential's
 * selector on the old key's verdict even though the new key may serve it
 * (repro: A-old rejected → A-new succeeds → late A-old denial → latched:true,
 * account active, selector unselectable without a peer).
 *
 * With no other account admitted for the selector, latching this one turns an
 * honest 403 (the upstream's own verdict) into "pool exhausted" for every
 * later request — the account was never the problem, the selector simply
 * cannot run anywhere in this pool. In that case keep the pool selectable and
 * let each request surface the real upstream rejection.
 *
 * Returns true when the latch was written.
 */
export function markSelectorIneligible(apiKey, selector, { credentialCurrent = true } = {}) {
  if (!selector) return false;
  // Old-epoch verdict: no availability state. The caller still bumps the
  // selector_ineligible counter — stats describe what upstream said, not which
  // credential is live now.
  if (!credentialCurrent) return false;
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account || account.status !== 'active') return false;
  const now = Date.now();
  // "Could take over" means servable for the NEXT request, not merely entitled.
  // isAdmittedForRequest is the scheduler's own predicate (maintenance,
  // in-flight cap, cooldown, latch, RPM, tier/entitlement), so a peer that
  // passes here is one getApiKey can actually hand out. `excludeKeys` is
  // request-specific and irrelevant to the next request, so it is not passed.
  const hasPeer = accounts.some(a => a !== account
    && isAdmittedForRequest(a, { connectSelector: selector, now }));
  if (!hasPeer) return false;
  if (!account._selectorIneligible) account._selectorIneligible = {};
  account._selectorIneligible[selector] = now + SELECTOR_INELIGIBLE_TTL_MS;
  log.warn(`Account ${safeAccountRef(account)} cannot serve ${selector} (upstream: model no longer available for this account) — selector-scoped, account stays active`);
  return true;
}

// True if at least one active account is entitled to this connect selector.
export function hasConnectEntitledAccount(selector) {
  return accounts.some(a => a.status === 'active' && isConnectSelectorAllowedForAccount(a, selector));
}

/** List of model keys this account is currently allowed to call. */
export function getAvailableModelsForAccount(account) {
  const blocked = new Set(account.blockedModels || []);
  const tierModels = getTierModels(account.tier || 'unknown', account.id);
  // Manual tier override or no GetUserStatus yet → tier static table.
  if (account.tierManual || !account.userStatusLastFetched || !account.capabilities) {
    return tierModels.filter(m => !blocked.has(m));
  }
  // After GetUserStatus: a capability verdict is authoritative for every
  // catalog entry, enum-keyed or not. `user_status` (upstream allowlist) and a
  // fresh `success` (the model actually ran here) are positive; `not_entitled`
  // is negative. Entries with no verdict fall back to the tier table — which
  // for UID-only models is the only source, since GetUserStatus cannot classify
  // them (it returns allowlists by enum only).
  const allowed = [];
  for (const [key, info] of Object.entries(MODELS)) {
    if (blocked.has(key)) continue;
    if (!isModelAllowedByCloudCatalog(key, process.env, account.id)) continue;
    // Same precedence as isModelAllowedForAccount: the verdict outranks the
    // tier table, so the list and the routing decision cannot disagree.
    const verdict = capabilityVerdict(account, key);
    if (verdict === true) { allowed.push(key); continue; }
    if (verdict === false) continue;
    if (info.enumValue && info.enumValue > 0) {
      // Enum-keyed and classified as unavailable by GetUserStatus.
      continue;
    }
    if (tierModels.includes(key)) allowed.push(key);
  }
  return allowed;
}

// Manual recovery is the only path out of `banned`; leaving the reason and the
// detector streak behind would make the drawer claim a healthy account is
// still banned and let a stale streak re-ban it on the next single hit.
function clearBanState(account) {
  account.bannedAt = 0;
  account.bannedReason = '';
  account._banSignalAt = 0;
  account._banSignalCount = 0;
  account._banSignalLastMessage = '';
}

// `disabled` and `banned` are OPERATOR terminal states, not health verdicts.
// A request acquired before the operator flipped the switch can report its
// outcome afterwards, and every background recovery RPC (auto re-login,
// liveness probe, Firebase token refresh) can finish after it. None of those
// may leave these states — only an explicit operator action (setAccountStatus /
// resetAccountErrors) can. One predicate so every path agrees on the vocabulary.
function isOperatorTerminalStatus(status) {
  return status === 'disabled' || status === 'banned';
}

// Identity check for work that spanned an await: the account object captured
// before the RPC must still be the live row in the pool. `id` alone is not
// enough — a delete + re-add (or a test seam) can reuse it, and publishing a
// stale RPC result onto the new row is exactly the cross-epoch bug this guards.
function isCurrentAccount(account) {
  return Boolean(account) && accounts.find(a => a.id === account.id) === account;
}

// ─── Session re-auth (`status: 'reauth'`) ───────────────────────────────────
// A `devin-session-token$` account whose server-side session_id was retired is
// unrecoverable without a fresh login. A bare UNAUTHORIZED on the data path is
// NOT proof of that: the non-stream path documents an entitlement wall as
// "byte-for-byte indistinguishable from a retired token". Only the free
// GetUserStatus liveness probe can arbitrate, so `reauth` is written from
// requestReauthCheck (and the liveness sweep) — never from one chat 401.
//
// `status === 'reauth'` is the whole bit. Selection already filters
// `status === 'active'`, and the half-open error recovery only runs for
// `status === 'error'`, so a new status value makes both correct structurally
// instead of relying on a boolean that a later refactor can drop.
const REAUTH_SOURCES = new Set(['request', 'liveness', 'manual']);
const REAUTH_CHECK_COOLDOWN_MS = 60 * 1000;

function sanitizeReauthRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const at = Number(record.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    at,
    source: REAUTH_SOURCES.has(record.source) ? record.source : 'request',
    code: typeof record.code === 'string' ? record.code.slice(0, 64) : '',
    attempts: Number.isFinite(Number(record.attempts)) ? Math.max(0, Math.floor(Number(record.attempts))) : 0,
    lastAttemptAt: Number.isFinite(Number(record.lastAttemptAt)) ? Math.max(0, Number(record.lastAttemptAt)) : 0,
  };
}

function reauthRefusal() {
  return Object.assign(new Error('ERR_REAUTH_TOKEN_UNCHANGED'), {
    code: 'ERR_REAUTH_TOKEN_UNCHANGED',
    statusCode: 409,
  });
}

/**
 * Mark an account as needing a fresh session token. Called only after the free
 * GetUserStatus probe answered UNAUTHORIZED for the CURRENT key.
 */
export function markNeedsReauth(id, { source = 'request', code = 'UNAUTHORIZED' } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  // Operator intent (disabled) and upstream bans outrank a token verdict.
  if (account.status === 'disabled' || account.status === 'banned') return false;
  if (account.status === 'reauth') return false; // keep the first confirmation timestamp
  account.status = 'reauth';
  account.reauth = sanitizeReauthRecord({ at: Date.now(), source, code });
  saveAccounts();
  log.warn(`Account ${safeAccountRef(account)} NEEDS RE-AUTH: session token confirmed dead (${code}, source=${source}) — out of rotation until a fresh token is added`);
  bumpConnect('reauth_required');
  trySyncModelCatalog();
  return true;
}

/** Return a reauth account to rotation (probe said alive, or the operator proved it). */
export function clearNeedsReauth(id, { reason = 'alive' } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account || account.status !== 'reauth') return false;
  account.status = 'active';
  account.errorCount = 0;
  account.erroredAt = 0;
  delete account.reauth;
  saveAccounts();
  log.info(`Account ${safeAccountRef(account)} re-auth cleared (${reason}) — back in rotation`);
  bumpConnect('reauth_cleared');
  trySyncModelCatalog();
  return true;
}

/**
 * Install a freshly minted token on an EXISTING account and return it to
 * rotation. This is the only way out of `reauth` that proves liveness: the
 * caller just logged in (or exchanged a token) upstream.
 *
 * Refuses the one move that re-creates the original bug: putting the SAME key
 * back with no re-auth performed (I2). Login paths pass `allowSameKey: true`
 * because a successful login IS proof the token works.
 */
export function markAccountReauthenticated(id, { apiKey = null, via = 'manual', allowSameKey = false } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  // Operator intent (disabled) and an upstream ban outrank a token install: a
  // successful login does not un-ban an account, and it must not silently
  // re-enable one the operator parked. Both routes answer 409 for this, so a
  // bound password/email login and a pasted token cannot disagree.
  if (account.status === 'disabled' || account.status === 'banned') {
    throw Object.assign(new Error('ERR_REAUTH_NOT_APPLICABLE'), { code: 'ERR_REAUTH_NOT_APPLICABLE', statusCode: 409 });
  }
  if (apiKey != null && account.status === 'reauth' && apiKey === account.apiKey && !allowSameKey) {
    throw reauthRefusal();
  }
  if (apiKey != null && apiKey !== account.apiKey) {
    const previousKey = account.apiKey;
    account.apiKey = apiKey;
    markKeyRotation(account, previousKey);
    invalidateModelCatalogForAccount(account.id);
    bumpUserJwtEpoch();
  }
  const wasReauth = account.status === 'reauth';
  account.status = 'active';
  account.errorCount = 0;
  account.erroredAt = 0;
  account._errorAt = 0;
  account._reloginAt = Date.now();
  delete account.reauth;
  // A real login proves the credential is fine, so a stale ban-signal streak
  // must not re-ban it on the next single hit. The ban FIELDS are only cleared
  // here because a banned account was refused above — this cannot erase an
  // active ban.
  clearBanState(account);
  saveAccounts();
  trySyncModelCatalog();
  if (wasReauth) {
    log.info(`Account ${safeAccountRef(account)} re-authenticated (${via}) — fresh session token installed`);
    bumpConnect('reauth_ok');
  }
  return true;
}

// Per-account de-dupe for the confirmation probe: a burst of dead-token
// verdicts must not turn into a probe storm, and concurrent callers share one
// in-flight probe. `force` bypasses the cooldown (manual "Check token").
const _reauthChecks = new Map(); // id → { lastAt, inflight }

/** Test seam: clear the confirmation-probe cooldown between cases. */
export function __resetReauthChecks() {
  _reauthChecks.clear();
}

/**
 * The two-signal confirmation rule (SessionReauth §2).
 *
 * UNAUTHORIZED on the data path → one free GetUserStatus probe:
 *   alive             → clear any stale reauth (the 401 was a blip)
 *   code UNAUTHORIZED → mark `reauth` (confirmed death)
 *   anything else     → no-op (CAPACITY / UPSTREAM_INTERNAL / NO_TOKEN are transient)
 *
 * Never throws; a probe failure is not evidence of anything.
 * @returns {Promise<{checked:boolean, alive?:boolean, code?:string, marked?:boolean, status?:string, reason?:string}>}
 */
export async function requestReauthCheck(id, { source = 'request', force = false } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return { checked: false, reason: 'NO_ACCOUNT' };
  if (account.status === 'disabled' || account.status === 'banned') {
    return { checked: false, reason: 'NOT_ELIGIBLE' };
  }
  const state = _reauthChecks.get(id) || { lastAt: 0, inflight: null };
  if (state.inflight) return state.inflight;
  const now = Date.now();
  if (!force && now - state.lastAt < REAUTH_CHECK_COOLDOWN_MS) {
    return { checked: false, reason: 'COOLDOWN' };
  }
  const token = account.apiKey;
  const attempt = (async () => {
    const { checkSessionLiveness } = (_reloginDeps && _reloginDeps.checkSessionLiveness)
      ? _reloginDeps
      : await import('./devin-connect-catalog.js');
    let result;
    try {
      result = await checkSessionLiveness({ token });
    } catch (e) {
      return { checked: false, reason: 'PROBE_FAILED', code: e.code || 'UPSTREAM_ERROR' };
    }
    // The key was replaced while the probe was in flight: its verdict is about
    // a credential that is no longer in the pool.
    if (account.apiKey !== token) return { checked: false, reason: 'TOKEN_CHANGED' };
    // The row itself can be removed/re-added while the probe is pending. Never
    // publish the old object's verdict onto a new lifetime with the same id.
    if (!isCurrentAccount(account)) return { checked: false, reason: 'ACCOUNT_CHANGED' };
    // Operator terminal states outrank a probe verdict: an ALIVE response may
    // clear reauth, but it must not clear a disable/ban issued mid-probe.
    if (isOperatorTerminalStatus(account.status)) return { checked: false, reason: 'NOT_ELIGIBLE' };
    if (result?.alive) {
      const cleared = clearNeedsReauth(id, { reason: 'probe_alive' });
      return { checked: true, alive: true, cleared, status: account.status };
    }
    if (result?.code === 'UNAUTHORIZED') {
      const marked = markNeedsReauth(id, { source, code: result.code });
      return { checked: true, alive: false, code: result.code, marked, status: account.status };
    }
    return { checked: true, alive: false, code: result?.code || 'UPSTREAM_ERROR', marked: false, status: account.status };
  })();
  state.lastAt = now;
  state.inflight = attempt;
  _reauthChecks.set(id, state);
  try {
    return await attempt;
  } finally {
    const s = _reauthChecks.get(id);
    if (s) s.inflight = null;
  }
}

/**
 * Set account status (active, disabled, error, banned, reauth).
 *
 * `reauth → active` is refused without `force`: that flip puts a token the
 * upstream has already retired back into rotation, which is the 401 loop this
 * state exists to stop. The operator must re-authenticate (or force).
 */
export function setAccountStatus(id, status, { force = false } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  if (account.status === 'reauth' && status === 'active' && !force) throw reauthRefusal();
  account.status = status;
  if (status === 'active') {
    account.errorCount = 0;
    delete account.reauth;
    clearBanState(account);
  }
  saveAccounts();
  log.info(`Account ${id} status set to ${status}`);
  trySyncModelCatalog();
  return true;
}

/**
 * Reset error count for an account.
 */
export function resetAccountErrors(id) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  // "Reset errors" on a reauth account is the operator asserting a token they
  // have not replaced is fine — the same lie as `setAccountStatus(active)`.
  if (account.status === 'reauth') throw reauthRefusal();
  account.errorCount = 0;
  account.status = 'active';
  clearBanState(account);
  saveAccounts();
  log.info(`Account ${id} errors reset`);
  trySyncModelCatalog();
  return true;
}

/**
 * Update account label.
 *
 * The label IS the display email (the dashboard renames a row by editing it), so
 * it moves `email` — but NOT `credentialEmail`: the encrypted password record is
 * keyed by the address it was stored under, and re-login / removal must keep
 * finding it after a rename.
 */
// The label is stored into `email` and rendered into dashboard rows, batch
// results, the search corpus and log lines. The write took the string
// verbatim, so a PATCHed label could carry C0/C1 controls (ANSI into the
// operator's terminal when a log line prints it), characters that break the
// markup contexts escapers don't reach, or a length that wedges the table.
// Printable Unicode is legitimate (non-ASCII names exist); control chars and
// a >128-char blob are not. Rejects via a coded error so the API layer can
// return a 400 with a stable code instead of a silent no-op.
export function updateAccountLabel(id, label) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  const next = typeof label === 'string' ? label.trim() : '';
  assertAccountLabel(next);
  account.email = next;
  saveAccounts();
  return true;
}

/**
 * Record which email the stored re-login credential is keyed by (set right after
 * a successful `storeCredential`). Separate from `email` so a later rename
 * cannot orphan the secret.
 */
export function setAccountCredentialEmail(id, email) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  account.credentialEmail = String(email || '');
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

// ─── Account-gone cleanup (G14) ─────────────────────────────
// removeAccount / reportBanSignal / key rotation fire these cleanups as
// un-awaited dynamic imports: the callers are synchronous, and a static
// import would cycle (conversation-pool / windsurf-api reach back through
// config). A rejection must still be OBSERVABLE — a failed invalidateFor
// leaves pool entries resuming onto a dead account, a failed evictForAccount
// leaves a resumable detached pin, and a failed user-JWT epoch bump keeps a
// mint cached for a rotated key — all previously swallowed by
// `.catch(()=>{})`. Every failure is counted (account_cleanup_failed) and
// logged; the caller still never waits on the cleanup.
//
// Test seam (__setReloginDeps shape): a deps map keyed by cleanup name can
// substitute the cleanup promise so a rejection is exercised without a
// module loader. Production leaves it null.
let _accountCleanupDeps = null;
export function __setAccountCleanupDeps(deps) { _accountCleanupDeps = deps || null; }

function reportAccountCleanupFailure(op) {
  return (e) => {
    bumpConnect('account_cleanup_failed');
    log.warn(`account cleanup "${op}" failed — stale pool/detached/JWT state may persist: ${e?.message || e}`);
  };
}

function accountCleanup(op, start) {
  try {
    const dep = _accountCleanupDeps && _accountCleanupDeps[op];
    Promise.resolve(dep ? dep() : start()).catch(reportAccountCleanupFailure(op));
  } catch (e) {
    reportAccountCleanupFailure(op)(e);
  }
}

// Invalidate any cached short-lived user JWT minted for the pool. The mint
// cache lives in windsurf-api.js; the epoch is bumped on every key rotation /
// account removal so a mint racing a logout cannot repopulate a stale JWT.
// Fire-and-forget dynamic import — auth.js cannot statically depend on
// windsurf-api.js (windsurf-api.js → config.js → runtime-config.js → auth.js
// would cycle), and this already follows the module's existing lazy-import
// pattern for windsurf-api.js in the model-catalog sync path.
function bumpUserJwtEpoch() {
  accountCleanup('bumpUserJwtCacheEpoch', () => import('./windsurf-api.js').then(m => m.__bumpUserJwtCacheEpoch()));
}

export function setAccountTokens(id, { apiKey, refreshToken, idToken } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  const previousKey = account.apiKey;
  const apiKeyChanged = apiKey != null && account.apiKey !== apiKey;
  if (apiKey != null) account.apiKey = apiKey;
  if (refreshToken != null) account.refreshToken = refreshToken;
  if (idToken != null) account.idToken = idToken;
  if (apiKeyChanged) {
    markKeyRotation(account, previousKey);
    invalidateModelCatalogForAccount(account.id);
    bumpUserJwtEpoch();
    trySyncModelCatalog();
  }
  saveAccounts();
  return true;
}

/**
 * Stamp the key-rotation clock. Called at every site that replaces an account's
 * upstream session key (re-login, Firebase refresh, paste-over). The dashboard's
 * key card reads `keyRotatedAt` to answer "when did this credential last change"
 * — a question the upstream never answers, since session keys carry no expiry.
 */
function markKeyRotation(account, previousKey) {
  if (!account || typeof account !== 'object') return;
  if (!previousKey || previousKey === account.apiKey) return;
  account.keyRotatedAt = Date.now();
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

// A waiter used to sit in `_reloginWaiters` until a slot freed up, with no
// bound: a holder whose upstream login hung kept every queued reLoginAccount
// pending forever, and an aborted caller's waiter was never removed. Bound the
// WAIT (not the login itself) and let both a timer and an AbortSignal settle
// it. The default is generous next to a real Auth1 login; a caller that cannot
// be served within it is better off failing fast than pinning a request slot.
const RELOGIN_QUEUE_TIMEOUT_MS = () => positiveIntEnv('DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS', 60 * 1000);

function reloginQueueError(message, code, name) {
  return Object.assign(new Error(message), name ? { name, code } : { code });
}

/**
 * Acquire a global re-login slot. Resolves when the caller may run its login;
 * rejects (never hangs) when the optional `signal` aborts or `timeoutMs` /
 * DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS elapses first. A cancelled waiter is
 * spliced out of the FIFO, so releaseReloginSlot never hands a slot to a
 * promise nobody is awaiting.
 */
function acquireReloginSlot({ signal, timeoutMs } = {}) {
  if (signal?.aborted) {
    return Promise.reject(reloginQueueError('re-login queue wait aborted', 'ABORT_ERR', 'AbortError'));
  }
  if (_reloginActive < RELOGIN_MAX_CONCURRENT()) {
    _reloginActive += 1;
    return Promise.resolve();
  }
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : RELOGIN_QUEUE_TIMEOUT_MS();
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && onAbort) { signal.removeEventListener('abort', onAbort); onAbort = null; }
    };
    const drop = () => {
      const i = _reloginWaiters.indexOf(waiter);
      if (i !== -1) _reloginWaiters.splice(i, 1);
    };
    const waiter = {
      grant() { cleanup(); resolve(); },
      cancel(err) { cleanup(); reject(err); },
    };
    timer = setTimeout(() => {
      drop();
      waiter.cancel(reloginQueueError(
        `re-login queue wait exceeded ${waitMs}ms`, 'RELOGIN_QUEUE_TIMEOUT'));
    }, waitMs);
    // A pending waiter must not be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref();
    if (signal) {
      onAbort = () => {
        drop();
        waiter.cancel(reloginQueueError('re-login queue wait aborted', 'ABORT_ERR', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    _reloginWaiters.push(waiter);
  });
}
function releaseReloginSlot() {
  const next = _reloginWaiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter — active count stays the same.
    next.grant();
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
  // Settle, don't orphan: a pending waiter is awaiting a promise inside
  // reLoginAccount, which turns this rejection into `false`. Dropping the array
  // alone would leave those promises pending forever.
  for (const w of _reloginWaiters) {
    w.cancel(reloginQueueError('re-login state reset', 'ABORT_ERR', 'AbortError'));
  }
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
 * @param {AbortSignal} [opts.signal] abort a queued wait for a global login slot
 */
export async function reLoginAccount(id, { force = false, signal } = {}) {
  if (!getBackendSwitch('autoRelogin')) return false;
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  // Operator terminal states are authoritative: a disabled/banned account must
  // not spend a login attempt, and a successful login cannot un-ban it. Only an
  // explicit operator reset leaves these states.
  if (isOperatorTerminalStatus(account.status)) {
    log.debug(`re-login ${safeAccountRef(account)} skipped: operator ${account.status}`);
    return false;
  }
  const tokenAtStart = account.apiKey;

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
      password = getCredential(account.credentialEmail || account.email);
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
    // mass token-death event can't launch an unbounded login stampede. The wait
    // is bounded: a hung holder or a cancelled caller must not pin this attempt
    // (and its request slot) forever. `false` preserves reLoginAccount's
    // "apiKey or false, never throws" contract.
    try {
      await acquireReloginSlot({ signal });
    } catch (e) {
      log.debug(`re-login ${safeAccountRef(account)} skipped: ${
        e.code === 'RELOGIN_QUEUE_TIMEOUT' ? 'queue wait timed out' : 'queue wait aborted'}`);
      return false;
    }
    try {
      // Revalidate after the queued wait: the operator may have disabled,
      // banned, removed or re-keyed the row while this attempt held no slot.
      if (!isCurrentAccount(account) || isOperatorTerminalStatus(account.status) || account.apiKey !== tokenAtStart) {
        log.debug(`re-login ${safeAccountRef(account)} skipped: account changed while queued`);
        return false;
      }
      const proxy = getEffectiveProxy(account.id) || null;
      const { windsurfLogin } = _reloginDeps || await import('./dashboard/windsurf-login.js');
      const result = await windsurfLogin(account.email, password, proxy);
      if (!result?.apiKey) throw new Error('login returned no apiKey');
      // The login RPC is the longest await in this path. Revalidate identity,
      // operator intent and the credential epoch BEFORE committing anything: a
      // disable/ban issued while the login was in flight wins, and a removed or
      // re-added row must never receive the old attempt's token.
      if (!isCurrentAccount(account) || isOperatorTerminalStatus(account.status)) {
        log.warn(`re-login ${safeAccountRef(account)} result discarded: account is ${account.status} or no longer in the pool`);
        return false;
      }
      if (account.apiKey !== tokenAtStart) {
        log.warn(`re-login ${safeAccountRef(account)} result discarded: credential changed during login`);
        return false;
      }
      const apiKeyChanged = account.apiKey !== result.apiKey;
      const previousKey = account.apiKey;
      account.apiKey = result.apiKey;
      if (apiKeyChanged) {
        markKeyRotation(account, previousKey);
        invalidateModelCatalogForAccount(account.id);
        bumpUserJwtEpoch();
      }
      if (result.refreshToken) account.refreshToken = result.refreshToken;
      const wasReauth = account.status === 'reauth';
      account.status = 'active';
      account.errorCount = 0;
      account.erroredAt = 0;
      account._errorAt = 0;
      account._reloginAt = Date.now();
      // A successful login proves the NEW token works, so the evidence behind a
      // previous reauth verdict is dead — dropping it is what makes the state
      // change structural rather than a second flag to remember.
      delete account.reauth;
      // A fresh credential also invalidates a stale ban-signal streak; the ban
      // STATUS itself was refused above, so this cannot erase an operator ban.
      clearBanState(account);
      saveAccounts();
      trySyncModelCatalog();
      log.info(`re-login OK: ${safeAccountRef(account)} → fresh session token`);
      bumpConnect('relogin_ok');
      if (wasReauth) bumpConnect('reauth_ok');
      return result.apiKey;
    } catch (e) {
      log.warn(`re-login ${safeAccountRef(account)} failed: ${e.message}`);
      bumpConnect('relogin_fail');
      if (account.status === 'reauth') bumpConnect('reauth_fail');
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
  // The periodic sweep also filters these, but the function is a public seam:
  // probing a parked credential is pointless and its verdict must never revive it.
  if (isOperatorTerminalStatus(account.status)) return { alive: false, code: 'NOT_ELIGIBLE' };
  const tokenAtStart = account.apiKey;

  const { checkSessionLiveness } = (_reloginDeps && _reloginDeps.checkSessionLiveness)
    ? _reloginDeps
    : await import('./devin-connect-catalog.js');
  const result = await checkSessionLiveness({ token: tokenAtStart, signal });
  // The probe is an await: revalidate the row and credential before applying
  // its verdict. A delete + re-add or a token replacement makes the result
  // belong to a dead lifetime; an operator disable/ban outranks it entirely.
  if (!isCurrentAccount(account)) return { alive: false, code: 'ACCOUNT_CHANGED' };
  if (account.apiKey !== tokenAtStart) return { alive: false, code: 'TOKEN_CHANGED' };
  if (isOperatorTerminalStatus(account.status)) return { alive: false, code: 'NOT_ELIGIBLE' };
  if (result.alive) {
    // A previously-errored account that now probes alive is healthy again.
    if (account.status === 'error') {
      account.status = 'active';
      account.errorCount = 0;
      account._errorAt = 0;
      saveAccounts();
      trySyncModelCatalog();
      log.info(`liveness probe: ${safeAccountRef(account)} recovered to active`);
    } else if (account.status === 'reauth') {
      // The token that was benched now answers GetUserStatus (proxy fixed,
      // upstream restored). The probe is the evidence that benched it, so it
      // is also the only automatic way back into rotation.
      clearNeedsReauth(id, { reason: 'liveness_alive' });
    }
    return { alive: true };
  }

  // Only a genuine auth death warrants pre-emptive recovery; a transient
  // rate-limit or 5xx is not the session_id dying.
  if (result.code === 'UNAUTHORIZED') {
    log.warn(`liveness probe: ${safeAccountRef(account)} session token DEAD (${result.code})`);
    reportError(account.apiKey);
    const fresh = await reLoginAccount(id, { force: true, signal }).catch(() => false);
    if (fresh) bumpConnect('liveness_recovered');
    // No stored credential (or the re-login failed): the token cannot be
    // revived on this account. The probe already answered UNAUTHORIZED for the
    // CURRENT key, so record the terminal state instead of leaving the account
    // to flap back through the error TTL and burn a login attempt every cycle.
    // Revalidate once more: the failed re-login was another await, and a row
    // removed/re-added or parked during it must not receive this old verdict.
    else if (isCurrentAccount(account) && account.apiKey === tokenAtStart && !isOperatorTerminalStatus(account.status)) {
      markNeedsReauth(id, { source: 'liveness', code: result.code });
    }
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
  forgetAccountRequests(id);
  invalidateModelCatalogForAccount(id);
  bumpUserJwtEpoch();
  // The account itself is gone — drop the "had a filter" marker too, unlike a key
  // rotation or status flip where the same account is still under the same upstream
  // restriction.
  forgetCloudModelCatalog(id);
  trySyncModelCatalog();
  saveAccounts();
  // The stored password is a live re-login credential for an account that no
  // longer exists. Leaving it behind meant a deleted account kept a decryptable
  // secret on disk forever (deleteCredential had zero production callers).
  // Best-effort: a store that is disabled, locked or corrupt must not stop the
  // removal — the account is already out of the pool.
  try {
    if (deleteCredential(account.credentialEmail || account.email)) log.info(`Stored credential removed for ${safeAccountRef(account)}`);
  } catch (e) {
    log.warn(`Could not remove stored credential for ${safeAccountRef(account)}: ${e.code || e.message}`);
  }
  // Drop any Cascade conversations owned by this key so future requests
  // don't try to resume on an account that no longer exists.
  accountCleanup('invalidateFor', () => import('./conversation-pool.js').then(m => m.invalidateFor({ apiKey: account.apiKey })));
  // Detach P1: a frozen turn pinned to this account must not be resumable
  // either. The entry holds no LS lease, so eviction is just the map delete;
  // the next retry goes upstream.
  accountCleanup('evictForAccount', () => import('./detached-registry.js').then(m => m.evictForAccount(account.id)));
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
// the one closest to self-healing, most likely to succeed right now. Default ON since
// ea1332e (`degradedServe` def:true) — it shipped default-off for a byte-identical rollout,
// then was flipped deliberately to break the 429 lockout loop. Opt out with
// WINDSURFAPI_DEGRADED_SERVE=0 to get a hard 429 back.
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
    // A selector-scoped upstream rejection is not a throttle: degraded-serve must
    // not re-send a request the upstream already refused for this account.
    if (connectSelector && isSelectorIneligible(a, connectSelector, now)) continue;
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

/**
 * @param {string[]} [excludeKeys]
 * @param {string|null} [modelKey]
 * @param {string|null} [callerKey]
 * @param {string|null} [connectSelector]
 * @param {{ pinOnly?: boolean }} [opts] `pinOnly` makes the sticky arm NON-DESTRUCTIVE:
 *   return the pinned account if it is usable right now, otherwise return null WITHOUT
 *   clearing the binding and WITHOUT rotating to a substitute. It exists so an async
 *   caller can poll for its own pin (chat.js queue-on-pin) using the very same
 *   usability test a real acquisition uses — re-implementing that conjunction next to
 *   the wait loop is how "the fix covered only some paths" keeps recurring here.
 *   It is absolute: with `pinOnly` this NEVER returns a non-pinned account, not even
 *   when no binding exists, so a poll can never be answered with a substitute.
 */
export function getApiKey(excludeKeys = [], modelKey = null, callerKey = null, connectSelector = null, opts = {}) {
  const now = Date.now();
  const pinOnly = !!opts.pinOnly;
  const inflightCap = maxInflightPerAccount();

  // ── Sticky session: prefer the account from the last turn ────────
  // When enabled, this keeps multi-turn conversations on the same upstream
  // account so the cascade_id from the previous turn is still valid.
  // Falls through to normal selection if the bound account is unavailable.
  if (callerKey && isStickyEnabled()) {
    // Pass the connect selector through as its own dimension. getApiKey has always
    // RECEIVED it (the connect path acquires with modelKey=null + a selector) but the
    // binding key ignored it, so all of a caller's connect selectors shared one slot.
    // pinOnly resolves the binding SILENTLY. getStickyBinding counts the lookup and
    // refreshes LRU order, which is right for an acquisition and wrong for a poll: a
    // failed poll still resolves the binding successfully (only the usability test below
    // fails), so counting it would score a hit per poll and make the hit rate an operator
    // reads a function of how long callers waited rather than of how well affinity worked.
    // The successful resolve is promoted to a real, counted lookup further down.
    const bound = pinOnly
      ? peekStickyBinding(callerKey, modelKey, connectSelector)
      : getStickyBinding(callerKey, modelKey, connectSelector);
    if (bound) {
      // Match by account id ONLY — never by the apiKey snapshot taken at bind time.
      // A background re-login swaps account.apiKey in place (keeping the id and
      // forcing status='active'), and the connect path fires re-login on every
      // UNAUTHORIZED, possibly triggered by a DIFFERENT caller sharing the account.
      // Requiring key equality therefore broke affinity precisely in the
      // dead-token→re-login scenario connect deployments hit constantly: the
      // binding missed, got cleared, and the conversation migrated to another
      // account with a full prompt-cache rewrite even though the bound account was
      // healthy under its fresh token. The upstream prompt cache lives on the
      // ACCOUNT, not on the session token, so a re-keyed account still owns it.
      // The key handed back below is always the pool object's CURRENT one.
      const acct = accounts.find(a => a.id === bound.accountId && a.status === 'active');
      if (!acct) {
        log.debug(`[sticky] bound account ${bound.accountId} not selectable (removed or disabled) — falling through`);
      }
      // A bound account listed in excludeKeys was already burned by THIS request
      // (dead token / failover hop passes triedKeys here). Honoring the binding
      // would re-hand the same dead account on every hop — the failover loop then
      // exhausts maxHops on one account and 401s while healthy accounts sit idle
      // (and the repeat reportError calls disable it). Treat it as unusable so it
      // falls through to the no-longer-usable branch below.
      if (acct && !excludeKeys.includes(acct.apiKey)) {
        // Same admission predicate the hard filter and the selector latch use:
        // status, maintenance (incl. language-server), cooldown, selector latch,
        // RPM window, in-flight cap, tier/entitlement. Keeping it in ONE place is
        // what stops "usable here" from drifting away from "usable in getApiKey".
        if (isAdmittedForRequest(acct, { modelKey, connectSelector, now, inflightCap, excludeKeys })) {
          pruneRpmHistory(acct, now); // housekeeping only; the predicate is read-only
          // A pinOnly poll that SUCCEEDS is a real acquisition, so record it as one now
          // (the silent peek above deliberately did not). Without this a queued turn
          // would report zero hits and under-state affinity by exactly the turns
          // queue-on-pin rescued — the opposite bias to counting every poll.
          if (pinOnly) getStickyBinding(callerKey, modelKey, connectSelector);
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
      // Bound account is no longer usable.
      //
      // stickyNoFallback means "do not rotate to another account" — refusing is the point,
      // because rotating rewrites the whole prompt cache. But refusing has to be
      // RECOVERABLE, and it was not: returning null while LEAVING the binding in place
      // means every later request re-resolves the same dead binding and refuses again,
      // forever. Measured: bind a caller, disable the bound account, and four consecutive
      // acquisitions all return null with the binding still present.
      //
      // (The handoff described this as needing BOTH stickyBindByUserOnly and
      // stickyNoFallback. Measured otherwise — stickyNoFallback ALONE wedges, and
      // stickyBindByUserOnly alone self-heals. One documented flag is enough, so the
      // exposure was larger than recorded.)
      //
      // So split the two reasons an account can be unusable:
      //   - TRANSIENTLY (cooling, RPM ceiling, in maintenance): refusing is correct and
      //     the caller should retry — the pin is still meaningful, keep the binding.
      //   - STRUCTURALLY (not in the pool any more, or not 'active'): the binding can
      //     never resolve again, so holding it serves nobody. Clear it and let this
      //     request fall through to normal selection.
      // pinOnly: the caller is POLLING for its own pin and will decide for itself
      // whether to keep waiting or give up. Report "not right now" and change nothing —
      // no clear, no fallback stat, no rotation. Placed ahead of both arms below so it
      // is the same answer regardless of stickyNoFallback, and returns before any
      // mutation so a poll is genuinely free.
      if (pinOnly) return null;
      if (isExperimentalEnabled('stickyNoFallback')) {
        const boundAccount = accounts.find(a => a.id === bound.accountId);
        const structurallyGone = !boundAccount || boundAccount.status !== 'active';
        if (structurallyGone) {
          log.warn(`[sticky] NO-FALLBACK caller=${callerKey.slice(0, 50)} model=${modelKey || '(none)'} — bound account is gone or disabled, clearing the pin instead of refusing forever`);
          clearStickyBinding(callerKey, modelKey, connectSelector);
          noteStickyFallback();
        } else {
          log.info(`[sticky] NO-FALLBACK caller=${callerKey.slice(0, 50)} model=${modelKey || '(none)'} — bound account temporarily unavailable, refusing to rotate`);
          return null;
        }
      } else {
        // Clear it so the next call falls through to normal selection instead of looping.
        clearStickyBinding(callerKey, modelKey, connectSelector);
        noteStickyFallback();
      }
    }
  }

  // pinOnly means "the pinned account or nothing". Reaching here means there was no
  // usable pin — including the no-binding case, and the case where a concurrent request
  // cleared the pin between the poll loop's peek and this call. Falling through would
  // hand back a SUBSTITUTE, which a polling caller would then mistake for its own pin
  // and rebind to, silently converting a wait into the rotation it was avoiding.
  if (pinOnly) return null;

  const candidates = [];
  for (const a of accounts) {
    maybeRecoverErrorAccount(a, now); // AP-RISK-1: half-open trial after TTL
    // ONE admission predicate, shared with markSelectorIneligible: status,
    // request exclusions, maintenance (incl. language-server), cooldown/selector
    // latch, RPM window, in-flight cap, tier/entitlement. The latch asks this
    // exact question before writing "a peer can take over", so it can no longer
    // latch an account while the only peer is one this loop would skip.
    if (!isAdmittedForRequest(a, { modelKey, connectSelector, now, inflightCap, excludeKeys })) continue;
    const used = pruneRpmHistory(a, now); // housekeeping only; the predicate is read-only
    candidates.push({ account: a, used, limit: rpmLimitFor(a) });
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
  // single one that still has RPM headroom — see issue #37).
  //
  // This is in direct tension with sticky-session prompt-cache affinity: a caller's
  // parallel first-round requests deliberately scatter (measured: 8 concurrent → 8
  // distinct accounts, 0 sticky hits), so each account pays its own cache write. The
  // trade is intentional and documented on both sides — see the CONCURRENCY note in
  // account/sticky-session.js and test/sticky-concurrency-tension.test.js. Do not
  // "fix" one side without reading the other.
  //
  // Then prefer
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
    // strictPin means "pin each caller to a fixed slot regardless of quota / RPM / tier",
    // which is only a coherent request when sticky is actually on: the binding and the
    // no-rotate behaviour that make the pin meaningful live in the sticky path.
    //
    // isStickyEnabled() is REQUIRED here, and its absence was a live defect rather than a
    // theoretical one. The two flags are dashboard-settable at runtime while sticky itself
    // is an env-only module-load const, so an operator flipping both switches on a deploy
    // without STICKY_SESSION_ENABLED=1 got `span = candidates.length` — the shard permuting
    // the ENTIRE pool, free to promote the worst account present — with none of the pinning
    // that exemption exists to serve. Reproduced: sticky off, both flags on, and the account
    // at 55/60 RPM carrying a two-failure trouble cluster was selected for 2 of 6 sampled
    // callerKeys.
    const strictPin = isStickyEnabled()
      && isExperimentalEnabled('stickyBindByUserOnly')
      && isExperimentalEnabled('stickyNoFallback');
    {
      // There used to be a separate gate here that computed whether candidates[0] and [1]
      // tied, and only then allowed the shard to run. It is gone because the tied-prefix
      // bound below SUBSUMES it exactly: when the top two do not tie, the prefix is length
      // 1, `hash % 1` is 0, and no swap happens. Verified equivalent across 50 scenarios
      // (5 pool sizes x 5 callerKeys x tied/skewed) — byte-identical selections with the
      // gate present and with it absent. (This said "25 scenarios" and listed a third
      // condition, "forced true"; 5x5x2 is 50, and forcing the gate true is the SAME
      // condition as the gate being absent, not a third one. dcc8cee corrected seven claims
      // in this round and walked past these two lines.)
      //
      // Keeping it would have been worse than removing it: two mechanisms enforcing one
      // property reads as though both were needed, and the next person to touch either
      // would have to re-derive that they are not.
      //
      // Shard only among the candidates that are ACTUALLY TIED with candidates[0].
      //
      // The defect that motivated the bound: that removed gate checked only that [0] and [1]
      // tied, and the code then indexed `hash % candidates.length` across the WHOLE array —
      // so it could promote an account that ties with nothing, including the worst one
      // present. (This paragraph used to open "the check above establishes that [0] and [1]
      // tie", which stopped being true the moment the gate was deleted a commit later — a
      // comment describing a mechanism two paragraphs after explaining its removal.) During a
      // concurrent burst that is exactly what happened: the account already serving sorts
      // LAST on in-flight, the two idle accounts at the front tie, so the gate opened and
      // the swap pulled the busiest account back to position 0. Measured on a pool of 8
      // with tier=pro: a caller whose bucket landed on the last index served the SAME
      // account 8 times while seven peers sat at zero in-flight — the precise pile-up
      // issue #37's inflight-first ordering exists to prevent, re-introduced by its own
      // tiebreaker.
      //
      // It was invisible because the outcome depends entirely on sha256(callerKey) % pool:
      // buckets 0–1 spread across all 8, bucket 7 spread across 1. The pinning test
      // happens to use a callerKey that hashes to bucket 0 — the best case — so it read as
      // "8 concurrent → 8 distinct, by design". Of 8 realistic callerKeys sampled during the
      // investigation only 2 spread across the whole pool; the committed guard in
      // test/shard-tied-prefix.test.js carries 7 of those 8, which is what is reproducible
      // from this repo — the 8th was a probe-only key and is not corroborated here.
      //
      // Bounding the permutation to the tied prefix keeps what sharding is for (a caller
      // deterministically prefers its own slot among EQUALLY GOOD accounts, so two callers
      // don't stack on the same one) while making it structurally unable to promote a
      // worse account. strictPin still shards across everything: that mode is explicitly
      // "pin per user regardless of quota/RPM/tier differences".
      // The predicate must mirror EVERY term the sort compares, with the same bucketing.
      // The first version omitted the recent-trouble bucket — the sort's SECOND-most
      // significant key — which broke the invariant this block exists to establish, in two
      // ways at once: an account the sort demoted for a recent failure cluster counted as
      // tied and could be promoted to slot 0, and because that term outranks the rest, a
      // genuinely-tied account could sit AFTER a non-tied one, so the scan stopped early and
      // under-sharded. Measured: an account with two hard failures (trouble score 6, bucket
      // 2) was still selected for 2 of 6 sampled callerKeys.
      //
      // Any term added to the sort must be added here too. That coupling is the price of
      // bounding the shard by the sort's own notion of "equally good".
      const tiedWithFirst = (c) => {
        const a = candidates[0];
        return (accountInflight(c.account) + accountMaintenance(c.account))
             === (accountInflight(a.account) + accountMaintenance(a.account))
          && Math.floor(recentTroubleScore(c.account, now) / 3)
             === Math.floor(recentTroubleScore(a.account, now) / 3)
          && Math.floor(quotaScore(c.account) / 5) === Math.floor(quotaScore(a.account) / 5)
          && ((c.limit - c.used) / c.limit || 0) === ((a.limit - a.used) / a.limit || 0)
          && (c.account.lastUsed || 0) === (a.account.lastUsed || 0);
      };
      let span = 1;
      if (strictPin) {
        span = candidates.length;
      } else {
        while (span < candidates.length && tiedWithFirst(candidates[span])) span++;
      }
      // Hash only when a shard can actually happen. An earlier version computed sha256 on
      // every getApiKey call carrying a callerKey, including the common case where nothing
      // ties and the result is discarded; the pre-fix code had it inside the gate.
      if (span > 1) {
        const hash = createHash('sha256').update(callerKey).digest();
        const bucket = hash.readUInt32BE(0) % span;
        if (bucket > 0) {
          const chosen = candidates[bucket];
          candidates[bucket] = candidates[0];
          candidates[0] = chosen;
        }
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
  // Selector-scoped upstream verdict (see isSelectorIneligible): the account is
  // healthy, but not for this selector, so a pinned re-acquire must refuse it the
  // same way the general selection path does.
  if (connectSelector && isSelectorIneligible(a, connectSelector, now)) return null;
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

// ─── Ban history: bounded log of every rate-limit event ─────────────────────
// _health (C5, above) answers "how many throttles did this account take in the
// last hour" — a COUNT. It cannot answer the question an operator actually asks
// after a lockout: WHICH window did the upstream ask for, and which one did we
// apply? Those two differ whenever markRateLimited clamps (the Math.max(1000,…)
// floor below), and the clamp is exactly where a real reset window gets lost —
// #242's resetMs drop was invisible for that reason. So this records BOTH sides
// per event, in arrival order, ring-buffered so a 429 storm cannot grow it.
// In-memory only and deliberately NOT persisted: unlike _health this is triage
// detail, not selection input, so it must not enlarge accounts.json.
const RATE_LIMIT_HISTORY_MAX = 500;
const _rateLimitHistory = [];

/**
 * Append one rate-limit event, evicting the oldest once at capacity.
 * `upstreamMs` is what the caller asked for (may be null/0/garbage — that IS
 * the signal worth keeping); `effectiveMs` is what markRateLimited clamped it to.
 */
// Normalize a caller-supplied window to a number, or null when no usable window
// arrived. null/undefined/'' mean "the upstream window never reached us" (#242);
// 0 is a real — if degenerate — window, so it is NOT nulled. Garbage (NaN)
// is a window that cannot be used, so it is nulled too.
function toWindowMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function recordRateLimitEvent(account, { upstreamMs, effectiveMs, until, modelKey, healthKind }) {
  const raw = toWindowMs(upstreamMs);
  _rateLimitHistory.push({
    at: Date.now(),
    accountId: account?.id || 'unknown',
    // Selector or model key the cooldown was scoped to; null = whole account.
    modelKey: modelKey || null,
    // Raw request, normalized to a number-or-null so a caller passing undefined
    // is distinguishable from one passing 0.
    upstreamMs: raw,
    effectiveMs,
    // True when the floor/normalization moved the window — the operator's cue
    // that the upstream window did not survive the trip.
    clamped: effectiveMs !== raw,
    expiresAt: until,
    kind: healthKind,
  });
  if (_rateLimitHistory.length > RATE_LIMIT_HISTORY_MAX) {
    _rateLimitHistory.splice(0, _rateLimitHistory.length - RATE_LIMIT_HISTORY_MAX);
  }
}

/**
 * Public accessor: the rate-limit ring, oldest first (dashboard triage).
 * Returns a copy so a caller cannot mutate the ring; `limit` takes the most
 * RECENT n while preserving that order.
 *
 * Without a limit this returns the WHOLE ring rather than the last
 * RATE_LIMIT_HISTORY_MAX. Capping here too would look equivalent and is not: it
 * would silently paper over a ring that stopped evicting, so the bound would
 * become unobservable from outside — the one property this structure exists to
 * have. The ring is what's bounded; the accessor only reports it.
 */
export function getRateLimitHistory({ limit = 0 } = {}) {
  const n = Math.trunc(Number(limit) || 0);
  const view = n > 0 ? _rateLimitHistory.slice(-n) : _rateLimitHistory.slice();
  return view.map(e => ({ ...e }));
}

/** Test aid: drop the ring so one test's events can't leak into another's. */
export function _resetRateLimitHistoryForTests() { _rateLimitHistory.length = 0; }

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
  recordRateLimitEvent(account, { upstreamMs: durationMs, effectiveMs: safeMs, until, modelKey, healthKind });
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
//
// SELECTOR-AWARE (reviewer #1): the tier bucket is a NECESSARY but not
// sufficient fallback test. Two same-tier peers can differ per selector — a
// per-account catalog that lacks the selector, an operator blocklist entry, or
// an upstream "no longer available for your account" verdict. Counting such a
// peer as a fallback made the breaker disable the only account that could
// serve the selector: three rejections for one retired model removed the
// account from rotation for EVERY model. So when the caller knows which
// selector is in play, a peer must also be entitled to it (and not latched
// out of it) to disqualify `account` from the exemption.
function tierBucketRank(tier) {
  switch (tierBucket(tier)) {
    case 'pro': return 2;
    case 'unknown': return 1;
    case 'free': return 0;
    default: return -1; // expired / anything else — never a capability fallback
  }
}
function isLastUsableAccount(account, now = Date.now(), selector = null) {
  if (!account) return false;
  const ownRank = tierBucketRank(account.tier);
  for (const a of accounts) {
    if (a === account) continue;
    if (a.status !== 'active') continue;
    if (isRateLimitedForModel(a, null, now)) continue;
    // Selector scope: a peer that cannot serve the selector in question is not a
    // fallback for it (see the SELECTOR-AWARE note above). `selector == null`
    // keeps every existing caller's account-wide meaning byte-identical.
    if (selector && (!isConnectSelectorAllowedForAccount(a, selector)
        || isSelectorIneligible(a, selector, now))) continue;
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

// Which dimension wrote account.quotaResetAt. One deadline is shared by two
// writers with different evidence (a proactive weekly/balance snapshot and a
// live 402), so the deadline alone cannot answer "may this snapshot clear it?".
// Persisted with the deadline: after a restart the live-402 window must not
// become clearable by unrelated weekly data. Unknown (older accounts.json, or a
// hand-edited file) is NOT guessed — an unrecorded deadline is only cleared by
// expiry.
const QUOTA_RESET_SOURCES = new Set(['snapshot', 'live402']);

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
  const reserveOverride = parseOptionalNumber(account?.onDemandReserve);
  const reserve = reserveOverride !== null && reserveOverride >= 0
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
    const previous = account.quotaResetAt || 0;
    const alreadyCooled = previous > now;
    // MONOTONIC: a cooldown is a deadline, not a value. A later snapshot may
    // extend it but must never pull it closer — a stale snapshot (or a lowered
    // WINDSURFAPI_QUOTA_COOLDOWN_MS) re-entering an account before the upstream
    // said it is usable just earns another 402.
    const next = Math.max(previous, now + quotaCooldownMs());
    account.quotaResetAt = next;
    // PROVENANCE: record which dimension wrote the CURRENT deadline. Only that
    // dimension may clear it (see the recovery branch). When this snapshot did
    // not extend the deadline it is not the author — keep the existing source.
    if (next > previous) account.quotaResetSource = 'snapshot';
    if (!alreadyCooled) {
      bumpConnect('quota_exhausted');
      log.warn(`Account ${safeAccountRef(account)} quota dry (weekly ${w}%) — quota cooldown ${Math.round(quotaCooldownMs() / 60000)}m (self-healing)`);
    }
  } else if (account.quotaResetAt) {
    // Recovered included quota OR a spendable on-demand balance under the active
    // policy → clear ONLY the quota dimension, never the transient one.
    //
    // SAME-SOURCE ONLY: a weekly/balance snapshot is evidence about its own
    // dimension. A live-402 deadline (markQuotaExhausted) is a NEWER statement
    // that an actual request could not be served, and the snapshot carries no
    // per-dimension timestamp to prove it is fresher — clearing it on unrelated
    // weekly data re-entered an account the upstream had just rejected. An
    // unrecorded source (accounts.json from a version that did not persist one)
    // is treated the same way: unknown is never proof. Both self-heal on expiry.
    const expired = account.quotaResetAt <= now;
    if (expired || account.quotaResetSource === 'snapshot') {
      account.quotaResetAt = 0;
      account.quotaResetSource = null;
      log.info(`Account ${safeAccountRef(account)} quota recovered (weekly ${w}%) — quota cooldown cleared`);
    } else {
      log.info(`Account ${safeAccountRef(account)} quota cooldown retained (weekly ${w}% is not evidence for the ${account.quotaResetSource || 'unknown'}-sourced deadline)`);
    }
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
      const n = parseOptionalNumber(reserve);
      if (n !== null && n >= 0) account.onDemandReserve = n;
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
    reserveOverride: parseOptionalNumber(account?.onDemandReserve),
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
  const previous = account.quotaResetAt || 0;
  const alreadyCooled = previous > now;
  account.quotaResetAt = Math.max(previous, now + ms);
  // Provenance of the CURRENT deadline: this live 402 is its author only when it
  // actually extended it. A longer snapshot-armed deadline keeps its own source,
  // so a later recovery snapshot can still clear what it wrote.
  if (account.quotaResetAt > previous) account.quotaResetSource = 'live402';
  if (!alreadyCooled) {
    log.warn(`Account ${safeAccountRef(account)} QUOTA_EXHAUSTED (live 402) — quota cooldown ${Math.round(ms / 60000)}m (self-healing)`);
  }
}

/**
 * Read-only half of maybeRecoverErrorAccount: is this account's half-open trial
 * due? Split out so a caller that MUST NOT mutate — the connect preflight — can
 * still model what the next getApiKey call will do (it recovers before applying
 * the admission predicate), instead of concluding "nothing selectable" for a
 * pool whose next selection would make this account active.
 */
function errorRecoveryDue(account, now) {
  if (!account || account.status !== 'error') return false;
  const since = account.erroredAt || account._errorAt || 0;
  return since > 0 && (now - since) >= errorRecoveryTtlMs();
}

function maybeRecoverErrorAccount(account, now) {
  if (!errorRecoveryDue(account, now)) return;
  const since = account.erroredAt || account._errorAt || 0;
  account.status = 'active';
  account.errorCount = 0;
  log.info(`Account ${safeAccountRef(account)} half-open recovery after ${Math.round((now - since) / 60000)}m in error state`);
  trySyncModelCatalog();
}

/**
 * Check if an account is rate-limited for a specific model.
 */
/**
 * Cooldown check across BOTH model dimensions a request can carry.
 *
 * The connect path selects with modelKey=null and a `connectSelector` instead, so
 * a model-scoped cooldown written under the selector (CAPACITY, chat.js) is
 * invisible to isRateLimitedForModel(account, null) — the structural trap #224 hit
 * for RATE_LIMITED. Checking both keys makes a selector-scoped cooldown actually
 * gate connect selection while keeping the account healthy for every other model.
 */
function isCooledForRequest(account, modelKey, connectSelector, now) {
  if (isRateLimitedForModel(account, modelKey, now)) return true;
  if (connectSelector && connectSelector !== modelKey
      && isRateLimitedForModel(account, connectSelector, now)) return true;
  // Selector-scoped upstream verdict ("no longer available for your account"):
  // not a throttle, but for THIS selector the account is just as unusable, so
  // selection must skip it exactly like a cooled one while keeping it fully
  // available for every other selector.
  if (connectSelector && isSelectorIneligible(account, connectSelector, now)) return true;
  return false;
}

// Side-effect-free twin of isCooledForRequest for admission probes. Same
// dimensions, but it never deletes expired model/latch entries — asking "could
// this peer serve the selector?" must not mutate the peer.
function isCooledForRequestReadOnly(account, modelKey, connectSelector, now) {
  if ((account.rateLimitedUntil || 0) > now) return true;
  if ((account.quotaResetAt || 0) > now) return true;
  if (modelKey && (account._modelRateLimits?.[modelKey] || 0) > now) return true;
  if (connectSelector && connectSelector !== modelKey
      && (account._modelRateLimits?.[connectSelector] || 0) > now) return true;
  if (connectSelector && isSelectorIneligibleAt(account, connectSelector, now)) return true;
  return false;
}

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
export function reportError(apiKey, { windowMs = getBreakerTunable('errorWindowMs'), selector = null } = {}) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  // Operator terminal states are authoritative. A request acquired before the
  // disable/ban can report its failure afterwards; counting it would walk the
  // account into 'error' — a SELF-HEALING state whose TTL hands the credential
  // back to selection. Only an explicit operator reset may leave these states.
  if (isOperatorTerminalStatus(account.status)) return;
  // SessionReauth: the token is retired upstream and out of rotation. Counting
  // errors here would only walk it toward 'error' — a SELF-HEALING state — and
  // maybeRecoverErrorAccount would then hand the dead key back to selection.
  // Only a fresh token (or an alive probe) leaves 'reauth'.
  if (account.status === 'reauth') return;
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
    if (lastAccountExemptEnabled() && isLastUsableAccount(account, now, selector)) {
      log.warn(`Account ${safeAccountRef(account)} hit ${account.errorCount} errors in ${Math.round(windowMs / 60000)}m but is the LAST usable account${selector ? ` for ${selector}` : ''} — kept in rotation (single-account exemption); surfacing upstream errors instead of a pool-wide 529`);
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
    trySyncModelCatalog();
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
  const hadErrors = account.errorCount > 0;
  const wasErrored = account.status === 'error';
  if (hadErrors) account.errorCount = 0;
  // A success is evidence about the CREDENTIAL, not about operator intent.
  // Only the self-healing 'error' state may be promoted; 'active' is a no-op,
  // while 'disabled'/'banned' are terminal until an explicit operator reset and
  // 'reauth' only leaves with a fresh token. This is the late-outcome guard:
  // the request may have been acquired before the operator flipped the switch.
  if (wasErrored) {
    account.status = 'active';
    account.erroredAt = 0;
    trySyncModelCatalog();
  } else if (hadErrors && !isOperatorTerminalStatus(account.status)) {
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
 * K8: accumulate one request's usage onto the account's lifetime spend counter.
 * Called after a completed chat (both Cascade and DEVIN_CONNECT paths) with the
 * OpenAI-shaped usage object. Monotonic and independent of the rolling stats
 * window / log rotation, so the dashboard can show "which account burns fastest"
 * and drive rotation/retirement decisions. Lazy-persisted via markDirty (the
 * periodic flush writes it — no hot-path fsync). creditCost only accrues when a
 * paid token surfaced billing (DEVIN_CONNECT_BILLING_TAGS calibrated).
 *
 * The first argument is an ATTEMPT IDENTITY, not a credential lookup key. The
 * account is resolved by its immutable id whenever the caller has one; the
 * apiKey on the identity is only the credential the attempt presented, and may
 * already be stale by the time the turn completes (re-login / manual rotation).
 * A bare apiKey is still accepted for the env-token and detached-resume paths,
 * which have no pool account to point at.
 *
 * @param {string|{accountId?: string, id?: string, apiKey?: string, attemptId?: string, reservationTimestamp?: number}} identity
 * @param {object|null} usage  { prompt_tokens, completion_tokens, total_tokens }
 * @param {object} [opts]      { creditCost?: number, acuCost?: number, model?: string, attemptId?: string }
 */
/**
 * Full billable cost of a request, independent of whatever shape total_tokens is in.
 *
 * Cost accounting must NOT read total_tokens directly. On the CASCADE path,
 * WINDSURFAPI_STRICT_USAGE_TOTAL=1 deliberately excludes cache-write from total_tokens to
 * satisfy OpenAI's arithmetic identity, so metering off it would make an operator's own
 * spend tally under-report the moment they opted into spec compliance — they would pay
 * for cache-writes that never appear in their own chart. The cache-write figure is on the
 * wire either way as `cache_creation_input_tokens`, so the full cost stays recoverable.
 *
 * On the CONNECT path (O2) the split is the other way round: cache-write is already
 * INSIDE prompt_tokens, so adding cache_write again would bill the prefix twice.
 * `fresh_input_tokens` is emitted there precisely so this function does not have to
 * infer which convention produced the object.
 *
 * Lives here, beside its only caller, rather than in a handler: this used to be defined in
 * handlers/chat.js with recordAccountSpend re-implementing the same arithmetic inline. Two
 * copies of a billing calculation is one too many, and the exported copy had no production
 * caller at all, so its mutation guard was protecting nothing that reached the wire.
 *
 * The max() is over non-negative terms only. An earlier inline version ended in
 * `|| (prompt + completion)`, which was unreachable for any real usage block AND the single
 * path able to emit a NEGATIVE spend total (a negative bucket makes the max 0, and `0 ||`
 * then falls through to the negative sum). Clamping instead keeps the tally monotonic,
 * which is the one property a cumulative counter has to have.
 */
export function fullBillableTokens(usage) {
  if (!usage) return 0;
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  const cacheWrite = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
  const total = Math.max(0, Number(usage.total_tokens) || 0);
  const freshRaw = Number(usage.fresh_input_tokens);
  if (Number.isFinite(freshRaw) && usage.fresh_input_tokens != null) {
    // The connect shape: rebuild the full cost from explicit buckets instead of
    // assuming cache-write sits outside prompt_tokens.
    const fresh = Math.max(0, freshRaw);
    const cacheRead = Math.max(0, Number(
      usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens,
    ) || 0);
    return Math.max(total, fresh + cacheRead + cacheWrite + completion);
  }
  // The Cascade shape: the grand total already includes cache-write unless the strict
  // flag stripped it. Taking the max covers both without knowing which produced it.
  return Math.max(total, prompt + completion + cacheWrite);
}

// ─── Per-account request history ─────────────────────────────────────────
// Neither existing request log can answer "what has THIS account served":
//   • stats.recentRequests is a bounded global ring (500 rows) that now carries
//     an opaque account ref, so it can say which account served a recent
//     request but cannot retain or query a per-account history;
//   • request-ring rows are keyed by a caller hash, with no account attribution.
// This ring is written from recordAccountSpend (billed successes) and
// recordAccountAttempt (failed attempts that still have an account owner). A
// row therefore always belongs to an account; a pool-wide failure with no
// account (empty pool, un-attributed env-token call) writes nothing.
// The consequences are stated on the drawer card, not just here:
//   • billed rows carry tokens + cost; failed rows carry outcome/status at zero cost;
//   • process-local and bounded (ACCOUNT_REQUEST_CAP rows per account), with the
//     window reserved for billed rows: failures are evicted first and an
//     incoming failure is dropped rather than displacing a billed row;
//   • never persisted — accounts.json stays free of request history;
//   • no key material: model name, token counts, cost figures and outcome only.
export const ACCOUNT_REQUEST_CAP = 100;
const _accountRequests = new Map();

export function recordAccountRequest(account, { model = '', usage = null, creditCost = 0, acuCost = 0, attemptId = '', billed = true, outcome = '', status = null, now = Date.now() } = {}) {
  const id = account?.id;
  if (!id) return null;
  const isBilled = billed !== false;
  const entry = {
    ts: now,
    // The upstream attempt that produced this row (the reservation timestamp).
    // Immutable for the life of the attempt, so a row stays traceable when the
    // account's credential rotated between two otherwise identical turns.
    attemptId: attemptId == null ? '' : String(attemptId).slice(0, 80),
    model: typeof model === 'string' ? model.slice(0, 120) : '',
    // `billed:false` is a FAILED attempt: the account was asked to serve it and
    // did not. Its cost fields are forced to zero below so a caller cannot
    // accidentally charge a failed row into the billed summary.
    billed: isBilled,
    ...(isBilled ? {} : {
      outcome: typeof outcome === 'string' ? outcome.slice(0, 40) : '',
      status: Number.isFinite(Number(status)) && Number(status) > 0 ? Math.trunc(Number(status)) : null,
    }),
    promptTokens: isBilled ? Math.max(0, Number(usage?.prompt_tokens) || 0) : 0,
    completionTokens: isBilled ? Math.max(0, Number(usage?.completion_tokens) || 0) : 0,
    totalTokens: isBilled ? fullBillableTokens(usage) : 0,
    credit: isBilled ? Math.max(0, Number(creditCost) || 0) : 0,
    acu: isBilled ? Math.max(0, Number(acuCost) || 0) : 0,
  };
  let ring = _accountRequests.get(id);
  if (!ring) { ring = []; _accountRequests.set(id, ring); }
  ring.push(entry);
  if (ring.length > ACCOUNT_REQUEST_CAP) {
    // Billed rows are the money truth; failed attempts are best-effort and
    // share this window. Evict the oldest failure first so a failure burst can
    // never erase the billed window and zero its summary (wave-7 P2). A new
    // billed row evicts the oldest failure, or — when every slot is billed —
    // the oldest billed row. An incoming failure with no failure slot to take
    // is dropped rather than displacing a billed row.
    const failedAt = ring.findIndex(r => r.billed === false);
    if (failedAt !== -1) {
      ring.splice(failedAt, 1);
    } else if (isBilled) {
      ring.splice(0, 1);
    } else {
      ring.pop(); // the just-pushed failure: no billed row may be displaced
    }
  }
  return entry;
}

/**
 * Record a FAILED upstream attempt against the account that was asked to serve
 * it. No account id ⇒ no row: an unattributed failure (empty pool, env-token
 * call) belongs to nobody, and inventing an owner would make the per-account
 * history lie. The row is deliberately cost-free (`billed:false`, zero tokens /
 * credit / ACU); `outcome` is a short machine label (rate_limited,
 * connection_error, client_abort, upstream_error, …) and `status` the HTTP-ish
 * verdict the client saw (429 / 502 / 499 / …). Neither field carries upstream
 * message text, which can contain request content.
 */
export function recordAccountAttempt(account, { model = '', outcome = '', status = null, attemptId = '', now = Date.now() } = {}) {
  if (!account?.id) return null;
  return recordAccountRequest(account, {
    model,
    usage: null,
    creditCost: 0,
    acuCost: 0,
    attemptId,
    billed: false,
    outcome,
    status,
    now,
  });
}

/**
 * Newest-first page of an account's requests plus the billed totals over the
 * whole retained window. `total` is the ring size (billed + failed rows), never
 * the page size, so a caller can tell "50 of 50" from "50 of 3". `billed` and
 * `failed` split that total; `summary` stays a BILLED summary — a failed row
 * never moves its token/credit/ACU counters or its `lastTs`.
 */
export function getAccountRequests(id, { limit = 50 } = {}) {
  const ring = _accountRequests.get(String(id || '')) || [];
  const n = Math.max(1, Math.min(ACCOUNT_REQUEST_CAP, Number(limit) || 50));
  let billed = 0;
  let failed = 0;
  const summary = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    credit: 0,
    acu: 0,
    lastTs: 0,
  };
  for (const r of ring) {
    if (r.billed === false) { failed++; continue; }
    billed++;
    summary.requests += 1;
    summary.promptTokens += r.promptTokens;
    summary.completionTokens += r.completionTokens;
    summary.totalTokens += r.totalTokens;
    summary.credit += r.credit;
    summary.acu += r.acu;
    summary.lastTs = r.ts;
  }
  return {
    items: ring.slice(-n).reverse(),
    total: ring.length,
    billed,
    failed,
    capacity: ACCOUNT_REQUEST_CAP,
    summary,
  };
}

/** Drop an account's ring when the account itself is gone. */
export function forgetAccountRequests(id) {
  _accountRequests.delete(String(id || ''));
}

/** Test seam: empty every ring without touching production state. */
export function __resetAccountRequestsForTest() {
  _accountRequests.clear();
}

function resolveSpendAccount(identity) {
  if (!identity) return null;
  if (typeof identity === 'object') {
    const id = identity.accountId || identity.id;
    // A supplied id is authoritative. Do NOT fall back to the key when it does
    // not resolve: a credential that outlived its account may since have been
    // recycled onto a different one, and crediting that account would be a
    // worse error than dropping a row for an account that no longer exists.
    if (id) return accounts.find(a => a.id === id) || null;
    return accounts.find(a => a.apiKey === identity.apiKey) || null;
  }
  return accounts.find(a => a.apiKey === identity) || null;
}

function spendAttemptId(identity, explicit) {
  if (explicit) return String(explicit);
  if (!identity || typeof identity !== 'object') return '';
  const id = identity.attemptId ?? identity.reservationTimestamp;
  return id == null ? '' : String(id);
}

export function recordAccountSpend(identity, usage, { creditCost = 0, acuCost = 0, model = '', attemptId = '' } = {}) {
  const account = resolveSpendAccount(identity);
  if (!account) return;
  if (!account._totalSpend || typeof account._totalSpend !== 'object') {
    account._totalSpend = { requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, creditCost: 0, acuCost: 0 };
  }
  const s = account._totalSpend;
  // Clamped for the same reason fullBillableTokens clamps: these are CUMULATIVE counters, so
  // a single malformed upstream usage block would drag them permanently negative and no
  // later request could undo it. The first version of this fix clamped only inside
  // fullBillableTokens, which covered totalTokens and left promptTokens / completionTokens
  // unprotected — measured: {prompt_tokens:-500, completion_tokens:-10} left both counters
  // permanently negative while totalTokens correctly stayed 0. The "keeps the tally
  // monotonic" claim held for one counter of three.
  const prompt = Math.max(0, Number(usage?.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage?.completion_tokens) || 0);
  // Cost accounting must not read total_tokens directly. With
  // WINDSURFAPI_STRICT_USAGE_TOTAL=1 that field deliberately drops generation-side
  // cache-write to satisfy OpenAI's arithmetic identity, so metering off it would make
  // this tally under-report the moment an operator opted into spec compliance — they
  // would pay for cache-writes that never appear in their own spend chart. The
  // cache-write figure is on the wire as cache_creation_input_tokens either way, so the
  // full cost stays recoverable regardless of which shape total_tokens is in.
  const total = fullBillableTokens(usage);
  s.requests += 1;
  s.promptTokens += prompt;
  s.completionTokens += completion;
  s.totalTokens += total;
  s.creditCost += Math.max(0, Number(creditCost) || 0);
  s.acuCost = (Number(s.acuCost) || 0) + Math.max(0, Number(acuCost) || 0);
  recordAccountRequest(account, { model, usage, creditCost, acuCost, attemptId: spendAttemptId(identity, attemptId) });
  markDirty();
}

/**
 * Report an upstream "internal error occurred (error ID: ...)" from Windsurf.
 * These are account-specific backend errors — a given key will keep hitting
 * them until we stop using it. Quarantine the key for 5 minutes after 2
 * consecutive hits so we stop burning user-visible retries on a dead key.
 */
export function reportInternalError(apiKey, { selector = null } = {}) {
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
    if (lastAccountExemptEnabled() && isLastUsableAccount(account, now, selector)) {
      log.warn(`Account ${safeAccountRef(account)} hit ${account.internalErrorStreak} consecutive upstream internal errors but is the LAST usable account${selector ? ` for ${selector}` : ''} — NOT quarantined (single-account exemption)`);
      return;
    }
    // cool-01: Math.max so a shorter internal-error quarantine never SHORTENS a
    // longer existing cooldown (e.g. a 3h RATE_LIMITED reset window). Mirrors the
    // guard at markRateLimited (:1726) and the backoff path (:2117).
    account.rateLimitedUntil = Math.max(account.rateLimitedUntil || 0, now + getBreakerTunable('internalQuarantineMs'));
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
  // Operator terminal states are authoritative: a late ban-shaped error must
  // not replace a disable with a ban (or refresh an existing ban's evidence).
  if (isOperatorTerminalStatus(account.status)) return false;
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
    trySyncModelCatalog();
    log.error(`Account ${safeAccountRef(account)} marked BANNED after ${account._banSignalCount} ban-shaped errors`);
    // Drop any cascade-pool entries owned by this key.
    accountCleanup('invalidateFor', () => import('./conversation-pool.js').then(m => m.invalidateFor({ apiKey })));
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
  // Connect selection asks with modelKey=null + a resolved selector, so a
  // cooldown written under the SELECTOR dimension must gate this preflight just
  // like one written under modelKey. Without it, a model-scoped 429 (the
  // upstream's "rate limit for this model ... Resets in: 3h") that the handler
  // scopes to the selector is invisible here: the pool fast-path reports
  // "available", spends the whole queue wait, and only then discovers every
  // account is cooled for that selector. The scheduler's own admission
  // predicate (isCooledForRequest) already ORs the two dimensions; this is the
  // preflight's copy of that conjunction.
  const selectorKey = connectSelector && connectSelector !== modelKey ? connectSelector : null;
  for (const a of accounts) {
    if (a.status !== 'active') continue;
    if (modelKey && !isModelAllowedForAccount(a, modelKey)) continue;
    if (connectSelector && !isConnectSelectorAllowedForAccount(a, connectSelector)) continue;
    anyEligible = true;
    const cooled = isRateLimitedForModel(a, modelKey, now)
      || (selectorKey ? isRateLimitedForModel(a, selectorKey, now) : false);
    if (!cooled) return { allLimited: false };
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
    if (selectorKey && a._modelRateLimits?.[selectorKey] > now) {
      soonestExpiry = Math.min(soonestExpiry, a._modelRateLimits[selectorKey]);
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
  // Same dimension split as isAllRateLimited: connect selection asks with
  // modelKey=null + a resolved selector, and isCooledForRequestReadOnly excludes
  // an account cooled for that selector. If this view ignored the selector, the
  // chat preflight would read a selector-cooled pool as "rate-limited but still
  // degradable" (rl true, tu false) and skip its fast 429, spending the queue
  // wait before failing. Reporting it unavailable restores the fast 429 with the
  // upstream reset as Retry-After.
  const selectorKey = connectSelector && connectSelector !== modelKey ? connectSelector : null;

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

    if (selectorKey && a._modelRateLimits) {
      const until = a._modelRateLimits[selectorKey];
      if (until && until > now) {
        soonestExpiry = Math.min(soonestExpiry, until);
        continue;
      }
      if (until && until <= now) delete a._modelRateLimits[selectorKey];
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

/**
 * Preflight view of the SELECTION conjunction for one connect selector: is every
 * entitled account unselectable right now?
 *
 * isAllRateLimited / isAllTemporarilyUnavailable model only the cooldown and RPM
 * dimensions. They are blind to the dimensions isAdmittedForRequest adds — account
 * maintenance (held for the duration of a background or language-server swap; live
 * by default) and the per-account in-flight cap (DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT)
 * — and to the selector latch. A pool that is unselectable for one of those reasons
 * therefore passes the fast-fail preflight, spends the queue wait in
 * acquireConnectAccount, and acquires null — which the connect path cannot tell apart
 * from "no pool at all" and answers with the un-accounted env token (the P0-2
 * conflation the preflight exists to prevent).
 *
 * Read-only and reservation-free: it delegates to isAdmittedForRequest, the
 * scheduler's own predicate, rather than re-deriving the conjunction (a second copy
 * is exactly how the latch's peer gate once disagreed with getApiKey).
 *
 * Returns the same shape as its two siblings so the caller folds it into one arm.
 * `retryAfterMs` is a flat 30s: maintenance and in-flight release carry no deadline
 * this layer can read, and the point is only to stop the caller from blocking a full
 * queue wait on a pool that cannot serve it.
 *
 * An empty eligible set means "no pool to judge" (every account disabled, or an
 * env-token deploy) — NOT exhaustion — so it reports available, leaving the caller's
 * env-token fallback intact.
 *
 * One step of getApiKey is modelled rather than skipped: it half-opens an 'error'
 * account whose recovery TTL has elapsed BEFORE applying the admission predicate
 * (maybeRecoverErrorAccount). A pool whose remaining candidate is due for that trial
 * is not exhausted, and fast-failing here would be self-inflicted — the recovery only
 * runs inside getApiKey, so a 429 would never let it happen. The trial is evaluated
 * on a COPY: this function still mutates nothing.
 */
export function isAllConnectAccountsUnavailable(selector) {
  const now = Date.now();
  let anyEligible = false;
  for (const a of accounts) {
    if (a.status !== 'active') {
      if (errorRecoveryDue(a, now)
          && isAdmittedForRequest({ ...a, status: 'active' }, { connectSelector: selector, now })) {
        return { allUnavailable: false, retryAfterMs: null };
      }
      continue;
    }
    if (!isConnectSelectorAllowedForAccount(a, selector)) continue;
    anyEligible = true;
    if (isAdmittedForRequest(a, { connectSelector: selector, now })) {
      return { allUnavailable: false, retryAfterMs: null };
    }
  }
  if (!anyEligible) return { allUnavailable: false, retryAfterMs: null };
  return { allUnavailable: true, retryAfterMs: 30_000 };
}

export function isAuthenticated() {
  return accounts.some(a => a.status === 'active');
}

export function maskApiKey(key = '') {
  const s = String(key || '');
  if (!s) return '';
  // Never show more than ~25% of the secret: the 8-char minimum key used to
  // leak its first half (4 chars) through the "masked" field (S6-F1).
  if (s.length <= 8) return `${s.slice(0, 2)}...`;
  if (s.length <= 12) return `${s.slice(0, 3)}...`;
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

// One closed status vocabulary for the dashboard's row badge, status filter and
// drawer. The five server booleans overlap (a rate-limited account also has
// errorCount > 0, a quota-cooled account can still be `active`), so every
// consumer resolves them through THIS precedence ladder instead of re-deriving
// its own. `state` rides the account payload so the client never recomputes it
// and the filter can never disagree with the badge it painted.
export const ACCOUNT_STATE_VALUES = Object.freeze([
  'disabled', 'banned', 'reauth', 'error', 'quota_cooled', 'rate_limited', 'capacity', 'near_limit', 'watch', 'active',
]);

export function resolveAccountState(a, now = Date.now(), { rpmUsed, rpmLimit } = {}) {
  if (!a) return 'active';
  if (a.status === 'disabled') return 'disabled';
  // A banned account is out of routing and only the operator can recover it
  // (reset errors / enable). It must never render as healthy, and it outranks
  // every transient cooldown: the credential itself was rejected upstream.
  if (a.status === 'banned') return 'banned';
  // SessionReauth: the server retired this session token. Terminal until a
  // fresh token is installed, so it outranks every self-healing cooldown — an
  // account that is also rate-limited is still dead, and painting it "rate
  // limited" would promise a recovery that never comes.
  if (a.status === 'reauth') return 'reauth';
  if (a.status === 'error') return 'error';
  if (a.quotaResetAt && a.quotaResetAt > now) return 'quota_cooled';
  if (a.rateLimitedUntil && a.rateLimitedUntil > now) return 'rate_limited';
  if (a._modelRateLimits && Object.values(a._modelRateLimits).some((until) => until > now)) return 'capacity';
  const limit = rpmLimit ?? rpmLimitFor(a);
  const used = rpmUsed ?? pruneRpmHistory(a, now);
  if (limit > 0 && used / limit >= 0.9) return 'near_limit';
  if ((a.errorCount || 0) > 0) return 'watch';
  return 'active';
}

// The ban reason is the upstream error text that tripped the detector. It is
// operator-facing (why is this account dead?), but it is still untrusted text:
// cap it and redact anything token-shaped before it rides the account payload
// into the dashboard, logs or an export. Never expose the credential itself.
export function publicBanReason(reason) {
  if (typeof reason !== 'string' || !reason) return '';
  return reason
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(?:sk|sess|key|tok)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .slice(0, 240);
}

function publicAccount(a, now, { view = 'full' } = {}) {
  const rpmLimit = rpmLimitFor(a);
  const rpmUsed = pruneRpmHistory(a, now);
  const tierModels = getTierModels(a.tier || 'unknown', a.id);
  const cr = a.credits || null;
  const base = {
    id: a.id,
    email: a.email,
    label: a.label || '',
    method: a.method,
    status: a.status,
    state: resolveAccountState(a, now, { rpmUsed, rpmLimit }),
    // Ban metadata is operator-facing only: when it happened, and the
    // sanitized upstream text that tripped the detector. Empty for healthy
    // accounts, so the drawer can render conditionally.
    bannedAt: a.status === 'banned' ? (a.bannedAt || a._banSignalAt || 0) : 0,
    bannedReason: a.status === 'banned' ? publicBanReason(a.bannedReason || a._banSignalLastMessage) : '',
    // SessionReauth: `status`/`state` are the bit; this is only the evidence
    // behind it (when the probe confirmed death and what it answered), so the
    // row tooltip and the drawer card can explain the state without a second
    // request. Null for every other status.
    reauth: a.status === 'reauth' && a.reauth
      ? { at: a.reauth.at || 0, source: a.reauth.source || 'request', code: a.reauth.code || '' }
      : null,
    errorCount: a.errorCount,
    lastUsed: a.lastUsed ? new Date(a.lastUsed).toISOString() : null,
    addedAt: new Date(a.addedAt).toISOString(),
    // Last time the upstream session key changed (re-login / Firebase refresh).
    // 0 = never rotated since the account was added.
    keyRotatedAt: a.keyRotatedAt || 0,
    // Same rule as maskApiKey: the "prefix" must never be a recoverable
    // fraction of the key. Cap at 8 chars but never show more than a third:
    // a 9–12-char key otherwise leaks 8/9 of its entropy (L1-F4).
    keyPrefix: a.apiKey.slice(0, Math.min(8, Math.max(2, Math.floor(a.apiKey.length / 3)))) + '...',
    apiKey_masked: maskApiKey(a.apiKey),
    tier: a.tier || 'unknown',
    lastProbed: a.lastProbed || 0,
    rateLimitedUntil: a.rateLimitedUntil || 0,
    rateLimited: !!(a.rateLimitedUntil && a.rateLimitedUntil > now),
    quotaResetAt: a.quotaResetAt || 0,
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
    // CAPACITY vs RATE_LIMITED distinction (user-facing). `rateLimited` (above) is
    // an ACCOUNT-wide throttle — switching accounts helps. `capacityThrottled` is
    // a MODEL being temporarily overloaded (short, model-scoped _modelRateLimits) —
    // switching accounts does NOT help (the model itself is busy). Surfacing both
    // lets an operator tell "change account" from "wait / try another model".
    capacityThrottled: !!(a._modelRateLimits && Object.values(a._modelRateLimits).some(until => until > now)),
    // Account-wide quota dry-well (out of credit; self-healing at quotaResetAt).
    // Distinct from rateLimited — surfaced so the pool-event notifier can tell
    // "out of quota" from "throttled".
    quotaCooled: !!(a.quotaResetAt && a.quotaResetAt > now),
  };
  if (view === 'summary') return base;

  const proxy = getEffectiveProxy(a.id) || null;
  const lsAdmission = getLsAdmissionStatus(proxy);
  return {
    ...base,
    // K8: lifetime spend (monotonic; independent of the rolling stats window).
    // `?? 0`-guarded so an account loaded from a pre-K8 accounts.json reads zero.
    totalSpend: a._totalSpend
      ? {
          requests: a._totalSpend.requests || 0,
          totalTokens: a._totalSpend.totalTokens || 0,
          promptTokens: a._totalSpend.promptTokens || 0,
          completionTokens: a._totalSpend.completionTokens || 0,
          creditCost: a._totalSpend.creditCost || 0,
          acuCost: a._totalSpend.acuCost || 0,
        }
      : { requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, creditCost: 0, acuCost: 0 },
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

export const ACCOUNT_SORT_VALUES = Object.freeze(['quota_weekly', 'balance', 'last_used', 'errors']);

// Shared predicate: getAccountList() slices the result and getAccountsPayload()
// counts it, so `total` and the rows can never disagree (D10 — flagged+tier used
// to count byTier[tier] while rows honoured both).
function accountMatchesQuery(a, { filter = '', tier = '', q = '', status = '', now = Date.now() }) {
  if (filter === 'flagged') {
    // "Needs attention" is one predicate, shared with the KPI strip: every
    // state except 正常 and 手动停用. It used to be a hand-written OR that
    // missed quota-cooled/capacity/near-limit accounts while the KPI counted a
    // different set — the two numbers then disagreed on the same page.
    const state = resolveAccountState(a, now);
    if (state === 'active' || state === 'disabled') return false;
  }
  if (tier && tierBucket(a.tier) !== tier) return false;
  if (status && resolveAccountState(a, now) !== status) return false;
  if (q) {
    const needle = String(q).toLowerCase();
    const hay = `${a.email || ''}\n${a.id || ''}\n${a.label || ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function sortAccountList(list, sort, order) {
  if (!ACCOUNT_SORT_VALUES.includes(sort)) return list;
  const dir = order === 'asc' ? 1 : -1;
  const valueOf = (a) => {
    switch (sort) {
      case 'quota_weekly': return typeof a.credits?.weeklyPercent === 'number' ? a.credits.weeklyPercent : null;
      case 'balance': return typeof a.credits?.balance === 'number' ? a.credits.balance : null;
      case 'last_used': return a.lastUsed || 0;
      case 'errors': return a.errorCount || 0;
      default: return null;
    }
  };
  return [...list].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    // Nulls sort last in both directions: an account that never reported a
    // weekly quota is not "the lowest quota", it is unknown.
    if (av == null && bv == null) return a.id < b.id ? -1 : 1;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return a.id < b.id ? -1 : 1;
    return (av - bv) * dir;
  });
}

export function getAccountList({ view = 'full', offset = 0, limit = Infinity, filter = '', tier = '', q = '', status = '', sort = '', order = '' } = {}) {
  const now = Date.now();
  let list = accounts.filter((a) => accountMatchesQuery(a, { filter, tier, q, status, now }));
  list = sortAccountList(list, sort, order);
  const start = Math.max(0, Number.isFinite(offset) ? offset : 0);
  const end = Number.isFinite(limit) ? start + Math.max(0, limit) : undefined;
  return list.slice(start, end).map(a => publicAccount(a, now, { view }));
}

// Count with the exact predicate getAccountList() applies, for pagination.
export function countAccountList({ filter = '', tier = '', q = '', status = '' } = {}) {
  const now = Date.now();
  return accounts.filter((a) => accountMatchesQuery(a, { filter, tier, q, status, now })).length;
}

export function getAccountPublic(id, { view = 'full' } = {}) {
  const account = accounts.find(a => a.id === id);
  return account ? publicAccount(account, Date.now(), { view }) : null;
}

export function getAccountListStats() {
  const now = Date.now();
  let rateLimited = 0;
  let banned = 0;
  let reauth = 0;
  const byTier = { pro: 0, free: 0, unknown: 0, expired: 0 };
  // One bucket per resolveAccountState() value. The KPI strip is a PARTITION
  // over these (正常 / 已停用 / 需处理), not a pile of overlapping predicates:
  // 3.9.53 counted banned/reauth/error accounts as "停用" AND again as
  // "需关注", so the six cells looked additive and were not.
  const stateCounts = Object.fromEntries(ACCOUNT_STATE_VALUES.map((state) => [state, 0]));
  // Billing owner → the one balance that owner reports. Teams share a single
  // on-demand balance across every member; summing per account multiplied it.
  const balanceByOwner = new Map();
  let balanceAccounts = 0;
  for (const account of accounts) {
    const isRateLimited = !!(account.rateLimitedUntil && account.rateLimitedUntil > now);
    if (isRateLimited) rateLimited++;
    if (account.status === 'banned') banned++;
    if (account.status === 'reauth') reauth++;
    stateCounts[resolveAccountState(account, now)]++;
    byTier[tierBucket(account.tier)]++;
    // On-demand prepaid balance ($) — only Teams/paid accounts carry it.
    const bal = account?.credits?.balance;
    // Negative values are "no billing snapshot" sentinels; uint64 -1 decodes to
    // ~1.8e13 USD. Only a plausible on-demand balance counts toward the pool.
    if (typeof bal === 'number' && Number.isFinite(bal) && bal >= 0 && bal <= 1_000_000) {
      balanceAccounts++;
      // Identity comes from the ACU org reader when it has run, else the
      // GetUserStatus team id, else the account itself (org-identity.js).
      // Two members of one team collapse to one entry; the freshest snapshot
      // wins so a stale sibling can't overwrite a newer read.
      const owner = balanceGroupOf(account);
      const at = Number(account?.credits?.fetchedAt || 0);
      const prev = balanceByOwner.get(owner.key);
      if (!prev || at > prev.at || (at === prev.at && String(account.id) < prev.id)) {
        balanceByOwner.set(owner.key, { balance: bal, at, id: String(account.id) });
      }
    }
  }
  let balanceTotal = 0;
  for (const entry of balanceByOwner.values()) balanceTotal += entry.balance;
  const total = accounts.length;
  // 需处理 = every state except 正常 and 手动停用. The same predicate as
  // `filter=flagged`, so the KPI and the "仅异常" filter cannot disagree.
  const attention = total - stateCounts.active - stateCounts.disabled;
  return {
    ...getAccountCount(),
    stateCounts,
    attention,
    flagged: attention,
    rateLimited,
    // 已停用 means the operator disabled it — nothing else.
    disabled: stateCounts.disabled,
    banned,
    reauth,
    byTier,
    balanceTotal,
    balanceAccounts,
    balanceOwners: balanceByOwner.size,
    balanceSharedAccounts: balanceAccounts - balanceByOwner.size,
  };
}

export function getAccountInternal(id) {
  return accounts.find(a => a.id === id) || null;
}

/**
 * Run one upstream web search on a named account.
 *
 * The upstream call (windsurf-api.js getWebSearchResults, the RPC
 * GetWebSearchResults) has existed and been tested since it was reverse-
 * engineered, but nothing ever called it — this is the exposure. It costs no
 * model credits: it rides the account's own session token, so the only budget it
 * touches is whatever rate limit the upstream applies to search itself.
 *
 * The ACCOUNT IS NAMED BY THE CALLER rather than picked here, matching
 * refreshCredits below. Silent selection would make an unexplained rate-limit or
 * ban land on an account the operator did not choose, and the dashboard already
 * knows which account it is asking about.
 *
 * Errors come back in-band ({ok:false}) like every other dashboard-facing helper,
 * so a failed search renders as a message instead of a 500.
 */
export async function searchWebForAccount(id, { query, limit, domain } = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { ok: false, error: 'query required' };
  const account = accounts.find(a => a.id === id);
  if (!account) return { ok: false, error: 'Account not found' };
  // An error'd/disabled account's token is the likeliest to be dead; refusing here
  // gives a clear reason instead of an opaque upstream failure.
  if (account.status !== 'active') return { ok: false, error: `Account is ${account.status}` };
  try {
    const getWebSearchResults = _webSearchDeps?.getWebSearchResults
      || (await import('./windsurf-api.js')).getWebSearchResults;
    const proxy = getEffectiveProxy(account.id) || null;
    const results = await getWebSearchResults(account.apiKey, { query: q, limit, domain }, proxy);
    return { ok: true, ...results };
  } catch (e) {
    // safeAccountRef, never the raw key: this string reaches the dashboard and the log.
    log.warn(`Web search failed for ${safeAccountRef(account)}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Bounded credit-snapshot ledger, per account.
 *
 * The chat wire carries no per-turn billing tag (#239), so the only honest
 * "recent debit" the proxy can show is the delta between two credit refreshes:
 * prepaid balance, prompt/flex credits, and the daily/weekly remaining
 * percentages. Entries are written by `refreshCredits` (manual + the 15-minute
 * loop) and persisted in accounts.json so an operator restart does not erase
 * the last hour of history.
 *
 * Cap CREDIT_LEDGER_CAP per account, pruned at write time. An entry is only
 * recorded when a value actually changed — a refresh that learned nothing new
 * must not push a zero-delta row that later reads as "no spend".
 */

/** Raw credit snapshots for one account, oldest first. Empty when unknown. */
export function getCreditLedger(id) {
  const account = accounts.find(a => a.id === id);
  if (!account || !Array.isArray(account._creditHistory)) return [];
  return account._creditHistory
    .filter((row) => row && typeof row === 'object' && typeof row.ts === 'number')
    .slice(-CREDIT_LEDGER_CAP);
}

/** Test seam: drop every account's credit history without touching the file. */
export function __resetCreditLedgerForTest() {
  for (const account of accounts) delete account._creditHistory;
}

/**
 * Fetch live credit balance + plan info from server.codeium.com and stash it
 * on the account. Used by manual refresh and by the 15-minute background loop.
 * Errors are returned in-band so the dashboard can show them without throwing.
 */
const _creditInFlight = new Map();

function creditSnapshotOf(credits) {
  const c = credits && typeof credits === 'object' ? credits : {};
  const pick = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const prompt = c.prompt && typeof c.prompt === 'object' ? c.prompt : {};
  const flex = c.flex && typeof c.flex === 'object' ? c.flex : {};
  return {
    ts: Date.now(),
    balance: pick(c.balance),
    overageBalance: pick(c.overageBalance),
    promptRemaining: pick(prompt.remaining),
    promptUsed: pick(prompt.used),
    flexRemaining: pick(flex.remaining),
    flexUsed: pick(flex.used),
    dailyPercent: pick(c.dailyPercent),
    weeklyPercent: pick(c.weeklyPercent),
  };
}

const CREDIT_SNAPSHOT_FIELDS = [
  'balance', 'overageBalance', 'promptRemaining', 'promptUsed',
  'flexRemaining', 'flexUsed', 'dailyPercent', 'weeklyPercent',
];

function sameCreditSnapshot(a, b) {
  if (!a || !b) return false;
  return CREDIT_SNAPSHOT_FIELDS.every((field) => a[field] === b[field]);
}

/** Record one observed credit snapshot. Never throws, never logs the snapshot. */
export function recordCreditSnapshot(account, credits = null) {
  if (!account || typeof account !== 'object') return null;
  const snapshot = creditSnapshotOf(credits ?? account.credits);
  const history = Array.isArray(account._creditHistory) ? account._creditHistory : [];
  const last = history.length ? history[history.length - 1] : null;
  if (sameCreditSnapshot(last, snapshot)) return last;
  history.push(snapshot);
  if (history.length > 24) history.splice(0, history.length - 24);
  account._creditHistory = history;
  if (typeof markDirty === 'function') markDirty();
  return snapshot;
}


/**
 * Tier implied by the billing plan name from refreshCredits' GetUserStatus call.
 *
 * 'pro' for the paid plans and trials (Windsurf returns "INDIVIDUAL" / "TRIAL" /
 * "PREMIUM" for paid-tier trials too — issue #8: motto1's 14-day Pro trial was
 * misclassified as free because the check only knew the literal "Pro"), 'free' only
 * for an explicit free plan, and null when the upstream named nothing usable.
 *
 * Null is deliberate and load-bearing: an unnamed plan is NOT evidence of a free
 * plan, and treating it as one is what let the canary fallback demote a paid account.
 *
 * Declared BEFORE refreshCredits on purpose: the ban-signal source contract slices
 * that function up to the next top-level export, and an export placed between it and
 * _refreshCreditsImpl would hide the catch block from the guard.
 */
export function tierFromPlanName(planName) {
  const pn = String(planName || '');
  if (/pro|teams|enterprise|trial|individual|premium|paid/i.test(pn)) return 'pro';
  if (/free/i.test(pn)) return 'free';
  return null;
}

export async function refreshCredits(id) {
  const existing = _creditInFlight.get(id);
  if (existing) return existing;

  const account = accounts.find(a => a.id === id);
  if (!account) return { ok: false, error: 'Account not found' };

  const promise = _refreshCreditsImpl(account).finally(() => {
    if (_creditInFlight.get(id) === promise) _creditInFlight.delete(id);
  });
  _creditInFlight.set(id, promise);
  return promise;
}

async function _refreshCreditsImpl(account) {
  const id = account.id;
  const apiKey = account.apiKey;
  try {
    const { getUserStatus } = await import('./windsurf-api.js');
    const proxy = getEffectiveProxy(account.id) || null;
    const status = await getUserStatus(apiKey, proxy);
    // Drop the huge raw payload before persisting — keep it only in memory for
    // downstream callers (e.g. model catalog cache) to inspect once.
    const { raw, ...persist } = status;
    // Publish once after both reads settle. Readers keep the last complete
    // snapshot while the billing RPC is in flight; no half-updated object leaks.
    delete persist.rateTable;
    delete persist.rateTableFetchedAt;
    // B: on-demand balance + billing period. The REST getUserStatus `raw` is a
    // PARSED JSON object, not protobuf bytes — feeding it to decodeUserStatusFull
    // (a byte parser) always returned empty, so the on-demand balance never
    // surfaced. Decode balance from the protobuf GetUserStatus instead, whose
    // bytes carry it at the calibrated field #1.13.16 (paid-verified 2026-07-06).
    // fetchUserStatus is a FREE read-only RPC (no chat / no billing fire).
    try {
      const { fetchUserStatus } = await import('./devin-connect-catalog.js');
      // withCatalog pairs the per-model credit rate table (#1.13.1.21) to catalog
      // selectors, turning a bare float array into { selector → creditFloat }. The
      // decoder has produced this since 2026-07; it had zero consumers because this
      // call omitted the catalog, so `rate === 0` — the only authoritative answer to
      // "which models are free RIGHT NOW" — was never available. GLM-5.2's free
      // status is a rolling promotion while MODELS hardcodes credit: 1.5, which is
      // why users burned paid quota on a model the app showed as free (#235).
      const billing = await fetchUserStatus({ token: apiKey, withCatalog: true });
      if (billing) {
        if (billing.balance != null) persist.balance = billing.balance;
        else delete persist.balance; // never keep a stale sentinel value
        if (billing.periodStart) persist.periodStart = billing.periodStart;
        if (billing.periodEnd) persist.periodEnd = billing.periodEnd;
        // Only a PAIRED rate table (selector-keyed object) is usable. An unpaired
        // array means the catalog fetch failed, and positional floats without their
        // selectors cannot be attributed to a model.
        //
        // DISCIPLINE: a missing or unpaired field must never widen the free list.
        // The rate table lives in a plan sub-message that free accounts may not send
        // at all, so "no data" has to mean "keep the conservative whitelist", not
        // "everything is free" — the latter bills the user's paid quota, which is the
        // amplified version of the #235 trap. Absence therefore clears our cached
        // view rather than producing an empty-and-therefore-permissive one.
        const paired = billing.rateTable && !Array.isArray(billing.rateTable)
          ? billing.rateTable
          : null;
        if (paired && Object.keys(paired).length > 0) {
          persist.rateTable = paired;
          persist.rateTableFetchedAt = Date.now();
        } else {
          delete persist.rateTable;
          delete persist.rateTableFetchedAt;
        }
      }
    } catch (billingErr) {
      log.warn(`refreshCredits ${id}: billing decode failed: ${billingErr.message}`);
    }
    // RB2/B2+B3+B6: react to the fresh balance snapshot. A dry account is
    // pre-cooled on its own quotaResetAt dimension (so getApiKey stops handing
    // it out to eat 402s) and a recovered account is uncooled immediately. This
    // rides the existing 15-min refreshAllCredits timer (B3) — no new timer.
    // Self-healing and NEVER permanent (see applyQuotaSnapshot).
    // A re-login/removal can change the account while either RPC is pending.
    // Never publish an old credential's snapshot onto the new account lifetime.
    if (!accounts.includes(account) || account.apiKey !== apiKey) {
      return { ok: false, error: 'Account changed during credit refresh' };
    }
    account.credits = persist;
    // Ledger: one row per observable change (see recordCreditSnapshot). Written
    // before saveAccounts() below so the history and the snapshot persist together.
    recordCreditSnapshot(account, persist);
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
      //
      // Record the plan-derived tier as a FLOOR as well as the current tier:
      // inferTier (the canary fallback) must never demote below it. Measured, one
      // gemini-2.5-flash canary success flipped a Pro account to 'free', after
      // which isConnectSelectorAllowedForAccount blocked every swe-2 selector —
      // the only ones the account could actually run. A null plan name (upstream
      // stayed silent) leaves the previous floor in place: unknown ≠ free.
      const planTier = tierFromPlanName(pn);
      if (planTier) account.planTier = planTier;
      if (planTier === 'pro') {
        if (account.tier !== 'pro') account.tier = 'pro';
      } else if (planTier === 'free') {
        if (account.tier === 'unknown') account.tier = 'free';
      }
    }
    saveAccounts();
    // Surface the raw response once so the caller can decide whether to mine
    // the bundled model catalog from it.
    return { ok: true, credits: persist, raw };
  } catch (e) {
    if (!accounts.includes(account) || account.apiKey !== apiKey) {
      return { ok: false, error: 'Account changed during credit refresh' };
    }
    const msg = e.message || String(e);
    log.warn(`refreshCredits ${id} failed: ${msg}`);
    // Stash the error on the account so the dashboard can show "last refresh
    // failed" without losing the previously successful snapshot.
    if (account.credits) account.credits.lastError = msg;
    else account.credits = { lastError: msg, fetchedAt: Date.now() };
    // A ban-shaped failure here is the CLEAREST signal the pool ever gets, and it was
    // being discarded into lastError.
    //
    // Measured on a real account: GetUserStatus returned 403 permission_denied "Your
    // subscription has been canceled. Resubscribe to continue.", while the catalog RPC
    // (which does not check entitlement) still returned 167 selectors and chat failed
    // with a GENERIC upstream "an internal error occurred". Because chat's failure is
    // classified UPSTREAM_INTERNAL — deliberately not charged to the account, so one
    // upstream wobble can't disable the pool — the account sat at status='active',
    // errorCount=0, advertising 163 models, and failed 100% of chat requests forever.
    // Nothing connected the one RPC that knew why to the account's state.
    //
    // looksLikeBanSignal already discriminates correctly here (verified against the real
    // message: true, while 'an internal error occurred' and 'CAPACITY' are false), and
    // reportBanSignal already requires two hits in 30 min before disabling. Since
    // refreshAllCredits runs every 15 minutes, a genuinely cancelled subscription trips
    // twice within the window on consecutive rounds while a deploy-time blip does not.
    // So this is a wiring gap, not a missing mechanism — no new state, no new pattern.
    if (looksLikeBanSignal(msg)) {
      reportBanSignal(account.apiKey, msg);
    }
    return { ok: false, error: msg };
  }
}

// ─── Periodic billing sync (cost tier / promo / rate) ──────────────────────
//
// The cost tier + promo + credit rate all ride GetCascadeModelConfigs, and that
// RPC used to run exactly ONCE per API key: `_modelCatalogSyncedKeys` latches the
// key after the first accepted catalog, and there is no other periodic catalog
// refresh. So a promotion that STARTED after an account's first sync was invisible
// forever (its END date still expired locally, which is why the failure looked
// like "free models randomly disappear" instead of "sync stopped"). This refreshes
// only the billing half on its own cadence; it never touches the UID filter
// snapshot, so a transient shrunken catalog cannot re-advertise or hide models.
const _billingSyncAt = new Map(); // account id → last successful billing snapshot (ms)
const _billingSyncPromises = new Map(); // account id → in-flight promise

/** Billing refresh cadence. 0 disables the periodic sync entirely. */
export function billingSyncIntervalMs(env = process.env) {
  const raw = Number(env.BILLING_SYNC_INTERVAL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 30 * 60 * 1000;
}

/**
 * Refresh one account's cost tier / promo / rate from GetCascadeModelConfigs.
 *
 * Read-only RPC (the same one the catalog sync uses), no chat, no billing fire.
 * The response goes through mergeCloudCostTiers, which owns the replace rules and
 * the freshness stamp; this function owns only the transport and the cadence.
 */
export async function refreshAccountBilling(id, { force = false, now = Date.now() } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account || account.status !== 'active') return { ok: false, error: 'account_not_active' };
  if (_billingSyncPromises.has(id)) return _billingSyncPromises.get(id);
  const interval = billingSyncIntervalMs();
  if (!force && interval > 0) {
    const last = _billingSyncAt.get(id) || 0;
    if (now - last < interval) return { ok: true, skipped: true, reason: 'fresh' };
  }
  // V-26: capture the credential epoch before the first await. The cost tier,
  // promo and per-model rate below are plan facts of the credential that
  // answered, so a re-login mid-flight must not publish them onto the new one.
  const tokenAtStart = account.apiKey;
  const promise = (async () => {
    try {
      const { getCascadeModelConfigs } = _modelCatalogDeps?.getCascadeModelConfigs
        ? { getCascadeModelConfigs: _modelCatalogDeps.getCascadeModelConfigs }
        : await import('./windsurf-api.js');
      const proxy = getEffectiveProxy(account.id) || null;
      const result = await getCascadeModelConfigs(tokenAtStart, proxy);
      // Same identity + key pair the credit path and the liveness probes use.
      if (!isCurrentAccount(account) || account.apiKey !== tokenAtStart) {
        return { ok: false, error: 'ACCOUNT_CHANGED' };
      }
      const merged = mergeCloudCostTiers(result?.configs, { accountId: account.id, now });
      if (merged.applied) _billingSyncAt.set(id, now);
      return { ok: true, ...merged };
    } catch (e) {
      // Leave _billingSyncAt alone: the next round retries instead of waiting a
      // full interval for a failure that lasted one second.
      log.warn(`Billing sync ${safeAccountRef(account)} failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  })().finally(() => {
    if (_billingSyncPromises.get(id) === promise) _billingSyncPromises.delete(id);
  });
  _billingSyncPromises.set(id, promise);
  return promise;
}

/** Refresh every active account's billing snapshot (fire-and-forget friendly). */
export async function refreshAllBilling({ force = false, now = Date.now() } = {}) {
  const results = [];
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    const r = await refreshAccountBilling(account.id, { force, now });
    results.push({ id: account.id, ...r });
  }
  return results;
}

/**
 * Arm the periodic billing refresh. Returns the interval handle, or null when the
 * cadence is disabled (BILLING_SYNC_INTERVAL_MS=0).
 *
 * Split out of initAuth so the "0 disables it" contract is testable without
 * booting a server: the property that matters is that NOTHING is scheduled, and a
 * test seam for setInterval is the only way to assert an absence.
 */
export function armBillingSyncTimer({
  setIntervalImpl = setInterval,
  intervalMs = billingSyncIntervalMs(),
  refresh = refreshAllBilling,
} = {}) {
  if (!(intervalMs > 0)) return null;
  refresh().catch(e => log.warn(`Initial billing sync: ${e.message}`));
  return setIntervalImpl(() => {
    refresh().catch(e => log.warn(`Scheduled billing sync: ${e.message}`));
  }, intervalMs);
}

/** Test seam: forget the per-account cadence stamps. */
export function __resetBillingSyncState() {
  _billingSyncAt.clear();
  _billingSyncPromises.clear();
}

/** Billing-sync health for the dashboard (freshness + row counts). */
export function getBillingSyncSummary(now = Date.now()) {
  const state = getCloudBillingSyncState(now);
  const fresh = billingFreshness(now);
  return {
    ...state,
    fetchedAt: fresh.fetchedAt,
    stale: fresh.stale,
    intervalMs: billingSyncIntervalMs(),
  };
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
    account.tier = inferTier(account.capabilities, { floorTier: account.planTier });
  }
  saveAccounts();
}

/**
 * Infer subscription tier from which canary models work. Fallback only —
 * probeAccount prefers GetUserStatus which returns the authoritative tier.
 *
 * Two conservative rules, both from live evidence:
 *
 *  1. NEVER demote below the billing plan. `refreshCredits` learns the plan from
 *     GetUserStatus's planName ("Pro" → tier 'pro') but does not set
 *     userStatusLastFetched, so this fallback used to run on every capability
 *     update. Measured: a Pro account whose only working selector was
 *     `swe-2-medium` flipped to 'free' the moment a `gemini-2.5-flash` canary
 *     succeeded — and `isConnectSelectorAllowedForAccount` then blocked every
 *     swe-2 selector, i.e. the canary removed the account's only working route.
 *     A plan name is positive evidence; a non-premium model succeeding is not
 *     evidence of a downgrade.
 *  2. Unknown is not free. All canaries failing is NOT expiry: on a daily-dry
 *     account every paid canary fails with QUOTA_EXHAUSTED while the account is
 *     perfectly healthy. The old `every(ok === false) → 'expired'` arm benched
 *     exactly that account. Expiry is only ever set from the authoritative
 *     GetUserStatus tierName.
 */
function inferTier(caps, { floorTier = null } = {}) {
  const works = (m) => caps?.[m]?.ok === true;
  if (works('claude-opus-4.6') || works('claude-sonnet-4.6')) return 'pro';
  if (floorTier === 'pro') return 'pro'; // positive plan evidence outranks a canary
  if (works('gemini-2.5-flash') || works('gpt-4o-mini')) return 'free';
  return 'unknown';
}

/**
 * Fetch authoritative user status from the LS → account fields.
 * Returns the parsed UserStatus object on success, null on failure.
 */
export async function fetchUserStatus(id, { allowLsStart = true } = {}) {
  const account = accounts.find(a => a.id === id);
  if (!account) return null;
  // V-26: a snapshot describes ONE credential at ONE point in time. Capture the
  // epoch before the first await; the guard after the RPC compares against it.
  const tokenAtStart = account.apiKey;

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

  // The RPC is sent with the credential captured at entry, so the response and
  // the epoch we validate against describe the same credential.
  const client = new WindsurfClient(tokenAtStart, ls.port, ls.csrfToken);
  let status;
  try {
    status = await client.getUserStatus();
  } catch (err) {
    log.warn(`GetUserStatus ${safeAccountRef(account)} failed: ${err.message}`);
    return null;
  }

  // V-26: revalidate after the await. A re-login installs a new apiKey on this
  // same row (setAccountTokens / reLoginAccount) and the row itself can be
  // removed/re-added; publishing the OLD credential's tier, entitlement
  // allowlist and capabilities onto the NEW lifetime would route models the new
  // credential does not own. Same identity + key pair the guarded credit path
  // and the liveness probes use — no second epoch vocabulary.
  if (!isCurrentAccount(account) || account.apiKey !== tokenAtStart) {
    log.info(`UserStatus ${safeAccountRef(account)} discarded: account/credential changed during the probe`);
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
    email: status.email == null ? status.email : sanitizeLabelText(status.email),
    displayName: status.displayName == null ? status.displayName : sanitizeLabelText(status.displayName),
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
  const statusEmail = status.email ? sanitizeLabelText(status.email) : '';
  if (statusEmail && !account.email.includes('@')) account.email = statusEmail;

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
        // The refreshed allowlist is authoritative for enum-keyed models: an
        // enum it no longer lists is not entitled NOW, even if a call succeeded
        // under an older plan. Preserving the old `success` let a Pro/trial
        // success outlive a downgrade or trial expiry, so a free account kept
        // listing and routing a premium model the upstream had stopped
        // entitling (wave-7 P2). A call that succeeds AFTER this snapshot
        // re-establishes `success` through updateCapability().
        account.capabilities[key] = { ok: false, lastCheck: Date.now(), reason: 'not_entitled' };
      }
    }
  }

  if (prevTier !== account.tier) {
    log.info(`Tier change ${safeAccountRef(account)}: ${prevTier} → ${account.tier} (plan="${status.planName}", ${status.allowedModels.length} allowed models)`);
  } else {
    log.info(`UserStatus ${safeAccountRef(account)}: tier=${account.tier} plan="${status.planName}" allowed=${status.allowedModels.length}`);
  }
  // #245: `tier` above is the tier AFTER mapTeamsTier ran, so a teams account
  // whose TeamsTier decoded as UNSPECIFIED(0) is indistinguishable in the log
  // from a genuine free account — the exact ambiguity the maintainer asked this
  // line to resolve. Report the raw enum the mapping consumed and the tier it
  // produced (parseGetUserStatusResponse sets tierName = mapTeamsTier(teamsTier)).
  // Gated on the response carrying teams evidence: the PlanInfo flags cover a
  // teams plan whose enum is 0, while a plain free response (no flags, enum 0 by
  // protobuf default) would otherwise print teams_tier=0 and read as the very
  // failure this line exists to diagnose.
  if (status.isTeams || status.isEnterprise || status.teamsTier > 0) {
    log.info(`UserStatus ${safeAccountRef(account)}: teams_tier=${status.teamsTier} mapped=${status.tierName} plan="${status.planName}"`);
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
    const allModels = filterModelKeysByCloudCatalog(
      Object.keys(MODELS),
      process.env,
      account.id,
    );
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
    banned: accounts.filter(a => a.status === 'banned').length,
    reauth: accounts.filter(a => a.status === 'reauth').length,
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
  // M1 (Grok audit): no API_KEY configured used to fail OPEN on a local bind —
  // but "local bind" is not "no proxy": behind a same-host reverse proxy
  // (openresty → 127.0.0.1) the bind is local for everyone, so this silently
  // ran the whole gateway unauthenticated. Now fail CLOSED by default; running
  // with no key is an explicit opt-in (WINDSURFAPI_ALLOW_UNAUTHENTICATED=1) for
  // genuine local/dev use — and even then only on a local bind (never expose an
  // unauthenticated gateway on a public bind). The Windows exe auto-generates an
  // API_KEY on first run, so it never reaches this path.
  if (!effectiveKey) {
    return process.env.WINDSURFAPI_ALLOW_UNAUTHENTICATED === '1' && isLocalBindHost(_bindHost);
  }
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
    // M3 (Grok audit): the same misconfig (loopback bind, XFF trust off) is what
    // makes a same-host reverse proxy present every remote client as 127.0.0.1.
    // If the apiKey-as-dashboard-password convenience is ALSO opted in, that
    // means a remote client holding the shared chat key could open the panel.
    // Warn explicitly so the two risks aren't conflated with the generic notice.
    if (process.env.DASHBOARD_ALLOW_API_KEY_AS_PASSWORD === '1') {
      log.warn('AUTH: DASHBOARD_ALLOW_API_KEY_AS_PASSWORD=1 with XFF trust OFF behind a proxy — a remote client presenting the chat API key could pass as a local operator and open the dashboard. Set a real DASHBOARD_PASSWORD, or enable TRUST_PROXY_X_FORWARDED_FOR=1 so the local-client check is trustworthy.');
    }
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
    const tokenAtStart = a.apiKey;
    try {
      const proxy = getEffectiveProxy(a.id) || null;
      const { idToken, refreshToken: newRefresh } = await refreshFirebaseToken(a.refreshToken, proxy);
      // The refresh RPC is an await: revalidate identity, operator intent and
      // the credential epoch before committing either half of the token pair.
      if (!isCurrentAccount(a) || a.status !== 'active' || a.apiKey !== tokenAtStart) {
        log.debug(`Firebase refresh ${a.id} result discarded: account changed during refresh`);
        continue;
      }
      a.refreshToken = newRefresh;
      // Re-register to get a fresh API key (may be the same key)
      const { apiKey } = await reRegisterWithCodeium(idToken, proxy);
      if (!isCurrentAccount(a) || a.status !== 'active' || a.apiKey !== tokenAtStart) {
        log.debug(`Firebase refresh ${a.id} key discarded: account changed during re-register`);
        continue;
      }
      if (apiKey && apiKey !== a.apiKey) {
        log.info(`Firebase refresh: ${safeAccountRef(a)} got new API key`);
        const previousKey = a.apiKey;
        a.apiKey = apiKey;
        markKeyRotation(a, previousKey);
        invalidateModelCatalogForAccount(a.id);
        trySyncModelCatalog();
      }
      a._refreshFailStreak = 0;
      saveAccounts();
    } catch (e) {
      // A failure that happened after the operator parked the row must not
      // accumulate a fail streak or downgrade anything — the row is terminal.
      if (!isCurrentAccount(a) || a.status !== 'active') {
        log.debug(`Firebase refresh ${a.id} failure ignored: account changed during refresh`);
        continue;
      }
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
        trySyncModelCatalog();
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

  // K7: periodically persist lazy self-healing state (health window / cooldown
  // deadlines) that hot paths mutate without a synchronous save. Replaces the
  // shutdown flush so an external accounts.json write is no longer clobbered on
  // stop, and a hard kill loses at most one interval of best-effort state.
  startDirtyFlush();

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
        addAccountByPastedSecret(token).catch(err => log.error(`Token auth failed: ${err.message}`))
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

  // Periodic billing sync (cost tier / promo / credit rate) from
  // GetCascadeModelConfigs. Separate from the catalog latch above: that one runs
  // once per API key, so without this a promotion starting after the first sync
  // was never seen. Cadence is its own knob so an operator can slow it down (or
  // disable it with 0) without touching credit refresh.
  armBillingSyncTimer()?.unref?.();

  // Fetch live model catalog from cloud and merge into hardcoded catalog.
  // Fire-and-forget — the hardcoded catalog is sufficient until this completes.
  // trySyncModelCatalog also fires whenever an account becomes active.
  trySyncModelCatalog();
  const CONNECT_CATALOG_REFRESH_INTERVAL = connectCatalogPollMs();
  setInterval(() => {
    trySyncConnectCatalogs();
  }, CONNECT_CATALOG_REFRESH_INTERVAL).unref?.();

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
        // Operator-parked rows are terminal: never spend an upstream probe on
        // them, and never let a probe verdict revive one. Re-checked inside
        // probeAndRecoverConnectAccount for the status change during the await.
        if (isOperatorTerminalStatus(a.status)) continue;
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
