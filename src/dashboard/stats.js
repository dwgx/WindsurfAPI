/**
 * Request statistics collector with debounced JSON persistence.
 */

import { readFileSync, existsSync } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../fs-atomic.js';
import { join } from 'path';
import { config } from '../config.js';
import { getModelInfo, getCloudSelectorPricing, resolveModel } from '../models.js';
import { resolveConnectSelector } from '../devin-connect-models.js';
import { accountRef } from '../log-safety.js';
import { REPORTED_USAGE, tokenCount } from '../reported-usage.js';

const STATS_FILE = join(config.dataDir, 'stats.json');

// v2.0.9x — cardinality bound for per-model stats. modelCounts is keyed by
// the client-controlled model string; without a cap, case-permuted names or
// free-tier passthrough names grow RAM + stats.json + the per-poll sort
// unbounded. Cap the number of *real* model keys (LRU-evict the
// least-recently-updated one into a shared '(other)' bucket so totals still
// reconcile). Secure default is bounded; set STATS_MAX_MODELS=0 to opt back
// into the old unbounded behavior.
const OTHER_MODEL_KEY = '(other)';
const MAX_MODELS = (() => {
  const raw = parseInt(process.env.STATS_MAX_MODELS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
})();

// Monotonic recency counter for LRU eviction. Wall-clock time ties within a
// single millisecond (many requests can land there), which would make
// eviction fall back to insertion order and starve hot-but-old keys; a
// strictly-increasing seq gives an unambiguous least-recently-updated pick.
let _touchSeq = 0;

// audit S8: cache of the current-hour hourlyBuckets entry so recordRequest
// avoids an O(n) .find per request. Reset (null) means "re-resolve on next
// record" — safe after restart or hour rollover.
let _curBucket = null;

// Every caller-keyed map is stored on a null prototype so a model literally
// named "__proto__" is an ordinary own key instead of Object.prototype. The
// public getStats()/exportStats() views convert these back to plain objects so
// JSON consumers keep the historical shape.
const MAP_KEYS = ['modelCounts', 'accountCounts', 'creditsByHour', 'creditsByDay', 'creditsByModel', 'tokensByModel'];
const UNSAFE_MODEL_KEYS = new Set(['__proto__', 'constructor', 'toString', 'prototype']);

/** A dictionary with no inherited keys. */
function emptyMap() {
  return Object.create(null);
}

/**
 * True for model names that would collide with a prototype/function property.
 * `Object.hasOwn(Object.prototype, key)` catches the wider inherited surface
 * (`valueOf`, `hasOwnProperty`, …) while the explicit set documents the three
 * names this fix is contracted to reject.
 */
function isUnsafeModelKey(key) {
  return typeof key !== 'string' || key === '' || UNSAFE_MODEL_KEYS.has(key)
    || Object.hasOwn(Object.prototype, key);
}

/** Shallow plain-object copy of an internal null-prototype map. */
function plainMap(source) {
  return Object.fromEntries(Object.entries(source && typeof source === 'object' ? source : {}));
}

/** Ensure a state map is null-prototype; migrate a plain object in place. */
function ensureNullProtoMap(name) {
  const current = _state[name];
  if (!current || typeof current !== 'object' || Array.isArray(current)
    || Object.getPrototypeOf(current) !== null) {
    if (name === 'modelCounts') _state[name] = adoptModelCounts(current);
    else if (name === 'tokensByModel') _state[name] = adoptTokensByModel(current);
    else if (name === 'creditsByModel') _state[name] = adoptCreditsByModel(current);
    else _state[name] = adoptMap(current);
  }
  return _state[name];
}

/** Count of tracked model keys excluding the shared overflow bucket. */
function realModelKeyCount(modelCounts = _state.modelCounts) {
  let n = 0;
  for (const k of Object.keys(modelCounts)) {
    if (k !== OTHER_MODEL_KEY) n++;
  }
  return n;
}

/** Fold an evicted model's counts into the shared '(other)' bucket. */
function foldIntoOther(src, modelCounts = _state.modelCounts) {
  let dst = Object.hasOwn(modelCounts, OTHER_MODEL_KEY) ? modelCounts[OTHER_MODEL_KEY] : null;
  if (!dst) {
    dst = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [], lastTs: 0 };
    modelCounts[OTHER_MODEL_KEY] = dst;
  }
  dst.requests += src.requests || 0;
  dst.success += src.success || 0;
  dst.errors += src.errors || 0;
  dst.totalMs += src.totalMs || 0;
  if (!dst.recentMs) dst.recentMs = [];
  if (Array.isArray(src.recentMs) && src.recentMs.length) {
    for (const v of src.recentMs) dst.recentMs.push(v);
    if (dst.recentMs.length > 200) dst.recentMs = dst.recentMs.slice(-200);
  }
  dst.lastTs = modelCounts === _state.modelCounts ? ++_touchSeq : Math.max(dst.lastTs || 0, src.lastTs || 0);
}

/**
 * The modelCounts key a request belongs to, applying the cardinality cap.
 *
 * Shared by recordRequest and recordTokenUsage so the two maps cannot disagree
 * about which bucket a model landed in — a token row under a key the request
 * table never created would render as a model with tokens and zero requests.
 */
function boundedModelKey(model) {
  let key = typeof model === 'string' && model ? model : OTHER_MODEL_KEY;
  // Reject prototype-shaped names before any map lookup: "__proto__" would
  // otherwise resolve to Object.prototype, and "constructor"/"toString" to a
  // shared function object. They cannot be real model ids, so account for the
  // request in the shared overflow bucket instead.
  if (key !== OTHER_MODEL_KEY && isUnsafeModelKey(key)) key = OTHER_MODEL_KEY;
  if (key !== OTHER_MODEL_KEY && !Object.hasOwn(_state.modelCounts, key)) {
    enforceModelCap();
    if (MAX_MODELS > 0 && realModelKeyCount() >= MAX_MODELS) key = OTHER_MODEL_KEY;
  }
  return key;
}

/**
 * Ensure there is room for one more real model key, LRU-evicting the
 * least-recently-updated real model into '(other)' while over the cap.
 * No-op when MAX_MODELS is 0 (unbounded).
 */
function enforceModelCap(reserveSlot = true, modelCounts = _state.modelCounts) {
  const evicted = [];
  if (MAX_MODELS <= 0) return evicted;
  while (realModelKeyCount(modelCounts) > MAX_MODELS - (reserveSlot ? 1 : 0)) {
    let coldestKey = null;
    let coldestTs = Infinity;
    for (const [k, s] of Object.entries(modelCounts)) {
      if (k === OTHER_MODEL_KEY) continue;
      const ts = s.lastTs || 0;
      if (ts < coldestTs) { coldestTs = ts; coldestKey = k; }
    }
    if (coldestKey == null) break;
    foldIntoOther(modelCounts[coldestKey], modelCounts);
    delete modelCounts[coldestKey];
    evicted.push(coldestKey);
  }
  // Only the live state owns the live token map, and only the keys THIS call
  // evicted may be folded: a token row can legitimately exist before its request
  // row (recordTokenUsage runs first on several chat paths), so sweeping every
  // key absent from modelCounts would misfile a live model under '(other)'.
  if (modelCounts === _state.modelCounts && evicted.length) {
    pruneTokensToModelCounts(evicted, modelCounts);
  }
  return evicted;
}

