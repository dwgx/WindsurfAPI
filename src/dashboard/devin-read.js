import { retryAfterHeaderMs } from '../reset-hints.js';
/**
 * Dashboard Devin read path — H0.
 *
 * One helper owns fetch + cache + redaction for every dashboard card that reads
 * app.devin.ai. It is deliberately GET-ONLY: `readDevinJson` has no `method` and
 * no `body` parameter, so a write cannot be expressed through this module. The
 * write-classified `POST /users/post-auth` probe is never called here; the org is
 * resolved with `GET /users/current-membership` and the `GET /organizations`
 * fallback.
 *
 * Nothing is persisted: the only state is an in-memory Map, cleared on restart.
 * Every card builds a hand-written allowlist object; raw upstream bodies never
 * reach the browser.
 */

import { createHash } from 'node:crypto';
import { VERSION } from '../version.js';
import { accountRef, redactCredentialFragments } from '../log-safety.js';
import { getAccountInternal, getAccountList } from '../auth.js';

export { accountRef };

export const BASE_URL = 'https://app.devin.ai/api';
export const MAX_BYTES = 256 * 1024;
export const MAX_STALE_MS = 30 * 60 * 1000;
export const ORG_TTL_MS = 10 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 200;

export const TTL_MS = {
  quota: 30_000,
  status: 30_000,
  limits: 30_000,
  daily: 30_000,
  spending: 60_000,
  suspended: 30_000,
  unpaid: 30_000,
  autorecharge: 60_000,
  models: 300_000,
  org: ORG_TTL_MS,
};

const ORG_RE = /^org-[A-Za-z0-9-]+$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export class ReadError extends Error {
  constructor(kind, { status = null, detail = null, cause = undefined } = {}) {
    super(kind);
    this.name = 'ReadError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    if (cause !== undefined) this.cause = cause;
  }
}

let _fetchImpl = null;
let _now = () => Date.now();
const _cache = new Map();
const _inflight = new Map();

/** Test seam: inject the fetch implementation (null restores global fetch). */
export function __setFetchImplForTest(fn) {
  _fetchImpl = typeof fn === 'function' ? fn : null;
}

/** Test seam: inject the clock used for TTL / stale decisions. */
export function __setNowForTest(fn) {
  _now = typeof fn === 'function' ? fn : () => Date.now();
}

/** Test seam: drop every cached snapshot and in-flight marker. */
export function __resetReadCache() {
  _cache.clear();
  _inflight.clear();
}

function hashToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

/**
 * Cache key for one account + one logical source. The raw token is never part of
 * the key; its digest makes a key rotation invalidate the entry.
 */
export function cacheKey({ accountId, token, name } = {}) {
  return `${String(accountId || 'unknown')}:${hashToken(token).slice(0, 12)}:${String(name || 'source')}`;
}

function assertPath(path) {
  const value = typeof path === 'string' ? path : '';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')
    || CONTROL_CHARS.test(value) || value.includes('\\') || /\s/.test(value)) {
    throw new ReadError('bad_path', { status: 500 });
  }
  return value;
}

function assertOrg(orgId) {
  const value = String(orgId || '');
  if (!ORG_RE.test(value)) throw new ReadError('bad_org', { status: 500 });
  return value;
}

