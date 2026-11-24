/**
 * Observable fleet runs: probe-all / refresh-all as a cancellable job.
 *
 * 3.9.53 ran these as ONE blocking POST: the browser showed a static sentence
 * for minutes, had no cancel, and — because the failure list lived inside the
 * selection bar — could not open the per-account failures at all without
 * selecting rows first. The pool-wide work is unchanged (serial, one account at
 * a time: parallel writes to the same pool trip the upstream brute-force
 * guard); what changes is that it now has an identity the UI can watch.
 *
 * Lifecycle: `POST /accounts/fleet-jobs` returns a job id, the runner advances
 * `done` after every account, and the UI polls `GET …/:id?since=N` for the
 * delta. Cancelling stops SCHEDULING new accounts; the request already in
 * flight is allowed to finish, so `done` never regresses.
 *
 * Jobs are process-local and bounded (MAX_JOBS, JOB_TTL_MS): a restart loses
 * them, which is correct — the pool state itself is persisted, the progress
 * narration is not.
 */

import { randomUUID } from 'node:crypto';
import {
  getAccountList,
  probeAccount,
  refreshCredits,
} from '../auth.js';

/** Finished jobs kept for polling. Older ones are dropped on the next start. */
export const MAX_JOBS = 8;
/** A finished job stays readable this long, then it is collected. */
export const JOB_TTL_MS = 30 * 60 * 1000;
/** Hard bound on one run's item list (matches the batch route's cap). */
export const MAX_ITEMS = 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

/**
 * A skipped probe must never read as success. Kept here (not in api.js) so the
 * batch route, the fleet job and the single-account route classify identically.
 */
export function probeOutcomeEntry(id, result) {
  if (!result) return { id, ok: false, error: 'ERR_ACCOUNT_NOT_FOUND' };
  if (result.skipped) {
    return { id, ok: false, skipped: true, reason: result.reason || 'probe_skipped', tier: result.tier || 'unknown' };
  }
  if (result.ok === false) return { id, ok: false, error: result.error || 'ERR_ACCOUNT_CHECK_STATUS_UNAVAILABLE' };
  return { id, ok: true, tier: result.tier || 'unknown' };
}

/** Attempted/succeeded/failed/skipped totals for a probe result list. */
export function summarizeProbeResults(results = []) {
  const skippedCount = results.filter((r) => r.skipped).length;
  const okCount = results.filter((r) => r.ok && !r.skipped).length;
  const failCount = results.filter((r) => !r.ok && !r.skipped).length;
  return { attempted: results.length - skippedCount, okCount, failCount, skippedCount };
}

const DEFAULT_OPS = {
  async probe(account, { force }) {
    const result = await probeAccount(account.id, { allowLsStart: force });
    const entry = probeOutcomeEntry(account.id, result);
    return {
      ...entry,
      email: account.email,
      reason: entry.reason || result?.reason || null,
      admission: result?.admission || null,
    };
  },
  async refresh(account) {
    const result = await refreshCredits(account.id);
    return result?.ok
      ? { id: account.id, email: account.email, ok: true }
      : { id: account.id, email: account.email, ok: false, error: result?.error || 'ERR_REFRESH_FAILED' };
  },
};

function pruneJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size >= MAX_JOBS) {
    const finished = [...jobs.values()].filter((job) => job.state !== 'running');
    if (!finished.length) break;
    finished.sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    jobs.delete(finished[0].id);
  }
}

/**
 * Which accounts a fleet run touches.
 *
 * Both operations target `status === 'active'` accounts: probing a banned or
 * disabled account cannot change anything, and refreshing a retired token only
 * produces a guaranteed failure. `excluded` reports how many pool members were
 * left out, so the UI can say "已排除 N 个非活跃账号" instead of silently
 * shrinking the denominator.
 */
