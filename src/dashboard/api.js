/**
 * Dashboard API route handlers.
 * All routes are under /dashboard/api/*.
 */

import { config, log } from '../config.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAccountList, getAccountCount, getAccountListStats, getAccountPublic, addAccountByKey, addAccountByToken,
  removeAccount, setAccountStatus, resetAccountErrors, updateAccountLabel,
  isAuthenticated, probeAccount, ensureLsForAccount,
  refreshCredits, refreshAllCredits,
  setAccountBlockedModels, setAccountTokens, setAccountTier, setAccountSpendPolicy,
  getAccountInternal, isLocalBindHost, maskApiKey, safeEqualString,
  checkLockout, failedAuthAttempt, successfulAuthAttempt,
  getDroughtSummary, getPoolHealthWindow,
} from '../auth.js';
import { restartLsForProxy } from '../langserver.js';
import { getLsStatus, stopLanguageServerAndWait, startLanguageServer, isLanguageServerRunning, getLsAdmissionStatus } from '../langserver.js';
import { getStats, resetStats, recordRequest, exportStats, importStats } from './stats.js';
import { getConnectMetrics, resetConnectMetrics } from '../devin-connect-metrics.js';
import { cacheStats, cacheClear } from '../cache.js';
import {
  getExperimental, setExperimental, getTunables, setTunables, getPrefs, setPrefs, getSystemPrompts, setSystemPrompts, resetSystemPrompt,
  getCredentials, setRuntimeApiKey, setRuntimeDashboardPassword,
  verifyPassword, getEffectiveApiKey, getEffectiveDashboardPasswordStored,
  getBackendSwitch, getBackendSwitchOverrides, setBackendSwitches,
  getBreakerTunables, getBreakerOverrides, setBreakerTunables,
  getQuotaTunables, getQuotaOverrides, setQuotaTunables,
} from '../runtime-config.js';
import { poolStats as convPoolStats, poolClear as convPoolClear } from '../conversation-pool.js';
import { getLogs, subscribeToLogs, unsubscribeFromLogs } from './logger.js';
import { getProxyConfig, getProxyConfigMasked, setGlobalProxy, setAccountProxy, removeProxy, getEffectiveProxy } from './proxy-config.js';
import { MODELS, MODEL_TIER_ACCESS as _TIER_TABLE, getTierModels as _getTierModels } from '../models.js';
import { windsurfLogin, refreshFirebaseToken, reRegisterWithCodeium } from './windsurf-login.js';
import { getModelAccessConfig, setModelAccessMode, setModelAccessList, addModelToList, removeModelFromList, setDefaultModel } from './model-access.js';
import { checkMessageRateLimit } from '../windsurf-api.js';
import { getNativeBridgeConfigStatus } from '../cascade-native-bridge.js';
import { getNativeBridgeStats } from '../native-bridge-stats.js';
import { assertPublicUrlHost } from '../image.js';
import { validateHostFormat, resolveProxyConnectHost } from '../net-safety.js';
import { discoverWindsurfCredentials, isLoopbackAddress } from './local-windsurf.js';
import { parseAccountText, classifyToken } from './account-text-parser.js';
import { detectDockerSelfUpdate, runDockerSelfUpdate } from './docker-self-update.js';
import { BatchImportParseError, parseBatchImportInput } from './import-parser.js';

function shouldPrewarmLsOnAccountAdd() {
  return process.env.LS_PREWARM_ON_ACCOUNT_ADD === '1' || process.env.LS_PREWARM_PROXIES === '1';
}

async function runAccountWarmup(accountId, { probe = true, requireOptIn = true } = {}) {
  if (requireOptIn && !shouldPrewarmLsOnAccountAdd()) return { ok: true, skipped: true, reason: 'prewarm_disabled' };
  const ls = await ensureLsForAccount(accountId);
  if (!ls?.ok) return { ok: false, skipped: false, reason: ls?.errorType || 'ls_start_failed', ls };
  if (!probe) return { ok: true, skipped: false, ls };
  try {
    const probeResult = await probeAccount(accountId);
    return { ok: true, skipped: false, ls, probe: probeResult };
  } catch (e) {
    return { ok: false, skipped: false, reason: e?.message || 'probe_failed', ls };
  }
}

function scheduleAccountWarmup(accountId, { probe = true } = {}) {
  if (!shouldPrewarmLsOnAccountAdd()) return;
  runAccountWarmup(accountId, { probe, requireOptIn: false })
    .then(r => {
      if (r && !r.ok) log.warn(`LS warmup failed for account ${accountId}: ${r.reason || 'unknown_error'}`);
      return null;
    })
    .catch(e => log.warn(`LS ensure failed: ${e.message}`));
}

export function parseProxyUrl(proxy) {
  // Normalize whitespace so "socks5 127.0.0.1   1089" and
  // "socks5://127.0.0.1:1089" both parse correctly.
  const s = String(proxy).replace(/\s+/g, ' ').trim();
  // Try canonical URL form first: protocol://[user:pass@]host:port
  // Host must not contain spaces — otherwise "http 1.2.3.4:8080" would
  // greedily capture "http 1.2.3.4" as the host.
  let m = s.match(/^(?:(\w+):\/\/)?(?:([^\s:]+):([^\s@]+)@)?([^\s:]+):(\d+)$/);
  // Fallback: "type host port" (space-separated, no :// and no colon)
  if (!m) m = s.match(/^(\w+)\s+([^\s:]+)\s+(\d+)$/);
  // Fallback: "type host:port" (type prefix, no ://)
  if (!m) m = s.match(/^(\w+)\s+([^\s:]+):(\d+)$/);
  if (!m) return null;
  if (m.length === 4) {
    // space-or-type-separated form: [type] host port
    return {
      type: m[1],
      host: m[2],
      port: parseInt(m[3]),
      username: '',
      password: '',
    };
  }
  return {
    type: m[1] || 'http',
    host: m[4],
    port: parseInt(m[5]),
    username: m[2] || '',
    password: m[3] || '',
  };
}

export async function validateProxyHost(proxy) {
  if (!proxy?.host) return;
  if (config.allowPrivateProxyHosts) {
    await validateHostFormat(proxy.host);
  } else {
    await assertPublicUrlHost(proxy.host);
  }
}

export function buildBatchProxyBinding(result, proxy) {
  const accountId = result?.account?.id || null;
  if (!result?.success || !proxy || !accountId) return null;
  const parsed = parseProxyUrl(proxy);
  if (!parsed) return null;
  return {
    accountId,
    proxy: parsed,
  };
}

// AUTH-1 CORS hardening: the dashboard used to answer every request (and
// every OPTIONS preflight) with `Access-Control-Allow-Origin: *` while also
// advertising the X-Dashboard-Password header, which invites any web origin
// to script authenticated dashboard calls from a victim's browser. We now
// reflect only origins the operator explicitly allowlists via
// DASHBOARD_CORS_ORIGINS (csv). Unset ⇒ no ACAO header at all (same-origin
// dashboard use needs none; cross-origin is denied by the browser). The
// literal `*` is still honoured but only when the operator opts in by
// listing `*` in DASHBOARD_CORS_ORIGINS.
function resolveCorsOrigin(req) {
  const origin = req?.headers?.origin || '';
  if (!origin) return '';
  const allow = String(process.env.DASHBOARD_CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!allow.length) return '';
  if (allow.includes('*')) return '*';
  return allow.includes(origin) ? origin : '';
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Password',
  };
  // Origin resolved once per request at the top of handleDashboardApi and
  // stashed on res. Only emit ACAO when an origin is actually allowed; a
  // specific echoed origin also needs Vary: Origin so caches don't serve
  // one origin's CORS decision to another.
  const acao = res?._dashboardCorsOrigin || '';
  if (acao) {
    headers['Access-Control-Allow-Origin'] = acao;
    if (acao !== '*') headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(data);
}

function dashboardUrl(req) {
  return new URL(req?.url || '/', 'http://localhost');
}

function parseBoundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getAccountsPayload(req) {
  const url = dashboardUrl(req);
  const qs = url.searchParams;
  const wantsPaged = qs.has('page') || qs.has('pageSize') || qs.has('offset') || qs.has('limit') || qs.has('view') || qs.has('filter') || qs.has('tier');
  if (!wantsPaged) return { accounts: getAccountList() };

  const view = qs.get('view') === 'summary' ? 'summary' : 'full';
  const pageSize = parseBoundedInt(qs.get('pageSize') ?? qs.get('limit'), 50, { min: 1, max: 1000 });
  const page = parseBoundedInt(qs.get('page'), 1, { min: 1, max: 1000000 });
  const explicitOffset = qs.has('offset')
    ? parseBoundedInt(qs.get('offset'), 0, { min: 0, max: Number.MAX_SAFE_INTEGER })
    : null;
  const offset = explicitOffset ?? ((page - 1) * pageSize);
  const filter = qs.get('filter') === 'flagged' ? 'flagged' : '';
  const tier = ['pro', 'free', 'unknown', 'expired'].includes(qs.get('tier')) ? qs.get('tier') : '';
  const stats = getAccountListStats();
  const total = filter === 'flagged'
    ? stats.flagged
    : (tier ? (stats.byTier?.[tier] ?? 0) : stats.total);
  const accounts = getAccountList({ view, offset, limit: pageSize, filter, tier });
  return {
    accounts,
    page,
    pageSize,
    offset,
    total,
    hasMore: offset + accounts.length < total,
    view,
    filter,
    tier,
    stats,
  };
}

// v2.0.56: client IP extraction. Mirrors caller-key.js TRUST_PROXY_XFF
// — we only honour X-Forwarded-For when the operator opts in. Default is
// `socket.remoteAddress` so a rogue dashboard caller can't dodge the
// brute-force lockout by spoofing XFF and ending up on a fresh bucket.
//
// XFF-1 (audit P1): the LEFTMOST X-Forwarded-For token is fully attacker-
// controllable — a client just prepends any IP. Taking parts[0] let an
// attacker rotate the value every request to land in a fresh lockout bucket
// and never reach the 5-strike ban. Trusted proxies APPEND the peer they
// received the connection from to the RIGHT, so the real client IP is counted
// from the right by TRUST_PROXY_HOPS (default 1). This MUST stay identical to
// src/caller-key.js clientIp()/trustedProxyHops() (the source of truth) so the
// dashboard lockout and the caller-key fingerprint can't drift apart — update
// both together.
function dashboardTrustedProxyHops() {
  const raw = Number(process.env.TRUST_PROXY_HOPS);
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

function dashboardClientIp(req) {
  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  if (process.env.TRUST_PROXY_X_FORWARDED_FOR !== '1') return remote;
  const parts = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) return remote;
  // The last `hops` entries were appended by our trusted proxy chain; the real
  // client IP is the entry just before them. If the header is shorter than the
  // configured hop count it can't be trusted — fall back to the socket peer.
  const idx = parts.length - dashboardTrustedProxyHops();
  return (idx >= 0 ? parts[idx] : '') || remote;
}