function headerValue(res, name) {
  try {
    return res?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function mapStatus(status, res) {
  if (status === 401) return new ReadError('unauthorized', { status });
  if (status === 403) return new ReadError('forbidden', { status });
  if (status === 404) return new ReadError('not_found', { status });
  if (status === 429) {
    const retryAfterMs = retryAfterHeaderMs(headerValue(res, 'retry-after'));
    return new ReadError('rate_limited', {
      status,
      detail: retryAfterMs !== null ? { retryAfterMs } : null,
    });
  }
  if (status >= 300 && status < 400) return new ReadError('redirect_blocked', { status });
  return new ReadError('upstream', { status });
}

/**
 * GET one app.devin.ai JSON document.
 *
 * @param {object} opts
 * @param {string} opts.token Bearer token (required)
 * @param {string} opts.path Absolute path under /api, e.g. `/org-x/billing/status`
 * @param {string} [opts.orgId] adds `x-cog-org-id` (must look like `org-…`)
 * @param {Function} [opts.fetchImpl] injectable transport (tests)
 * @param {number} [opts.timeoutMs] abort budget (default 5 s)
 * @param {number} [opts.maxBytes] body cap (default 256 KiB)
 */
export async function readDevinJson({
  token,
  path,
  orgId = '',
  fetchImpl = null,
  timeoutMs = 5000,
  maxBytes = MAX_BYTES,
} = {}) {
  if (!token || typeof token !== 'string') throw new ReadError('no_account', { status: 503 });
  const safePath = assertPath(path);
  const org = orgId ? assertOrg(orgId) : '';
  const fetchFn = fetchImpl || _fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new ReadError('upstream', { status: 502 });

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': `WindsurfAPI/${VERSION}`,
  };
  if (org) headers['x-cog-org-id'] = org;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : null;
  let res;
  try {
    res = await fetchFn(`${BASE_URL}${safePath}`, {
      method: 'GET',
      headers,
      redirect: 'error',
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof ReadError) throw err;
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ReadError('timeout', { status: null, cause: err });
    }
    const causeText = String(err?.cause?.message || err?.message || '');
    if (/redirect/i.test(causeText)) throw new ReadError('redirect_blocked', { status: null, cause: err });
    throw new ReadError('upstream', { status: null, cause: err });
  }

  const status = Number(res?.status) || 0;
  if (!res?.ok) {
    clearTimeout(timer);
    throw mapStatus(status, res);
  }

  const contentLength = Number(headerValue(res, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    clearTimeout(timer);
    throw new ReadError('too_large', { status });
  }

  // Keep the abort timer armed through body consumption: a server that sends
  // headers promptly but drips (or never finishes) the body must still time
  // out. Enforce maxBytes per chunk so an oversized body is aborted while it
  // is being read, not after `res.text()` has already allocated all of it.
  let text;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        total += buf.length;
        if (total > maxBytes) {
          try { controller?.abort(); } catch {}
          try { await reader.cancel(); } catch {}
          throw new ReadError('too_large', { status });
        }
        chunks.push(buf);
      }
      text = Buffer.concat(chunks, total).toString('utf8');
    } else {
      text = typeof res.text === 'function' ? await res.text() : '';
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ReadError('too_large', { status });
    }
  } catch (err) {
    if (err instanceof ReadError) throw err;
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ReadError('timeout', { status, cause: err });
    }
    throw new ReadError('upstream', { status, cause: err });
  } finally {
    clearTimeout(timer);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ReadError('malformed', { status, cause: err });
  }
}

/**
 * Resolve the org id with GET-only calls.
 *
 * Order: explicit/env `DEVIN_BACKEND_ORG_ID` → `GET /users/current-membership`
 * (`org.org_id`) → `GET /organizations` (primary flag, or the only org).
 * Multiple orgs with no primary is `org_unresolved` — never a guess.
 */
