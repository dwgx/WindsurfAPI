/**
 * REST/Connect-RPC client for Windsurf/Codeium cloud services.
 *
 * Unlike client.js (which talks to the local language server binary over gRPC),
 * this module hits public Connect-RPC endpoints that accept JSON, so we don't
 * need proto builders/parsers to fetch account metadata.
 *
 *   POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus
 *   Content-Type: application/json
 *   Connect-Protocol-Version: 1
 *
 * Currently exposes:
 *   - getUserStatus(apiKey, proxy)        — plan info, quotas, credit balance
 *   - getCascadeModelConfigs(apiKey, proxy) — live model catalog (82+ models)
 *   - checkMessageRateLimit(apiKey, proxy)  — pre-flight rate limit check
 *   - getUserJwt(apiKey, host, proxy)     — short-lived user JWT (env-gated,
 *     rides in Metadata.user_jwt on chat RPCs via src/windsurf.js)
 */

import http from 'http';
import https from 'https';
import { config, log } from './config.js';
import { safeKeyRef } from './log-safety.js';
import { resolveProxyConnectHost } from './net-safety.js';

const SERVER_HOSTS = [
  'server.codeium.com',
  'server.self-serve.windsurf.com',
];
const USER_STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const MODEL_CONFIGS_PATH = '/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs';
const RATE_LIMIT_PATH = '/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit';
const WEB_SEARCH_PATH = '/exa.api_server_pb.ApiServerService/GetWebSearchResults';
// exa.auth_pb.AuthService/GetUserJwt → GetUserJwtResponse { user_jwt = 1,
// custom_api_server_url = 2 }. Cross-validated across four independent .protos
// (windsurf-grpc, widevin, Antigravity-Tools-LS, OmniRoute); rsvedant/
// opencode-windsurf-auth treats the JWT as REQUIRED on chat RPCs and rides it
// in Metadata.user_jwt = 21. ~24 min TTL, HS256-signed. Gate: env-only, default
// OFF — attaching user_jwt changes the wire every chat RPC sends, and we have no
// live capture proving the Windsurf backend needs or tolerates it.
const USER_JWT_PATH = '/exa.auth_pb.AuthService/GetUserJwt';
const USER_JWT_TTL_MS = 24 * 60 * 1000;
// TTL floor lets tests (which fake time via cacheEpoch) and clock jitter force
// a re-mint without waiting out a full window; the JWT is not persisted.
const USER_JWT_MIN_TTL_MS = 5 * 60 * 1000;

// Env switch: enable minting + attaching the short-lived user JWT. Default OFF
// (byte-identical wire until an operator opts in). Read through a function so
// tests can flip it and callers share one source of truth.
export function isUserJwtEnabled(env = process.env) {
  return String(env.WINDSURFAPI_USER_JWT || '') === '1';
}

// Monotonic epoch: bumped on every sign-out / key rotation. A mint that races a
// logout can't re-populate a stale JWT — the epoch guard below rejects the
// result of any mint that started before the bump. Mirrors rsvedant's cache
// design (per-(apiKey,host) in-flight dedup + cacheEpoch).
let _cacheEpoch = 0;
const _jwtCache = new Map();   // `${apiKey}@${host}` → { jwt, expiresAt, epoch }
const _jwtInflight = new Map(); // `${apiKey}@${host}` → Promise

/** Test seam: advance the epoch (logout/rotation path in auth.js calls this). */
export function __bumpUserJwtCacheEpoch() { _cacheEpoch++; }

import { isSocks, createSocksTunnel } from './socks.js';

