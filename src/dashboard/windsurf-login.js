/**
 * Windsurf direct login — Auth1/Firebase auth + Codeium registration.
 * Supports proxy tunneling and fingerprint randomization.
 */

import http from 'http';
import https from 'https';
import { config, log } from '../config.js';
import { resolveProxyConnectHost } from '../net-safety.js';
import { safeEmailRef, safeKeyRef, logHash } from '../log-safety.js';
import { isSocks, createSocksTunnel } from '../socks.js';
import { getEmailLockThreshold, getEmailLockMs, getBackendSwitch } from '../runtime-config.js';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const FIREBASE_AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const CODEIUM_REGISTER_URL = 'https://api.codeium.com/register_user/';
const AUTH1_CONNECTIONS_URL = 'https://windsurf.com/_devin-auth/connections';
const AUTH1_PASSWORD_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
// 2026-04-26: Windsurf moved the primary email-method probe to a Connect-RPC
// path under `_backend/...SeatManagementService/CheckUserLoginMethod`. The
// response is fast and clean (`{userExists,hasPassword}`); the old
// `/_devin-auth/connections` path is still wired in their bundle but
// runs on Vercel functions that 504 every few seconds. We use the new
// endpoint as the primary probe and fall back to the old one only if
// the new one is unreachable.
const WINDSURF_CHECK_LOGIN_METHOD_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod';
const WINDSURF_SEAT_SERVICE_BASE = 'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService';
const WINDSURF_POST_AUTH_URL = `${WINDSURF_SEAT_SERVICE_BASE}/WindsurfPostAuth`;
const WINDSURF_ONE_TIME_TOKEN_URL = `${WINDSURF_SEAT_SERVICE_BASE}/GetOneTimeAuthToken`;
// v2.0.57 (Fix 2): Windsurf migrated PostAuth into the website _backend
// path. Wam-bundle and the official 2.0.67 IDE talk to the new host;
// keep the old self-serve endpoint as fallback so a regional outage on
// either side doesn't break login. Same for GetOneTimeAuthToken which
// shares the SeatManagementService surface.
const WINDSURF_BACKEND_SEAT_BASE = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService';
const WINDSURF_POST_AUTH_URL_NEW = `${WINDSURF_BACKEND_SEAT_BASE}/WindsurfPostAuth`;
const WINDSURF_ONE_TIME_TOKEN_URL_NEW = `${WINDSURF_BACKEND_SEAT_BASE}/GetOneTimeAuthToken`;

// ─── Second-host fallback: app.devin.ai (opt-in, OFF by default) ──────────
// The OAuth feasibility study (.workflow-results/oauth-relogin-study/
// FEASIBILITY-BLUEPRINT.md §6 + tool-github-oauth-totp.md §1.1) found the
// leaked Windsurf account-switcher drives app.devin.ai/api/auth1/{connections,
// password/login} as the SAME Auth1 mechanism we hit on windsurf.com/_devin-auth,
// differing only by host. windsurf.com runs on Vercel functions that 504/503
// intermittently and has migrated endpoints under us before; pointing a fallback
// at a second host (app.devin.ai) spreads that single-host availability risk
// without touching GitHub OAuth / TOTP / form-scraping.
//
// Gated behind DEVIN_CONNECT_LOGIN_HOST_FALLBACK=1. When the env var is unset
// (default), windsurfLogin behaves EXACTLY as before — only the windsurf.com
// primary path runs and this code is never reached.
const DEVIN_HOST_BASE = 'https://app.devin.ai';
const DEVIN_AUTH1_CONNECTIONS_URL = `${DEVIN_HOST_BASE}/api/auth1/connections`;
const DEVIN_AUTH1_PASSWORD_LOGIN_URL = `${DEVIN_HOST_BASE}/api/auth1/password/login`;

function isLoginHostFallbackEnabled() {
  return getBackendSwitch('loginHostFallback');
}

// Test-only transport seam: when set, every httpsRequest in this module is
// routed through the injected fn (same (url, opts, postData, proxy) signature,
// must resolve { status, data } — data is a Buffer when opts.raw is set). Lets
// the host-fallback tests drive the full login flow deterministically with zero
// real network. Mirrors the __set*ForTests convention used elsewhere (auth.js
// __setReloginDeps, _resetEmailLockoutForTests below).
let _transportOverride = null;
export function __setLoginTransportForTests(fn) { _transportOverride = fn; }

function parsePostAuthResponseData(payload) {
  const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload || '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  const sessionToken = raw.match(/devin-session-token\$[a-zA-Z0-9._-]+/)?.[0];
  const accountId = raw.match(/account-[a-f0-9]+/)?.[0];
  const primaryOrgId = raw.match(/org-[a-f0-9]+/)?.[0];
  if (sessionToken) return { sessionToken, accountId, primaryOrgId };
  return { error: raw.slice(0, 200) || 'empty response' };
}