export async function resolveOrgId({ token, fetchImpl = null, preferredOrgId = '', force = false } = {}) {
  const override = String(preferredOrgId || process.env.DEVIN_BACKEND_ORG_ID || '').trim();
  if (ORG_RE.test(override)) return override;

  const key = `org:${hashToken(token).slice(0, 12)}`;
  const result = await readCached(key, ORG_TTL_MS, async () => {
    try {
      const who = await readDevinJson({ token, path: '/users/current-membership', fetchImpl });
      const id = who?.org?.org_id || who?.org_id || who?.organization?.org_id;
      if (ORG_RE.test(String(id || ''))) return id;
    } catch (err) {
      if (err instanceof ReadError && (err.kind === 'unauthorized' || err.kind === 'forbidden')) throw err;
    }

    const orgs = await readDevinJson({ token, path: '/organizations', fetchImpl });
    const list = Array.isArray(orgs) ? orgs : (orgs?.organizations || orgs?.orgs || []);
    const valid = list
      .map((org) => String(org?.org_id || org?.id || ''))
      .filter((id) => ORG_RE.test(id));
    const primary = Array.isArray(list)
      ? list.find((org) => org?.is_primary_org === true
        && ORG_RE.test(String(org?.org_id || org?.id || '')))
      : null;
    if (primary) return String(primary.org_id || primary.id);
    if (valid.length === 1) return valid[0];
    throw new ReadError('org_unresolved', { status: 502 });
  }, { force });

  if (!result.ok) throw new ReadError(result.error, { status: result.status ?? null });
  return result.value;
}

function remember(key, value, fetchedAt, ttlMs) {
  if (!_cache.has(key) && _cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, fetchedAt, ttlMs });
}

/**
 * Per-process TTL cache with single-flight and bounded stale-on-error.
 *
 * - fresh hit → `{ok:true, cached:true, stale:false}`
 * - concurrent miss → one loader call, every waiter gets the same result
 * - loader error → last good value as `stale:true` (401/429/5xx/timeout), for at
 *   most MAX_STALE_MS; a 403 is never served from cache.
 */
export async function readCached(key, ttlMs, loader, { force = false } = {}) {
  const now = _now();
  const hit = _cache.get(key);
  if (!force && hit && now - hit.fetchedAt < ttlMs) {
    return { ok: true, value: hit.value, fetchedAt: hit.fetchedAt, ageMs: now - hit.fetchedAt, stale: false, cached: true };
  }
  const pending = _inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await loader();
      const fetchedAt = _now();
      remember(key, value, fetchedAt, ttlMs);
      return { ok: true, value, fetchedAt, ageMs: 0, stale: false, cached: false };
    } catch (err) {
      const kind = err instanceof ReadError ? err.kind : 'upstream';
      const status = err instanceof ReadError ? err.status : null;
      const last = _cache.get(key);
      if (kind !== 'forbidden' && last && _now() - last.fetchedAt <= MAX_STALE_MS) {
        return {
          ok: true,
          value: last.value,
          fetchedAt: last.fetchedAt,
          ageMs: _now() - last.fetchedAt,
          stale: true,
          cached: true,
          error: kind,
          status,
        };
      }
      return { ok: false, error: kind, status, cached: false };
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);
  return promise;
}

/** Read-only cache probe. Never fetches; null once the entry is beyond max-stale. */
export function peekCached(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  const ageMs = _now() - hit.fetchedAt;
  if (ageMs > MAX_STALE_MS) return null;
  return { value: hit.value, fetchedAt: hit.fetchedAt, ageMs, stale: ageMs >= hit.ttlMs };
}