/**
 * Fold the given models' token rows into '(other)'.
 *
 * Used for keys the request table actually lost (LRU eviction, or an imported
 * snapshot whose cap dropped them). The dashboard joins the two maps by key, and
 * an orphan would render a model that "moved 2M tokens" while the request table
 * says it never ran.
 */
function pruneTokensToModelCounts(keys, modelCounts = _state.modelCounts, tokens = _state.tokensByModel) {
  if (!tokens || typeof tokens !== 'object') return;
  for (const key of keys || []) {
    if (key === OTHER_MODEL_KEY) continue;
    if (Object.hasOwn(modelCounts, key)) continue;
    if (!Object.hasOwn(tokens, key)) continue;
    const dst = tokens[OTHER_MODEL_KEY] || {
      fresh_input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0, requests_with_usage: 0,
    };
    tokens[OTHER_MODEL_KEY] = dst;
    for (const field of Object.keys(dst)) dst[field] += tokens[key][field] || 0;
    delete tokens[key];
  }
}

const STATS_DEFAULTS = {
  startedAt: 0,
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  modelCounts: {},    // { "gpt-4o-mini": { requests, success, errors, totalMs } }
  accountCounts: {},  // { "acct-<8 hex>": { requests, success, errors } } — opaque ref, never a key/email
  hourlyBuckets: [],  // [{ hour: "2026-04-09T07:00:00Z", requests, errors }]
  // v2.0.69 (#118 wnfilm) — bucket-level token totals so the dashboard
  // can show fresh_input / cache_read / cache_write / output without
  // having to recompute from the per-request usage stream. Keyed by
  // bucket so summing across the proxy lifetime is just `totals[k]`.
  tokenTotals: {
    fresh_input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    total: 0,
    requests_with_usage: 0,
  },
  // v2.0.91 — track upstream rejection/cooldown events
  policyBlockedCount: 0,
  // v3.4.x — content-policy-block observability ring. The upstream content
  // policy is non-deterministic (same prompt blocks then passes), so we
  // capture a small system-prompt-only sample at block time for later A/B.
  // Bounded ring, newest last; cap via POLICY_BLOCK_RING (default 50).
  recentPolicyBlocks: [],
  rateLimitedCount: 0,
  // v2.0.148 — Credits spend dimension. creditsByHour/Day are keyed maps
  // { "<iso-hour|day>": creditsFloat } so the dashboard can chart spend over
  // time. Cost per request = MODELS[model].credit (rate card), summed here so we
  // never have to thread cost through the 10 recordRequest call sites. Only
  // successful attempts are charged; failed attempts keep their request row
  // with credit 0, so the log and this card share one number.
  creditsTotal: 0,
  creditsByHour: {},   // { "2026-07-09T01:00:00Z": 12.5 }
  creditsByDay: {},    // { "2026-07-09": 340.0 }
  creditsByModel: {},  // { "claude-opus-4-8-medium": 88.0 }
  // v3.10.x — per-model token totals. tokenTotals answers "how many tokens did
  // this deployment move"; this answers "which model moved them", which is the
  // question a bill asks. Keyed by the same bounded model key modelCounts uses,
  // so a client-permuted name cannot grow this map without bound.
  tokensByModel: {},   // { "swe-2-medium": { fresh_input, cache_read, cache_write, output, total, requests_with_usage } }
  // v2.0.148 — per-request detail ring buffer (bounded, persisted) so long runs
  // keep a rolling window of recent calls for audit/export instead of losing them.
  recentRequests: [],  // [{ ts, model, success, ms, account, credit }]  newest last, cap 500; account is an opaque acct-<hash> ref
};

function createStatsState() {
  const state = structuredClone(STATS_DEFAULTS);
  for (const key of MAP_KEYS) state[key] = emptyMap();
  return { ...state, startedAt: Date.now() };
}

const _state = createStatsState();

const RECENT_REQ_CAP = 500;

const ACCOUNT_REF_RE = /^acct-[0-9a-f]{8}$/;

/**
 * Canonical account reference for stats persistence and display.
 *
 * The request log used to key this dimension by `String(accountId).slice(0, 8)`.
 * Chat handlers passed the credential the attempt presented, and every
 * `devin-session-token$…` key starts with `devin-se`, so all connect accounts
 * collapsed into one bucket and stats.json stored a credential prefix. Callers
 * now pass the immutable account id; this boundary turns any value into an
 * opaque `acct-<8 hex>` ref (the same shape the DevIn panel uses). A value that
 * already looks like a ref passes through, so re-reading a persisted row or
 * importing an exported snapshot is idempotent.
 */
function normalizeAccountRef(value) {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value : String(value);
  if (!raw) return null;
  return ACCOUNT_REF_RE.test(raw) ? raw : accountRef(raw);
}

/** Re-key a persisted account map by normalized ref, merging old duplicates. */
function normalizeAccountCounts(map) {
  const out = emptyMap();
  const source = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  for (const [key, counts] of Object.entries(source)) {
    const ref = normalizeAccountRef(key);
    if (!ref) continue;
    const current = out[ref] || { requests: 0, success: 0, errors: 0 };
    current.requests += Number(counts?.requests) || 0;
    current.success += Number(counts?.success) || 0;
    current.errors += Number(counts?.errors) || 0;
    out[ref] = current;
  }
  return out;
}

/** Scrub the credential-derived `account` values older versions persisted. */
function normalizeRecentRequests(rows) {
  if (!Array.isArray(rows)) return [];
  for (const row of rows) {
    if (row && typeof row === 'object') row.account = normalizeAccountRef(row.account);
  }
  return rows;
}

/**
 * Copy a persisted/generic map onto a null-prototype dictionary. Only own
 * enumerable keys are read, and the three prototype-shaped names are dropped.
 * Model-keyed maps use the adopt* helpers below, which fold unsafe names into
 * the shared '(other)' bucket instead of silently losing their totals.
 */
function adoptMap(source) {
  const out = emptyMap();
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = value;
  }
  return out;
}

/** Adopt persisted model rows, folding prototype-shaped keys into '(other)'. */
function adoptModelCounts(source) {
  const out = emptyMap();
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (!isUnsafeModelKey(key)) { out[key] = value; continue; }
    if (!value || typeof value !== 'object') continue;
    const dst = out[OTHER_MODEL_KEY] || (out[OTHER_MODEL_KEY] = {
      requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [], lastTs: 0,
    });
    for (const field of ['requests', 'success', 'errors', 'totalMs']) {
      dst[field] = (Number(dst[field]) || 0) + (Number(value[field]) || 0);
    }
    if (!Array.isArray(dst.recentMs)) dst.recentMs = [];
    if (Array.isArray(value.recentMs)) {
      for (const sample of value.recentMs) {
        if (Number.isFinite(sample)) dst.recentMs.push(sample);
      }
      if (dst.recentMs.length > 200) dst.recentMs = dst.recentMs.slice(-200);
    }
    dst.lastTs = Math.max(Number(dst.lastTs) || 0, Number(value.lastTs) || 0);
  }
  return out;
}

