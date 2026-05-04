/**
 * Windsurf direct login — Auth1/Firebase auth + Codeium registration.
 * Supports proxy tunneling and fingerprint randomization.
 */

import http from 'http';
import https from 'https';
import { log } from '../config.js';
import { isSocks, createSocksTunnel } from '../socks.js';

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

async function postAuthDualPath(body, fingerprint, proxy, preferredHost = null) {
  // Try the new windsurf.com/_backend host first; on 5xx / network error
  // retry against the legacy server.self-serve.windsurf.com host. Both
  // accept the same Connect-RPC body shape.
  //
  // v2.0.75 (#114 CharwinYAO follow-up): added preferredHost so the
  // caller can force the OPPOSITE host on a cross-host invalid-token
  // retry — see the OneTimeToken cross-host fallback in
  // windsurfLoginViaPasswordAuth1.
  const headers = buildJsonHeaders(fingerprint, body, { 'Connect-Protocol-Version': '1' });
  const orderedHosts = preferredHost === 'legacy'
    ? [[WINDSURF_POST_AUTH_URL, 'legacy'], [WINDSURF_POST_AUTH_URL_NEW, 'new']]
    : [[WINDSURF_POST_AUTH_URL_NEW, 'new'], [WINDSURF_POST_AUTH_URL, 'legacy']];
  let lastErr;
  for (const [url, label] of orderedHosts) {
    try {
      const res = await httpsRequest(url, { method: 'POST', headers }, body, proxy);
      // 4xx is an actual auth failure (bad token, etc) — don't fall through.
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

function createProxyTunnel(proxy, targetHost, targetPort) {
  if (isSocks(proxy)) return createSocksTunnel(proxy, targetHost, targetPort);
  return new Promise((resolve, reject) => {
    const proxyHost = proxy.host.replace(/:\d+$/, '');
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
        const raw = Buffer.concat(bufs).toString('utf8');
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
      log.warn(`CheckUserLoginMethod empty body for ${email}, falling back to /_devin-auth/connections`);
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

  log.info(`Auth1 login OK: ${email}`);

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
  const bridgeBody = JSON.stringify({ auth1Token, orgId: '' });
  const { res: br, label: bl } = await postAuthDualPath(bridgeBody, fingerprint, proxy);
  if (br.status >= 400 || !br.data?.sessionToken) {
    throw new Error(`ERR_POSTAUTH_FAILED:${JSON.stringify(br.data).slice(0, 200)}`);
  }
  const sessionToken = br.data.sessionToken;
  const accountId = br.data.accountId || 'unknown';
  log.info(`Windsurf PostAuth OK (${bl}): ${email} account=${accountId} → using sessionToken as apiKey`);

  return {
    apiKey: sessionToken,
    name: email,
    email,
    apiServerUrl: '',
    sessionToken,
    auth1Token,
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

  log.info(`Firebase login OK: ${email}, UID=${fbRes.data.localId}`);

  const reg = await registerWithCodeium(idToken, fingerprint, proxy);
  log.info(`Codeium register OK: ${email} → key=${reg.api_key.slice(0, 20)}...`);

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
const EMAIL_LOCK_THRESHOLD = 3;
const EMAIL_LOCK_DURATION_MS = 15 * 60 * 1000;
const EMAIL_LOCK_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const _emailFailures = new Map();

export function _resetEmailLockoutForTests() { _emailFailures.clear(); }

export function checkEmailLocked(email) {
  if (!email || typeof email !== 'string') return null;
  const k = email.toLowerCase();
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
  const k = email.toLowerCase();
  const now = Date.now();
  let e = _emailFailures.get(k);
  if (!e) { e = { count: 0, lockedUntil: 0, lastActivity: now }; _emailFailures.set(k, e); }
  e.count += 1;
  e.lastActivity = now;
  e.lastReason = reason ? String(reason).slice(0, 80) : '';
  if (e.count >= EMAIL_LOCK_THRESHOLD) {
    e.lockedUntil = now + EMAIL_LOCK_DURATION_MS;
    e.count = 0;
    log.warn(`Email lockout: ${k} banned for ${EMAIL_LOCK_DURATION_MS / 60000}min after ${EMAIL_LOCK_THRESHOLD} failed Windsurf logins (last="${e.lastReason}")`);
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
    const err = new Error(`Email ${email} 因连续 ${EMAIL_LOCK_THRESHOLD} 次登录失败被本地锁定，请 ${minutes} 分钟后再试。`);
    err.code = 'ERR_EMAIL_LOCKED';
    err.retryAfterMs = lockMs;
    err.isAuthFail = false;
    throw err;
  }
  const fingerprint = generateFingerprint();
  log.info(`Windsurf login: ${email} fp=${fingerprint['User-Agent'].slice(0, 40)}... proxy=${proxy?.host || 'none'}`);

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
      log.warn(`Auth1 connections probe failed for ${email}: ${err.message}`);
    }
    // interpretConnections handles BOTH the old `{auth_method:{...}}`
    // and the post-2026-04-26 `{connections:[...]}` shape — Windsurf is
    // currently serving both depending on which CDN edge you hit.
    conn = interpretConnections(auth1Connections);
  }

  if (conn.method === 'auth1') {
    if (!conn.hasPassword) {
      const err = createFriendlyAuthError('Auth1', 'No password set. Please log in with Google or GitHub.');
      recordEmailFailure(email, 'no_password');
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
