/**
 * Org-scoped ACU & usage reader (Q3 / REPORT C1).
 *
 * `app.devin.ai/{org}/billing/*` is ORGANIZATION-scoped: every account that
 * belongs to the same org sees identical quota, limits and daily usage. The
 * dashboard therefore resolves each account's org first and reads the ledger
 * ONCE per org — never once per account, and never sums across accounts that
 * share an org (that would multiply the same ACUs by the member count).
 *
 * The raw org id never leaves this module: callers receive a stable
 * `orgref-<hash>` and per-account refs. Tokens, emails and raw upstream bodies
 * are not part of the payload.
 *
 * Read-only: every upstream call goes through `readDevinJson` (GET only).
 */

import { getAccountInternal, getAccountList } from '../auth.js';
import { accountRef } from '../log-safety.js';
import { orgRefOf, rememberAccountOrg } from '../org-identity.js';
import {
  ReadError,
  httpStatusForKind,
  resolveOrgId,
  worstError,
} from './devin-read.js';
import { readQuotaBurnDown } from './quota-burn-down.js';

/** Upper bound on membership resolutions per panel load. */
export const MAX_ACCOUNTS = 40;
/** Membership resolution concurrency (one GET per account on a cold cache). */
export const RESOLVE_CONCURRENCY = 4;
/** Org reads concurrency (each org read is four GETs). */
export const ORG_CONCURRENCY = 2;

const SESSION_TOKEN_PREFIX = 'devin-session-token$';

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Hash the org id. The browser gets a stable, non-reversible handle so it can
 * dedupe/select orgs without receiving the upstream identifier.
 *
 * Re-exported from `org-identity.js` so the ACU panel and the pool-balance KPI
 * name the same org with the same handle (one hashing convention, not two).
 */
export { orgRefOf };

/**
 * Build the three ACU cells the panel renders.
 *
 * Truth rules:
 * - `max_acu_limit: null` is "unlimited" on the wire, never zero.
 * - an absent `cycle.total` is unknown (`—`), never a fabricated zero.
 * - `remaining` is DERIVED (limit − used) and says so; it is not an
 *   upstream-reported balance. Unlimited limit ⇒ unlimited remaining.
 * - `overageCredits` is a SIGNED USD balance. A negative value is an overdrawn
 *   on-demand balance (a real debt state, not a rounding error), so it is
 *   passed through unchanged and the panel renders the sign rather than
 *   clamping it to zero.
 */
export function deriveAcuCells({ limits, cycle } = {}) {
  const rawLimit = limits?.maxAcuLimit;
  const rawTotal = cycle?.total;
  const unlimited = rawLimit === null;

  const acuLimit = {
    value: num(rawLimit),
    known: num(rawLimit) !== null,
    unlimited,
    reason: num(rawLimit) !== null ? 'reported' : (unlimited ? 'unlimited' : 'absent_on_wire'),
  };
  const used = {
    value: num(rawTotal),
    known: num(rawTotal) !== null,
    reason: num(rawTotal) !== null ? 'reported' : 'absent_on_wire',
  };

  let remaining;
  if (unlimited) {
    remaining = { value: null, known: false, unlimited: true, derived: false, reason: 'unlimited' };
  } else if (!acuLimit.known) {
    remaining = { value: null, known: false, unlimited: false, derived: false, reason: 'limit_absent' };
  } else if (!used.known) {
    remaining = { value: null, known: false, unlimited: false, derived: false, reason: 'usage_absent' };
  } else {
    remaining = {
      value: Math.max(0, acuLimit.value - used.value),
      known: true,
      unlimited: false,
      derived: true,
      over: used.value > acuLimit.value,
      reason: 'derived',
    };
  }

  return { acuLimit, used, remaining };
}

/** Latest reported day at the supplied UTC clock, or null when none is eligible. */
export function latestDayOf(days, now) {
  if (!Array.isArray(days) || days.length === 0) return null;
  const date = new Date(Number.isFinite(now) ? now : NaN);
  const today = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  let latest = null;
  for (const day of days) {
    if (!day || typeof day.date !== 'string') continue;
    if (today && day.date > today) continue;
    if (!latest || day.date > latest.date) latest = day;
  }
  if (!latest) return null;
  return {
    date: latest.date,
    amount: num(latest.amount),
    cumulative: num(latest.cumulative),
  };
}

/** Run `fn` over `items` with a bounded number of concurrent workers. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Candidate accounts for an org-scoped read.
 *
 * Only `devin-session-token$…` credentials are tried: app.devin.ai's REST
 * surface rejects Windsurf API keys, and probing every pool account would turn
 * one panel open into N guaranteed 401s. When no such account exists, the
 * deploy-level Devin token is used (the same fallback as `/usage`).
 */
function collectCandidates(maxAccounts) {
  const out = [];
  const seenTokens = new Set();
  for (const summary of getAccountList({ view: 'summary' })) {
    if (summary.status !== 'active') continue;
    const account = getAccountInternal(summary.id);
    const token = String(account?.apiKey || '').trim();
    if (!token || !token.startsWith(SESSION_TOKEN_PREFIX)) continue;
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    out.push({ id: account.id, ref: accountRef(account.id), token });
  }

  if (out.length === 0) {
    const envToken = String(
      process.env.DEVIN_CONNECT_TOKEN
      || process.env.DEVIN_BACKEND_TOKEN
      || process.env.WINDSURF_API_KEY
      || '',
    ).trim();
    if (envToken) out.push({ id: 'env-token', ref: accountRef('env-token'), token: envToken });
  }

  const truncated = out.length > maxAccounts;
  return { items: out.slice(0, Math.max(0, maxAccounts)), truncated };
}