const TOKEN_FIELDS = ['fresh_input', 'cache_read', 'cache_write', 'output', 'total', 'requests_with_usage'];

/** Adopt persisted token rows, folding prototype-shaped keys into '(other)'. */
function adoptTokensByModel(source) {
  const out = emptyMap();
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (!isUnsafeModelKey(key)) { out[key] = value; continue; }
    if (!value || typeof value !== 'object') continue;
    let dst = out[OTHER_MODEL_KEY];
    if (!dst) {
      dst = emptyMap();
      out[OTHER_MODEL_KEY] = dst;
    }
    for (const field of TOKEN_FIELDS) {
      dst[field] = (Number(dst[field]) || 0) + (Number(value[field]) || 0);
    }
  }
  return out;
}

/** Adopt persisted per-model credits, folding prototype-shaped keys into '(other)'. */
function adoptCreditsByModel(source) {
  const out = emptyMap();
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const target = isUnsafeModelKey(key) ? OTHER_MODEL_KEY : key;
    out[target] = (Object.hasOwn(out, target) ? out[target] : 0) + value;
  }
  return out;
}

// ─── Per-HTTP-request accounting scope ─────────────────────────────────
// recordRequest (the attempt row) and recordTokenUsage (the usage block) are
// called from different depths of a chat handler and, depending on the route,
// in either order. A module-level "last row" pointer would attribute tokens to
// whichever concurrent request happened to finish last, so the two calls are
// joined through the async context the HTTP server establishes per request.
// Outside such a scope (unit tests, direct handler calls) both functions keep
// their pre-existing aggregate-only behaviour and the log row gets the
// success-derived status.
const _requestScope = new AsyncLocalStorage();
const REQUEST_ID_RE = /^req_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REQUEST_DISPATCH_CAP = 8;

function requestLogModel(model) {
  return typeof model === 'string' && model.length > 0 ? model.slice(0, 160) : null;
}

function requestLogFailureCode(code) {
  return typeof code === 'string' && code !== 'error' && /^[a-zA-Z0-9_-]{1,64}$/.test(code) ? code : null;
}

export const requestLogBootId = randomUUID();
const REQUEST_BOOT_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REQUEST_SURFACES = new Set(['chat_completions', 'completions', 'responses', 'messages', 'gemini']);

function requestLogOrigin(build) {
  return {
    requestBootId: requestLogBootId,
    requestVersion: build?.version || null,
    requestCommit: build?.commit || null,
    requestBuildSource: build?.source || null,
  };
}

/** Track the Connect dispatch boundary under the public Chat request ID. */
export function beginChatRequestLog(scope, requestId, requestedModel, build) {
  const chatLog = {
    requestId, requestedModel: requestLogModel(requestedModel), dispatches: [], dispatchCount: 0,
    origin: { ...requestLogOrigin(build), requestSurface: 'chat_completions' },
  };
  scope.chatLog = chatLog;
  return (selector) => {
    chatLog.dispatchCount++;
    if (chatLog.dispatches.length < REQUEST_DISPATCH_CAP) chatLog.dispatches.push(requestLogModel(selector));
  };
}

// The HTTP account gate runs before reading the request body or handing off
// to any model transport. Keep its rejection in the same bounded history
// without recording an upstream attempt or modifying usage aggregates.
export function recordAccountAdmissionRejection({ requestId, surface, status, build }) {
  appendRecentRequest({
    statsRowId: randomUUID(),
    requestId,
    ...requestLogOrigin(build),
    requestSurface: surface,
    requestStage: 'account_admission',
    requestFailureCode: 'NO_ACTIVE_ACCOUNTS',
    requestHttpStatus: status,
    requestDispatchCount: 0,
    ts: Date.now(),
    model: '',
    status,
    success: false,
    reportedUsage: null,
  });
}

/**
 * Run `fn` inside a per-request accounting scope. Returns fn's own result.
 * Re-entrant: an existing scope is reused, so wrapping a handler twice never
 * splits one request across two scopes.
 */
export function withStatsScope(fn) {
  const existing = _requestScope.getStore();
  if (existing) return fn(existing);
  const scope = { rows: [], pendingUsage: null, status: null };
  return _requestScope.run(scope, () => fn(scope));
}

/**
 * Close a scope. The last attempt row is the one the client actually received,
 * so it gets the real HTTP status; earlier failover attempts keep the
 * success-derived 200/500 they were recorded with. Rows are the same objects
 * held in recentRequests, so this patch persists with the next scheduled save.
 */
export function finalizeStatsScope(scope) {
  if (!scope) return;
  const row = scope.rows[scope.rows.length - 1];
  if (!row) return;
  if (Number.isFinite(scope.status)) row.status = scope.status;
  if (scope.chatLog) {
    // Keep the HTTP outcome and dispatch history on the last accounting row.
    // All attempts retain their own statsRowId and point to the same HTTP root.
    row.requestHttpStatus = scope.status;
    row.requestFailureCode = requestLogFailureCode(scope.chatLog.failureCode);
    row.requestDispatches = scope.chatLog.dispatches.slice();
    row.requestDispatchCount = scope.chatLog.dispatchCount;
    scheduleSave();
  }
}

/** Non-negative finite number or 0 — rows come from persisted JSON too. */
function nonNeg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function usageTokenParts(usage, inputAlias) {
  const bd = usage?.cascade_breakdown;
  const prompt = tokenCount(usage?.prompt_tokens) ?? inputAlias;
  const cacheRead = tokenCount(bd?.cache_read_tokens) ?? tokenCount(usage?.prompt_tokens_details?.cached_tokens)
    ?? tokenCount(usage?.cache_read_input_tokens);
  const cacheWrite = tokenCount(bd?.cache_write_tokens) ?? tokenCount(usage?.cache_creation_input_tokens);
  // Connect usage carries the fresh bucket explicitly because its prompt_tokens
  // includes cache_write (O2); `prompt - cached` would count the write as fresh.
  const fresh = tokenCount(bd?.fresh_input_tokens) ?? tokenCount(usage?.fresh_input_tokens)
    ?? (prompt === undefined ? undefined : Math.max(0, prompt - (cacheRead ?? 0)));
  const output = tokenCount(bd?.output_tokens) ?? tokenCount(usage?.completion_tokens) ?? tokenCount(usage?.output_tokens);
  return { fresh, cacheRead, cacheWrite, output };
}