async function postAuthDualPath(auth1Token, fingerprint, proxy, preferredHost = null) {
  // v2.0.91 (#144 by @Await-d): upstream PostAuth now expects:
  // - empty application/proto body (not the old JSON bridge)
  // - X-Devin-Auth1-Token header (not in body)
  // - Referer from windsurf.com
  // - Raw response that may be binary proto or JSON
  const body = Buffer.alloc(0);
  const headers = {
    ...fingerprint,
    'Content-Type': 'application/proto',
    'Content-Length': 0,
    'Connect-Protocol-Version': '1',
    'X-Devin-Auth1-Token': auth1Token,
    'Referer': 'https://windsurf.com/account/login',
  };
  const orderedHosts = preferredHost === 'legacy'
    ? [[WINDSURF_POST_AUTH_URL, 'legacy'], [WINDSURF_POST_AUTH_URL_NEW, 'new']]
    : [[WINDSURF_POST_AUTH_URL_NEW, 'new'], [WINDSURF_POST_AUTH_URL, 'legacy']];
  let lastErr;
  for (const [url, label] of orderedHosts) {
    try {
      const rawRes = await httpsRequest(url, { method: 'POST', headers, raw: true }, body, proxy);
      const res = { ...rawRes, data: parsePostAuthResponseData(rawRes.data) };
      if (res.status >= 400 && res.status < 500) return { res, label };
      if (res.status >= 200 && res.status < 300 && res.data?.sessionToken) {
        return { res, label };
      }
      lastErr = new Error(`PostAuth ${label} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 120)}`);
    } catch (e) {
      lastErr = new Error(`PostAuth ${label}: ${e.message}`);
    }
  }
  throw lastErr || new Error('PostAuth: both endpoints failed');
}

async function oneTimeTokenDualPath(body, fingerprint, proxy, preferredHost = null) {
  // v2.0.61 (#114): pin OneTimeAuthToken to whichever host PostAuth used.
  // The session token gateways aren't symmetric — a token minted by
  // windsurf.com/_backend may be rejected as "invalid token" on
  // server.self-serve.windsurf.com (and vice versa). When we know which
  // host PostAuth just talked to, retry order is forced to put it first
  // so we don't accidentally replay the token across host boundaries.
  const headers = buildJsonHeaders(fingerprint, body, { 'Connect-Protocol-Version': '1' });
  const orderedHosts = preferredHost === 'legacy'
    ? [[WINDSURF_ONE_TIME_TOKEN_URL, 'legacy'], [WINDSURF_ONE_TIME_TOKEN_URL_NEW, 'new']]
    : [[WINDSURF_ONE_TIME_TOKEN_URL_NEW, 'new'], [WINDSURF_ONE_TIME_TOKEN_URL, 'legacy']];
  let lastErr;
  let firstRes = null;
  let firstLabel = null;
  for (const [url, label] of orderedHosts) {
    try {
      const res = await httpsRequest(url, { method: 'POST', headers }, body, proxy);
      if (res.status >= 200 && res.status < 300 && res.data?.authToken) {
        return { res, label };
      }
      // v2.0.61: 4xx from the preferred host is meaningful — used to
      // return immediately so caller saw the real auth error.
      //
      // v2.0.79 (audit M-3): widened to keep trying the other host
      // ONLY when the preferred host returned an "invalid token"
      // 401 — that signal is exactly the cross-host symmetry failure
      // we want to fall through. Other 4xx codes (400 bad request,
      // 403 forbidden, 410 gone) still short-circuit because they're
      // genuine permanent errors and trying the other host won't help.
      if (res.status >= 400 && res.status < 500) {
        const blob = JSON.stringify(res.data || '').toLowerCase();
        const isInvalidToken = res.status === 401 && /invalid\s*token|unauthenticated/i.test(blob);
        if (label === orderedHosts[0][1] && !isInvalidToken) {
          return { res, label };
        }
        // Either non-preferred 4xx OR preferred-but-invalid-token: keep
        // the response around in case the other host also fails — we
        // surface the FIRST 4xx (preferred host) so the caller sees the
        // primary auth error not whatever the fallback produced.
        if (firstRes === null) {
          firstRes = res;
          firstLabel = label;
        }
        lastErr = new Error(`OneTimeToken ${label} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 120)}`);
        continue;
      }
      lastErr = new Error(`OneTimeToken ${label} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 120)}`);
    } catch (e) {
      lastErr = new Error(`OneTimeToken ${label}: ${e.message}`);
    }
  }
  // Both hosts failed — return the preferred-host 4xx if we have one
  // (more useful to the caller than the fallback's error).
  if (firstRes) return { res: firstRes, label: firstLabel };
  throw lastErr || new Error('OneTimeToken: both endpoints failed');
}

// ─── Fingerprint randomization ────────────────────────────

const OS_VERSIONS = [
  'Windows NT 10.0; Win64; x64',
  'Windows NT 10.0; WOW64',
  'Macintosh; Intel Mac OS X 10_15_7',
  'Macintosh; Intel Mac OS X 11_6_0',
  'Macintosh; Intel Mac OS X 12_3_1',
  'Macintosh; Intel Mac OS X 13_4_1',
  'Macintosh; Intel Mac OS X 14_2_1',
  'X11; Linux x86_64',
  'X11; Ubuntu; Linux x86_64',
];

