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
 */

import http from 'http';
import https from 'https';
import { log } from './config.js';

const SERVER_HOSTS = [
  'server.codeium.com',
  'server.self-serve.windsurf.com',
];
const USER_STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const MODEL_CONFIGS_PATH = '/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs';
const RATE_LIMIT_PATH = '/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit';

import { isSocks, createSocksTunnel } from './socks.js';

// Tunnel HTTPS through an HTTP CONNECT proxy or SOCKS5 proxy.
function createProxyTunnel(proxy, targetHost, targetPort) {
  if (isSocks(proxy)) return createSocksTunnel(proxy, targetHost, targetPort);
  return new Promise((resolve, reject) => {
    const proxyHost = proxy.host.replace(/:\d+$/, '');
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

function postJson(host, path, body, proxy) {
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

  // Legacy values come in hundredths; divide by 100 for display.
  const legacyDiv = (n) => (typeof n === 'number' ? n / 100 : null);

  // Unix timestamps may be numeric or string depending on server version.
  const asUnix = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };

  const out = {
    planName: plan.planName || 'Unknown',
    dailyPercent: typeof ps.dailyQuotaRemainingPercent === 'number' ? ps.dailyQuotaRemainingPercent : null,
    weeklyPercent: typeof ps.weeklyQuotaRemainingPercent === 'number' ? ps.weeklyQuotaRemainingPercent : null,
    dailyResetAt: asUnix(ps.dailyQuotaResetAtUnix),
    weeklyResetAt: asUnix(ps.weeklyQuotaResetAtUnix),
    overageBalance: typeof ps.overageBalanceMicros === 'number' ? ps.overageBalanceMicros / 1_000_000 : null,
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
          log.info(`RegisterUser via register.windsurf.com OK (key=${apiKey.slice(0, 12)}...)`);
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