// Tunnel HTTPS through an HTTP CONNECT proxy or SOCKS5 proxy.
async function createProxyTunnel(proxy, targetHost, targetPort) {
  if (isSocks(proxy)) return createSocksTunnel(proxy, targetHost, targetPort);
  // #11: pin the proxy host to a vetted IP literal so the CONNECT socket does no
  // second (rebindable) DNS lookup. Honors ALLOW_PRIVATE_PROXY_HOSTS.
  const rawHost = proxy.host.replace(/:\d+$/, '');
  const proxyHost = await resolveProxyConnectHost(rawHost, { allowPrivate: config.allowPrivateProxyHosts });
  return new Promise((resolve, reject) => {
    const proxyPort = proxy.port || 8080;
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(proxy.username ? {
          'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}`,
        } : {}),
      },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else { socket.destroy(); reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`)); }
    });
    req.on('error', (err) => reject(new Error(`Proxy tunnel: ${err.message}`)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Proxy tunnel timeout')); });
    req.end();
  });
}

/** Detect errors caused by the proxy itself (not the upstream API). */
function isProxyError(err) {
  const m = err?.message || '';
  return /Proxy CONNECT failed|Proxy tunnel|Proxy connection/i.test(m);
}

let postJsonOverride = null;

export function __setWindsurfApiPostJsonForTest(fn) {
  postJsonOverride = typeof fn === 'function' ? fn : null;
}

function postJson(host, path, body, proxy) {
  if (postJsonOverride) return postJsonOverride(host, path, body, proxy);
  return new Promise(async (resolve, reject) => {
    const postData = JSON.stringify(body);
    const opts = {
      hostname: host,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Connect-Protocol-Version': '1',
        'Accept': 'application/json',
        'User-Agent': 'windsurf/1.9600.41',
      },
    };
    const onRes = (res) => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(bufs).toString('utf8');
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          resolve({ status: res.statusCode, data: parsed, raw });
        } catch {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    };
    try {
      let req;
      if (proxy && proxy.host) {
        const socket = await createProxyTunnel(proxy, host, 443);
        opts.socket = socket;
        opts.agent = false;
        req = https.request(opts, onRes);
      } else {
        req = https.request(opts, onRes);
      }
      req.on('error', (err) => reject(new Error(`Request: ${err.message}`)));
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(postData);
      req.end();
    } catch (err) { reject(err); }
  });
}

/**
 * Mint (and cache) the short-lived user JWT for `apiKey` from the given host.
 *
 * Returns the JWT string. Callers that will send it MUST first check
 * isUserJwtEnabled() — this function does the network round-trip regardless, so
 * the hot path must not call it when the feature is off.
 *
 * Cache shape (mirrors rsvedant/opencode-windsurf-auth):
 *   - per-(apiKey,host) entries, so a multi-host pool doesn't share one JWT
 *     minted against the wrong host;
 *   - in-flight dedup: concurrent callers for the same (apiKey,host) share one
 *     upstream RPC instead of stampeding GetUserJwt;
 *   - monotonic cacheEpoch: auth.js bumps the epoch on every logout / key
 *     rotation, so a mint racing a logout cannot repopulate a stale JWT. The
 *     epoch guard lives INSIDE the shared mint promise, so every awaiter (the
 *     owner and any concurrent joiner) sees the same rejection rather than the
 *     owner alone — a joiner that returned a stale token would defeat the guard.
 *
 * The TTL is shortened to USER_JWT_MIN_TTL_MS when it would expire sooner, so
 * a process that observes clock skew re-mints rather than trusting a token that
 * may already be expired upstream.
 *
 * @param {string} apiKey
 * @param {string} host
 * @param {object} [proxy]
 * @returns {Promise<string>}
 */
export async function getUserJwt(apiKey, host, proxy = null) {
  const key = `${apiKey}@${host}`;
  const now = Date.now();
  const cached = _jwtCache.get(key);
  if (cached && cached.epoch === _cacheEpoch && cached.expiresAt > now) {
    return cached.jwt;
  }
  if (_jwtInflight.has(key)) {
    // A mint is already running for this (apiKey,host) — share its guarded
    // result instead of stampeding GetUserJwt. On failure, fall through and
    // start a fresh mint below.
    try { return await _jwtInflight.get(key); } catch { /* retry fresh */ }
  }
  const epochAtStart = _cacheEpoch;
  const mint = (async () => {
    const body = { metadata: buildMetadata(apiKey) };
    let lastErr = null;
    for (const px of proxy ? [proxy, null] : [null]) {
      try {
        const res = await postJson(host, USER_JWT_PATH, body, px);
        if (res.status >= 400) {
          lastErr = new Error(`GetUserJwt ${host} → ${res.status}: ${res.raw.slice(0, 160)}`);
          continue;
        }
        const jwt = res.data?.userJwt || res.data?.user_jwt;
        if (typeof jwt !== 'string' || !jwt) {
          lastErr = new Error(`GetUserJwt ${host}: response missing user_jwt`);
          continue;
        }
        // A logout/rotation that raced this mint must not re-populate the cache
        // with a stale JWT nor hand one to any awaiter — reject outright.
        if (epochAtStart !== _cacheEpoch) {
          throw new Error('GetUserJwt: cache epoch changed during mint (logout raced)');
        }
        const mintedAt = Date.now();
        const ttl = Math.max(USER_JWT_MIN_TTL_MS, Math.min(USER_JWT_TTL_MS, Number(res.data?.ttlMs) || USER_JWT_TTL_MS));
        _jwtCache.set(key, { jwt, expiresAt: mintedAt + ttl, epoch: _cacheEpoch });
        return jwt;
      } catch (e) {
        lastErr = e;
        if (px && isProxyError(e)) break; // bad tunnel — go straight to direct
      }
    }
    throw lastErr || new Error('GetUserJwt: all hosts failed');
  })();
  _jwtInflight.set(key, mint);
  try {
    return await mint;
  } finally {
    // Only the owner reaches here (joiners early-returned above); remove the
    // in-flight marker so a later caller can mint a fresh one.
    if (_jwtInflight.get(key) === mint) _jwtInflight.delete(key);
  }
}

/** Test seam: reset the cache + epoch so tests can start clean. */
export function __resetUserJwtCache() {
  _jwtCache.clear();
  _jwtInflight.clear();
  _cacheEpoch = 0;
}

/** Test seam: current cache size (dedup/invalidation assertions). */
export function __userJwtCacheStats() {
  return { entries: _jwtCache.size, inflight: _jwtInflight.size, epoch: _cacheEpoch };
}

function normalizeWebSearchResults(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    results,
    webSearchUrl: data?.webSearchUrl || data?.web_search_url || '',
    summary: data?.summary || '',
    raw: data,
    fetchedAt: Date.now(),
  };
}

/**
 * Fetch account status: plan, quotas, credit balance, and model catalog.
 * Tries both known Connect-RPC hostnames before giving up.
 *
 * Returns a normalized shape that covers both the legacy credit contract
 * (availablePromptCredits / usedPromptCredits) and the newer quota contract
 * (dailyQuotaRemainingPercent / weeklyQuotaRemainingPercent).
 *
 * @param {string} apiKey
 * @param {object} [proxy] optional HTTP CONNECT proxy
 * @returns {Promise<{planName, dailyPercent, weeklyPercent, dailyResetAt, weeklyResetAt, prompt:{used,limit}, flex:{used,limit}, raw}>}
 */
export async function getUserStatus(apiKey, proxy = null) {
  const body = {
    metadata: {
      apiKey,
      ideName: 'windsurf',
      ideVersion: '1.9600.41',
      extensionName: 'windsurf',
      extensionVersion: '1.9600.41',
      locale: 'en',
    },
  };

  // Try with proxy first, then retry direct if proxy itself fails (407 etc.).
  const proxyModes = proxy ? [proxy, null] : [null];
  let lastErr = null;
  for (const px of proxyModes) {
    for (const host of SERVER_HOSTS) {
      try {
        const res = await postJson(host, USER_STATUS_PATH, body, px);
        if (res.status >= 400) {
          lastErr = new Error(`GetUserStatus ${host} → ${res.status}: ${res.raw.slice(0, 160)}`);
          continue;
        }
        return normalizeUserStatus(res.data);
      } catch (e) {
        lastErr = e;
        log.debug(`getCreditUsage ${host} failed: ${e.message}`);
        if (px && isProxyError(e)) break; // skip second host, go straight to direct
      }
    }
  }
  throw lastErr || new Error('GetUserStatus: all hosts failed');
}

function normalizeUserStatus(data) {
  const ps = data?.userStatus?.planStatus || {};
  const plan = ps.planInfo || {};

  // Capability discovery, not plan-name detection: newer Devin-backed plans
  // expose fractional ACU accounting directly on PlanStatus. Keep absence as
  // null (never manufacture a zero), and never persist the raw UserStatus where
  // org/user identifiers and deployment URLs also live.
  const nonNegativeNumber = (value) => {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  // Legacy values come in hundredths; divide by 100 for display.
  // Devin-backed plans use -1 as a legacy-credit "not applicable" sentinel.
  // Treat it as absence so it cannot render as -0.01 credits or masquerade as
  // a personal quota alongside ACU accounting.
  const legacyDiv = (n) => (
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n / 100 : null
  );

  // Unix timestamps may be numeric or string depending on server version.
  const asUnix = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };

  const out = {
    planName: plan.planName || 'Unknown',
    // proto3-JSON omits zero values, so a fully-used quota (0% remaining) comes
    // back as an ABSENT field, not `0` — which we'd otherwise render as N/A even
    // though the real answer is "0% left / 100% used". When the quota dimension
    // is clearly active (its reset timestamp is present, or the sibling daily
    // field exists), treat a missing percentage as 0 rather than null/N/A.
    dailyPercent: typeof ps.dailyQuotaRemainingPercent === 'number'
      ? ps.dailyQuotaRemainingPercent
      : (ps.dailyQuotaResetAtUnix != null ? 0 : null),
    weeklyPercent: typeof ps.weeklyQuotaRemainingPercent === 'number'
      ? ps.weeklyQuotaRemainingPercent
      : ((ps.weeklyQuotaResetAtUnix != null || typeof ps.dailyQuotaRemainingPercent === 'number') ? 0 : null),
    dailyResetAt: asUnix(ps.dailyQuotaResetAtUnix),
    weeklyResetAt: asUnix(ps.weeklyQuotaResetAtUnix),
    overageBalance: typeof ps.overageBalanceMicros === 'number' ? ps.overageBalanceMicros / 1_000_000 : null,
    acuConsumed: nonNegativeNumber(ps.acuConsumed ?? ps.acu_consumed),
    acuLimit: nonNegativeNumber(ps.acuLimit ?? ps.acu_limit),
    prompt: {
      limit: legacyDiv(plan.monthlyPromptCredits),
      used: legacyDiv(ps.usedPromptCredits),
      remaining: legacyDiv(ps.availablePromptCredits),
    },
    flex: {
      limit: legacyDiv(plan.monthlyFlexCreditPurchaseAmount),
      used: legacyDiv(ps.usedFlexCredits),
      remaining: legacyDiv(ps.availableFlexCredits),
    },
    planStart: ps.planStart || null,
    planEnd: ps.planEnd || null,
    // Preserve the untouched response so downstream caching (model catalog)
    // can inspect fields we haven't normalized yet.
    raw: data,
    fetchedAt: Date.now(),
  };

  // Derive a single display-friendly percent: prefer daily remaining; otherwise
  // compute from prompt credits; otherwise null.
  if (out.dailyPercent != null) {
    out.percent = out.dailyPercent;
  } else if (out.prompt.limit && out.prompt.remaining != null) {
    out.percent = (out.prompt.remaining / out.prompt.limit) * 100;
  } else {
    out.percent = null;
  }

  return out;
}

// ─── Dynamic model catalog ────────────────────────────────

function buildMetadata(apiKey) {
  return {
    apiKey,
    ideName: 'windsurf',
    ideVersion: '1.9600.41',
    extensionName: 'windsurf',
    extensionVersion: '1.9600.41',
    locale: 'en',
  };
}

/**
 * Fetch the live model catalog from Codeium's cloud.
 * Returns an array of ClientModelConfig objects with modelUid, label,
 * creditMultiplier, provider, maxTokens, supportsImages, etc.
 *
 * @param {string} apiKey
 * @param {object} [proxy]
 * @returns {Promise<{configs: object[], sorts: object[], defaultOverride: object|null}>}
 */
export async function getCascadeModelConfigs(apiKey, proxy = null) {
  const body = { metadata: buildMetadata(apiKey) };

  const proxyModes = proxy ? [proxy, null] : [null];
  let lastErr = null;
  for (const px of proxyModes) {
    for (const host of SERVER_HOSTS) {
      try {
        const res = await postJson(host, MODEL_CONFIGS_PATH, body, px);
        if (res.status >= 400) {
          lastErr = new Error(`GetCascadeModelConfigs ${host} → ${res.status}: ${res.raw.slice(0, 160)}`);
          continue;
        }
        return {
          configs: res.data.clientModelConfigs || [],
          sorts: res.data.clientModelSorts || [],
          defaultOverride: res.data.defaultOverrideModelConfig || null,
        };
      } catch (e) {
        lastErr = e;
        log.debug(`GetCascadeModelConfigs host ${host} failed: ${e.message}`);
        if (px && isProxyError(e)) break;
      }
    }
  }
  throw lastErr || new Error('GetCascadeModelConfigs: all hosts failed');
}

/**
 * Direct Windsurf web search API.
 *
 * Confirmed from the LS descriptor dump and VPS canary:
 *   GetWebSearchResultsRequest {
 *     metadata = 1;
 *     query = 2;
 *     limit = 3;
 *     domain = 4;
 *     third_party_config = 5;
 *     mode = 6;
 *   }
 *   GetWebSearchResultsResponse { results = 1; web_search_url = 2; summary = 3 }
 *
 * This helper is intentionally separate from the native bridge. LS-native
 * WebSearch/WebFetch still returns a Cascade permission_denied error in live
 * canaries even when this direct API succeeds.
 */
export async function getWebSearchResults(apiKey, {
  query,
  limit = 5,
  domain = '',
  thirdPartyConfig = null,
  mode = undefined,
} = {}, proxy = null) {
  const q = String(query || '').trim();
  if (!q) throw new Error('getWebSearchResults: query required');
  const body = {
    metadata: buildMetadata(apiKey),
    query: q,
    limit: Math.max(1, Math.min(10, Number(limit) || 5)),
  };
  if (domain) body.domain = String(domain);
  if (thirdPartyConfig && typeof thirdPartyConfig === 'object') body.thirdPartyConfig = thirdPartyConfig;
  if (mode !== undefined && mode !== null && mode !== '') body.mode = mode;

  const proxyModes = proxy ? [proxy, null] : [null];
  let lastErr = null;
  for (const px of proxyModes) {
    for (const host of SERVER_HOSTS) {
      try {
        const res = await postJson(host, WEB_SEARCH_PATH, body, px);
        if (res.status >= 400) {
          lastErr = new Error(`GetWebSearchResults ${host} -> ${res.status}: ${res.raw.slice(0, 160)}`);
          continue;
        }
        return normalizeWebSearchResults(res.data);
      } catch (e) {
        lastErr = e;
        log.debug(`GetWebSearchResults host ${host} failed: ${e.message}`);
        if (px && isProxyError(e)) break;
      }
    }
  }
  throw lastErr || new Error('GetWebSearchResults: all hosts failed');
}

/**
 * Register a Codeium/Windsurf account from a Firebase ID token. v2.0.57:
 * tries the new `register.windsurf.com/.../SeatManagementService/RegisterUser`
 * Connect-RPC path first, then falls back to the legacy
 * `api.codeium.com/register_user/` REST path. Windsurf migrated the seat-
 * management surface in 2026 — the new path is the one wam-bundle and
 * WindsurfSwitch use, and is what the official Windsurf 2.0.67 IDE talks
 * to. The fallback keeps existing /auth/login flows alive even if the
 * new host has a regional outage or a temporary 5xx.
 *
 * Optional `customRequest(url, opts, body)` lets callers (windsurf-login.js)
 * inject fingerprint headers + proxy tunneling. When omitted we use the
 * built-in postJson with no fingerprint and direct egress.
 *
 * @param {string} firebaseToken
 * @param {object} [opts]
 * @param {(url:string, opts:object, body:string) => Promise<{status:number,data:any,raw:string}>} [opts.requestFn]
 *   Custom HTTP function. Receives full URL, fetch-like opts, and stringified body.
 * @param {object} [opts.proxy]  Used by the default postJson path.
 * @returns {Promise<{apiKey, name, apiServerUrl, source: 'new'|'legacy'}>}
 */
export async function registerWithFirebaseToken(firebaseToken, opts = {}) {
  if (!firebaseToken || typeof firebaseToken !== 'string') {
    throw new Error('registerWithFirebaseToken: firebase token required');
  }
  const body = { firebase_id_token: firebaseToken };
  const bodyStr = JSON.stringify(body);
  const proxy = opts.proxy || null;

  // Connect-RPC compliant request to register.windsurf.com.
  const newUrl = 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser';
  // Legacy REST endpoint at api.codeium.com.
  const legacyUrl = 'https://api.codeium.com/register_user/';

  const tryUrl = async (url, source) => {
    if (typeof opts.requestFn === 'function') {
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Connect-Protocol-Version': '1',
        'Accept': 'application/json',
        'User-Agent': 'windsurf/1.9600.41',
      };
      const r = await opts.requestFn(url, { method: 'POST', headers }, bodyStr);
      return { status: r.status, data: r.data, raw: r.raw, source };
    }
    // Default path: built-in postJson on the host of the URL.
    const u = new URL(url);
    const r = await postJson(u.hostname, u.pathname, body, proxy);
    return { status: r.status, data: r.data, raw: r.raw, source };
  };

  const errors = [];
  for (const [url, source] of [[newUrl, 'new'], [legacyUrl, 'legacy']]) {
    try {
      const r = await tryUrl(url, source);
      // Both paths return either snake_case (api_key/name/api_server_url) or
      // camelCase (apiKey/name/apiServerUrl) depending on the gateway.
      const apiKey = r.data?.api_key || r.data?.apiKey;
      const name = r.data?.name || '';
      const apiServerUrl = r.data?.api_server_url || r.data?.apiServerUrl || '';
      if (r.status < 400 && apiKey) {
        if (source === 'legacy') {
          log.warn(`RegisterUser fell back to legacy api.codeium.com (new endpoint failed)`);
        } else {
          log.info(`RegisterUser via register.windsurf.com OK (${safeKeyRef(apiKey, 'apiKey')})`);
        }
        return { apiKey, name, apiServerUrl, source };
      }
      errors.push(`${source}=HTTP ${r.status} ${r.raw?.slice(0, 120) || '(empty)'}`);
    } catch (e) {
      errors.push(`${source}=${e.message}`);
    }
  }
  throw new Error(`RegisterUser failed both endpoints: ${errors.join(' | ')}`);
}

/**
 * Pre-flight check: does this account still have message capacity?
 * Returns { hasCapacity, messagesRemaining, maxMessages }.
 * -1 means unlimited.
 *
 * @param {string} apiKey
 * @param {object} [proxy]
 * @returns {Promise<{hasCapacity: boolean, messagesRemaining: number, maxMessages: number}>}
 */
export async function checkMessageRateLimit(apiKey, proxy = null) {
  const body = { metadata: buildMetadata(apiKey) };

  const proxyModes = proxy ? [proxy, null] : [null];
  let lastErr = null;
  for (const px of proxyModes) {
    for (const host of SERVER_HOSTS) {
      try {
        const res = await postJson(host, RATE_LIMIT_PATH, body, px);
        if (res.status >= 400) {
          lastErr = new Error(`CheckRateLimit ${host} → ${res.status}: ${res.raw.slice(0, 160)}`);
          continue;
        }
        return {
          hasCapacity: res.data.hasCapacity !== false,
          messagesRemaining: res.data.messagesRemaining ?? -1,
          maxMessages: res.data.maxMessages ?? -1,
          retryAfterMs: Number.isFinite(res.data.retryAfterMs) ? res.data.retryAfterMs : null,
        };
      } catch (e) {
        lastErr = e;
        log.debug(`CheckRateLimit host ${host} failed: ${e.message}`);
        if (px && isProxyError(e)) break;
      }
    }
  }
  // On failure, assume capacity so we don't block requests.
  log.warn(`CheckRateLimit failed: ${lastErr?.message}`);
  return { hasCapacity: true, messagesRemaining: -1, maxMessages: -1, retryAfterMs: null };
}