/** Redact credentials and internal identifiers from free-text upstream fields. */
export function redactUpstreamText(text, max = 200) {
  const limit = Number.isFinite(max) && max > 0 ? max : 200;
  const cleaned = redactCredentialFragments(String(text ?? ''))
    .replace(/\borg-[A-Za-z0-9-]{6,}\b/g, '[org-redacted]')
    .replace(/\buser-[A-Za-z0-9-]{6,}\b/g, '[user-redacted]')
    .replace(/\bacct_[A-Za-z0-9-]{6,}\b/g, '[acct-redacted]')
    .replace(EMAIL_RE, '[email-redacted]')
    .replace(CONTROL_CHARS, '\u00b7');
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}\u2026` : cleaned;
}

/**
 * Select the account whose token the card should read with.
 *
 * Explicit id → that account (404 if unknown). No id → first active pool account,
 * then the env-token deploy. The returned object is the only place a raw token
 * lives; card payloads carry `accountId` + hashed `accountRef` only.
 */
export function resolveAccount(id) {
  if (id) {
    const account = getAccountInternal(id);
    if (!account) return { ok: false, error: 'account_not_found', status: 404 };
    if (!account.apiKey) return { ok: false, error: 'no_account', status: 503 };
    return { ok: true, accountId: account.id, token: account.apiKey, accountRef: accountRef(account.id) };
  }

  const first = getAccountList({ view: 'summary' }).find((account) => account.status === 'active');
  if (first) {
    const account = getAccountInternal(first.id);
    if (account?.apiKey) {
      return { ok: true, accountId: account.id, token: account.apiKey, accountRef: accountRef(account.id) };
    }
  }

  // app.devin.ai accepts the Devin session token; DEVIN_BACKEND_TOKEN is a
  // different credential class and 401s on the GET read surface. Prefer the
  // session token, then fall back for deployments that only set the backend
  // token or the documented single-token WINDSURF_API_KEY shape.
  const token = String(
    process.env.DEVIN_CONNECT_TOKEN
      || process.env.DEVIN_BACKEND_TOKEN
      || process.env.WINDSURF_API_KEY
      || '',
  ).trim();
  if (token) return { ok: true, accountId: 'env-token', token, accountRef: accountRef('env-token') };
  return { ok: false, error: 'no_account', status: 503 };
}

/** Project one cached source result into the per-card `sources` map. */
export function sourceSummary(result) {
  if (!result) return { ok: false, error: 'upstream' };
  const out = {
    ok: !!result.ok,
    stale: !!result.stale,
    fetchedAt: result.fetchedAt ?? null,
  };
  if (result.error) out.error = result.error;
  if (result.status) out.status = result.status;
  return out;
}

const ERROR_PRECEDENCE = [
  'forbidden',
  'unauthorized',
  'rate_limited',
  'timeout',
  'upstream',
  'malformed',
  'too_large',
  'redirect_blocked',
  'org_unresolved',
  'bad_path',
  'bad_org',
  'not_found',
  'account_not_found',
  'no_account',
];

/** Aggregate error precedence across several sources. */
export function worstError(kinds) {
  const list = (Array.isArray(kinds) ? kinds : [kinds]).filter(Boolean);
  for (const kind of ERROR_PRECEDENCE) if (list.includes(kind)) return kind;
  return list[0] || 'upstream';
}

/** Browser-facing HTTP status for a ReadError kind. */
export function httpStatusForKind(kind) {
  switch (kind) {
    case 'unauthorized': return 401;
    case 'forbidden': return 403;
    case 'not_found':
    case 'account_not_found': return 404;
    case 'rate_limited': return 429;
    case 'timeout': return 504;
    case 'no_account': return 503;
    case 'bad_path':
    case 'bad_org': return 500;
    default: return 502;
  }
}

/**
 * Cache-only billing overlay for the pool card. Never fetches, so the 20 s pool
 * poll stays at zero upstream cost. Returns null when no card has primed the cache.
 */
export function peekBillingFacts({ accountId, token } = {}) {
  if (!accountId || !token) return null;
  const status = peekCached(cacheKey({ accountId, token, name: 'status' }));
  const spending = peekCached(cacheKey({ accountId, token, name: 'spending' }));
  if (!status && !spending) return null;
  const statusValue = status?.value && typeof status.value === 'object' ? status.value : {};
  const spendingValue = spending?.value && typeof spending.value === 'object' ? spending.value : {};
  return {
    plan: typeof statusValue.plan_slug === 'string' ? statusValue.plan_slug : null,
    billingValid: typeof statusValue.is_subscription_valid === 'boolean' ? statusValue.is_subscription_valid : null,
    spendingState: typeof spendingValue.state === 'string' ? spendingValue.state : null,
    fetchedAt: Math.max(status?.fetchedAt || 0, spending?.fetchedAt || 0) || null,
    stale: !!(status?.stale || spending?.stale),
  };
}