/**
 * Read one org with its representative account, falling back to another member
 * only when the failure is credential-shaped. A 403 / unresolved org is
 * org-wide: retrying a sibling cannot change the answer.
 */
async function readOrgWithFallback(group, { force, fetchImpl, now }) {
  let last = null;
  for (const member of group.accounts) {
    const token = String(member.token || getAccountInternal(member.id)?.apiKey || '').trim();
    if (!token) {
      last = { ok: false, error: 'no_account', httpStatus: 503 };
      continue;
    }
    const provided = { ok: true, accountId: member.id, token, accountRef: member.ref };
    last = await readQuotaBurnDown({
      account: provided,
      orgId: group.orgId,
      force,
      fetchImpl,
      now,
    });
    if (last.ok) return last;
    if (last.error === 'forbidden' || last.error === 'org_unresolved' || last.error === 'not_found') break;
  }
  return last;
}

/**
 * Read the ACU ledger for every distinct org reachable from the active pool.
 *
 * Returns `{ok:true, orgs:[…]}` even when some orgs fail — each org entry says
 * `ok:false` with its own reason, so the panel can render a per-org error state
 * without discarding the orgs that did answer.
 */
export async function readAcuUsageByOrg({
  force = false,
  fetchImpl = null,
  now = Date.now(),
  maxAccounts = MAX_ACCOUNTS,
} = {}) {
  const candidates = collectCandidates(maxAccounts);
  if (candidates.items.length === 0) {
    return {
      ok: false,
      error: 'no_account',
      httpStatus: 503,
      generatedAt: now,
      accountsScanned: 0,
      truncated: false,
      orgs: [],
    };
  }

  const resolved = await mapLimit(candidates.items, RESOLVE_CONCURRENCY, async (candidate) => {
    try {
      const orgId = await resolveOrgId({ token: candidate.token, fetchImpl, force });
      return { ...candidate, orgId };
    } catch (err) {
      return {
        ...candidate,
        error: err instanceof ReadError ? err.kind : 'upstream',
        status: err instanceof ReadError ? err.status : null,
      };
    }
  });

  const groups = new Map();
  const failures = [];
  for (const item of resolved) {
    if (!item.orgId) {
      failures.push({ ref: item.ref, error: item.error || 'upstream' });
      continue;
    }
    if (!groups.has(item.orgId)) {
      groups.set(item.orgId, {
        orgId: item.orgId,
        orgRef: orgRefOf(item.orgId),
        accounts: [],
      });
    }
    // Publish the mapping so pool-level arithmetic (the balance KPI) dedupes by
    // the same billing owner this panel reads. Raw org id stays server-side.
    rememberAccountOrg(item.id, item.orgId);
    groups.get(item.orgId).accounts.push({ id: item.id, ref: item.ref, token: item.token });
  }

  if (groups.size === 0) {
    const kind = worstError(failures.map((failure) => failure.error)) || 'upstream';
    return {
      ok: false,
      error: kind,
      httpStatus: httpStatusForKind(kind),
      generatedAt: now,
      accountsScanned: candidates.items.length,
      truncated: candidates.truncated,
      unresolvedAccounts: failures.length,
      orgs: [],
    };
  }

  const orgs = await mapLimit([...groups.values()], ORG_CONCURRENCY, async (group) => {
    const usage = await readOrgWithFallback(group, { force, fetchImpl, now });
    // Tokens are server-side only; the browser gets the account ids/refs it
    // already sees on the accounts panel.
    const base = {
      orgRef: group.orgRef,
      accounts: group.accounts.map(({ id, ref }) => ({ id, ref })),
    };

    if (!usage || !usage.ok) {
      return {
        ...base,
        ok: false,
        error: usage?.error || 'upstream',
        httpStatus: usage?.httpStatus || httpStatusForKind(usage?.error || 'upstream'),
        sources: usage?.sources || {},
      };
    }

    return {
      ...base,
      ok: true,
      accountId: usage.accountId,
      accountRef: usage.accountRef,
      cached: usage.cached,
      stale: usage.stale,
      partial: usage.partial,
      plan: usage.plan,
      billingValid: usage.billingValid,
      billingMethod: usage.billingMethod,
      availableCredits: usage.availableCredits,
      overageCredits: usage.overageCredits,
      quota: usage.quota,
      limits: usage.limits,
      cycle: usage.cycle,
      days: usage.days,
      products: usage.products,
      reset: usage.reset,
      serverNow: usage.serverNow,
      derived: {
        ...deriveAcuCells({ limits: usage.limits, cycle: usage.cycle }),
        latestDay: latestDayOf(usage.days, now),
      },
      sources: usage.sources,
    };
  });

  return {
    ok: true,
    generatedAt: now,
    accountsScanned: candidates.items.length,
    truncated: candidates.truncated,
    unresolvedAccounts: failures.length,
    orgs,
  };
}