function reportedTokenFields(usage) {
  const tokensIn = tokenCount(usage?.tokensIn);
  const tokensOut = tokenCount(usage?.tokensOut);
  const totalTokens = tokenCount(usage?.totalTokens);
  if (tokensIn === undefined && tokensOut === undefined && totalTokens === undefined) return null;
  return {
    ...(tokensIn === undefined ? {} : { tokensIn }),
    ...(tokensOut === undefined ? {} : { tokensOut }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

/**
 * Keep display evidence separate from the numeric counters used by rollups.
 * The latter can contain estimates. A missing side, or a cache detail without
 * an input count, does not establish the full input or output usage.
 */
function usageTokenCounts(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const parts = usageTokenParts(usage);
  const raw = Object.hasOwn(usage, REPORTED_USAGE) ? usage[REPORTED_USAGE] : usage;
  // Accept the input alias for observations without changing the rollup's
  // established prompt_tokens accounting.
  const report = usageTokenParts(raw, tokenCount(raw?.input_tokens));
  const reportedUsage = reportedTokenFields({
    tokensIn: report.fresh === undefined ? undefined : report.fresh + (report.cacheRead ?? 0) + (report.cacheWrite ?? 0),
    tokensOut: report.output,
    totalTokens: raw?.total_tokens,
  });
  const { fresh = 0, cacheRead = 0, cacheWrite = 0, output: tokensOut = 0 } = parts;
  if (!reportedUsage && !fresh && !cacheRead && !cacheWrite && !tokensOut) return null;
  return { tokensIn: fresh + cacheRead + cacheWrite, tokensOut, cacheRead, cacheWrite, reportedUsage };
}

function applyUsageToRow(row, counts) {
  if (!counts || row.cacheServed) return;
  row.tokensIn = counts.tokensIn;
  row.tokensOut = counts.tokensOut;
  row.cacheRead = counts.cacheRead;
  row.cacheWrite = counts.cacheWrite;
  if (counts.reportedUsage) row.reportedUsage = counts.reportedUsage;
}

// Load persisted stats. The reviver drops prototype-shaped keys at every
// depth (JSON.parse creates an own "__proto__" property, and Object.assign
// would otherwise invoke its setter on _state). Each keyed map is then rebuilt
// on a null prototype so a legacy stats.json written by the vulnerable version
// cannot reintroduce a prototype key.
try {
  if (existsSync(STATS_FILE)) {
    const saved = JSON.parse(readFileSync(STATS_FILE, 'utf-8'), (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value);
    Object.assign(_state, saved);
    _state.modelCounts = adoptModelCounts(_state.modelCounts);
    _state.tokensByModel = adoptTokensByModel(_state.tokensByModel);
    _state.creditsByModel = adoptCreditsByModel(_state.creditsByModel);
    _state.creditsByHour = adoptMap(_state.creditsByHour);
    _state.creditsByDay = adoptMap(_state.creditsByDay);
    // Older versions persisted the credential prefix (or a raw id) as the
    // account key/value. Normalize on load so stats.json and the dashboard stop
    // displaying it without waiting for the 500-row ring to rotate.
    _state.accountCounts = normalizeAccountCounts(_state.accountCounts);
    _state.recentRequests = normalizeRecentRequests(_state.recentRequests);
    // Reseed the recency counter above any persisted lastTs so LRU ordering
    // survives a restart without an early wrap-collision.
    for (const s of Object.values(_state.modelCounts || {})) {
      if (s && s.lastTs > _touchSeq) _touchSeq = s.lastTs;
    }
  }
} catch {}

// Debounced save
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      writeJsonAtomic(STATS_FILE, _state);
    } catch {}
  }, 5000);
}

function getHourKey() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * Credit cost of one request, from live billing data when the sync knows it.
 *
 * The static rate card is a snapshot of one moment and knows nothing about
 * promotions: swe-2-medium's card says 6 credits while the upstream marks it
 * FREE until 2026-11-01. Metering the card would report spend the account never
 * incurred, and the free badge on the model row would then contradict the very
 * number next to it. Precedence: live free → 0; live credit rate → that rate;
 * nothing live → the static card (the pre-existing behaviour).
 */
function requestCreditCost(model) {
  if (!model) return 0;
  const key = resolveModel(model) || model;
  const resolution = resolveConnectSelector(key, { warnOnFallback: false });
  if (resolution?.mapped) {
    const live = getCloudSelectorPricing(resolution.selector);
    if (live.freeNow === true) return 0;
    if (typeof live.rate === 'number') return Math.max(0, live.rate);
  }
  const card = Number(getModelInfo(key)?.credit);
  return Number.isFinite(card) && card > 0 ? card : 0;
}

/**
 * Record a completed request.
 *
 * `extra` is optional and additive: `{ status, usage }`. `status` is the real
 * HTTP status when the caller knows it; otherwise the row carries the
 * success-derived 200/500. `usage` lets a caller that already holds the usage
 * block attach it directly; normally recordTokenUsage joins it via the scope.
 */
