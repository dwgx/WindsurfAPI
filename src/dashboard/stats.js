/**
 * Request statistics collector with debounced JSON persistence.
 */

import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic } from '../fs-atomic.js';
import { join } from 'path';
import { config } from '../config.js';
import { getModelInfo } from '../models.js';

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
  let dst = modelCounts[OTHER_MODEL_KEY];
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
 * Ensure there is room for one more real model key, LRU-evicting the
 * least-recently-updated real model into '(other)' while over the cap.
 * No-op when MAX_MODELS is 0 (unbounded).
 */
function enforceModelCap(reserveSlot = true, modelCounts = _state.modelCounts) {
  if (MAX_MODELS <= 0) return;
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
  }
}

const STATS_DEFAULTS = {
  startedAt: 0,
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  modelCounts: {},    // { "gpt-4o-mini": { requests, success, errors, totalMs } }
  accountCounts: {},  // { "abc123": { requests, success, errors } }
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
  // never have to thread cost through the 10 recordRequest call sites.
  creditsTotal: 0,
  creditsByHour: {},   // { "2026-07-09T01:00:00Z": 12.5 }
  creditsByDay: {},    // { "2026-07-09": 340.0 }
  creditsByModel: {},  // { "claude-opus-4-8-medium": 88.0 }
  // v2.0.148 — per-request detail ring buffer (bounded, persisted) so long runs
  // keep a rolling window of recent calls for audit/export instead of losing them.
  recentRequests: [],  // [{ ts, model, success, ms, account, credit }]  newest last, cap 500
};

function createStatsState() {
  return { ...structuredClone(STATS_DEFAULTS), startedAt: Date.now() };
}

const _state = createStatsState();

const RECENT_REQ_CAP = 500;