const CHROME_VERSIONS = [
  '120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0',
  '125.0.0.0', '126.0.0.0', '127.0.0.0', '128.0.0.0', '129.0.0.0',
  '130.0.0.0', '131.0.0.0', '132.0.0.0', '133.0.0.0', '134.0.0.0',
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9', 'en-GB,en;q=0.9', 'zh-TW,zh;q=0.9,en;q=0.8',
  'zh-CN,zh;q=0.9,en;q=0.8', 'ja,en-US;q=0.9,en;q=0.8',
  'ko,en-US;q=0.9,en;q=0.8', 'de,en-US;q=0.9,en;q=0.8',
  'fr,en-US;q=0.9,en;q=0.8', 'es,en-US;q=0.9,en;q=0.8',
  'pt-BR,pt;q=0.9,en;q=0.8',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateFingerprint() {
  const os = pick(OS_VERSIONS);
  const chromeVer = pick(CHROME_VERSIONS);
  const major = chromeVer.split('.')[0];
  const ua = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;

  return {
    'User-Agent': ua,
    'Accept-Language': pick(ACCEPT_LANGUAGES),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity',
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': os.includes('Windows') ? '"Windows"' : os.includes('Mac') ? '"macOS"' : '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Origin': 'https://windsurf.com',
    'Referer': 'https://windsurf.com/',
  };
}

function buildJsonHeaders(fingerprint, body, extra = {}) {
  return {
    ...fingerprint,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  };
}

// ─── Proxy tunnel (HTTP CONNECT or SOCKS5) ───────────────

async function createProxyTunnel(proxy, targetHost, targetPort) {
  if (isSocks(proxy)) return createSocksTunnel(proxy, targetHost, targetPort);
  // #11: pin the proxy host to a vetted IP literal (no second rebindable lookup).
  const rawHost = proxy.host.replace(/:\d+$/, '');
  const proxyHost = await resolveProxyConnectHost(rawHost, { allowPrivate: config.allowPrivateProxyHosts });
  return new Promise((resolve, reject) => {
    const proxyPort = proxy.port || 8080;

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}` } : {}),
      },
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }
    });

    connectReq.on('error', (err) => reject(new Error(`Proxy connection error: ${err.message}`)));
    connectReq.setTimeout(15000, () => { connectReq.destroy(); reject(new Error('Proxy connection timeout')); });
    connectReq.end();
  });
}

// ─── HTTPS request with optional proxy ────────────────────

function httpsRequest(url, opts, postData, proxy) {
  if (_transportOverride) return _transportOverride(url, opts, postData, proxy);
  return new Promise(async (resolve, reject) => {
    const parsed = new URL(url);
    const requestOpts = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'POST',
      headers: opts.headers || {},
    };

    const handleResponse = (res) => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => {
        const rawBuffer = Buffer.concat(bufs);
        if (opts.raw) {
          resolve({ status: res.statusCode, data: rawBuffer });
          return;
        }
        const raw = rawBuffer.toString('utf8');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          reject(new Error(`Parse error (status ${res.statusCode}, encoding ${res.headers['content-encoding'] || 'identity'}): ${raw.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    };

    try {
      let req;
      if (proxy && proxy.host) {
        const socket = await createProxyTunnel(proxy, parsed.hostname, 443);
        requestOpts.socket = socket;
        requestOpts.agent = false;
        req = https.request(requestOpts, handleResponse);
      } else {
        req = https.request(requestOpts, handleResponse);
      }

      req.on('error', (err) => reject(new Error(`Request error: ${err.message}`)));
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
      if (postData) req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Login flow ───────────────────────────────────────────

function createFriendlyAuthError(prefix, detail, fallback = 'ERR_LOGIN_FAILED') {
  const normalized = String(detail || '').trim();
  // Map Firebase/Auth1 error codes to our error codes
  const errorCodeMap = {
    'EMAIL_NOT_FOUND': 'ERR_EMAIL_NOT_FOUND',
    'INVALID_PASSWORD': 'ERR_INVALID_PASSWORD',
    'INVALID_LOGIN_CREDENTIALS': 'ERR_INVALID_CREDENTIALS',
    'Invalid email or password': 'ERR_INVALID_CREDENTIALS',
    'No password set. Please log in with Google or GitHub.': 'ERR_NO_PASSWORD_SET',
    'No password set': 'ERR_NO_PASSWORD_SET',
    'USER_DISABLED': 'ERR_USER_DISABLED',
    'TOO_MANY_ATTEMPTS_TRY_LATER': 'ERR_TOO_MANY_ATTEMPTS',
    'INVALID_EMAIL': 'ERR_INVALID_EMAIL',
  };
  const errorCode = errorCodeMap[normalized] || normalized || fallback;
  const err = new Error(errorCode);
  err.isAuthFail = [
    'EMAIL_NOT_FOUND',
    'INVALID_PASSWORD',
    'INVALID_LOGIN_CREDENTIALS',
    'Invalid email or password',
    'No password set. Please log in with Google or GitHub.',
    'No password set',
  ].includes(normalized);
  err.firebaseCode = normalized || undefined;
  err.code = errorCode;
  return err;
}

// 5xx retry helper: Windsurf 的 _devin-auth/* 端点跑在 Vercel functions
// 上，时不时 504 / 503 (FUNCTION_INVOCATION_TIMEOUT)。一次 dispatch 的
// 暂时失败不该让用户看到 "登录失败"，所以对 5xx 加退避重试 (max 3 次)。
// 4xx 和 200 直接返回不重试。
async function httpsRequestRetrying(url, opts, postData, proxy, label = 'request') {
  let lastErr = null;
  const delays = [0, 2000, 5000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const res = await httpsRequest(url, opts, postData, proxy);
      if (res.status >= 500 && res.status < 600) {
        log.warn(`${label} upstream ${res.status} (attempt ${i + 1}/${delays.length})`);
        lastErr = new Error(`Windsurf upstream ${res.status}: ${JSON.stringify(res.data || '').slice(0, 120)}`);
        continue;
      }
      return res;
    } catch (e) {
      log.warn(`${label} threw: ${e.message} (attempt ${i + 1}/${delays.length})`);
      lastErr = e;
    }
  }
  throw lastErr || new Error(`${label} failed after retries`);
}

// Windsurf 在 2026-04-26 把 /_devin-auth/connections 的响应从
//   { auth_method: { method: 'auth1', has_password: bool } }
// 换成
//   { connections: [{ id, type, enabled, client_id }, ...] }
// 其中 type:'email' + enabled:true = 该账号支持邮箱密码登录。
// 这个函数兼容新旧两种形态，返回统一的 { method, hasPassword, raw }。
function interpretConnections(data) {
  if (data && Array.isArray(data.connections)) {
    const email = data.connections.find(c => c && c.type === 'email');
    return {
      method: 'auth1',
      hasPassword: !!(email && email.enabled),
      raw: data,
    };
  }
  if (data && data.auth_method) {
    return {
      method: data.auth_method.method || null,
      hasPassword: data.auth_method.has_password !== false,
      raw: data,
    };
  }
  return { method: null, hasPassword: false, raw: data || {} };
}

async function fetchAuth1Connections(email, fingerprint, proxy) {
  const body = JSON.stringify({ product: 'windsurf', email });
  const headers = buildJsonHeaders(fingerprint, body);
  const res = await httpsRequestRetrying(
    AUTH1_CONNECTIONS_URL, { method: 'POST', headers }, body, proxy, 'Auth1 connections'
  );
  return res.data || {};
}

// New primary email-method probe (Windsurf 2026-04-26 migration).
// Returns the same { method, hasPassword, raw } shape as
// interpretConnections so call sites are uniform. On reachability failure
// returns null (caller falls back to /_devin-auth/connections).
async function fetchCheckUserLoginMethod(email, fingerprint, proxy) {
  const body = JSON.stringify({ email });
  const headers = buildJsonHeaders(fingerprint, body, { 'Connect-Protocol-Version': '1' });
  try {
    const res = await httpsRequest(
      WINDSURF_CHECK_LOGIN_METHOD_URL, { method: 'POST', headers }, body, proxy
    );
    if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
      log.warn(`CheckUserLoginMethod non-200 (${res.status}): ${JSON.stringify(res.data || '').slice(0, 120)}`);
      return null;
    }
    // Empirically (2026-04-29) the Vercel function will sometimes serve
    // an empty `{}` for valid emails — likely a cache miss / cold-start
    // edge or geo-routing fallback. Treating `userExists`/`hasPassword`
    // as false in that case wrongly funnels every account into the
    // "no password set" branch and aborts before any login attempt.
    // When neither field is present, defer to the legacy connections
    // endpoint instead of guessing.
    const hasUserField = Object.prototype.hasOwnProperty.call(res.data, 'userExists');
    const hasPwField = Object.prototype.hasOwnProperty.call(res.data, 'hasPassword');
    if (!hasUserField && !hasPwField) {
      log.warn(`CheckUserLoginMethod empty body for ${safeEmailRef(email)}, falling back to /_devin-auth/connections`);
      return null;
    }
    if (res.data.userExists === false) {
      // Caller maps this to "user not found" via interpretConnections{method:null}.
      return { method: null, hasPassword: false, raw: res.data };
    }
    return {
      method: 'auth1',
      hasPassword: !!res.data.hasPassword,
      raw: res.data,
    };
  } catch (e) {
    log.warn(`CheckUserLoginMethod unreachable: ${e.message}`);
    return null;
  }
}

async function registerWithCodeium(token, fingerprint, proxy) {
  // v2.0.57 (Fix 1): try register.windsurf.com first, fall back to
  // api.codeium.com. Both go through our fingerprint+proxy-aware
  // httpsRequest so the egress IP / UA stays consistent with the rest of
  // this login flow.
  const { registerWithFirebaseToken } = await import('../windsurf-api.js');
  const requestFn = async (url, opts, body) => {
    // buildJsonHeaders adds fingerprint headers; preserve any explicit
    // Connect-Protocol-Version / Accept the helper provided.
    const merged = buildJsonHeaders(fingerprint, body, {
      'Connect-Protocol-Version': '1',
      'Accept': 'application/json',
    });
    const r = await httpsRequest(url, { method: opts.method || 'POST', headers: merged }, body, proxy);
    return { status: r.status, data: r.data, raw: typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {}) };
  };
  try {
    const r = await registerWithFirebaseToken(token, { requestFn, proxy });
    // Preserve the snake_case shape downstream callers consume.
    return {
      api_key: r.apiKey,
      name: r.name,
      api_server_url: r.apiServerUrl,
    };
  } catch (e) {
    throw new Error(`ERR_CODEIUM_REGISTER_FAILED:${e.message}`);
  }
}

async function windsurfLoginViaAuth1(email, password, fingerprint, proxy) {
  const loginBody = JSON.stringify({ email, password });
  const loginHeaders = buildJsonHeaders(fingerprint, loginBody);
  const loginRes = await httpsRequestRetrying(
    AUTH1_PASSWORD_LOGIN_URL, { method: 'POST', headers: loginHeaders }, loginBody, proxy, 'Auth1 password/login'
  );

  // Pydantic v2 returns `detail: [...]` for validation errors; the older
  // shape was `detail: 'message'`. Normalize both for the friendly-error
  // mapper so we don't blow up trying to .toLowerCase an array.
  const rawDetail = loginRes.data?.detail;
  const detailMsg = Array.isArray(rawDetail)
    ? rawDetail.map(d => d?.msg || d?.type || JSON.stringify(d)).join('; ')
    : (typeof rawDetail === 'string' ? rawDetail : '');

  if (loginRes.status >= 400 || detailMsg) {
    throw createFriendlyAuthError('Auth1', detailMsg, 'ERR_LOGIN_FAILED');
  }

  const auth1Token = loginRes.data?.token;
  if (!auth1Token) {
    throw new Error(`ERR_AUTH1_TOKEN_MISSING:${JSON.stringify(loginRes.data).slice(0, 200)}`);
  }

  log.info(`Auth1 login OK: ${safeEmailRef(email)}`);

  // v2.0.90 (#114 lnqdev / CharwinYAO): drop OneTimeAuthToken + Codeium
  // register_user step entirely. Upstream GetOneTimeAuthToken started
  // returning 401 invalid_token for ALL sessionTokens — matrix probe
  // (scripts/probes/v2089-ott-host-matrix.mjs) confirmed 12/12 fail
  // across 3 accounts × {sToken_new, sToken_legacy} × {OTT_new,
  // OTT_legacy}. Cross-host retry can't save it; the OTT endpoint is
  // gone for good (Cognition migrated to the Devin auth flow).
  //
  // Reverse-engineering windsurf-assistant v17.42.20 (2026-04-27, the
  // upstream-tracked Windsurf account-switcher) confirms its production
  // path is Devin-only:
  //     Auth1 password/login → WindsurfPostAuth → sessionToken
  // and uses sessionToken directly as the IDE auth credential. No OTT,
  // no RegisterUser, no codeium register_user.
  //
  // Probe scripts/probes/v2089-sessiontoken-as-apikey.mjs verified the
  // Cascade gRPC backend (server.codeium.com /
  // server.self-serve.windsurf.com) accepts the raw sessionToken
  // (devin-session-token$xxx) as metadata.apiKey on GetUserStatus
  // → 4/4 200 OK with valid planName. The downstream protocol treats
  // it identically to the codeium register_user-issued sk-ws-01-... key.
  //
  // So the chain collapses from
  //     Auth1 → PostAuth → OTT → registerWithCodeium → apiKey
  // to
  //     Auth1 → PostAuth → apiKey = sessionToken.
  // RegisterUser only accepts firebase_id_token (won't take sessionToken)
  // and Firebase signInWithPassword now demands App Check tokens that
  // server-side callers can't produce — so the firebase path is dead
  // too. Devin path is the only one that works post-2026-05-04.
  const { res: br, label: bl } = await postAuthDualPath(auth1Token, fingerprint, proxy);
  if (br.status >= 400 || !br.data?.sessionToken) {
    throw new Error(`ERR_POSTAUTH_FAILED:${JSON.stringify(br.data).slice(0, 200)}`);
  }
  const sessionToken = br.data.sessionToken;
  const accountId = br.data.accountId || 'unknown';
  log.info(`Windsurf PostAuth OK (${bl}): ${safeEmailRef(email)} accountHash=${logHash(accountId)} → using sessionToken as apiKey`);

  return {
    apiKey: sessionToken,
    name: email,
    email,
    apiServerUrl: '',
    sessionToken,
    auth1Token,
  };
}

// ─── Second-host fallback chain: app.devin.ai ─────────────────────────────
//
// A COMPLETE, INDEPENDENT login attempt against app.devin.ai instead of
// windsurf.com. Only reached when DEVIN_CONNECT_LOGIN_HOST_FALLBACK=1 AND the
// windsurf.com primary path already failed. Same email+password, no GitHub,
// no TOTP, no form-scraping.
//
// Chain: app.devin.ai/api/auth1/connections (probe) →
//        app.devin.ai/api/auth1/password/login ({email,password}) → {token} →
//        postAuthDualPath(token) [REUSED from the primary path] → sessionToken.
//
// TODO(unverified): the final hop — feeding an Auth1 token minted on
// app.devin.ai into OUR WindsurfPostAuth (windsurf.com/_backend or
// server.self-serve.windsurf.com) and getting a usable `devin-session-token$`
// back — has NOT been exercised against a live account. The study
// (.workflow-results/oauth-relogin-study/FEASIBILITY-BLUEPRINT.md §1.2/§5.3,
// tool-github-oauth-totp.md §1.1) establishes only that both hosts share the
// SAME Auth1 family statically; "same family" does NOT prove our PostAuth
// exchanger accepts a token sourced from the other host. This must be
// confirmed with a real account before relying on the fallback as live-effective.
async function windsurfLoginViaDevinHost(email, password, fingerprint, proxy) {
  // Step 1 — connections probe (app.devin.ai uses product:"devin").
  // Best-effort: a probe failure must NOT abort — we still try the login,
  // exactly like the primary path tolerates a flaky connections endpoint.
  try {
    const connBody = JSON.stringify({ product: 'devin', email });
    const connHeaders = buildJsonHeaders(fingerprint, connBody);
    await httpsRequestRetrying(
      DEVIN_AUTH1_CONNECTIONS_URL, { method: 'POST', headers: connHeaders }, connBody, proxy,
      'Devin-host Auth1 connections'
    );
  } catch (err) {
    log.warn(`Devin-host connections probe failed for ${safeEmailRef(email)}: ${err.message}`);
  }

  // Step 2 — Auth1 password/login on app.devin.ai → auth1 bearer token.
  const loginBody = JSON.stringify({ email, password });
  const loginHeaders = buildJsonHeaders(fingerprint, loginBody);
  const loginRes = await httpsRequestRetrying(
    DEVIN_AUTH1_PASSWORD_LOGIN_URL, { method: 'POST', headers: loginHeaders }, loginBody, proxy,
    'Devin-host Auth1 password/login'
  );

  const rawDetail = loginRes.data?.detail;
  const detailMsg = Array.isArray(rawDetail)
    ? rawDetail.map(d => d?.msg || d?.type || JSON.stringify(d)).join('; ')
    : (typeof rawDetail === 'string' ? rawDetail : '');
  if (loginRes.status >= 400 || detailMsg) {
    throw createFriendlyAuthError('DevinHost', detailMsg, 'ERR_LOGIN_FAILED');
  }

  const auth1Token = loginRes.data?.token;
  if (!auth1Token) {
    throw new Error(`ERR_AUTH1_TOKEN_MISSING:${JSON.stringify(loginRes.data).slice(0, 200)}`);
  }
  log.info(`Devin-host Auth1 login OK: ${safeEmailRef(email)}`);

  // Step 3 — REUSE the existing PostAuth dual-path exchanger. See the
  // TODO(unverified) above: this is the hop whose cross-host acceptance is
  // not yet live-confirmed.
  const { res: br, label: bl } = await postAuthDualPath(auth1Token, fingerprint, proxy);
  if (br.status >= 400 || !br.data?.sessionToken) {
    throw new Error(`ERR_POSTAUTH_FAILED:${JSON.stringify(br.data).slice(0, 200)}`);
  }
  const sessionToken = br.data.sessionToken;
  const accountId = br.data.accountId || 'unknown';
  log.info(`Devin-host PostAuth OK (${bl}): ${safeEmailRef(email)} accountHash=${logHash(accountId)} → using sessionToken as apiKey`);

  return {
    apiKey: sessionToken,
    name: email,
    email,
    apiServerUrl: '',
    sessionToken,
    auth1Token,
    viaHost: 'app.devin.ai',
  };
}

async function windsurfLoginViaFirebase(email, password, fingerprint, proxy) {
  const firebaseBody = JSON.stringify({
    email,
    password,
    returnSecureToken: true,
  });

  const fbHeaders = buildJsonHeaders(fingerprint, firebaseBody);
  const fbRes = await httpsRequest(FIREBASE_AUTH_URL, { method: 'POST', headers: fbHeaders }, firebaseBody, proxy);

  if (fbRes.data.error) {
    const msg = fbRes.data.error.message || 'Unknown Firebase error';
    throw createFriendlyAuthError('Firebase', msg, msg);
  }

  const idToken = fbRes.data.idToken;
  if (!idToken) throw new Error('ERR_FIREBASE_TOKEN_MISSING');

  log.info(`Firebase login OK: ${safeEmailRef(email)}, uidHash=${logHash(fbRes.data.localId)}`);

  const reg = await registerWithCodeium(idToken, fingerprint, proxy);
  log.info(`Codeium register OK: ${safeEmailRef(email)} → ${safeKeyRef(reg.api_key, 'apiKey')}`);

  return {
    apiKey: reg.api_key,
    name: reg.name || email,
    email,
    idToken,
    refreshToken: fbRes.data.refreshToken || '',
    apiServerUrl: reg.api_server_url || '',
  };
}

/**
 * Full Windsurf login:
 *  - Auth1 password login → bridge session → one-time auth token → Codeium register
 *  - or legacy Firebase auth → Codeium register
 * @param {string} email
 * @param {string} password
 * @param {object} [proxy] - { host, port, username, password }
 * @returns {{ apiKey, name, email, idToken }}
 */
// v2.0.57 Fix 6 — per-email brute-force lockout. Inspiration:
// windsurf-assistant-pub `_bumpFailure` (3 strikes / 15 min ban). Without
// this, a dashboard-authenticated operator hammering bad credentials
// against /auth/login burns through Firebase/Windsurf upstream rate
// limits per account and risks getting the *real* email flagged. Lock
// the email locally so we never forward more than 3 fresh attempts in
// any 15-minute window.
const EMAIL_LOCK_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const _emailFailures = new Map();

export function _resetEmailLockoutForTests() { _emailFailures.clear(); }

export function checkEmailLocked(email) {
  if (!email || typeof email !== 'string') return null;
  const k = email.toLowerCase();
  // Operator disabled the email lockout (threshold 0): release any existing
  // lock immediately so "0 = off" takes effect now, not at natural expiry.
  if (getEmailLockThreshold() <= 0) {
    _emailFailures.delete(k);
    return null;
  }
  const e = _emailFailures.get(k);
  if (!e) return null;
  const now = Date.now();
  if (e.lockedUntil > now) return e.lockedUntil - now;
  if (e.lockedUntil > 0 && e.lockedUntil <= now) {
    e.count = 0;
    e.lockedUntil = 0;
  }
  return null;
}

function recordEmailFailure(email, reason) {
  if (!email) return;
  // Operator can disable the email lockout entirely (threshold 0) from Settings.
  const threshold = getEmailLockThreshold();
  if (threshold <= 0) return;
  const k = email.toLowerCase();
  const now = Date.now();
  let e = _emailFailures.get(k);
  if (!e) { e = { count: 0, lockedUntil: 0, lastActivity: now }; _emailFailures.set(k, e); }
  e.count += 1;
  e.lastActivity = now;
  e.lastReason = reason ? String(reason).slice(0, 80) : '';
  if (e.count >= threshold) {
    const durMs = getEmailLockMs();
    e.lockedUntil = now + durMs;
    e.count = 0;
    log.warn(`Email lockout: ${safeEmailRef(k)} banned for ${Math.round(durMs / 60000)}min after ${threshold} failed Windsurf logins (last="${e.lastReason}")`);
  }
}

function recordEmailSuccess(email) {
  if (!email) return;
  _emailFailures.delete(email.toLowerCase());
}

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _emailFailures) {
    if (e.lockedUntil > now) continue;
    if (now - (e.lastActivity || 0) > EMAIL_LOCK_IDLE_TTL_MS) _emailFailures.delete(k);
  }
}, 60 * 60 * 1000).unref?.();