export function recordRequest(model, success, durationMs, accountId, extra = {}) {
  _state.totalRequests++;
  if (success) _state.successCount++;
  else _state.errorCount++;

  // A cache-served turn is real client traffic but ZERO upstream consumption:
  // no request reached the backend, so it must not charge the model's credit
  // card. Before this flag the Connect replay arms called recordRequest like any
  // completed turn, so every cache hit re-billed the answer it replayed. The row
  // keeps the marker so the log can tell the two apart.
  const cacheServed = extra?.cacheServed === true;

  // Per-model stats (includes a small ring buffer for p50/p95 latency).
  // Cap real-model cardinality: a brand-new key that would exceed the limit
  // gets folded into the shared '(other)' bucket instead (LRU eviction of the
  // coldest existing key). Known keys and '(other)' itself always update.
  // The map is null-prototype and every read is an own-key check, so a model
  // string can never resolve to an inherited object/function.
  const modelCounts = ensureNullProtoMap('modelCounts');
  const key = boundedModelKey(model);
  if (!Object.hasOwn(modelCounts, key)) {
    modelCounts[key] = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [], lastTs: 0 };
  }
  const mc = modelCounts[key];
  mc.requests++;
  if (success) mc.success++;
  else mc.errors++;
  mc.totalMs += durationMs;
  mc.lastTs = ++_touchSeq;
  if (!mc.recentMs) mc.recentMs = [];
  if (durationMs > 0) {
    mc.recentMs.push(durationMs);
    if (mc.recentMs.length > 200) mc.recentMs.shift();
  }

  // Per-account stats, keyed by the same opaque ref the log row carries.
  const account = normalizeAccountRef(accountId);
  if (account) {
    const accountCounts = ensureNullProtoMap('accountCounts');
    if (!Object.hasOwn(accountCounts, account)) {
      accountCounts[account] = { requests: 0, success: 0, errors: 0 };
    }
    const ac = accountCounts[account];
    ac.requests++;
    if (success) ac.success++;
    else ac.errors++;
  }

  // Hourly bucket. audit S8: the current-hour bucket is (almost) always the
  // last element, so a per-request O(n) linear .find over up to 720 buckets was
  // wasted work. Cache the current hour's bucket ref and only re-resolve when
  // the hour rolls over (or after a restart, where _curBucket starts null and
  // we fall back to the tail/find once).
  const hourKey = getHourKey();
  let bucket = _curBucket && _curBucket.hour === hourKey ? _curBucket : null;
  if (!bucket) {
    const tail = _state.hourlyBuckets[_state.hourlyBuckets.length - 1];
    bucket = tail && tail.hour === hourKey ? tail : _state.hourlyBuckets.find(b => b.hour === hourKey);
  }
  if (!bucket) {
    bucket = { hour: hourKey, requests: 0, errors: 0 };
    _state.hourlyBuckets.push(bucket);
    // Keep last 30 days of hourly data (720 buckets)
    if (_state.hourlyBuckets.length > 720) _state.hourlyBuckets.shift();
  }
  _curBucket = bucket;
  bucket.requests++;
  if (!success) bucket.errors++;

  // v2.0.148 — Credits spend + per-request detail. Cost comes from the live
  // billing sync when it knows the model (free promo → 0, catalog/rate-table
  // multiplier otherwise) and only falls back to the static rate card when the
  // upstream has said nothing. Persisted maps stay JSON-safe.
  //
  // A failed attempt is not spend: the credits card has always charged
  // successes only, while the row used to carry the model's price anyway, so
  // the log's cost column/summary over-reported by every failover, 429 and 500.
  // Store the charged amount (0 on failure); `success` is the explicit failed
  // flag, so the row and the card share one number.
  let credit = 0;
  if (success && !cacheServed) {
    // Never let a prototype-shaped model name reach the catalog lookup either;
    // it cannot name a real price card.
    const costModel = typeof model === 'string' && !isUnsafeModelKey(model) ? model : null;
    try { credit = requestCreditCost(costModel); } catch { credit = 0; }
  }
  if (credit > 0) {
    const dayKey = hourKey.slice(0, 10);
    const creditsByHour = ensureNullProtoMap('creditsByHour');
    const creditsByDay = ensureNullProtoMap('creditsByDay');
    const creditsByModel = ensureNullProtoMap('creditsByModel');
    _state.creditsTotal = (_state.creditsTotal || 0) + credit;
    creditsByHour[hourKey] = (Object.hasOwn(creditsByHour, hourKey) ? creditsByHour[hourKey] : 0) + credit;
    creditsByDay[dayKey] = (Object.hasOwn(creditsByDay, dayKey) ? creditsByDay[dayKey] : 0) + credit;
    // Key the credit row by the same bounded key as modelCounts so the
    // dashboard join stays intact and a dangerous model name is normalized.
    creditsByModel[key] = (Object.hasOwn(creditsByModel, key) ? creditsByModel[key] : 0) + credit;
    // Prune credit hour map to ~30 days (720 keys), day map to ~90 days.
    pruneKeyed(creditsByHour, 720);
    pruneKeyed(creditsByDay, 90);
  }
  const scope = _requestScope.getStore();
  const row = {
    statsRowId: randomUUID(),
    ...(scope?.chatLog ? {
      requestId: scope.chatLog.requestId,
      requestedModel: scope.chatLog.requestedModel,
      ...scope.chatLog.origin,
    } : {}),
    ts: Date.now(), model, success: !!success, ms: durationMs || 0,
    account,
    credit,
    status: Number.isFinite(extra?.status) ? extra.status : (success ? 200 : 500),
    tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
    reportedUsage: null,
    ...(cacheServed ? { cacheServed: true } : {}),
  };
  // Usage can arrive before its row. A direct measurement takes precedence
  // over the pending one, but an empty placeholder must not discard it.
  const counts = usageTokenCounts(extra?.usage) ?? scope?.pendingUsage;
  applyUsageToRow(row, counts);
  if (scope) {
    scope.rows.push(row);
    scope.pendingUsage = null;
  }
  appendRecentRequest(row);
}

function appendRecentRequest(row) {
  if (!Array.isArray(_state.recentRequests)) _state.recentRequests = [];
  _state.recentRequests.push(row);
  if (_state.recentRequests.length > RECENT_REQ_CAP) {
    _state.recentRequests.splice(0, _state.recentRequests.length - RECENT_REQ_CAP);
  }

  scheduleSave();
}

// Keep a keyed map bounded to the most recent `max` keys (lexicographic ISO
// order == chronological). Drops the oldest keys when over cap.
function pruneKeyed(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort();
  for (const k of keys.slice(0, keys.length - max)) delete map[k];
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

/**
 * Split the lifetime request total into rows that carry an account id and rows
 * that cannot be attributed to any account. Global/unauthenticated paths call
 * recordRequest with `accountId == null`, so they increment totalRequests but
 * have no accountCounts key — the account dimension silently sums short of the
 * page total. Derived at read time so pre-fix persisted snapshots reconcile
 * without a migration.
 */
function accountAttribution() {
  let attributed = 0;
  for (const s of Object.values(_state.accountCounts || {})) {
    const n = Number(s?.requests);
    if (Number.isFinite(n) && n > 0) attributed += n;
  }
  const total = Number(_state.totalRequests) || 0;
  return { total, attributed, unattributed: Math.max(0, total - attributed) };
}

/** Get all stats, with computed latency percentiles per model. */
export function getStats() {
  const out = { ..._state };
  out.accountAttribution = accountAttribution();
  // Rebuild every keyed map as a plain object: the public response keeps its
  // historical Object.prototype shape, while Object.fromEntries creates own
  // data properties (never the __proto__ setter) for every key.
  out.modelCounts = Object.fromEntries(Object.entries(_state.modelCounts).map(([m, s]) => {
    const sorted = (s.recentMs || []).slice().sort((a, b) => a - b);
    return [m, {
      requests: s.requests,
      success: s.success,
      errors: s.errors,
      totalMs: s.totalMs,
      avgMs: s.requests > 0 ? Math.round(s.totalMs / s.requests) : 0,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
    }];
  }));
  out.accountCounts = plainMap(_state.accountCounts);
  out.creditsByHour = plainMap(_state.creditsByHour);
  out.creditsByDay = plainMap(_state.creditsByDay);
  out.creditsByModel = plainMap(_state.creditsByModel);
  out.tokensByModel = plainMap(_state.tokensByModel);
  return out;
}

// v2.0.148 — Export the full stats state as a JSON-serializable snapshot (for
// backup / migration / offline analysis). Includes credits + recentRequests.
export function exportStats() {
  const out = { ..._state };
  for (const key of MAP_KEYS) out[key] = plainMap(_state[key]);
  return {
    _exportedAt: new Date().toISOString(),
    _schema: 'windsurfapi-stats-v2',
    ...out,
  };
}

function normalizeStatsSnapshot(src) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const number = (value = 0) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid number');
    return value;
  };
  const counts = (value, keys) => {
    if (!object(value)) throw new Error('invalid counters');
    // Own-key reads only: a polluted Object.prototype must never supply a
    // counter that the imported snapshot did not actually contain.
    return Object.fromEntries(keys.map(key =>
      [key, number(Object.hasOwn(value, key) ? value[key] : 0)]));
  };
  const out = createStatsState();
  if (!object(src) || !Object.keys(out).some(key => Object.hasOwn(src, key))) throw new Error('empty snapshot');
  if (src._schema != null && !['windsurfapi-stats-v1', 'windsurfapi-stats-v2'].includes(src._schema)) {
    throw new Error('unsupported schema');
  }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'number' && Object.hasOwn(src, key)) out[key] = number(src[key]);
  }
  for (const key of ['modelCounts', 'accountCounts', 'creditsByHour', 'creditsByDay', 'creditsByModel']) {
    if (!Object.hasOwn(src, key)) continue;
    if (!object(src[key])) throw new Error('invalid map');
    for (const [name, value] of Object.entries(src[key])) {
      if (key.startsWith('credits')) { out[key][name] = number(value); continue; }
      const entry = counts(value, key === 'modelCounts'
        ? ['requests', 'success', 'errors', 'totalMs', 'lastTs'] : ['requests', 'success', 'errors']);
      if (key === 'modelCounts') {
        if (value.recentMs !== undefined && !Array.isArray(value.recentMs)) throw new Error('invalid latency samples');
        entry.recentMs = (value.recentMs || []).map(v => number(v)).slice(-200);
      }
      out[key][name] = entry;
    }
  }
  // Snapshots written before the id fix carry credential prefixes in both the
  // account map keys and the request rows; scrub them on import too.
  out.accountCounts = normalizeAccountCounts(out.accountCounts);
  if (Object.hasOwn(src, 'tokenTotals')) out.tokenTotals = counts(src.tokenTotals, Object.keys(out.tokenTotals));
  if (Object.hasOwn(src, 'tokensByModel')) {
    if (!object(src.tokensByModel)) throw new Error('invalid token map');
    for (const [name, value] of Object.entries(src.tokensByModel)) {
      out.tokensByModel[name] = counts(value,
        ['fresh_input', 'cache_read', 'cache_write', 'output', 'total', 'requests_with_usage']);
    }
  }
  for (const key of ['hourlyBuckets', 'recentRequests', 'recentPolicyBlocks']) {
    if (!Object.hasOwn(src, key)) continue;
    if (!Array.isArray(src[key])) throw new Error('invalid history');
    out[key] = src[key].map(entry => {
      if (!object(entry)) throw new Error('invalid history entry');
      if (key === 'hourlyBuckets') {
        if (typeof entry.hour !== 'string' || !Number.isFinite(Date.parse(entry.hour))) throw new Error('invalid hour');
        return { hour: new Date(entry.hour).toISOString(), ...counts(entry, ['requests', 'errors']) };
      }
      number(entry.ts);
      if (!Object.hasOwn(entry, 'ts')) throw new Error('missing timestamp');
      if (key === 'recentRequests') {
        if (typeof entry.model !== 'string') throw new Error('invalid model');
        if (entry.success !== undefined && typeof entry.success !== 'boolean') throw new Error('invalid success flag');
        if (entry.account != null && typeof entry.account !== 'string') throw new Error('invalid account');
        for (const field of ['ms', 'credit']) if (Object.hasOwn(entry, field)) number(entry[field]);
      } else if (typeof entry.promptHash !== 'string') throw new Error('invalid prompt hash');
      return entry;
    });
  }
  out.recentRequests = normalizeRecentRequests(out.recentRequests);
  return out;
}

