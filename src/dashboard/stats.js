/**
 * Request statistics collector with debounced JSON persistence.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

const STATS_FILE = join(config.dataDir, 'stats.json');

const _state = {
  startedAt: Date.now(),
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  modelCounts: {},    // { "gpt-4o-mini": { requests, success, errors, totalMs } }
  accountCounts: {},  // { "abc123": { requests, success, errors } }
  hourlyBuckets: [],  // [{ hour: "2026-04-09T07:00:00Z", requests, errors }]
};

// Load persisted stats
try {
  if (existsSync(STATS_FILE)) {
    const saved = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    Object.assign(_state, saved);
  }
} catch {}

// Debounced save
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      writeFileSync(STATS_FILE, JSON.stringify(_state, null, 2));
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

  // Per-model stats (includes a small ring buffer for p50/p95 latency)
  if (!_state.modelCounts[model]) {
    _state.modelCounts[model] = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [] };
  }
  const mc = _state.modelCounts[model];
  mc.requests++;
  if (success) mc.success++;
  else mc.errors++;
  mc.totalMs += durationMs;
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

  // Hourly bucket
  const hourKey = getHourKey();
  let bucket = _state.hourlyBuckets.find(b => b.hour === hourKey);
  if (!bucket) {
    bucket = { hour: hourKey, requests: 0, errors: 0 };
    _state.hourlyBuckets.push(bucket);
    // Keep last 72 hours
    if (_state.hourlyBuckets.length > 72) _state.hourlyBuckets.shift();
  }
  bucket.requests++;
  if (!success) bucket.errors++;

  scheduleSave();
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

/** Reset all stats. */
export function resetStats() {
  _state.totalRequests = 0;
  _state.successCount = 0;
  _state.errorCount = 0;
  _state.modelCounts = {};
  _state.accountCounts = {};
  _state.hourlyBuckets = [];
  _state.startedAt = Date.now();
  scheduleSave();
}