export async function windsurfLogin(email, password, proxy = null) {
  const lockMs = checkEmailLocked(email);
  if (lockMs != null) {
    const minutes = Math.ceil(lockMs / 60000);
    const err = new Error(`Email ${email} 因连续 ${getEmailLockThreshold()} 次登录失败被本地锁定，请 ${minutes} 分钟后再试。`);
    err.code = 'ERR_EMAIL_LOCKED';
    err.retryAfterMs = lockMs;
    err.isAuthFail = false;
    throw err;
  }
  const fingerprint = generateFingerprint();
  log.info(`Windsurf login: ${safeEmailRef(email)} fpHash=${logHash(fingerprint['User-Agent'])} proxy=${proxy?.host || 'none'}`);

  try {
    return await windsurfLoginPrimaryHost(email, password, fingerprint, proxy);
  } catch (primaryErr) {
    // Default (flag unset): preserve the exact pre-existing behavior — only
    // windsurf.com runs, so re-throw and never touch app.devin.ai.
    if (!isLoginHostFallbackEnabled()) throw primaryErr;

    // Second-host fallback (app.devin.ai), opt-in. Same email+password, no
    // GitHub/TOTP. Spreads windsurf.com (Vercel) availability / endpoint-
    // migration risk across a second host.
    log.warn(`Primary windsurf.com login failed for ${safeEmailRef(email)} (${primaryErr.message}); attempting app.devin.ai host fallback`);
    try {
      const result = await windsurfLoginViaDevinHost(email, password, fingerprint, proxy);
      // Genuine success on the second host clears any failure the primary
      // path recorded — the credential is provably valid.
      recordEmailSuccess(email);
      log.info(`Host fallback OK via app.devin.ai for ${safeEmailRef(email)}`);
      return result;
    } catch (fallbackErr) {
      // Both hosts failed. Surface the ORIGINAL primary error so the caller
      // (reLoginAccount) sees the real primary signal and runs its existing
      // failure path → failover. We NEVER fake success, and we NEVER
      // reclassify the account as dead from here — a failed re-login just
      // means "re-login failed → false → failover", per the transient-first
      // error model. The upstream error classifier and the re-login flow in
      // auth.js stay untouched.
      log.warn(`Host fallback via app.devin.ai also failed for ${safeEmailRef(email)}: ${fallbackErr.message}`);
      throw primaryErr;
    }
  }
}