function mergeStatsHistory(existing, incoming, identity, cap) {
  const entries = new Map(existing.map(entry => [identity(entry), entry]));
  for (const entry of incoming) {
    const key = identity(entry);
    if (!entries.has(key)) entries.set(key, entry);
  }
  return [...entries.values()].sort((a, b) => a.ts - b.ts).slice(-cap);
}

function requestHistoryKey(row) {
  return typeof row.statsRowId === 'string' && row.statsRowId
    ? `id:${row.statsRowId}` : `legacy:${row.ts}|${row.model}`;
}

// v2.0.148 — Import a previously exported snapshot. MERGE mode (default) adds
// counts onto current; REPLACE overwrites. Numeric fields are summed, keyed
// maps merged, request rows de-duplicated by their private row id (legacy:
// timestamp and model), then capped.
export function importStats(snap, { mode = 'merge' } = {}) {
  if (!['merge', 'replace'].includes(mode)) return { ok: false, error: 'invalid mode' };
  let next;
  try {
    // Clone and validate before touching live state; prototype keys are stripped at every depth.
    const src = normalizeStatsSnapshot(JSON.parse(JSON.stringify(snap), (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    }));
    next = mode === 'replace' ? src : normalizeStatsSnapshot(JSON.parse(JSON.stringify(_state)));
    if (mode === 'merge') {
      for (const [key, value] of Object.entries(src)) {
        if (typeof value === 'number' && key !== 'startedAt') next[key] += value;
      }
      for (const key of ['creditsByHour', 'creditsByDay', 'creditsByModel', 'tokenTotals']) {
        for (const [name, value] of Object.entries(src[key])) {
          next[key][name] = (Object.hasOwn(next[key], name) ? next[key][name] : 0) + value;
        }
      }
      for (const [name, incoming] of Object.entries(src.tokensByModel)) {
        const current = Object.hasOwn(next.tokensByModel, name) ? next.tokensByModel[name] : null;
        if (!current) { next.tokensByModel[name] = { ...incoming }; continue; }
        for (const field of Object.keys(current)) current[field] += incoming[field] || 0;
      }
      for (const key of ['modelCounts', 'accountCounts']) {
        for (const [name, incoming] of Object.entries(src[key])) {
          const current = Object.hasOwn(next[key], name) ? next[key][name] : null;
          if (!current) { next[key][name] = incoming; continue; }
          for (const field of ['requests', 'success', 'errors']) current[field] += incoming[field];
          if (key === 'modelCounts') {
            current.totalMs += incoming.totalMs;
            current.lastTs = Math.max(current.lastTs, incoming.lastTs);
            current.recentMs = [...current.recentMs, ...incoming.recentMs].slice(-200);
          }
        }
      }
    }
    const hours = new Map();
    for (const bucket of [...(mode === 'merge' ? src.hourlyBuckets : []), ...next.hourlyBuckets]) {
      const current = hours.get(bucket.hour);
      if (current) { current.requests += bucket.requests; current.errors += bucket.errors; }
      else hours.set(bucket.hour, { ...bucket });
    }
    next.hourlyBuckets = [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour)).slice(-720);
    next.recentRequests = mergeStatsHistory(next.recentRequests, mode === 'merge' ? src.recentRequests : [],
      requestHistoryKey, RECENT_REQ_CAP);
    next.recentPolicyBlocks = mergeStatsHistory(next.recentPolicyBlocks, mode === 'merge' ? src.recentPolicyBlocks : [],
      r => `${r.ts}|${r.promptHash}`, Number(process.env.POLICY_BLOCK_RING) || 50);
    pruneKeyed(next.creditsByHour, 720);
    pruneKeyed(next.creditsByDay, 90);
    enforceModelCap(false, next.modelCounts);
    pruneTokensToModelCounts(Object.keys(next.tokensByModel || {}), next.modelCounts, next.tokensByModel);
    next = normalizeStatsSnapshot(next); // Also reject numeric overflow from merging.
    if (mode === 'merge') {
      // Keep existing row references so an in-flight scope can still finish
      // attributing usage and HTTP status after a non-destructive import.
      const liveRows = new Map(_state.recentRequests.filter(row => typeof row.statsRowId === 'string' && row.statsRowId)
        .map(row => [row.statsRowId, row]));
      next.recentRequests = next.recentRequests.map(row => liveRows.get(row.statsRowId) ?? row);
    }
  } catch {
    return { ok: false, error: 'invalid snapshot' };
  }
  Object.assign(_state, next);
  for (const entry of Object.values(_state.modelCounts)) _touchSeq = Math.max(_touchSeq, entry.lastTs);
  _curBucket = null;
  scheduleSave();
  return { ok: true, mode };
}