// Load persisted stats
try {
  if (existsSync(STATS_FILE)) {
    const saved = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    Object.assign(_state, saved);
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
 * Record a completed request.
 */
export function recordRequest(model, success, durationMs, accountId) {
  _state.totalRequests++;
  if (success) _state.successCount++;
  else _state.errorCount++;

  // Per-model stats (includes a small ring buffer for p50/p95 latency).
  // Cap real-model cardinality: a brand-new key that would exceed the limit
  // gets folded into the shared '(other)' bucket instead (LRU eviction of the
  // coldest existing key). Known keys and '(other)' itself always update.
  let key = model;
  if (!_state.modelCounts[key] && key !== OTHER_MODEL_KEY) {
    enforceModelCap();
    if (MAX_MODELS > 0 && realModelKeyCount() >= MAX_MODELS) key = OTHER_MODEL_KEY;
  }
  if (!_state.modelCounts[key]) {
    _state.modelCounts[key] = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [], lastTs: 0 };
  }
  const mc = _state.modelCounts[key];
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

  // Per-account stats
  if (accountId) {
    const aid = typeof accountId === 'string' ? accountId.slice(0, 8) : String(accountId);
    if (!_state.accountCounts[aid]) {
      _state.accountCounts[aid] = { requests: 0, success: 0, errors: 0 };
    }
    const ac = _state.accountCounts[aid];
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

  // v2.0.148 — Credits spend + per-request detail. Cost = model's rate-card
  // credit (getModelInfo), 0 if unknown. Persisted maps stay JSON-safe.
  let credit = 0;
  try { credit = Number(getModelInfo(model)?.credit) || 0; } catch { credit = 0; }
  if (credit > 0 && success) {
    const dayKey = hourKey.slice(0, 10);
    _state.creditsTotal = (_state.creditsTotal || 0) + credit;
    _state.creditsByHour[hourKey] = (_state.creditsByHour[hourKey] || 0) + credit;
    _state.creditsByDay[dayKey] = (_state.creditsByDay[dayKey] || 0) + credit;
    _state.creditsByModel[model] = (_state.creditsByModel[model] || 0) + credit;
    // Prune credit hour map to ~30 days (720 keys), day map to ~90 days.
    pruneKeyed(_state.creditsByHour, 720);
    pruneKeyed(_state.creditsByDay, 90);
  }
  if (!Array.isArray(_state.recentRequests)) _state.recentRequests = [];
  _state.recentRequests.push({
    ts: Date.now(), model, success: !!success, ms: durationMs || 0,
    account: accountId ? (typeof accountId === 'string' ? accountId.slice(0, 8) : String(accountId)) : null,
    credit,
  });
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

/** Get all stats, with computed latency percentiles per model. */
export function getStats() {
  const out = { ..._state };
  out.modelCounts = {};
  for (const [m, s] of Object.entries(_state.modelCounts)) {
    const sorted = (s.recentMs || []).slice().sort((a, b) => a - b);
    out.modelCounts[m] = {
      requests: s.requests,
      success: s.success,
      errors: s.errors,
      totalMs: s.totalMs,
      avgMs: s.requests > 0 ? Math.round(s.totalMs / s.requests) : 0,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
    };
  }
  return out;
}

// v2.0.148 — Export the full stats state as a JSON-serializable snapshot (for
// backup / migration / offline analysis). Includes credits + recentRequests.
export function exportStats() {
  return {
    _exportedAt: new Date().toISOString(),
    _schema: 'windsurfapi-stats-v2',
    ..._state,
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
    return Object.fromEntries(keys.map(key => [key, number(value[key])]));
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
  if (Object.hasOwn(src, 'tokenTotals')) out.tokenTotals = counts(src.tokenTotals, Object.keys(out.tokenTotals));
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

// v2.0.148 — Import a previously exported snapshot. MERGE mode (default) adds
// counts onto current; REPLACE overwrites. Numeric fields are summed, keyed
// maps merged, recentRequests concatenated + de-duped by ts+model then capped.
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
      r => `${r.ts}|${r.model}`, RECENT_REQ_CAP);
    next.recentPolicyBlocks = mergeStatsHistory(next.recentPolicyBlocks, mode === 'merge' ? src.recentPolicyBlocks : [],
      r => `${r.ts}|${r.promptHash}`, Number(process.env.POLICY_BLOCK_RING) || 50);
    pruneKeyed(next.creditsByHour, 720);
    pruneKeyed(next.creditsByDay, 90);
    enforceModelCap(false, next.modelCounts);
    next = normalizeStatsSnapshot(next); // Also reject numeric overflow from merging.
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
  _state.modelCounts = {};
  _state.accountCounts = {};
  _state.hourlyBuckets = [];
  _curBucket = null; // invalidate cached bucket ref (S8) — buckets array replaced
  _state.tokenTotals = {
    fresh_input: 0, cache_read: 0, cache_write: 0,
    output: 0, total: 0, requests_with_usage: 0,
  };
  _state.creditsTotal = 0;
  _state.creditsByHour = {};
  _state.creditsByDay = {};
  _state.creditsByModel = {};
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
 * fall back to standard fields.
 */
export function recordTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  const bd = usage.cascade_breakdown || null;
  const fresh = bd?.fresh_input_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - (usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || 0));
  const cacheR = bd?.cache_read_tokens ?? (usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || 0);
  const cacheW = bd?.cache_write_tokens ?? (usage.cache_creation_input_tokens || 0);
  const output = bd?.output_tokens ?? (usage.completion_tokens || usage.output_tokens || 0);
  if (!fresh && !cacheR && !cacheW && !output) return;
  if (!_state.tokenTotals) {
    _state.tokenTotals = { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0, requests_with_usage: 0 };
  }
  _state.tokenTotals.fresh_input += fresh;
  _state.tokenTotals.cache_read += cacheR;
  _state.tokenTotals.cache_write += cacheW;
  _state.tokenTotals.output += output;
  _state.tokenTotals.total += fresh + cacheR + cacheW + output;
  _state.tokenTotals.requests_with_usage += 1;
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