// The original windsurf.com login path (CheckUserLoginMethod probe →
// Auth1 password/login → PostAuth, or legacy Firebase). Extracted verbatim
// from windsurfLogin so the public entry can wrap it with the opt-in
// app.devin.ai host fallback without altering this logic.
async function windsurfLoginPrimaryHost(email, password, fingerprint, proxy) {
  // Probe sequence (per Windsurf 2026-04-26 half-migration):
  //   1. CheckUserLoginMethod (new Connect-RPC, fast + clean shape)
  //   2. _devin-auth/connections (old path, slow/flaky but still wired)
  //   3. fall through to Firebase legacy path
  let conn = await fetchCheckUserLoginMethod(email, fingerprint, proxy);
  if (!conn || conn.method === null) {
    let auth1Connections = null;
    try {
      auth1Connections = await fetchAuth1Connections(email, fingerprint, proxy);
    } catch (err) {
      log.warn(`Auth1 connections probe failed for ${safeEmailRef(email)}: ${err.message}`);
    }
    // interpretConnections handles BOTH the old `{auth_method:{...}}`
    // and the post-2026-04-26 `{connections:[...]}` shape — Windsurf is
    // currently serving both depending on which CDN edge you hit.
    conn = interpretConnections(auth1Connections);
  }

  if (conn.method === 'auth1') {
    if (!conn.hasPassword) {
      // This account has no email/password set — it registered via Google/GitHub
      // OAuth. That's a WRONG-METHOD signal, not a brute-force guess, so it must
      // NOT count toward the email lockout (otherwise using the wrong login tab
      // 3x locks the user out for 15min). Just return a clear, actionable error.
      const err = createFriendlyAuthError('Auth1', 'This account has no password (registered via Google/GitHub). Use the OAuth login, or paste an Auth Token from windsurf.com/show-auth-token.');
      err.code = 'ERR_NO_PASSWORD_OAUTH_ACCOUNT';
      throw err;
    }
    try {
      const result = await windsurfLoginViaAuth1(email, password, fingerprint, proxy);
      recordEmailSuccess(email);
      return result;
    } catch (e) {
      // Auth-shaped failures count toward the lockout. Network / 5xx
      // upstream errors don't (those aren't the operator's fault).
      if (e?.isAuthFail || /ERR_LOGIN_FAILED|ERR_AUTH1|EMAIL|PASSWORD/i.test(e?.message || '')) {
        recordEmailFailure(email, e?.message);
      }
      throw e;
    }
  }

  try {
    const result = await windsurfLoginViaFirebase(email, password, fingerprint, proxy);
    recordEmailSuccess(email);
    return result;
  } catch (firebaseErr) {
    if (!firebaseErr?.isAuthFail) {
      // Network / Firebase 5xx — don't count, just bubble up.
      throw firebaseErr;
    }

    try {
      const result = await windsurfLoginViaAuth1(email, password, fingerprint, proxy);
      recordEmailSuccess(email);
      return result;
    } catch (auth1Err) {
      if (auth1Err?.isAuthFail) {
        // Both paths confirmed the credential is wrong — count as one
        // failure (not two) so 3 distinct attempts truly = ban.
        recordEmailFailure(email, firebaseErr?.message || auth1Err?.message);
        throw firebaseErr;
      }
      throw auth1Err;
    }
  }
}