function checkAuth(req) {
  // Header-only auth. logs/stream switched from EventSource to fetch +
  // ReadableStream months ago, so the EventSource exception is gone and
  // ?pwd= query passwords would only leak into URL access logs and
  // browser history without any callers needing them.
  //
  // v2.0.55 (audit H1): on non-local binds we no longer fall back to
  // `config.apiKey` as the dashboard password. That fallback turned
  // every chat-API caller into a service operator (list accounts,
  // reveal-key, change proxy, trigger LS / docker self-update). Public
  // bind WITHOUT DASHBOARD_PASSWORD now fails closed; operators must
  // set DASHBOARD_PASSWORD explicitly. Localhost-only deployments keep
  // the convenience fallback so single-user `docker-compose up` doesn't
  // suddenly require an extra env.
  //
  // v2.0.56: dashboardPassword now comes from runtime-config (settable
  // from the dashboard) before falling back to env. apiKey fallback
  // (localhost only) also honours the runtime override.
  const pw = req.headers['x-dashboard-password'] || '';
  const storedDashboardPw = getEffectiveDashboardPasswordStored();
  if (storedDashboardPw) return verifyPassword(pw, storedDashboardPw);
  if (isLocalBindHost()) {
    const effectiveApiKey = getEffectiveApiKey();
    if (effectiveApiKey) return safeEqualString(pw, effectiveApiKey);
    // AUTH-1: localhost with NO secret configured used to be treated as
    // authenticated for every caller. Even on a loopback bind that lets any
    // process on the host (or anything that can reach 127.0.0.1 via a
    // container port-map / SSH forward / malicious localhost web page hitting
    // the dashboard) drive privileged endpoints unauthenticated. Default is
    // now fail-closed; operators who relied on the old open-local convenience
    // must opt in explicitly with DASHBOARD_ALLOW_NO_AUTH=1.
    return process.env.DASHBOARD_ALLOW_NO_AUTH === '1';
  }
  return false;
}

// AUTH-1: explicit re-auth for the reveal-key endpoint. The caller must
// present the dashboard password AGAIN in this request even though ambient
// dashboard auth already passed — via body.password / body.dashboardPassword
// or the X-Dashboard-Password-Confirm header. Mirrors checkAuth()'s secret
// resolution order (runtime/env dashboard password, then localhost API-key
// fallback). When no secret is configured at all the re-auth is only accepted
// on an opt-in open-local dashboard (DASHBOARD_ALLOW_NO_AUTH=1) — otherwise
// checkAuth would already have failed closed before we get here.
function confirmReauth(req, body) {
  const proof = (body && typeof body === 'object'
    && (typeof body.password === 'string' ? body.password
      : typeof body.dashboardPassword === 'string' ? body.dashboardPassword : ''))
    || req?.headers?.['x-dashboard-password-confirm']
    || '';
  const storedDashboardPw = getEffectiveDashboardPasswordStored();
  if (storedDashboardPw) return verifyPassword(proof, storedDashboardPw);
  if (isLocalBindHost()) {
    const effectiveApiKey = getEffectiveApiKey();
    if (effectiveApiKey) return safeEqualString(proof, effectiveApiKey);
    return process.env.DASHBOARD_ALLOW_NO_AUTH === '1';
  }
  return false;
}

// Mask an email for logs: keep first char + domain, redact the rest of the
// local part (a@b.com -> a***@b.com). Never log the full address.
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? s[0] + '***' : '';
  return s[0] + '***' + s.slice(at);
}

// Pull the auth token out of whatever the user pasted after finishing the
// Windsurf sign-in: a full redirect URL (token in query or #fragment), or the
// bare token string itself. Returns '' if nothing token-shaped is found. The
// caller must never log the raw input (it may contain a live token).
//
// Two diagnostic cases throw an ERR_* instead of returning '' so the user gets
// an actionable reason rather than a generic "no token found":
//   - ERR_INTERMEDIATE_CALLBACK: the pasted URL is a federated *intermediate*
//     callback (has ?code= on a /auth/<provider>/callback path). That code can
//     only be exchanged by windsurf.com's backend (holds the client_secret) —
//     the user pasted too early; they must wait for the show-auth-token page and
//     paste the token shown there.
//   - ERR_OAUTH_UPSTREAM:<error>[:<desc>]: the provider redirected back an
//     ?error= (e.g. access_denied) — surface the real reason.
// Exported for unit testing (also used by the /oauth/callback endpoint).
export function extractOAuthToken(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const pick = (params) => params.get('access_token') || params.get('token') || params.get('auth_token') || '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const fromQuery = pick(u.searchParams);
      if (fromQuery) return fromQuery.trim();
      // token may live in the #fragment (implicit flow): #access_token=...&...
      const frag = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
      const fragParams = frag ? new URLSearchParams(frag) : null;
      if (fragParams) {
        const fromHash = pick(fragParams);
        if (fromHash) return fromHash.trim();
      }
      // No token present — before giving up, distinguish an explicit upstream
      // error or an intermediate callback so the caller can explain what to do.
      const upstreamErr = u.searchParams.get('error') || (fragParams && fragParams.get('error')) || '';
      if (upstreamErr) {
        const desc = u.searchParams.get('error_description') || (fragParams && fragParams.get('error_description')) || '';
        const e = new Error('ERR_OAUTH_UPSTREAM:' + upstreamErr + (desc ? ':' + desc : ''));
        e.code = 'ERR_OAUTH_UPSTREAM';
        throw e;
      }
      if (u.searchParams.get('code') && /\/auth\/[^/]+\/callback/i.test(u.pathname)) {
        const e = new Error('ERR_INTERMEDIATE_CALLBACK');
        e.code = 'ERR_INTERMEDIATE_CALLBACK';
        throw e;
      }
    } catch (e) {
      // Propagate our own diagnostic ERR_* codes; swallow URL-parse failures
      // (malformed input) and fall through to bare-token handling.
      if (e && typeof e.message === 'string' && e.message.startsWith('ERR_')) throw e;
    }
    return '';
  }
  // Bare paste: accept a raw token (session/auth token), reject anything with
  // whitespace (that's not a token).
  if (/\s/.test(raw)) return '';
  return raw;
}

// Decide whether to persist a login password into the encrypted cred store so a
// dead session can auto-relogin. Storing a user's password is privacy-sensitive,
// so on a PUBLIC bind it requires BOTH an operator opt-in env AND a per-request
// opt-in (the dashboard checkbox). The "local" fast-path requires the request to
// ALSO come from a loopback peer — not just a loopback BIND host. Behind a
// reverse proxy (openresty → app on 127.0.0.1) isLocalBindHost() is always true,
// so checking bind alone would let any authenticated REMOTE user silently
// persist their plaintext password, defeating the DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE
// gate. Mirror the /accounts/import-local double gate. Store is still a no-op
// unless DEVIN_CONNECT_CRED_KEY is set.
function credStoreGateOpen(wantStore, req) {
  if (wantStore !== true) return false;
  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  if (isLocalBindHost() && isLoopbackAddress(remote)) return true;
  return process.env.DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE === '1';
}

async function processWindsurfLogin({ email, password, loginProxy, autoAdd, storeCredential: wantStore, req }) {
  if (!email || !password) {
    const err = new Error('ERR_EMAIL_PASSWORD_REQUIRED');
    err.statusCode = 400;
    err.code = 'ERR_EMAIL_PASSWORD_REQUIRED';
    throw err;
  }

  // Use provided proxy, or global proxy
  const proxy = loginProxy?.host ? loginProxy : getProxyConfig().global;
  const result = await windsurfLogin(email, password, proxy);

  // Auto-add to account pool if requested
  let account = null;
  if (autoAdd !== false) {
    account = addAccountByKey(result.apiKey, result.name || email);
    // Persist refresh token via the setter so it survives restart and
    // the background Firebase-renewal loop can find it.
    if (result.refreshToken) {
      setAccountTokens(account.id, { refreshToken: result.refreshToken, idToken: result.idToken });
    }
    // Persist the per-account proxy we used for login so chat requests
    // also egress through the same IP, then warm up a matching LS.
    if (loginProxy?.host) setAccountProxy(account.id, loginProxy);
    scheduleAccountWarmup(account.id);

    // Gap A+B: persist the password (encrypted) so a dead session_id can
    // auto-relogin (reLoginAccount). Gated by credStoreGateOpen — on a public
    // bind this needs both DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE=1 and the
    // request's storeCredential:true. Best-effort: a store failure must never
    // break the login that already succeeded. Plaintext password is never
    // logged (only the masked email).
    if (credStoreGateOpen(wantStore, req)) {
      try {
        const { storeCredential, isCredStoreEnabled } = await import('../devin-connect-credentials.js');
        if (isCredStoreEnabled()) {
          storeCredential(email, password);
          log.info(`Credential stored for auto-relogin: ${maskEmail(email)}`);
        }
      } catch (e) {
        log.warn(`Could not persist credential for re-login: ${e.message}`);
      }
    }
  }

  return {
    success: true,
    // When autoAdd:false, the caller is doing a one-time login to retrieve the
    // upstream key without storing it (e.g. external tooling that wants the
    // raw key) — they need the full apiKey. When autoAdd is true, the key is
    // already persisted in the pool and the response only echoes a masked
    // form (the dashboard never needs the raw key in the listing path; the
    // explicit reveal-key endpoint covers the rare per-account export case).
    ...(autoAdd === false
      ? { apiKey: result.apiKey }
      : { apiKey_masked: maskApiKey(result.apiKey) }),
    name: result.name,
    email: result.email,
    apiServerUrl: result.apiServerUrl,
    account: account ? { id: account.id, email: account.email, status: account.status } : null,
  };
}

/**
 * Handle all /dashboard/api/* requests.
 */