/** Reset all stats. */
export function resetStats() {
  _state.totalRequests = 0;
  _state.successCount = 0;
  _state.errorCount = 0;
  _state.modelCounts = emptyMap();
  _state.accountCounts = emptyMap();
  _state.hourlyBuckets = [];
  _curBucket = null; // invalidate cached bucket ref (S8) — buckets array replaced
  _state.tokenTotals = {
    fresh_input: 0, cache_read: 0, cache_write: 0,
    output: 0, total: 0, requests_with_usage: 0,
  };
  _state.creditsTotal = 0;
  _state.creditsByHour = emptyMap();
  _state.creditsByDay = emptyMap();
  _state.creditsByModel = emptyMap();
  _state.tokensByModel = emptyMap();
  _state.recentRequests = [];
  _state.recentPolicyBlocks = [];
  _state.startedAt = Date.now();
  scheduleSave();
}

/**
 * v2.0.69 (#118): record per-request token bucket totals so the dashboard
 * can show real fresh-input vs cache-read vs cache-write breakdown
 * instead of the conflated prompt_tokens number.
 *
 * Accepts the OpenAI-shaped usage object that buildUsageBody returns —
 * cascade_breakdown is the authoritative source when present, otherwise
 * fall back to standard fields. Connect usage (O2) has no cascade_breakdown but
 * carries `fresh_input_tokens` at the top level, because there prompt_tokens
 * includes cache_write and `prompt - cached` would book the write as fresh.
 */
export function recordTokenUsage(usage, model = null) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;
  // Join the display evidence even when the lifetime ledger has nothing to add.
  // The scope is the only safe join between concurrent calls for the same model.
  const scope = _requestScope.getStore();
  const row = scope?.rows.at(-1);
  if (row?.cacheServed) return;
  const counts = scope ? usageTokenCounts(usage) : null;
  if (row) applyUsageToRow(row, counts);
  else if (counts) scope.pendingUsage = counts;

  // The lifetime ledger keeps its existing alias fallback and positive-count
  // gate. A displayed zero or a total without a split does not add a charge.
  const bd = usage.cascade_breakdown || null;
  const cacheFallback = tokenCount(usage.prompt_tokens_details?.cached_tokens) || tokenCount(usage.cache_read_input_tokens) || 0;
  const fresh = tokenCount(bd?.fresh_input_tokens) ?? tokenCount(usage.fresh_input_tokens)
    ?? Math.max(0, (tokenCount(usage.prompt_tokens) ?? 0) - cacheFallback);
  const cacheR = tokenCount(bd?.cache_read_tokens) ?? cacheFallback;
  const cacheW = tokenCount(bd?.cache_write_tokens) ?? tokenCount(usage.cache_creation_input_tokens) ?? 0;
  const output = tokenCount(bd?.output_tokens) ?? (tokenCount(usage.completion_tokens) || tokenCount(usage.output_tokens) || 0);
  if (!fresh && !cacheR && !cacheW && !output) {
    if (row && counts) scheduleSave();
    return;
  }
  if (!_state.tokenTotals) {
    _state.tokenTotals = { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0, requests_with_usage: 0 };
  }
  _state.tokenTotals.fresh_input += fresh;
  _state.tokenTotals.cache_read += cacheR;
  _state.tokenTotals.cache_write += cacheW;
  _state.tokenTotals.output += output;
  _state.tokenTotals.total += fresh + cacheR + cacheW + output;
  _state.tokenTotals.requests_with_usage += 1;
  // Per-model attribution. Only when the caller KNOWS the model: filing an
  // unknown request under '(other)' would invent a model row that no client
  // ever named, and the global totals above already count it. Prototype-shaped
  // names are unknown by the same rule — rejecting them here also prevents
  // `tokensByModel['__proto__']` from resolving to Object.prototype.
  const requested = typeof model === 'string' && model.trim() ? model : null;
  const key = requested && !isUnsafeModelKey(requested) ? boundedModelKey(requested) : null;
  if (key) {
    const tokensByModel = ensureNullProtoMap('tokensByModel');
    if (!Object.hasOwn(tokensByModel, key)) {
      tokensByModel[key] = {
        fresh_input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0, requests_with_usage: 0,
      };
    }
    const tm = tokensByModel[key];
    tm.fresh_input += fresh;
    tm.cache_read += cacheR;
    tm.cache_write += cacheW;
    tm.output += output;
    tm.total += fresh + cacheR + cacheW + output;
    tm.requests_with_usage += 1;
  }
  scheduleSave();
}

export function recordPolicyBlocked(sample = null) {
  _state.policyBlockedCount = (_state.policyBlockedCount || 0) + 1;
  if (sample) {
    if (!Array.isArray(_state.recentPolicyBlocks)) _state.recentPolicyBlocks = [];
    _state.recentPolicyBlocks.push(sample);
    const CAP = Number(process.env.POLICY_BLOCK_RING) || 50;
    if (_state.recentPolicyBlocks.length > CAP) {
      _state.recentPolicyBlocks.splice(0, _state.recentPolicyBlocks.length - CAP);
    }
  }
  scheduleSave();
}

export function recordRateLimited() {
  _state.rateLimitedCount = (_state.rateLimitedCount || 0) + 1;
  scheduleSave();
}

// ─── Request log query ─────────────────────────────────────────────────
// Read-only view over the persisted per-request ring (recentRequests). Every
// number is computed from the rows that pass the filters, so the table and the
// aggregates below it always share one denominator. Retention is bounded and
// stated in the response (retention.stored/capacity); the panel labels the
// window instead of implying full history.
const LOG_PAGE_MAX = 200;

function requestLogDetails(row) {
  if (typeof row?.requestId !== 'string' || !REQUEST_ID_RE.test(row.requestId)) return null;
  const dispatches = Array.isArray(row.requestDispatches)
    ? row.requestDispatches.slice(0, REQUEST_DISPATCH_CAP).map(requestLogModel) : [];
  const count = row.requestDispatchCount;
  const httpStatus = row.requestHttpStatus;
  const admission = row.requestStage === 'account_admission';
  // A positive count comes from the existing Connect handoff observer. It
  // does not attest other transports. Zero is known only at the early gate.
  const observedConnect = Number.isSafeInteger(count) && count > 0 && count >= dispatches.length;
  return {
    requestId: row.requestId,
    requestedModel: requestLogModel(row.requestedModel),
    requestHttpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    requestFailureCode: requestLogFailureCode(row.requestFailureCode),
    requestDispatches: dispatches,
    requestDispatchCount: admission ? 0 : observedConnect ? count : null,
    requestDispatchCoverage: admission ? 'before_dispatch' : observedConnect ? 'connect_handoff' : null,
    requestStage: admission ? 'account_admission' : null,
    requestSurface: REQUEST_SURFACES.has(row.requestSurface) ? row.requestSurface : null,
    requestBootId: REQUEST_BOOT_ID_RE.test(row.requestBootId) ? row.requestBootId : null,
    requestVersion: typeof row.requestVersion === 'string' && /^[A-Za-z0-9.+_-]{1,48}$/.test(row.requestVersion) ? row.requestVersion : null,
    requestCommit: typeof row.requestCommit === 'string' && /^[a-f0-9]{7,40}$/i.test(row.requestCommit) ? row.requestCommit : null,
    requestBuildSource: ['build-env', 'build-git', 'git', 'package'].includes(row.requestBuildSource) ? row.requestBuildSource : null,
  };
}