/**
 * Refresh a Firebase ID token using a stored refresh token.
 * Returns a new { idToken, refreshToken, expiresIn } or throws.
 *
 * @param {string} refreshToken
 * @param {object} [proxy]
 * @returns {Promise<{idToken: string, refreshToken: string, expiresIn: number}>}
 */
export async function refreshFirebaseToken(refreshToken, proxy = null) {
  if (!refreshToken) throw new Error('No refresh token available');

  const postBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postBody),
    'Referer': 'https://windsurf.com/',
    'Origin': 'https://windsurf.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  };

  const res = await httpsRequest(FIREBASE_REFRESH_URL, { method: 'POST', headers }, postBody, proxy);

  if (res.data?.error) {
    const msg = res.data.error.message || res.data.error.code || 'Unknown error';
    throw new Error(`Firebase token refresh failed: ${msg}`);
  }

  const newIdToken = res.data?.id_token || res.data?.idToken;
  const newRefreshToken = res.data?.refresh_token || res.data?.refreshToken || refreshToken;
  const expiresIn = parseInt(res.data?.expires_in || res.data?.expiresIn || '3600', 10);

  if (!newIdToken) {
    throw new Error(`Firebase token refresh: no idToken in response: ${JSON.stringify(res.data).slice(0, 200)}`);
  }

  log.info(`Firebase token refreshed, expires in ${expiresIn}s`);
  return { idToken: newIdToken, refreshToken: newRefreshToken, expiresIn };
}

/**
 * Re-register with Codeium using a refreshed Firebase token.
 * Returns a fresh API key (may be the same key if unchanged).
 *
 * @param {string} idToken - fresh Firebase ID token
 * @param {object} [proxy]
 * @returns {Promise<{apiKey: string, name: string}>}
 */
export async function reRegisterWithCodeium(idToken, proxy = null) {
  const fingerprint = generateFingerprint();
  const regRes = await registerWithCodeium(idToken, fingerprint, proxy);

  return {
    apiKey: regRes.api_key,
    name: regRes.name || '',
  };
}