export async function handleDashboardApi(method, subpath, body, req, res) {
  // Resolve the CORS origin once (allowlist-gated, default none) so every
  // json() response — including the OPTIONS preflight below — reflects the
  // same decision instead of a blanket `*`.
  if (res) res._dashboardCorsOrigin = resolveCorsOrigin(req);
  if (method === 'OPTIONS') return json(res, 204, '');

  // v2.0.56: brute-force lockout — apply BEFORE the auth check so the
  // password comparison itself can't be used as an oracle once the IP is
  // banned. /auth route is exempt (unauthenticated probe used by the UI
  // to learn whether auth is required) but still feeds the lockout when
  // it serves as a credential-verification endpoint.
  const clientIp = dashboardClientIp(req);
  const lock = checkLockout(clientIp);
  if (lock.blocked) {
    res.setHeader?.('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)));
    return json(res, 429, {
      error: `Too many failed attempts. IP banned for ${Math.ceil(lock.retryAfterMs / 1000)}s.`,
      retryAfterMs: lock.retryAfterMs,
    });
  }

  // Auth check (except for auth verification endpoint)
  if (subpath !== '/auth' && !checkAuth(req)) {
    // Only count this toward the brute-force lockout when a NON-EMPTY password
    // was actually submitted — a wrong guess. A missing/empty header is the
    // normal pre-login state: the dashboard fires ~a dozen authed API calls
    // (overview/stats/accounts/…) on page load before the user has typed
    // anything, and counting each empty-password 401 as a "failed attempt"
    // banned the IP the instant the page opened. Mirrors the /auth probe below.
    if (String(req.headers['x-dashboard-password'] || '')) failedAuthAttempt(clientIp);
    return json(res, 401, { error: 'Unauthorized. Set X-Dashboard-Password header.' });
  }
  if (subpath !== '/auth') successfulAuthAttempt(clientIp);

  // ─── Auth ─────────────────────────────────────────────
  if (subpath === '/auth') {
    const storedPw = getEffectiveDashboardPasswordStored();
    const effectiveApiKey = getEffectiveApiKey();
    const hasSecret = !!(storedPw || effectiveApiKey);
    if (hasSecret) {
      const ok = checkAuth(req);
      // /auth is the credential-probe endpoint dashboards call before
      // showing the rest of the UI — count failures here so a brute-force
      // script doesn't get unlimited attempts via /auth alone.
      if (ok) successfulAuthAttempt(clientIp);
      else if (req.headers['x-dashboard-password']) failedAuthAttempt(clientIp);
      return json(res, 200, { required: true, valid: ok });
    }
    // No secret configured. AUTH-1: the open-local convenience is now
    // opt-in — only report the dashboard as open (required:false) on a
    // localhost bind when the operator set DASHBOARD_ALLOW_NO_AUTH=1, which
    // mirrors checkAuth(). Otherwise (default, and on public binds) checkAuth
    // fails closed, so the UI must show it as required-but-unconfigurable and
    // prompt the operator to set DASHBOARD_PASSWORD or API_KEY.
    if (isLocalBindHost() && process.env.DASHBOARD_ALLOW_NO_AUTH === '1') {
      return json(res, 200, { required: false });
    }
    return json(res, 200, { required: true, valid: false, locked: true });
  }

  // ─── Overview ─────────────────────────────────────────
  if (subpath === '/overview' && method === 'GET') {
    const stats = getStats();
    return json(res, 200, {
      uptime: process.uptime(),
      startedAt: stats.startedAt,
      accounts: getAccountCount(),
      authenticated: isAuthenticated(),
      langServer: getLsStatus(),
      totalRequests: stats.totalRequests,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      successRate: stats.totalRequests > 0
        ? ((stats.successCount / stats.totalRequests) * 100).toFixed(1)
        : '0.0',
      cache: cacheStats(),
      nativeBridge: getNativeBridgeStats(),
      nativeBridgeConfig: getNativeBridgeConfigStatus(),
      poolBalance: (() => {
        const s = getAccountListStats();
        return { total: s.balanceTotal, accounts: s.balanceAccounts };
      })(),
    });
  }

  // ─── Experimental features ────────────────────────────
  if (subpath === '/experimental' && method === 'GET') {
    return json(res, 200, { flags: getExperimental(), tunables: getTunables(), conversationPool: convPoolStats() });
  }
  if (subpath === '/experimental' && method === 'PUT') {
    // Numeric tunables (e.g. droughtThresholdPercent) ride the same endpoint
    // but must NOT go through setExperimental, which coerces every key to bool.
    const patch = { ...(body || {}) };
    let tunables;
    if (patch.tunables && typeof patch.tunables === 'object') {
      tunables = setTunables(patch.tunables);
    }
    delete patch.tunables;
    const flags = setExperimental(patch);
    // Dropping the toggle should also drop any live entries so nothing
    // resumes against a disabled feature on the next request.
    if (!flags.cascadeConversationReuse) convPoolClear();
    return json(res, 200, { success: true, flags, tunables: tunables ?? getTunables() });
  }
  if (subpath === '/experimental/conversation-pool' && method === 'DELETE') {
    const n = convPoolClear();
    return json(res, 200, { success: true, cleared: n });
  }

  // ─── System prompts (tool reinforcement, communication) ──
  if (subpath === '/system-prompts' && method === 'GET') {
    return json(res, 200, { prompts: getSystemPrompts() });
  }
  if (subpath === '/system-prompts' && method === 'PUT') {
    const prompts = setSystemPrompts(body || {});
    return json(res, 200, { success: true, prompts });
  }
  if (subpath.match(/^\/system-prompts\/[^/]+$/) && method === 'DELETE') {
    const key = subpath.split('/').pop();
    const prompts = resetSystemPrompt(key);
    return json(res, 200, { success: true, prompts });
  }

  // ─── Runtime backend switches (hot-flippable) + security status (read-only) ──
  // The six routing switches are migrated to runtime-config: an operator can
  // flip them here without a redeploy. GET reports each switch's EFFECTIVE value
  // plus its SOURCE ('config' when an override is set, else 'env' — which also
  // covers the historical default). The two credential-store env switches stay
  // READ-ONLY: they are a security boundary (a writable remote-cred-store toggle
  // would let a compromised dashboard self-authorize password storage), so they
  // are surfaced as booleans but never accepted on PUT. Secrets are reported as
  // a presence flag only, never the value.
  if (subpath === '/runtime-env-status' && method === 'GET') {
    const on = (v) => String(v || '').trim() === '1';
    const overrides = getBackendSwitchOverrides();
    const SWITCH_KEYS = ['devinConnect', 'devinOnly', 'devinCliMode', 'allowClientTools', 'loginHostFallback', 'autoRelogin'];
    const switches = {};
    for (const key of SWITCH_KEYS) {
      switches[key] = {
        value: getBackendSwitch(key),           // effective (config → env → default)
        override: overrides[key],               // null = not set → falling back to env
        source: overrides[key] === null ? 'env' : 'config',
      };
    }
    return json(res, 200, {
      // Flat effective values (back-compat with the prior read-only card shape).
      devinConnect: switches.devinConnect.value,
      devinOnly: switches.devinOnly.value,
      devinCliMode: switches.devinCliMode.value,
      allowClientTools: switches.allowClientTools.value,
      loginHostFallback: switches.loginHostFallback.value,
      autoRelogin: switches.autoRelogin.value,
      // Per-switch detail (effective value + override + source) for the toggle UI.
      switches,
      // Security boundary — env-only, read-only, never writable from here.
      remoteCredStore: on(process.env.DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE),
      credStoreEnabled: !!(process.env.DEVIN_CONNECT_CRED_KEY || '').trim(),
    });
  }

  // PUT — flip one or more backend switches. Whitelisted keys only (the setter
  // rejects everything else, including remoteCredStore/credStoreEnabled). A key
  // set to null CLEARS the override (falls back to env). devinCliMode accepts
  // only 'acp'|'print'; the rest are booleans.
  if (subpath === '/runtime-env-status' && method === 'PUT') {
    const overrides = setBackendSwitches(body || {});
    const SWITCH_KEYS = ['devinConnect', 'devinOnly', 'devinCliMode', 'allowClientTools', 'loginHostFallback', 'autoRelogin'];
    const switches = {};
    for (const key of SWITCH_KEYS) {
      switches[key] = {
        value: getBackendSwitch(key),
        override: overrides[key],
        source: overrides[key] === null ? 'env' : 'config',
      };
    }
    return json(res, 200, { success: true, switches });
  }

  // ─── Circuit-breaker / rate-limit tunables (hot-flippable) ──
  const breakerPayload = () => {
    const eff = getBreakerTunables(), ov = getBreakerOverrides(), knobs = {};
    for (const k of Object.keys(eff))
      knobs[k] = { value: eff[k], override: ov[k], source: ov[k] === null ? 'env' : 'config' };
    return { knobs };
  };
  if (subpath === '/breaker-config' && method === 'GET') return json(res, 200, breakerPayload());
  if (subpath === '/breaker-config' && method === 'PUT') {
    setBreakerTunables(body || {});
    return json(res, 200, { success: true, ...breakerPayload() });
  }

  // ─── Quota / on-demand spend tunables (global defaults, hot-flippable) ──
  // spendOnDemand + onDemandReserveUsd are the pool-wide defaults; each account
  // can still override them via PATCH /accounts/:id.
  const quotaPayload = () => {
    const eff = getQuotaTunables(), ov = getQuotaOverrides(), knobs = {};
    for (const k of Object.keys(eff))
      knobs[k] = { value: eff[k], override: ov[k], source: ov[k] === null ? 'env' : 'config' };
    return { knobs };
  };
  if (subpath === '/quota-config' && method === 'GET') return json(res, 200, quotaPayload());
  if (subpath === '/quota-config' && method === 'PUT') {
    setQuotaTunables(body || {});
    return json(res, 200, { success: true, ...quotaPayload() });
  }

  // ─── Proxy test — try an HTTP CONNECT through the given proxy ──
  if (subpath === '/test-proxy' && method === 'POST') {
    const { host, port, username, password, type = 'http' } = body || {};
    if (!host || !port) return json(res, 400, { ok: false, error: 'ERR_HOST_PORT_REQUIRED' });
    const startTime = Date.now();
    try {
      const result = await testProxy({ host, port: Number(port), username, password, type });
      return json(res, 200, { ok: true, ...result, latencyMs: Date.now() - startTime });
    } catch (err) {
      return json(res, 200, { ok: false, error: err.message, latencyMs: Date.now() - startTime });
    }
  }

  // ─── Self-update: pull latest code + request supervisor restart ──────
  if (subpath === '/self-update/check' && method === 'GET') {
    try {
      const info = await gitStatus();
      return json(res, 200, { ok: true, mode: 'git', ...info });
    } catch (err) {
      if (isSelfUpdateUnavailableError(err)) {
        // Git path is unavailable (most often docker). Fall back to
        // docker self-update via /var/run/docker.sock if the user
        // mounted it into the container; otherwise report the same
        // "manual command" hint we did before.
        const docker = await detectDockerSelfUpdate();
        if (docker.available) {
          return json(res, 200, {
            ok: true,
            mode: 'docker',
            image: docker.image,
            project: docker.project,
            workingDir: docker.workingDir,
          });
        }
        return json(res, 200, {
          ok: false,
          available: false,
          reason: err.reason,
          error: err.code,
          dockerReason: docker.reason,
          dockerDetail: docker.detail,
        });
      }
      return json(res, 200, { ok: false, error: err.message });
    }
  }
  if (subpath === '/self-update' && method === 'POST') {
    try {
      const before = await gitStatus();
      // Guard: working tree must be clean (ignoring untracked files like
      // accounts.json, stats.json, runtime-config.json which live in the
      // repo root but aren't checked in). If the tracked files were edited
      // manually (or pushed via SFTP without a corresponding commit),
      // `git pull --ff-only` would refuse — surface a friendly error
      // instead of a raw git message.
      const dirty = (await runGit(['status', '--porcelain', '-uno'])).trim();
      if (dirty) {
        const allowForce = !!(body && body.forceReset);
        if (!allowForce) {
          return json(res, 200, {
            ok: false,
            dirty: true,
            error: 'ERR_UNCOMMITTED_CHANGES',
            dirtyFiles: dirty.split('\n').slice(0, 20),
          });
        }
        // branch comes from `git rev-parse --abbrev-ref HEAD`; execFile
        // doesn't spawn a shell so metacharacters can't break out — the
        // regex is kept as defence-in-depth so a malformed ref can't feed
        // a bogus `origin/xxx` spec to `git fetch`.
        const safeBranch = /^[\w.\-\/]+$/.test(before.branch || '') ? before.branch : 'master';
        await runGit(['fetch', 'origin', safeBranch]);
        // AUTH-1: `git reset --hard origin/<branch>` is destructive. forceReset
        // covers the dirty working tree the operator explicitly chose to drop,
        // but the same reset also silently vaporizes any LOCAL COMMITS not yet
        // pushed to origin — irrecoverable data loss triggered by one dashboard
        // click. Refuse when HEAD is ahead of the remote unless the operator
        // sets the distinct DASHBOARD_ALLOW_HARD_RESET=1 opt-in.
        let ahead = 0;
        try {
          ahead = parseInt((await runGit(['rev-list', '--count', `origin/${safeBranch}..HEAD`])).trim(), 10) || 0;
        } catch { /* no upstream / detached — treat as 0, fall through */ }
        const allowHardReset = process.env.DASHBOARD_ALLOW_HARD_RESET === '1';
        if (ahead > 0 && !allowHardReset) {
          return json(res, 200, {
            ok: false,
            dirty: true,
            unpushedCommits: ahead,
            error: 'ERR_UNPUSHED_COMMITS',
            message: `Refusing hard-reset: ${ahead} local commit(s) not on origin/${safeBranch} would be lost. Set DASHBOARD_ALLOW_HARD_RESET=1 to override.`,
            dirtyFiles: dirty.split('\n').slice(0, 20),
          });
        }
        // Stash (don't discard) the working tree first so a mistaken
        // forceReset is recoverable via `git stash pop` instead of gone
        // forever. Best-effort — if there's nothing to stash it's a no-op.
        try {
          await runGit(['stash', 'push', '--include-untracked', '-m', `self-update-forceReset ${new Date().toISOString()}`]);
        } catch (e) {
          log.warn(`self-update: pre-reset stash failed (continuing): ${e.message}`);
        }
        await runGit(['reset', '--hard', `origin/${safeBranch}`]);
      }
      const safeBranch = /^[\w.\-\/]+$/.test(before.branch || '') ? before.branch : 'master';
      // execFile can't do `2>&1`; use child_process stderr merge via
      // combining stdout+stderr explicitly. runGit already pipes stderr
      // into the Error message on failure, so for success we get just
      // stdout, which is what the UI displays.
      const pull = dirty ? 'hard-reset applied' : await runGit(['pull', 'origin', safeBranch, '--ff-only']);
      const after = await gitStatus();
      const changed = before.commit !== after.commit;
      // Schedule process exit so the service supervisor restarts us. This is
      // port/env-agnostic compared to spawning update.sh (which hardcodes
      // PORT=3003 default).
      //
      // v2.0.85 (#127 123cek): graceful-stop the LS pool before exit so
      // a supervisor hard-kill doesn't leave orphan language_server_linux_x64
      // processes holding ports. Startup-time cleanup also runs as a
      // backstop, but stopping cleanly here means the next process won't
      // even need cleanup most of the time.
      if (changed) {
        setTimeout(async () => {
          log.info('self-update: stopping LS pool before exit');
          try {
            // v2.0.88 (audit H-4): use the await-and-wait variant so
            // SIGTERM has time to land before process.exit reparents
            // surviving children to init. Otherwise the newly spawned
            // process races with an orphan LS holding the same port.
            const m = await import('../langserver.js');
            await m.stopLanguageServerAndWait({ perProcessTimeoutMs: 1500 });
          } catch (e) {
            log.warn(`self-update: stopLanguageServer failed: ${e.message}`);
          }
          log.info('self-update: exiting with restart-requested status for service supervisor');
          process.exit(selfUpdateRestartExitCode());
        }, 800);
      }
      return json(res, 200, {
        ok: true,
        changed,
        before: before.commit,
        after: after.commit,
        pullOutput: pull.trim(),
        restarting: changed,
      });
    } catch (err) {
      if (isSelfUpdateUnavailableError(err)) {
        // Same fallback as /self-update/check: when git is unavailable
        // (docker), try the docker socket path. The dashboard may already
        // have called /self-update/check first and routed the user
        // straight to a docker-mode confirmation, but supporting fallback
        // here too keeps `POST /self-update` self-contained for scripts.
        const docker = await detectDockerSelfUpdate();
        if (docker.available) {
          const result = await runDockerSelfUpdate();
          return json(res, 200, { mode: 'docker', ...result });
        }
        return json(res, 200, {
          ok: false,
          available: false,
          reason: err.reason,
          error: err.code,
          dockerReason: docker.reason,
          dockerDetail: docker.detail,
        });
      }
      return json(res, 200, { ok: false, error: err.message });
    }
  }

  // ─── Cache ────────────────────────────────────────────
  if (subpath === '/cache' && method === 'GET') {
    return json(res, 200, cacheStats());
  }
  if (subpath === '/cache' && method === 'DELETE') {
    cacheClear();
    return json(res, 200, { success: true });
  }

  // ─── Accounts ─────────────────────────────────────────
  if (subpath === '/accounts' && method === 'GET') {
    return json(res, 200, getAccountsPayload(req));
  }

  if (subpath === '/accounts' && method === 'POST') {
    try {
      const apiServerUrl = body.apiServerUrl || body.api_server_url || '';
      if (!body.api_key && !body.token) {
        return json(res, 400, { error: 'Provide api_key or token' });
      }

      let parsedProxy = null;
      if (body.proxy) {
        parsedProxy = parseProxyUrl(body.proxy);
        if (!parsedProxy) {
          return json(res, 400, { error: 'ERR_PROXY_FORMAT_INVALID' });
        }
        try {
          await validateProxyHost(parsedProxy);
        } catch (e) {
          return json(res, 400, { error: e.message || 'ERR_PROXY_INVALID' });
        }
      }

      const account = body.api_key
        ? addAccountByKey(body.api_key, body.label, apiServerUrl)
        : await addAccountByToken(body.token, body.label);

      if (parsedProxy) {
        setAccountProxy(account.id, parsedProxy);
      }

      // Fire-and-forget LS warmup is opt-in. Current LS builds are heavy,
      // so adding many proxied accounts must not spawn many LSPs up front.
      scheduleAccountWarmup(account.id);
      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /accounts/import-text — smart bulk import. Paste mixed token formats
  // (session / auth1 / refresh-JWT / labeled pairs); the parser classifies each
  // and adds via the existing addAccountByToken flow. SECURITY: never logs the
  // pasted text or any token; results carry only id/email/kind, never raw token.
  if (subpath === '/accounts/import-text' && method === 'POST') {
    try {
      const text = String(body.text || '');
      if (!text.trim()) return json(res, 400, { error: 'ERR_IMPORT_TEXT_EMPTY' });
      const parsed = parseAccountText(text);
      const results = { added: [], skipped: [], failed: [] };
      // A devin-session-token$ is itself the apiKey (addAccountByKey); other
      // token shapes run RegisterUser (addAccountByToken). Route by classified
      // kind so a pasted session token doesn't fail against the Firebase-only
      // RegisterUser path.
      const addByKind = (tok, label) => classifyToken(tok) === 'session'
        ? addAccountByKey(tok, label)
        : addAccountByToken(tok, label);
      for (const raw of (parsed.tokens || [])) {
        const kind = classifyToken(raw);
        if (kind === 'unknown') { results.skipped.push({ kind, reason: 'unclassified' }); continue; }
        try {
          const acc = await addByKind(raw, '');
          results.added.push({ id: acc.id, email: acc.email, kind });
        } catch (e) { results.failed.push({ kind, error: e.message }); }
      }
      for (const pair of (parsed.tokenPairs || [])) {
        try {
          const acc = await addByKind(pair.token, pair.email || '');
          results.added.push({ id: acc.id, email: acc.email || pair.email, kind: classifyToken(pair.token) });
        } catch (e) { results.failed.push({ email: pair.email, error: e.message }); }
      }
      // Email/password accounts need the login flow (batch 2+); record as skipped.
      for (const a of (parsed.accounts || [])) {
        results.skipped.push({ kind: 'email_password', email: a.email, reason: 'use_login_flow' });
      }
      return json(res, 200, { success: true, ...results, ...getAccountCount() });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // dashboard can hide / disable the "Import from local Windsurf" button on
  // public binds *before* the user clicks it. Returns the same gates the
  // import endpoint enforces, plus a friendly explanation.
  if (subpath === '/accounts/import-local-availability' && method === 'GET') {
    const remote = req?.socket?.remoteAddress || '';
    const localBind = isLocalBindHost();
    const loopback = isLoopbackAddress(remote);
    let available = true;
    let reason = '';
    if (!localBind) {
      available = false;
      reason = 'public_bind';
    } else if (!loopback) {
      available = false;
      reason = 'non_loopback_caller';
    }
    return json(res, 200, {
      available,
      reason,
      bindHost: process.env.HOST || process.env.BIND_HOST || '0.0.0.0',
      remoteAddress: remote,
      hint: available
        ? ''
        : (reason === 'public_bind'
          ? '此实例绑定在公网/0.0.0.0 上 — "本地" Windsurf 是远端服务器上的，不是你电脑里的，所以这个功能被拒绝（设计如此）。要导入本机 Windsurf 凭证请用 localhost 部署。'
          : '只接受来自 127.0.0.1 的请求；当前调用来自 ' + (remote || '?') + '。'),
    });
  }

  // GET /accounts/import-local — discover Windsurf desktop client credentials
  // Local-only hardening: must be bound to loopback host and remote socket
  // must also be loopback, so reverse proxies on public binds cannot
  // expose local desktop credentials.
  if (subpath === '/accounts/import-local' && method === 'GET') {
    if (!isLocalBindHost()) {
      log.warn('local-windsurf import refused: dashboard not bound to loopback host');
      return json(res, 403, { error: 'ERR_LOCAL_IMPORT_NOT_AVAILABLE_PUBLIC_BIND' });
    }
    const remote = req?.socket?.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      log.warn(`local-windsurf import refused: non-loopback caller ${remote}`);
      return json(res, 403, { error: 'ERR_LOCAL_IMPORT_LOOPBACK_ONLY', message: 'Local Windsurf import only available from 127.0.0.1' });
    }
    try {
      const result = await discoverWindsurfCredentials();
      log.info(`local-windsurf import: found ${result.accounts.length} account(s) across ${result.sources.filter(s => s.ok).length} source(s)`);
      return json(res, 200, {
        success: true,
        accounts: result.accounts.map(a => ({
          method: a.method,
          apiKey: a.apiKey,
          apiKeyMasked: a.apiKeyMasked,
          email: a.email,
          name: a.name,
          apiServerUrl: a.apiServerUrl,
          label: a.label,
          source: a.source,
        })),
        sources: result.sources,
        sqliteSupport: result.sqliteSupport,
        platform: result.platform,
      });
    } catch (e) {
      log.warn(`local-windsurf import failed: ${e.message}`);
      return json(res, 500, { error: 'ERR_LOCAL_IMPORT_FAILED', message: e.message });
    }
  }

  // POST /accounts/probe-all — probe every active account
  if (subpath === '/accounts/probe-all' && method === 'POST') {
    const list = getAccountList({ view: 'summary' }).filter(a => a.status === 'active');
    const force = body?.force === true || body?.allowLsStart === true;
    const results = [];
    for (const a of list) {
      try {
        const r = await probeAccount(a.id, { allowLsStart: force });
        results.push({
          id: a.id,
          email: a.email,
          tier: r?.tier || 'unknown',
          skipped: !!r?.skipped,
          reason: r?.reason || null,
          admission: r?.admission || null,
        });
      } catch (err) {
        results.push({ id: a.id, email: a.email, error: err.message });
      }
    }
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/probe — manually trigger capability probe
  const accountProbe = subpath.match(/^\/accounts\/([^/]+)\/probe$/);
  if (accountProbe && method === 'POST') {
    try {
      const force = body?.force === true || body?.allowLsStart === true;
      // Billable canary sweep is opt-in: only when the caller explicitly asks
      // for a deep probe. A plain probe runs GetUserStatus only (free) and
      // never spends the account's prompt credits. (homecloud 2026-06-29:
      // a default canary sweep flipped a working free account to "expired".)
      const canary = body?.canary === true || body?.deep === true;
      const result = await probeAccount(accountProbe[1], { allowLsStart: force, canary });
      if (!result) return json(res, 404, { error: 'Account not found' });
      return json(res, 200, { success: true, ...result });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /accounts/refresh-credits — refresh every active account's balance
  if (subpath === '/accounts/refresh-credits' && method === 'POST') {
    const results = await refreshAllCredits();
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/refresh-credits — single-account refresh
  const creditRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-credits$/);
  if (creditRefresh && method === 'POST') {
    const r = await refreshCredits(creditRefresh[1]);
    return json(res, r.ok ? 200 : 400, r);
  }

  const accountGet = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountGet && method === 'GET') {
    const account = getAccountPublic(accountGet[1], { view: 'full' });
    if (!account) return json(res, 404, { error: 'Account not found' });
    return json(res, 200, { account });
  }

  // PATCH /accounts/:id
  const accountPatch = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountPatch && method === 'PATCH') {
    const id = accountPatch[1];
    if (body.status) setAccountStatus(id, body.status);
    if (body.label) updateAccountLabel(id, body.label);
    if (body.resetErrors) resetAccountErrors(id);
    if (Array.isArray(body.blockedModels)) setAccountBlockedModels(id, body.blockedModels);
    if (body.tier) setAccountTier(id, body.tier);
    // v3.0.3: per-account on-demand spend policy. Only the keys present are
    // touched (each can be set alone). spendOnDemand: true | false | null(inherit);
    // onDemandReserve: number | null/''(inherit).
    if ('spendOnDemand' in body || 'onDemandReserve' in body) {
      const patch = {};
      if ('spendOnDemand' in body) patch.spendOnDemand = body.spendOnDemand;
      if ('onDemandReserve' in body) patch.reserve = body.onDemandReserve;
      setAccountSpendPolicy(id, patch);
    }
    return json(res, 200, { success: true });
  }

  // GET /tier-access — hardcoded FREE/PRO model entitlement tables.
  // The dashboard uses this to render the full per-account model grid
  // (every row in the tier's list is shown, blocked models are dimmed).
  if (subpath === '/tier-access' && method === 'GET') {
    return json(res, 200, {
      free: _TIER_TABLE.free,
      pro: _TIER_TABLE.pro,
      unknown: _TIER_TABLE.unknown,
      expired: _TIER_TABLE.expired,
      allModels: Object.keys(MODELS),
    });
  }

  // DELETE /accounts/:id
  const accountDel = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountDel && method === 'DELETE') {
    const ok = removeAccount(accountDel[1]);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  // ─── Stats ────────────────────────────────────────────
  if (subpath === '/stats' && method === 'GET') {
    return json(res, 200, getStats());
  }

  if (subpath === '/stats' && method === 'DELETE') {
    resetStats();
    return json(res, 200, { success: true });
  }

  // v2.0.148 — export the full stats snapshot (credits + per-request detail) for
  // backup/migration. GET returns JSON the client can download as a file.
  if (subpath === '/stats/export' && method === 'GET') {
    return json(res, 200, exportStats());
  }

  // v2.0.148 — import a previously exported snapshot. Body: the snapshot object,
  // optional { mode: 'merge'|'replace' } (default merge). Merge sums counts.
  if (subpath === '/stats/import' && method === 'POST') {
    const mode = body && body.mode === 'replace' ? 'replace' : 'merge';
    const snap = body && body.snapshot ? body.snapshot : body;
    const result = importStats(snap, { mode });
    return json(res, result.ok ? 200 : 400, result);
  }

  // DEVIN_CONNECT recovery health: re-login / failover / dead-token / cooldown
  // counters + credential-store decrypt health, so an operator can watch the
  // self-heal machinery instead of grepping logs (#36, #37).
  if (subpath === '/connect-metrics' && method === 'GET') {
    // C5: fold in the persisted per-account rolling-hour health window so an
    // operator sees not just fleet-wide counters but which accounts are
    // currently throwing throttles/errors/dead-tokens over the last hour.
    return json(res, 200, { ...getConnectMetrics(), poolHealth: getPoolHealthWindow() });
  }
  if (subpath === '/connect-metrics' && method === 'DELETE') {
    resetConnectMetrics();
    return json(res, 200, { success: true });
  }

  // ─── Logs ─────────────────────────────────────────────
  if (subpath === '/logs' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const level = url.searchParams.get('level') || null;
    return json(res, 200, { logs: getLogs(since, level) });
  }

  // GET /logs/export — v2.0.60: download recent logs as JSONL or
  // pretty-text. Filterable by `type` (all / system / api), `level`
  // (debug/info/warn/error/all), `since` (unix ms). Designed for the
  // "give me logs to attach to a GitHub issue" flow so users don't have
  // to copy-paste from the streaming view. Returns Content-Disposition
  // so browsers download instead of preview.
  if (subpath === '/logs/export' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const type = (url.searchParams.get('type') || 'all').toLowerCase();
    const level = url.searchParams.get('level') || null;
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const fmt = (url.searchParams.get('format') || 'jsonl').toLowerCase();

    let entries = getLogs(since, level);
    if (type === 'api') {
      // API path: any log emitted by request handlers — Probe[id] / Chat[id]
      // / Cascade / ToolGuard / drought etc., plus any entry with a ctx
      // requestId. This is the "what happened to my request" view.
      entries = entries.filter(e => {
        if (e.ctx && (e.ctx.requestId || e.ctx.reqId)) return true;
        const m = e.msg || '';
        return /^(?:Probe|Chat|Cascade|ToolGuard|ToolParser|drought|Workspace|Settings):|\[Probe |\[Chat /i.test(m);
      });
    } else if (type === 'system') {
      // System path: everything that's NOT obviously per-request — auth
      // pool, LS lifecycle, cron jobs, etc.
      entries = entries.filter(e => {
        if (e.ctx && (e.ctx.requestId || e.ctx.reqId)) return false;
        const m = e.msg || '';
        return !/^(?:Probe|Chat|Cascade|ToolGuard|ToolParser):|\[Probe |\[Chat /i.test(m);
      });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `windsurf-api-logs-${type}-${stamp}.${fmt === 'txt' ? 'log' : 'jsonl'}`;
    let body;
    if (fmt === 'txt' || fmt === 'log') {
      body = entries.map(e => {
        const ts = new Date(e.ts).toISOString();
        const ctx = e.ctx ? ' ' + Object.entries(e.ctx).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') : '';
        return `${ts} [${e.level.toUpperCase()}] ${e.msg}${ctx}`;
      }).join('\n') + '\n';
    } else {
      body = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    }
    res.writeHead(200, {
      'Content-Type': fmt === 'txt' || fmt === 'log' ? 'text/plain; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  if (subpath === '/logs/stream' && method === 'GET') {
    req.socket.setKeepAlive(true);
    req.setTimeout(0);
    const streamHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    };
    // Same allowlist-gated CORS as json(): only emit ACAO for an allowed
    // origin, never a blanket `*` (see resolveCorsOrigin / AUTH-1).
    const streamAcao = res?._dashboardCorsOrigin || '';
    if (streamAcao) {
      streamHeaders['Access-Control-Allow-Origin'] = streamAcao;
      if (streamAcao !== '*') streamHeaders['Vary'] = 'Origin';
    }
    res.writeHead(200, streamHeaders);
    res.write('retry: 3000\n\n');

    // Send existing logs first
    const existing = getLogs();
    for (const entry of existing.slice(-50)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15000);

    const cb = (entry) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    subscribeToLogs(cb);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeFromLogs(cb);
    });
    return;
  }

  // ─── Proxy ────────────────────────────────────────────
  // Always return the masked view over the API — plaintext passwords
  // would otherwise end up in dashboard network logs, HAR files, proxy
  // access logs, etc. The UI posts the sentinel back to preserve the
  // stored password when editing other fields (see mergePassword).
  // ─── Drought summary (v2.0.57 Fix 5) ──────────────────
  if (subpath === '/drought' && method === 'GET') {
    return json(res, 200, getDroughtSummary());
  }

  // ─── Upstream endpoints (v2.0.60 — show migration status) ──
  // Surfaces which Windsurf upstream paths the proxy is currently
  // wired to talk to. Lets the operator confirm at a glance that we're
  // on the new register.windsurf.com / windsurf.com/_backend hosts and
  // that the legacy fallbacks are still in place. Read-only — the
  // actual switching happens automatically per-request based on
  // network success / 5xx response.
  if (subpath === '/upstream-endpoints' && method === 'GET') {
    return json(res, 200, {
      registerUser: {
        primary: 'register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser',
        fallback: 'api.codeium.com/register_user/',
        protocol: 'Connect-RPC (primary) / REST (fallback)',
        migratedSince: 'v2.0.57',
      },
      postAuth: {
        primary: 'windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth',
        fallback: 'server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth',
        protocol: 'Connect-RPC',
        migratedSince: 'v2.0.57',
      },
      oneTimeAuthToken: {
        primary: 'windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/GetOneTimeAuthToken',
        fallback: 'server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetOneTimeAuthToken',
        protocol: 'Connect-RPC',
        migratedSince: 'v2.0.57',
      },
      checkUserLoginMethod: {
        primary: 'windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod',
        fallback: 'windsurf.com/_devin-auth/connections',
        protocol: 'Connect-RPC',
        migratedSince: 'v2.0.39',
      },
      getUserStatus: {
        primary: 'server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
        fallback: 'server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
        protocol: 'Connect-RPC',
        note: '内置 daily/weekly% 解析；wam-bundle 用的 GetPlanStatus 是同一 service 的另一个 RPC，返回字段被 GetUserStatus.planStatus 嵌套覆盖。',
      },
      getCascadeModelConfigs: {
        primary: 'server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs',
        fallback: 'server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs',
        protocol: 'Connect-RPC',
      },
      firebaseAuth: {
        primary: 'identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
        refreshUrl: 'securetoken.googleapis.com/v1/token',
        note: 'Windsurf project Firebase API key 直连 — 同 WindsurfSwitch / wam-bundle 路径。',
      },
    });
  }

  // ─── Credentials (v2.0.56 — runtime-rotatable API_KEY + DASHBOARD_PASSWORD) ─────
  // GET /settings/credentials — masked snapshot. The plaintext API key is
  // never returned (use revealApiKey if/when added), but we expose
  // - source: 'runtime' | 'env' | 'unset'
  // - masked: 'sk-12...3456' for the API key
  // - dashboardPasswordSet: bool
  // - dashboardPasswordSource: 'runtime' | 'env' | 'unset'
  if (subpath === '/settings/credentials' && method === 'GET') {
    const creds = getCredentials();
    const effectiveApiKey = getEffectiveApiKey();
    const apiKeySource = creds.apiKey ? 'runtime' : (config.apiKey ? 'env' : 'unset');
    const dashboardPasswordSource = creds.dashboardPasswordHash
      ? 'runtime'
      : (config.dashboardPassword ? 'env' : 'unset');
    return json(res, 200, {
      apiKey_masked: maskApiKey(effectiveApiKey),
      apiKeySource,
      dashboardPasswordSet: !!getEffectiveDashboardPasswordStored(),
      dashboardPasswordSource,
    });
  }

  // PUT /settings/credentials — rotate one or both credentials. Body:
  //   { apiKey?: string, dashboardPassword?: string }
  // Empty string clears the runtime override (env value takes over).
  // Requires the caller to re-authenticate with the NEW dashboard
  // password on the next request — no session cookies, so the UI just
  // re-prompts. We don't accept the old-password proof here because the
  // caller already passed dashboard auth at the top of this function.
  if (subpath === '/settings/credentials' && method === 'PUT') {
    if (!body || typeof body !== 'object') {
      return json(res, 400, { error: 'Body must be a JSON object' });
    }
    const out = {};
    let touched = false;
    if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
      const v = body.apiKey;
      if (v != null && typeof v !== 'string') {
        return json(res, 400, { error: 'apiKey must be a string' });
      }
      const trimmed = String(v ?? '').trim();
      // Loose sanity: reject keys with whitespace / control chars. An
      // empty string is the explicit "clear runtime override" signal.
      if (trimmed && /[\s\x00-\x1f]/.test(trimmed)) {
        return json(res, 400, { error: 'apiKey must not contain whitespace or control characters' });
      }
      if (trimmed && trimmed.length < 8) {
        return json(res, 400, { error: 'apiKey must be at least 8 characters' });
      }
      setRuntimeApiKey(trimmed);
      out.apiKeyUpdated = true;
      out.apiKey_masked = maskApiKey(trimmed || getEffectiveApiKey());
      touched = true;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'dashboardPassword')) {
      const v = body.dashboardPassword;
      if (v != null && typeof v !== 'string') {
        return json(res, 400, { error: 'dashboardPassword must be a string' });
      }
      const pw = String(v ?? '');
      if (pw && pw.length < 8) {
        return json(res, 400, { error: 'dashboardPassword must be at least 8 characters' });
      }
      setRuntimeDashboardPassword(pw);
      out.dashboardPasswordUpdated = true;
      touched = true;
    }
    if (!touched) {
      return json(res, 400, { error: 'Provide apiKey, dashboardPassword, or both' });
    }
    log.info(`Settings: credentials rotated from ${dashboardClientIp(req) || 'unknown'} (apiKey=${!!out.apiKeyUpdated}, dashboardPassword=${!!out.dashboardPasswordUpdated})`);
    return json(res, 200, { success: true, ...out });
  }

  // GET /settings/prefs — dashboard UI preferences (booleans, shared across
  // browsers via runtime-config). PUT to change one or more.
  if (subpath === '/settings/prefs' && method === 'GET') {
    return json(res, 200, { prefs: getPrefs() });
  }
  if (subpath === '/settings/prefs' && method === 'PUT') {
    if (!body || typeof body !== 'object') {
      return json(res, 400, { error: 'Body must be a JSON object' });
    }
    return json(res, 200, { success: true, prefs: setPrefs(body) });
  }

  if (subpath === '/proxy' && method === 'GET') {
    return json(res, 200, getProxyConfigMasked());
  }

  if (subpath === '/proxy/global' && method === 'PUT') {
    // v2.0.55 (audit H3): wire this PUT through the same private-host
    // gate the add-account path uses, otherwise a dashboard-authenticated
    // caller can pin the global proxy at 127.0.0.1 / 169.254.169.254 /
    // any internal socket, then upstream egress flows through it. Skip
    // when the operator explicitly allows private hosts, only validate
    // host format. Empty body / no host = clearing the global proxy via
    // empty PUT.
    if (body && typeof body === 'object' && body.host) {
      try { await validateProxyHost(body); }
      catch (e) {
        return json(res, 400, { error: e?.message || 'ERR_PROXY_PRIVATE_HOST' });
      }
    }
    setGlobalProxy(body);
    return json(res, 200, { success: true, config: getProxyConfigMasked() });
  }

  if (subpath === '/proxy/global' && method === 'DELETE') {
    removeProxy('global');
    return json(res, 200, { success: true });
  }

  const proxyAccount = subpath.match(/^\/proxy\/accounts\/([^/]+)$/);
  if (proxyAccount && method === 'PUT') {
    // Same H3 gate as /proxy/global PUT — per-account proxies were the
    // other half of the bypass. Empty body / no host = clearing the
    // proxy, leave it unvalidated.
    if (body && typeof body === 'object' && body.host) {
      try { await validateProxyHost(body); }
      catch (e) {
        return json(res, 400, { error: e?.message || 'ERR_PROXY_PRIVATE_HOST' });
      }
    }
    setAccountProxy(proxyAccount[1], body);
    const admission = getLsAdmissionStatus(body?.host ? body : null);
    const warmupRequested = body?.warmup === true || body?.prewarm === true || shouldPrewarmLsOnAccountAdd();
    let warmup = { ok: true, skipped: true, reason: 'warmup_not_requested' };
    if (warmupRequested) {
      warmup = await runAccountWarmup(proxyAccount[1], { probe: false, requireOptIn: false });
    }
    return json(res, 200, { success: true, admission, warmup });
  }
  if (proxyAccount && method === 'DELETE') {
    removeProxy('account', proxyAccount[1]);
    return json(res, 200, { success: true });
  }

  // ─── Config ───────────────────────────────────────────
  if (subpath === '/config' && method === 'GET') {
    return json(res, 200, {
      port: config.port,
      defaultModel: config.defaultModel,
      maxTokens: config.maxTokens,
      logLevel: config.logLevel,
      lsBinaryPath: config.lsBinaryPath,
      lsPort: config.lsPort,
      codeiumApiUrl: config.codeiumApiUrl,
      hasApiKey: !!config.apiKey,
      hasDashboardPassword: !!config.dashboardPassword,
    });
  }

  // ─── Language Server binary inspect / update ─────────
  // GET → current LS binary stat (size, mtime, sha256 prefix). UI uses
  // this to show "binary installed at X, version sha:abcd1234, age 21d".
  if (subpath === '/langserver/binary' && method === 'GET') {
    const binPath = config.lsBinaryPath;
    try {
      const { statSync } = await import('node:fs');
      const { createReadStream } = await import('node:fs');
      const { createHash } = await import('node:crypto');
      const stat = statSync(binPath);
      const sha = await new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(binPath)
          .on('data', c => h.update(c))
          .on('end', () => resolve(h.digest('hex')))
          .on('error', reject);
      });
      return json(res, 200, {
        ok: true,
        path: binPath,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
        sha256: sha.slice(0, 16),
      });
    } catch (err) {
      return json(res, 200, {
        ok: false,
        path: binPath,
        error: err.code || err.message,
      });
    }
  }

  // POST → run install-ls.sh to download the latest binary, then restart
  // every LS pool entry so requests pick up the new binary on next call.
  // Body: { url?: string } — optional override (e.g. desktop-extracted
  // binary URL); falls back to `install-ls.sh` auto-discovery (our
  // release → Windsurf desktop LS release → Exafunction).
  if (subpath === '/langserver/update' && method === 'POST') {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pjoin } = await import('node:path');
    // install-ls.sh ships at the repo root, two levels above this file
    // (src/dashboard/api.js). Resolving by import.meta.url avoids any
    // dependence on cwd, so the endpoint works whether started from /app
    // (Docker), the repo root, or a deeper subdir.
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = pjoin(here, '..', '..', 'install-ls.sh');
    if (!existsSync(scriptPath)) {
      return json(res, 500, {
        ok: false,
        error: `install-ls.sh not found at ${scriptPath}`,
      });
    }
    const url = body && typeof body.url === 'string' ? body.url.trim() : '';
    // Defence-in-depth: only allow http(s) URLs from a small allowlist of
    // hosts. Without this, an attacker who got past dashboard auth could
    // pipe an arbitrary URL into the install script and have curl write
    // bytes to LS_BINARY_PATH which is then chmod +x and exec'd as the
    // node user. Still gated by checkAuth above; this is a second layer.
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch {
        return json(res, 400, { ok: false, error: 'invalid url' });
      }
      if (parsed.protocol !== 'https:') {
        return json(res, 400, { ok: false, error: 'url must be https' });
      }
      const allowedHosts = new Set([
        'github.com',
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com',
        'api.github.com',
      ]);
      if (!allowedHosts.has(parsed.hostname)) {
        return json(res, 400, {
          ok: false,
          error: `url host not allowed; permitted: ${[...allowedHosts].join(', ')}`,
        });
      }
    }
    const args = url ? ['--url', url] : [];
    const env = {
      ...process.env,
      LS_INSTALL_PATH: config.lsBinaryPath,
    };
    // Snapshot sha256 BEFORE the install. install-ls.sh will atomic-
    // rename the binary into place even if the download is byte-
    // identical to what's already there (no upstream change), so
    // without comparing before/after the dashboard can't tell whether
    // "Update LS" actually replaced anything — leading to user reports
    // like "LS update has no effect". Returning both lets the toast
    // distinguish "binary changed" from "binary already up to date".
    let beforeSha = null;
    try {
      const { createReadStream } = await import('node:fs');
      const { createHash } = await import('node:crypto');
      beforeSha = await new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(config.lsBinaryPath)
          .on('data', c => h.update(c))
          .on('end', () => resolve(h.digest('hex')))
          .on('error', () => resolve(null));
      });
    } catch { /* missing or unreadable — that's fine, treat as null */ }

    const child = spawn('bash', [scriptPath, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    const exitCode = await new Promise(resolve => {
      child.on('close', resolve);
      child.on('error', () => resolve(-1));
    });
    if (exitCode !== 0) {
      return json(res, 200, {
        ok: false,
        exitCode,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
      });
    }
    let afterSha = null;
    try {
      const { createReadStream } = await import('node:fs');
      const { createHash } = await import('node:crypto');
      afterSha = await new Promise((resolve) => {
        const h = createHash('sha256');
        createReadStream(config.lsBinaryPath)
          .on('data', c => h.update(c))
          .on('end', () => resolve(h.digest('hex')))
          .on('error', () => resolve(null));
      });
    } catch { /* keep null */ }
    const binaryChanged = !!(beforeSha && afterSha && beforeSha !== afterSha);
    // Restart every LS pool entry. The pool is keyed by proxy; iterating
    // through the live list catches per-account proxies as well as the
    // default no-proxy LS. Errors during restart get surfaced so the user
    // knows whether they need to bounce the container.
    const { _poolKeys, restartLsForProxy: doRestart, getProxyByKey } =
      await import('../langserver.js');
    let restarted = 0;
    let restartErrors = [];
    try {
      const keys = typeof _poolKeys === 'function' ? _poolKeys() : ['default'];
      for (const key of keys) {
        try {
          const proxy = typeof getProxyByKey === 'function' ? getProxyByKey(key) : null;
          await doRestart(proxy);
          restarted++;
        } catch (e) {
          restartErrors.push(`${key}: ${e.message}`);
        }
      }
    } catch (e) {
      restartErrors.push(e.message);
    }
    return json(res, 200, {
      ok: true,
      stdout: stdout.slice(-4000),
      restarted,
      restartErrors,
      // 16-char prefix matches what /langserver/binary returns so the
      // dashboard can string-compare against its current shown stat.
      beforeSha: beforeSha ? beforeSha.slice(0, 16) : null,
      afterSha: afterSha ? afterSha.slice(0, 16) : null,
      binaryChanged,
      // poolEmpty distinguishes "no live LS to restart" (cold proxy,
      // restart will happen on next request) from "all LS restart
      // attempts failed" (real problem). Without this the toast counts
      // both as "restarted 0".
      poolEmpty: restarted === 0 && restartErrors.length === 0,
    });
  }

  // ─── Language Server ──────────────────────────────────
  if (subpath === '/langserver/restart' && method === 'POST') {
    if (!body.confirm) {
      return json(res, 400, { error: 'Send { confirm: true } to restart language server' });
    }
    Promise.resolve().then(async () => {
      try {
        await stopLanguageServerAndWait({ perProcessTimeoutMs: 1500 });
        await startLanguageServer({
          binaryPath: config.lsBinaryPath,
          port: config.lsPort,
          apiServerUrl: config.codeiumApiUrl,
        });
      } catch (e) {
        log.error(`Language server restart failed: ${e.message}`);
      }
    });
    return json(res, 200, { success: true, message: 'Restarting language server...' });
  }

  // ─── Models list ──────────────────────────────────────
  if (subpath === '/models' && method === 'GET') {
    const models = Object.entries(MODELS).map(([id, info]) => ({
      id, name: info.name, provider: info.provider,
      credit: typeof info.credit === 'number' ? info.credit : null,
    }));
    return json(res, 200, { models });
  }

  // ─── Model Access Control ──────────────────────────────
  if (subpath === '/model-access' && method === 'GET') {
    return json(res, 200, getModelAccessConfig());
  }

  if (subpath === '/model-access' && method === 'PUT') {
    if (body.mode) setModelAccessMode(body.mode);
    if (body.list) setModelAccessList(body.list);
    if (body.defaultModel !== undefined) setDefaultModel(body.defaultModel);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  if (subpath === '/model-access/add' && method === 'POST') {
    if (!body.model) return json(res, 400, { error: 'model is required' });
    addModelToList(body.model);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  if (subpath === '/model-access/remove' && method === 'POST') {
    if (!body.model) return json(res, 400, { error: 'model is required' });
    removeModelFromList(body.model);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  // ─── Windsurf Login ────────────────────────────────────
  if (subpath === '/windsurf-login' && method === 'POST') {
    try {
      const { email, password, proxy: loginProxy, autoAdd, storeCredential } = body || {};
      return json(res, 200, await processWindsurfLogin({ email, password, loginProxy, autoAdd, storeCredential, req }));
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.message, isAuthFail: !!err.isAuthFail, firebaseCode: err.firebaseCode });
    }
  }

  if (subpath === '/windsurf-login/batch' && method === 'POST') {
    try {
      const { accounts, proxy: loginProxy, autoAdd, storeCredential } = body || {};
      if (!Array.isArray(accounts) || !accounts.length) {
        return json(res, 400, { error: 'ERR_ACCOUNTS_REQUIRED' });
      }

      const results = [];
      for (const acct of accounts) {
        const email = String(acct?.email || '').trim();
        const password = String(acct?.password || '').trim();
        try {
          const result = await processWindsurfLogin({ email, password, loginProxy, autoAdd, storeCredential, req });
          results.push(result);
        } catch (err) {
          results.push({
            success: false,
            email,
            error: err.message,
            isAuthFail: !!err.isAuthFail,
            firebaseCode: err.firebaseCode,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;
      return json(res, 200, {
        success: true,
        total: results.length,
        successCount,
        failCount,
        results,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // ─── Batch proxy + account import ─────────────────────
  // POST /batch-import — each line: "proxy email password" or "email password"
  if (subpath === '/batch-import' && method === 'POST') {
    try {
      const { text, autoAdd = true, storeCredential } = body || {};
      if (!text || typeof text !== 'string') return json(res, 400, { error: 'ERR_TEXT_REQUIRED' });
      const parsed = parseBatchImportInput(text, parseProxyUrl);
      if (!parsed.items.length) return json(res, 400, { error: 'ERR_NO_VALID_LINES' });
      const results = [];
      let skippedCount = 0;
      for (const item of parsed.items) {
        if (item.kind === 'issue') {
          skippedCount++;
          results.push({
            success: false,
            skipped: true,
            email: item.label,
            error: item.error,
            lineNumber: item.lineNumber,
            raw: item.raw,
          });
          continue;
        }
        try {
          if (item.proxy) await validateProxyHost(item.proxy);
          let result;
          if (item.kind === 'email_password') {
            const loginProxy = item.proxy || getProxyConfig().global;
            result = await processWindsurfLogin({
              email: item.email,
              password: item.password,
              loginProxy,
              autoAdd,
              storeCredential,
              req,
            });
            const binding = buildBatchProxyBinding(result, item.proxyRaw);
            if (binding) {
              setAccountProxy(binding.accountId, binding.proxy);
              scheduleAccountWarmup(binding.accountId);
            }
          } else if (item.kind === 'token') {
            const account = await addAccountByToken(item.token, item.label);
            if (item.proxy) {
              setAccountProxy(account.id, item.proxy);
              scheduleAccountWarmup(account.id);
            }
            result = {
              success: true,
              email: account.email,
              apiKey_masked: maskApiKey(account.apiKey),
              account: { id: account.id, email: account.email, status: account.status },
            };
          } else if (item.kind === 'api_key') {
            const account = addAccountByKey(item.apiKey, item.label, item.apiServerUrl || '');
            if (item.proxy) {
              setAccountProxy(account.id, item.proxy);
              scheduleAccountWarmup(account.id);
            }
            result = {
              success: true,
              email: account.email,
              apiKey_masked: maskApiKey(account.apiKey),
              account: { id: account.id, email: account.email, status: account.status },
            };
          } else {
            throw new Error('ERR_UNSUPPORTED_IMPORT_ITEM');
          }
          result.proxy = item.proxyRaw || null;
          result.importKind = item.kind;
          results.push(result);
        } catch (err) {
          results.push({
            success: false,
            skipped: false,
            email: item.email || item.label || '',
            error: err.message,
            lineNumber: item.lineNumber,
            raw: item.raw,
            proxy: item.proxyRaw || null,
            importKind: item.kind,
          });
        }
      }
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success && !r.skipped).length;
      return json(res, 200, {
        success: true,
        mode: parsed.mode,
        total: results.length,
        successCount,
        failCount,
        skippedCount,
        results,
      });
    } catch (err) {
      if (err instanceof BatchImportParseError) {
        return json(res, 400, { error: err.code });
      }
      return json(res, 400, { error: err.message });
    }
  }

  // ─── OAuth login (Google / GitHub via Firebase) ────────
  // POST /oauth-login — accepts Firebase idToken from client-side OAuth
  if (subpath === '/oauth-login' && method === 'POST') {
    try {
      const { idToken, refreshToken, email, provider, autoAdd } = body;
      if (!idToken) return json(res, 400, { error: 'ERR_IDTOKEN_REQUIRED' });

      const proxy = getProxyConfig().global;
      const { apiKey, name } = await reRegisterWithCodeium(idToken, proxy);

      let account = null;
      if (autoAdd !== false) {
        account = addAccountByKey(apiKey, name || email || provider || 'OAuth');
        if (refreshToken) {
          setAccountTokens(account.id, { refreshToken, idToken });
        }
        scheduleAccountWarmup(account.id);
      }

      return json(res, 200, {
        success: true,
        // Same one-time-export contract as /windsurf-login: raw key returned
        // only when autoAdd:false (caller takes the key themselves and we do
        // not persist it). Otherwise mask for listings.
        ...(autoAdd === false
          ? { apiKey }
          : { apiKey_masked: maskApiKey(apiKey) }),
        name,
        email: email || '',
        account: account ? { id: account.id, email: account.email, status: account.status } : null,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // ─── OAuth remote-onboarding state machine ──────────────────────
  // Lets a PUBLIC deploy onboard via the official Windsurf sign-in page without
  // the server ever receiving a localhost callback: start -> user logs in in
  // their own browser -> they paste the whole redirect URL back -> server pulls
  // the token out of it -> poll for the result. Ported (in-memory) from
  // CLIProxyAPI's oauth_sessions/oauth_callback. All three inherit checkAuth.
  if (subpath === '/oauth/start' && method === 'POST') {
    const { registerSession } = await import('./oauth-sessions.js');
    const state = registerSession('windsurf');
    // Windsurf editor backup-token signin URL (response_type=token). state rides
    // the OAuth state param so we can correlate the pasted callback.
    const url = 'https://windsurf.com/windsurf/signin?response_type=token'
      + '&client_id=3GUryQ7ldAeKEuD2obYnppsnmj58eP5u&redirect_uri=show-auth-token'
      + '&state=' + encodeURIComponent(state)
      + '&prompt=login&redirect_parameters_type=query&workflow=';
    return json(res, 200, { success: true, url, state });
  }
  if (subpath === '/oauth/callback' && method === 'POST') {
    const { validateState, getSession, completeSession, failSession } = await import('./oauth-sessions.js');
    const { state, redirect_url } = body || {};
    if (!validateState(state)) return json(res, 400, { error: 'ERR_INVALID_STATE' });
    const session = getSession(state);
    if (!session || session.status !== 'pending') return json(res, 409, { error: 'ERR_SESSION_NOT_PENDING' });
    try {
      // Extract the token from whatever the user pasted: a full redirect URL
      // (query or #hash), or the bare token itself. NEVER log redirect_url.
      const token = extractOAuthToken(redirect_url);
      if (!token) throw new Error('ERR_NO_TOKEN_IN_INPUT');
      // A devin-session-token$ IS the apiKey — it must go through addAccountByKey,
      // NOT addAccountByToken (which runs RegisterUser and only accepts a Firebase
      // idToken). Route by prefix so both token shapes onboard correctly.
      const account = classifyToken(token) === 'session'
        ? addAccountByKey(token, '')
        : await addAccountByToken(token, '');
      scheduleAccountWarmup(account.id);
      completeSession(state);
      return json(res, 200, { success: true, account: { id: account.id, email: account.email, status: account.status } });
    } catch (err) {
      failSession(state, err.message);
      return json(res, 400, { error: err.message });
    }
  }
  if (subpath === '/oauth/status' && method === 'GET') {
    const { getStatus } = await import('./oauth-sessions.js');
    const st = new URL(req.url, 'http://localhost').searchParams.get('state') || '';
    return json(res, 200, getStatus(st));
  }

  // ─── Email OTP Login — SEALED 2026-07-06 ────────────────────────
  // These endpoints are intact and the Connect-RPC wiring is verified, but the
  // flow is dormant: it needs a Cloudflare Turnstile token whose sitekey is
  // domain-bound to windsurf.com, so a self-hosted dashboard can't produce one.
  // The UI panel is hidden (index.html data-sealed). Endpoints remain reachable
  // for a future upstream change / a manually-supplied turnstile token.
  // ─── Email OTP Login (Step 1: Send verification code) ────
  if (subpath === '/email-otp/send' && method === 'POST') {
    try {
      const { email, firstName, turnstileToken } = body || {};
      if (!email || !firstName || !turnstileToken) {
        return json(res, 400, { error: 'ERR_EMAIL_FIRSTNAME_TURNSTILE_REQUIRED' });
      }
      const { sendEmailVerification } = await import('./email-otp-login.js');
      const proxy = getProxyConfig().global;
      await sendEmailVerification(email, firstName, turnstileToken, proxy);
      return json(res, 200, {
        success: true,
        email,
        message: 'Verification code sent. Check your email.',
      });
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.message });
    }
  }

  // ─── Email OTP Login (Step 2: Complete registration) ────
  if (subpath === '/email-otp/complete' && method === 'POST') {
    try {
      const { email, otpCode, turnstileToken, firstName, lastName, autoAdd } = body || {};
      if (!email || !otpCode || !turnstileToken) {
        return json(res, 400, { error: 'ERR_EMAIL_OTP_TURNSTILE_REQUIRED' });
      }
      const { registerUserWithOtp } = await import('./email-otp-login.js');
      const proxy = getProxyConfig().global;
      const { apiKey, name, apiServerUrl } = await registerUserWithOtp(
        email,
        otpCode,
        turnstileToken,
        firstName || '',
        lastName || '',
        proxy
      );

      let account = null;
      if (autoAdd !== false) {
        account = addAccountByKey(apiKey, name || email || 'OTP');
        scheduleAccountWarmup(account.id);
      }

      return json(res, 200, {
        success: true,
        ...(autoAdd === false
          ? { apiKey }
          : { apiKey_masked: maskApiKey(apiKey) }),
        name,
        email,
        apiServerUrl,
        account: account ? { id: account.id, email: account.email, status: account.status } : null,
      });
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.message });
    }
  }

  // ─── Rate Limit Check ──────────────────────────────────
  // POST /accounts/:id/rate-limit — check capacity for a single account
  const rateLimitCheck = subpath.match(/^\/accounts\/([^/]+)\/rate-limit$/);
  if (rateLimitCheck && method === 'POST') {
    const acct = getAccountPublic(rateLimitCheck[1], { view: 'summary' });
    if (!acct) return json(res, 404, { error: 'Account not found' });
    const secret = getAccountInternal(acct.id);
    try {
      const proxy = getEffectiveProxy(acct.id) || null;
      const result = await checkMessageRateLimit(secret.apiKey, proxy);
      return json(res, 200, { success: true, account: acct.email, ...result });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  const revealKey = subpath.match(/^\/account\/([^/]+)\/reveal-key$/);
  if (revealKey && method === 'POST') {
    const acct = getAccountInternal(revealKey[1]);
    if (!acct) return json(res, 404, { error: 'Account not found' });
    // AUTH-1: revealing an upstream key in cleartext is the single most
    // sensitive read the dashboard offers. Passing ambient dashboard auth is
    // no longer enough — require the operator to re-prove the dashboard
    // password in THIS request (body.password / body.dashboardPassword or the
    // X-Dashboard-Password-Confirm header), and audit-log the reveal. This
    // blocks a drive-by (CSRF / an already-open localhost dashboard) from
    // silently exfiltrating keys, and forces a deliberate confirmation step.
    if (!confirmReauth(req, body)) {
      log.warn(`reveal-key REFUSED for account ${revealKey[1]} from ${dashboardClientIp(req) || 'unknown'}: missing/invalid re-auth confirmation`);
      return json(res, 401, { error: 'ERR_REVEAL_REAUTH_REQUIRED', message: 'Re-enter the dashboard password to reveal this key.' });
    }
    log.info(`reveal-key: account ${revealKey[1]} (${acct.email || 'no-email'}) revealed from ${dashboardClientIp(req) || 'unknown'}`);
    return json(res, 200, { success: true, apiKey: acct.apiKey });
  }

  // ─── Firebase Token Refresh ───────────────────────────────
  // POST /accounts/:id/refresh-token — manually refresh Firebase token
  const tokenRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-token$/);
  if (tokenRefresh && method === 'POST') {
    const acct = getAccountInternal(tokenRefresh[1]);
    if (!acct) return json(res, 404, { error: 'Account not found' });
    if (!acct.refreshToken) return json(res, 400, { error: 'Account has no refresh token' });
    try {
      const proxy = getEffectiveProxy(acct.id) || null;
      const { idToken, refreshToken: newRefresh } = await refreshFirebaseToken(acct.refreshToken, proxy);
      const { apiKey } = await reRegisterWithCodeium(idToken, proxy);
      const keyChanged = apiKey && apiKey !== acct.apiKey;
      // Persist the fresh credentials back onto the account. Without this, the
      // in-memory apiKey stays on the now-stale value until the next server
      // restart — every subsequent request from this account will fail auth.
      setAccountTokens(acct.id, { apiKey: apiKey || acct.apiKey, refreshToken: newRefresh || acct.refreshToken, idToken });
      return json(res, 200, { success: true, keyChanged, email: acct.email });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  json(res, 404, { error: `Dashboard API: ${method} ${subpath} not found` });
}

// ─── Proxy connectivity test ──────────────────────────────
// HTTP CONNECT tunnel to api.ipify.org:443 → GET / → the returned IP is the
// proxy's egress IP. Confirms the proxy works AND that auth is accepted.
// ─── Self-update helpers ───────────────────────────────
//
// execFile (not exec) for every invocation: no shell is spawned, so
// metacharacters in any future argument source are data, not commands.
// Belt-and-braces with the branch-name regex in /self-update — if a
// future refactor drops the regex, execFile still denies injection.
const SELF_UPDATE_UNAVAILABLE = 'ERR_SELF_UPDATE_UNAVAILABLE';
let gitExecFileForTest = null;

// EX_TEMPFAIL: non-zero is intentional. systemd Restart=on-failure and PM2
// autorestart both relaunch after this self-update-only exit, while normal
// SIGINT/SIGTERM shutdown keeps its separate successful exit path in index.js.
export function selfUpdateRestartExitCode() {
  return 75;
}

export function setGitExecFileForTest(execFile) {
  gitExecFileForTest = execFile;
}

function makeSelfUpdateUnavailableError() {
  const err = new Error(SELF_UPDATE_UNAVAILABLE);
  err.code = SELF_UPDATE_UNAVAILABLE;
  err.reason = 'docker';
  return err;
}

function isSelfUpdateUnavailableError(err) {
  return err?.code === SELF_UPDATE_UNAVAILABLE || err?.message === SELF_UPDATE_UNAVAILABLE;
}

function hasGitMetadata(cwd = process.cwd()) {
  return existsSync(join(cwd, '.git'));
}

async function getGitExecFile() {
  if (gitExecFileForTest) return gitExecFileForTest;
  const { execFile } = await import('node:child_process');
  return execFile;
}

export function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!hasGitMetadata(opts.cwd)) return reject(makeSelfUpdateUnavailableError());
    getGitExecFile().then((execFile) => {
      execFile('git', args, { timeout: 30_000, maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') return reject(makeSelfUpdateUnavailableError());
        if (err) return reject(new Error((stderr || err.message).toString().slice(0, 500)));
        resolve(stdout.toString());
      });
    }).catch(reject);
  });
}

async function gitStatus() {
  const commit = (await runGit(['rev-parse', 'HEAD'])).trim();
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  let remote = '';
  try {
    await runGit(['fetch', '--quiet', 'origin']);
    remote = (await runGit(['rev-parse', `origin/${branch}`])).trim();
  } catch {}
  const localMsg = (await runGit(['log', '-1', '--pretty=format:%s'])).trim();
  const behind = remote && remote !== commit;
  const remoteMsg = behind ? (await runGit(['log', '-1', '--pretty=format:%s', remote]).catch(() => '')).trim() : '';
  return {
    commit: commit.slice(0, 7),
    commitFull: commit,
    branch,
    localMessage: localMsg,
    remoteCommit: remote ? remote.slice(0, 7) : '',
    remoteMessage: remoteMsg,
    behind,
  };
}

async function testProxy({ host, port, username, password, type }) {
  if (config.allowPrivateProxyHosts) {
    await validateHostFormat(host);
  } else {
    await assertPublicUrlHost(host);
  }
  const { isSocks, createSocksTunnel } = await import('../socks.js');
  const tls = await import('node:tls');
  const targetHost = 'api.ipify.org';
  const targetPort = 443;
  const proxy = { host, port, username, password, type };

  // Get a raw TCP socket — either via SOCKS5 or HTTP CONNECT
  let socket;
  if (isSocks(proxy)) {
    socket = await createSocksTunnel(proxy, targetHost, targetPort, 10000);
  } else {
    const http = await import('node:http');
    // #11: pin the proxy host to a vetted IP literal so this CONNECT does not
    // re-resolve the (already validated) hostname via a second, rebindable lookup.
    const dialHost = await resolveProxyConnectHost(host, { allowPrivate: config.allowPrivateProxyHosts });
    socket = await new Promise((resolve, reject) => {
      const authHeader = username
        ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64') }
        : {};
      const req = http.request({
        host: dialHost, port, method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers: { Host: `${targetHost}:${targetPort}`, ...authHeader },
        timeout: 10000,
      });
      req.on('connect', (res, sock) => {
        if (res.statusCode !== 200) { sock.destroy(); return reject(new Error(`ERR_PROXY_HTTP_ERROR:${res.statusCode}`)); }
        resolve(sock);
      });
      req.on('error', (err) => reject(new Error(`ERR_CONNECTION_FAILED:${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('ERR_TIMEOUT')); });
      req.end();
    });
  }

  // TLS handshake + GET to verify the tunnel works. SEC-W5: verify the cert —
  // targetHost is a fixed, well-known host (api.ipify.org) with a valid public
  // certificate, so there is no reason to accept an unverified cert. Leaving
  // rejectUnauthorized:false would let a MITM (or a malicious proxy itself)
  // present any cert and still pass the "tunnel works" check.
  return new Promise((resolve, reject) => {
      const tlsSock = tls.connect({ socket, servername: targetHost, rejectUnauthorized: true }, () => {
        tlsSock.write(`GET / HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\nUser-Agent: WindsurfAPI/ProxyTest\r\n\r\n`);
      });
      const chunks = [];
      tlsSock.on('data', c => chunks.push(c));
      tlsSock.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const match = body.match(/\r\n\r\n([^\r\n]+)/);
        const ip = match ? match[1].trim() : '';
        tlsSock.destroy();
        if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          return reject(new Error('ERR_TLS_TUNNEL_ERROR'));
        }
        resolve({ egressIp: ip, type });
      });
      tlsSock.on('error', (err) => reject(new Error(`ERR_TLS_FAILED:${err.message}`)));
  });
}