function logRowView(row) {
  const ts = Number(row?.ts);
  const rawStatus = row?.status;
  const derived = row?.success ? 200 : 500;
  const status = rawStatus == null || rawStatus === ''
    ? derived
    : (Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : derived);
  // Legacy rows stored ambiguous zero defaults. Keep their positive sides,
  // without guessing what a zero meant or relabeling new estimates as reports.
  const legacyReport = {
    tokensIn: tokenCount(row?.tokensIn) || undefined,
    tokensOut: tokenCount(row?.tokensOut) || undefined,
  };
  const report = row && Object.hasOwn(row, 'reportedUsage') ? row.reportedUsage : legacyReport;
  return {
    ...requestLogDetails(row),
    ts: Number.isFinite(ts) ? ts : 0,
    model: typeof row?.model === 'string' ? row.model : '',
    account: normalizeAccountRef(row?.account),
    status,
    success: !!row?.success,
    ms: nonNeg(row?.ms),
    tokensIn: nonNeg(row?.tokensIn),
    tokensOut: nonNeg(row?.tokensOut),
    reportedUsage: row?.cacheServed === true ? null : reportedTokenFields(report),
    cacheRead: nonNeg(row?.cacheRead),
    cacheWrite: nonNeg(row?.cacheWrite),
    credit: nonNeg(row?.credit),
  };
}

function emptyAggregate(extra) {
  return {
    ...extra,
    requests: 0, success: 0, errors: 0,
    tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, credits: 0, totalMs: 0,
    _latencies: [],
  };
}

function addToAggregate(agg, row) {
  agg.requests += 1;
  if (row.success) agg.success += 1;
  else agg.errors += 1;
  agg.tokensIn += row.tokensIn;
  agg.tokensOut += row.tokensOut;
  agg.cacheRead += row.cacheRead;
  agg.cacheWrite += row.cacheWrite;
  agg.credits += row.credit;
  agg.totalMs += row.ms;
  if (row.ms > 0) agg._latencies.push(row.ms);
}

function finishAggregate(agg) {
  const latencies = agg._latencies || [];
  agg.avgMs = agg.requests > 0 ? Math.round(agg.totalMs / agg.requests) : 0;
  agg.p50Ms = percentileOf(latencies, 0.5);
  agg.p95Ms = percentileOf(latencies, 0.95);
  delete agg.totalMs;
  delete agg._latencies;
  return agg;
}

/** Nearest-rank percentile over an unsorted sample; 0 when empty. */
function percentileOf(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Newest-first page of request-log rows plus aggregates over the whole
 * filtered window (not just the page). Filters: `from`/`to` epoch ms, exact
 * `model`/`account`/`requestId`, numeric `status`.
 */
export function getRequestLog({
  from = null, to = null, model = null, account = null, status = null, requestId = null,
  limit = 50, offset = 0,
} = {}) {
  const rows = Array.isArray(_state.recentRequests) ? _state.recentRequests : [];
  const fromNum = from == null || from === '' ? null : Number(from);
  const toNum = to == null || to === '' ? null : Number(to);
  const fromMs = Number.isFinite(fromNum) ? fromNum : null;
  const toMs = Number.isFinite(toNum) ? toNum : null;
  const statusNum = status == null || status === '' ? null : Number(status);
  const modelFilter = typeof model === 'string' && model ? model : null;
  const accountFilter = typeof account === 'string' && account ? account : null;
  const requestFilter = typeof requestId === 'string' ? requestId.trim() : '';

  const filtered = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = logRowView(raw);
    if (requestFilter && row.requestId !== requestFilter) continue;
    if (fromMs != null && row.ts < fromMs) continue;
    if (toMs != null && row.ts > toMs) continue;
    if (modelFilter && row.model !== modelFilter) continue;
    if (accountFilter && row.account !== accountFilter) continue;
    if (statusNum != null && (!Number.isFinite(statusNum) || row.status !== statusNum)) continue;
    filtered.push(row);
  }

  const n = Math.max(1, Math.min(LOG_PAGE_MAX, Number(limit) || 50));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const newestFirst = filtered.slice().reverse();
  const items = newestFirst.slice(off, off + n);

  const summary = emptyAggregate({ admissionRejections: 0 });
  const byModel = new Map();
  const byAccount = new Map();
  const byDay = new Map();
  const unattributed = emptyAggregate({ account: null });
  for (const row of filtered) {
    if (row.requestStage === 'account_admission') {
      summary.admissionRejections++;
      continue;
    }
    addToAggregate(summary, row);
    if (row.model) {
      const agg = byModel.get(row.model) || emptyAggregate({ model: row.model });
      addToAggregate(agg, row);
      byModel.set(row.model, agg);
    }
    if (row.account) {
      const agg = byAccount.get(row.account) || emptyAggregate({ account: row.account });
      addToAggregate(agg, row);
      byAccount.set(row.account, agg);
    } else {
      addToAggregate(unattributed, row);
    }
    const day = new Date(row.ts).toISOString().slice(0, 10);
    const agg = byDay.get(day) || emptyAggregate({ day });
    addToAggregate(agg, row);
    byDay.set(day, agg);
  }
  finishAggregate(summary);
  finishAggregate(unattributed);

  const models = [...byModel.values()]
    .map(finishAggregate)
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  const accounts = [...byAccount.values()]
    .map(finishAggregate)
    .sort((a, b) => b.requests - a.requests || String(a.account).localeCompare(String(b.account)));
  const days = [...byDay.values()]
    .map(finishAggregate)
    .sort((a, b) => a.day.localeCompare(b.day));

  const all = rows.map(logRowView);
  return {
    items,
    currentBootId: requestLogBootId,
    total: filtered.length,
    limit: n,
    offset: off,
    hasMore: off + items.length < filtered.length,
    retention: { stored: all.length, capacity: RECENT_REQ_CAP },
    filters: {
      models: [...new Set(all.map(r => r.model).filter(Boolean))].sort(),
      accounts: [...new Set(all.map(r => r.account).filter(Boolean))].sort(),
      statuses: [...new Set(all.map(r => r.status).filter(Number.isFinite))].sort((a, b) => a - b),
    },
    summary,
    byModel: models,
    byAccount: accounts,
    // Rows with no account id: byAccount + unattributed = summary, so the
    // account tab can state the remainder instead of silently summing short.
    unattributed,
    byDay: days,
  };
}