function selectTargets(ids) {
  const all = getAccountList({ view: 'summary' });
  if (Array.isArray(ids) && ids.length > 0) {
    const byId = new Map(all.map((account) => [account.id, account]));
    const targets = [];
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      targets.push(byId.get(id));
      if (targets.length >= MAX_ITEMS) break;
    }
    return { targets, excluded: 0, excludedAccounts: [], requested: ids.length };
  }
  const targets = all.filter((account) => account.status === 'active');
  const targetIds = new Set(targets.map((account) => account.id));
  const excludedAccounts = all
    .filter((account) => !targetIds.has(account.id))
    .map((account) => ({ id: account.id, email: account.email || '' }));
  return { targets, excluded: excludedAccounts.length, excludedAccounts, requested: all.length };
}

/** Public snapshot. `since` pages the item list so a poll stays O(delta). */
export function publicFleetJob(job, { since = 0 } = {}) {
  const from = Math.max(0, Math.min(Number.isFinite(since) ? since : 0, job.items.length));
  return {
    id: job.id,
    op: job.op,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    total: job.total,
    done: job.done,
    ok: job.okCount,
    fail: job.failCount,
    skipped: job.skippedCount,
    excluded: job.excluded,
    excludedAccounts: Array.isArray(job.excludedAccounts) ? job.excludedAccounts : [],
    cancelRequested: !!job.cancelRequested,
    current: job.current,
    error: job.error || null,
    itemCount: job.items.length,
    since: from,
    items: job.items.slice(from),
  };
}

export function getFleetJob(id) {
  return jobs.get(String(id || '')) || null;
}

/** Stop scheduling new accounts; the in-flight one finishes. */
export function cancelFleetJob(id) {
  const job = jobs.get(String(id || ''));
  if (!job) return null;
  if (job.state === 'running') job.cancelRequested = true;
  return job;
}

async function runFleetJob(job, ops) {
  const run = ops[job.op];
  for (const account of job.targets) {
    if (job.cancelRequested) break;
    job.current = { id: account.id, email: account.email || '' };
    let entry;
    try {
      entry = await run(account, { force: job.force });
    } catch (err) {
      entry = { id: account.id, email: account.email, ok: false, error: err?.message || 'ERR_FLEET_ITEM_FAILED' };
    }
    if (!entry || typeof entry !== 'object') {
      entry = { id: account.id, email: account.email, ok: false, error: 'ERR_FLEET_ITEM_FAILED' };
    }
    job.items.push({
      id: account.id,
      email: entry.email || account.email || '',
      ok: !!entry.ok,
      skipped: !!entry.skipped,
      error: entry.ok ? undefined : (entry.error || undefined),
      reason: entry.reason || undefined,
      tier: entry.tier || undefined,
      at: Date.now(),
    });
    job.done = job.items.length;
    if (entry.skipped) job.skippedCount++;
    else if (entry.ok) job.okCount++;
    else job.failCount++;
  }
  job.current = null;
  job.state = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
}

/**
 * Start a run. Returns the live job object; `job.promise` settles when the run
 * ends (used by the legacy blocking routes so they share this loop).
 */
export function startFleetJob({ op, ids = null, force = false, ops = null, now = Date.now() } = {}) {
  pruneJobs(now);
  // selectTargets takes the id list. It used to be called as (op, ids), which
  // silently dropped the caller's selection: "run on the checked rows" ran the
  // whole pool instead, and only the pool-wide case had a test.
  const { targets, excluded, excludedAccounts, requested } = selectTargets(ids);
  const job = {
    id: `fleet-${randomUUID()}`,
    op,
    state: 'running',
    startedAt: now,
    finishedAt: 0,
    total: targets.length,
    requested,
    excluded,
    excludedAccounts,
    done: 0,
    okCount: 0,
    failCount: 0,
    skippedCount: 0,
    cancelRequested: false,
    current: null,
    error: null,
    items: [],
    targets,
    force: !!force,
  };
  jobs.set(job.id, job);
  job.promise = runFleetJob(job, ops || DEFAULT_OPS).catch((err) => {
    job.error = err?.message || 'ERR_FLEET_FAILED';
    job.state = 'failed';
    job.finishedAt = Date.now();
  });
  return job;
}

/** Await a run's completion (legacy blocking routes). */
export async function awaitFleetJob(id) {
  const job = jobs.get(String(id || ''));
  if (!job) return null;
  await job.promise;
  return job;
}

/** Test seam: drop every job. */
export function __resetFleetJobsForTest() {
  jobs.clear();
}
