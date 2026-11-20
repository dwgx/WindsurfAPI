/**
 * Windsurf direct login — Auth1/Firebase auth + Codeium registration.
 * Supports proxy tunneling and fingerprint randomization.
 */

import https from 'https';
import { randomBytes } from 'crypto';
import { config, log } from '../config.js';
import { safeEmailRef, safeKeyRef, logHash, sliceRedactedJson } from '../log-safety.js';
import { createProxyTunnel } from '../proxy-connector.js';
import { getEmailLockThreshold, getEmailLockMs, getBackendSwitch } from '../runtime-config.js';
import { parseFields, getField, getAllFields } from '../proto.js';
import { loginResultIdentity, normalizeLoginIdentity } from '../account/login-identity.js';
// R-1 (RATE-RETRY audit): bounded response-body reads, shared with the
// devin-connect readers — one ceiling, one truncation contract.
import { createBoundedBodyAccumulator, MAX_ERROR_BODY_BYTES } from '../devin-connect.js';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const FIREBASE_AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const CODEIUM_REGISTER_URL = 'https://api.codeium.com/register_user/';
const AUTH1_CONNECTIONS_URL = 'https://windsurf.com/_devin-auth/connections';
const AUTH1_PASSWORD_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
const AUTH1_EMAIL_START_URL = 'https://windsurf.com/_devin-auth/email/start';
const AUTH1_EMAIL_COMPLETE_URL = 'https://windsurf.com/_devin-auth/email/complete';
// 2026-04-26: Windsurf added a Connect-RPC email-method probe under
// `_backend/...SeatManagementService/CheckUserLoginMethod` (`{userExists,
// hasPassword}`). It is NOT reliable: for a real, existing account it returns
// an EMPTY `{}` (live recon 2026-10-22), and treating that as "no password"
// or as "password-capable" both misclassify the account. `/_devin-auth/
// connections` is the authoritative probe — its `auth_method.has_password` is
// what windsurf.com's own login page reads. CheckUserLoginMethod is kept only
// as enrichment for the case where connections is unreachable.
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
// The OAuth feasibility study (docs-internal/workflow-results/oauth-relogin-study/
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
// Same Auth1 email-code flow, same two payloads — only the host and the
// optional `product` field differ (Devin's own bundle sends `{email, mode}`).
const DEVIN_AUTH1_EMAIL_START_URL = `${DEVIN_HOST_BASE}/api/auth1/email/start`;
const DEVIN_AUTH1_EMAIL_COMPLETE_URL = `${DEVIN_HOST_BASE}/api/auth1/email/complete`;

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

export function parsePostAuthResponseData(payload) {
  const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload || '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  // The wire response is application/proto — decode it directly (binary-safe)
  // instead of scanning the bytes as text: session_token = #1, orgs = #2,
  // auth1_token = #3 (optional, possibly ROTATED by this exchange),
  // account_id = #4, primary_org_id = #5.
  if (Buffer.isBuffer(payload)) {
    try {
      const fields = parseFields(payload);
      const sessionToken = getField(fields, 1, 2)?.value?.toString('utf8');
      if (sessionToken) {
        return {
          sessionToken,
          accountId: getField(fields, 4, 2)?.value?.toString('utf8'),
          primaryOrgId: getField(fields, 5, 2)?.value?.toString('utf8'),
          // Field #3 exists in WindsurfPostAuthResponse and the decoder used to
          // skip it. Absent → undefined (no behaviour change); present → the
          // token that can mint the NEXT session, so callers can re-store it.
          auth1Token: getField(fields, 3, 2)?.value?.toString('utf8'),
          orgs: getAllFields(fields, 2).filter(f => f.wireType === 2).map(f => decodePostAuthOrg(f.value)),
        };
      }
    } catch {}
  }
  // Regex fallback for non-protobuf responses (plain-text bodies etc.).
  const sessionToken = raw.match(/devin-session-token\$[a-zA-Z0-9._-]+/)?.[0];
  const accountId = raw.match(/account-[a-f0-9]+/)?.[0];
  const primaryOrgId = raw.match(/org-[a-f0-9]+/)?.[0];
  if (sessionToken) return { sessionToken, accountId, primaryOrgId };
  return { error: raw.slice(0, 200) || 'empty response' };
}

/** Decode one WindsurfPostAuthOrg sub-message (#2 of WindsurfPostAuthResponse). */
function decodePostAuthOrg(buf) {
  const f = parseFields(buf);
  const str = (n) => getField(f, n, 2)?.value?.toString('utf8');
  const bool = (n) => { const v = getField(f, n, 0); return v ? v.value !== 0 : undefined; };
  return {
    id: str(1), name: str(2), isAdmin: bool(3), canUseCli: bool(4),
    canUseCascade: bool(5), planSlug: str(6), subscriptionStatus: str(7),
    webappHost: str(8), ssoLoginRequired: bool(9),
  };
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
      lastErr = new Error(`PostAuth ${label} HTTP ${res.status}: ${sliceRedactedJson(res.data)}`);
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
        lastErr = new Error(`OneTimeToken ${label} HTTP ${res.status}: ${sliceRedactedJson(res.data)}`);
        continue;
      }
      lastErr = new Error(`OneTimeToken ${label} HTTP ${res.status}: ${sliceRedactedJson(res.data)}`);
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

// Same version the official IDE reports (src/windsurf.js DEFAULT_CLIENT_VERSION),
// sent as x-client-version on the Auth1/check-login-method hops. Mirror the
// upstream browser/desktop client header set so referrer-based firewall rules
// see the same fingerprint as a real Windsurf client.
const CLIENT_VERSION = process.env.WINDSURF_CLIENT_VERSION || '2.0.67';

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

  // Auth1/PostAuth routes are gated on a desktop-browser referrer; a desktop
  // User-Agent + Origin/Referer pair keeps this proxy indistinguishable from
  // the real Windsurf website client (mirrors cubezhao/ai-tools-mng auth.rs).
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
    'x-client-version': CLIENT_VERSION,
    ...extra,
  };
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
      // R-1 (RATE-RETRY audit): bounded read — see createBoundedBodyAccumulator
      // (shared ceiling). Over the cap → reject; never parse a truncated prefix.
      const buffer = createBoundedBodyAccumulator();
      res.on('data', buffer.onData);
      res.on('end', () => {
        const { raw: rawBuffer, truncated } = buffer.finish();
        if (truncated) {
          reject(new Error(`Response body exceeded ${MAX_ERROR_BODY_BYTES} bytes; truncated`));
          return;
        }
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
    // Firebase API-key referrer restriction (403). Not a credential failure —
    // our egress is what upstream rejected, so it must read as a deployment
    // problem, not "wrong password", and must never feed the email lockout.
    'API_KEY_HTTP_REFERRER_BLOCKED': 'ERR_HTTP_REFERRER_BLOCKED',
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
        lastErr = new Error(`Windsurf upstream ${res.status}: ${sliceRedactedJson(res.data || '')}`);
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

// Windsurf serves two shapes on /_devin-auth/connections:
//   { auth_method: { method, has_password, enterprise_sso_domain }, connections: [...] }
//   { auth_method: { method: 'auth1', has_password: bool } }            (older)
//
// `auth_method.has_password` is the ONLY authoritative password signal — it is
// what windsurf.com's own login page branches on (`if (has_password) password
// step; else send email code`).
//
// `connections[type=email].enabled` does NOT mean "has a password": the live
// OAuth-only account returns `email.enabled:true` alongside
// `has_password:false`, because the email connection is what carries the
// email CODE. Reading `enabled` as "password-capable" (what this function used
// to do) sent that account to password/login, and the resulting 401 was
// reported as ERR_INVALID_CREDENTIALS instead of "no password". Never infer a
// password from the connection list; when `auth_method` is absent the answer
// is `null` (unknown), not `true`.
function interpretConnections(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { method: null, hasPassword: null, userExists: null, emailCode: false, oauth: [], raw: {} };
  }
  const authMethod = data.auth_method && typeof data.auth_method === 'object' ? data.auth_method : null;
  const conns = Array.isArray(data.connections)
    ? data.connections.filter(c => c && typeof c === 'object')
    : null;
  const emailConn = conns ? conns.find(c => c.type === 'email') : null;
  const emailOffered = !!(emailConn && emailConn.enabled !== false);
  const oauth = conns
    ? conns.filter(c => c.enabled !== false && (c.type === 'google' || c.type === 'github')).map(c => c.type)
    : [];
  const hasPassword = authMethod && typeof authMethod.has_password === 'boolean'
    ? authMethod.has_password
    : null;
  // `method:null` on a present auth_method is upstream's "no such account", and
  // so is the LITERAL string "not_found": measured live 2026-10-22, an unknown
  // address returns
  //   auth_method: { method: "not_found", has_password: false, enterprise_sso_domain: false }
  // and windsurf.com's own login bundle branches on exactly that value
  // (`method === 'not_found'` → "No account found. Sign up?"). Reading it as a
  // method made `userExists` true and offered an email code for a typo (F1).
  // It is a sentinel, never a login method — do not return it to callers.
  const rawMethod = authMethod && typeof authMethod.method === 'string'
    ? authMethod.method.trim()
    : '';
  const method = rawMethod && rawMethod !== 'not_found' ? rawMethod : null;
  // With `auth_method` present, `method:null`/`not_found` is upstream's "no
  // such account". WITHOUT it, an empty `connections: []` is not evidence of
  // anything — the body may simply be partial — so the answer is "unknown"
  // (null), never "no account". Returning false there made a probe reply of
  // `{"connections":[]}` (a real shape from app.devin.ai) abort the login as
  // ERR_EMAIL_NOT_FOUND.
  const userExists = authMethod
    ? method !== null
    : (conns && conns.length > 0 ? true : null);
  // Email-code login is the alternative whenever there is no password. With
  // `hasPassword:true` the email connection is the password form, not a code.
  // A missing account gets neither: upstream's has_password:false describes a
  // method with no account behind it, so it must not become an offer to send
  // mail (F1).
  const emailCode = userExists === false
    ? false
    : hasPassword === false
      ? (conns ? emailOffered : true)
      : (hasPassword === null ? emailOffered : false);
  // The connection list is global, not account-scoped: upstream returns the
  // same email/google/github entries for an address that does not exist. Do
  // not hand a caller a provider list for a missing account.
  return { method, hasPassword, userExists, emailCode, oauth: userExists === false ? [] : oauth, raw: data };
}

// Which host answered the method probe for an address. The email-code flow
// starts on the SAME host: a probe that only app.devin.ai could answer is
// evidence that windsurf.com is not reachable from this deployment, and
// guessing again would send the operator's code request into the outage.
const PROBE_HOST_TTL_MS = 5 * 60 * 1000;
const _probeHost = new Map();
export function _resetProbeHostForTests() { _probeHost.clear(); }

function rememberProbeHost(email, host) {
  const key = String(email || '').toLowerCase();
  if (!key || (host !== 'windsurf' && host !== 'devin')) return;
  _probeHost.set(key, { host, at: Date.now() });
  if (_probeHost.size <= 200) return;
  const oldest = [..._probeHost.entries()].sort((a, b) => a[1].at - b[1].at)
    .slice(0, _probeHost.size - 200);
  for (const [k] of oldest) _probeHost.delete(k);
}

function preferredEmailHost(email) {
  const key = String(email || '').toLowerCase();
  const entry = _probeHost.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > PROBE_HOST_TTL_MS) {
    _probeHost.delete(key);
    return null;
  }
  return entry.host;
}

async function fetchAuth1Connections(email, fingerprint, proxy, host = 'windsurf') {
  const body = JSON.stringify({ product: 'windsurf', email });
  const headers = buildJsonHeaders(fingerprint, body);
  const url = host === 'devin' ? DEVIN_AUTH1_CONNECTIONS_URL : AUTH1_CONNECTIONS_URL;
  const res = await httpsRequestRetrying(
    url, { method: 'POST', headers }, body, proxy, `Auth1 connections (${host})`
  );
  // 400/422 is upstream answering about the REQUEST (measured: a malformed
  // address returns `value is not a valid email address`). Retrying it on the
  // other host or on the secondary probe cannot change that answer, so it is
  // terminal instead of "unknown".
  if (res.status === 400 || res.status === 422) {
    const detail = upstreamDetail(res.data);
    const invalidEmail = /email/i.test(detail);
    const err = new Error(invalidEmail ? 'ERR_INVALID_EMAIL' : 'ERR_LOGIN_PROBE_FAILED');
    err.code = err.message;
    err.statusCode = 400;
    err.detail = detail || `upstream ${res.status}`;
    throw err;
  }
  if (res.status >= 400) {
    const err = new Error(`connections ${res.status}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.data || {};
}

// Secondary probe (Windsurf 2026-04-26 Connect-RPC surface). Only consulted
// when /_devin-auth/connections is unreachable — it returns `{}` for real
// accounts, so an empty body is "unknown" (null), never "no password" and
// never "password-capable".
// Returns the uniform { method, hasPassword, userExists, emailCode, oauth, raw }
// shape, or null when it learned nothing.
async function fetchCheckUserLoginMethod(email, fingerprint, proxy) {
  const body = JSON.stringify({ email });
  const headers = buildJsonHeaders(fingerprint, body, { 'Connect-Protocol-Version': '1' });
  try {
    const res = await httpsRequest(
      WINDSURF_CHECK_LOGIN_METHOD_URL, { method: 'POST', headers }, body, proxy
    );
    if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
      log.warn(`CheckUserLoginMethod non-200 (${res.status}): ${sliceRedactedJson(res.data || '')}`);
      return null;
    }
    // Empirically (2026-04-29) the Vercel function will sometimes serve
    // an empty `{}` for valid emails — likely a cache miss / cold-start
    // edge or geo-routing fallback. Treating `userExists`/`hasPassword`
    // as false in that case wrongly funnels every account into the
    // "no password set" branch and aborts before any login attempt.
    // When neither field is present, the answer is "unknown".
    const hasUserField = Object.prototype.hasOwnProperty.call(res.data, 'userExists');
    const hasPwField = Object.prototype.hasOwnProperty.call(res.data, 'hasPassword');
    if (!hasUserField && !hasPwField) {
      log.warn(`CheckUserLoginMethod empty body for ${safeEmailRef(email)}; login method unknown`);
      return null;
    }
    if (res.data.userExists === false) {
      return { method: null, hasPassword: null, userExists: false, emailCode: false, oauth: [], raw: res.data };
    }
    const hasPassword = hasPwField ? !!res.data.hasPassword : null;
    return {
      method: 'auth1',
      hasPassword,
      userExists: true,
      // This endpoint says nothing about connections, so email-code availability
      // is only implied when it positively reports "no password".
      emailCode: hasPassword === false,
      oauth: [],
      raw: res.data,
    };
  } catch (e) {
    log.warn(`CheckUserLoginMethod unreachable: ${e.message}`);
    return null;
  }
}

// Authoritative login-method probe.
//
// Order matters: /_devin-auth/connections FIRST (its auth_method.has_password
// is what the website itself branches on), CheckUserLoginMethod only as
// enrichment when connections cannot answer. A probe that learns nothing
// yields hasPassword:null — callers must treat that as "unknown", not as
// either "password-capable" or "no password".
//
// When the login-host fallback is enabled, the SAME read-only probe is asked
// on app.devin.ai before giving up: both hosts were measured to return the
// identical shape (2026-10-22), and a probe outage on the Vercel host is the
// one input that used to turn "this account has no password" into
// "wrong password" (see the recheck in windsurfLoginPrimaryHost). With the
// fallback off, only windsurf.com is contacted — the default contract.
export async function probeLoginMethod(email, proxy = null, fingerprint = null) {
  const fp = fingerprint || generateFingerprint();
  const hosts = isLoginHostFallbackEnabled() ? ['windsurf', 'devin'] : ['windsurf'];
  let lastRaw = null;
  for (const host of hosts) {
    try {
      const connections = await fetchAuth1Connections(email, fp, proxy, host);
      lastRaw = connections;
      const interpreted = interpretConnections(connections);
      // A known non-auth1 method (firebase/oauth) is a routing answer, not noise:
      // returning it lets windsurfLoginPrimaryHost reach the legacy Firebase path
      // instead of guessing Auth1. Only a bare/empty body stays "unknown".
      if (interpreted.hasPassword !== null || interpreted.userExists === false
          || (interpreted.method && interpreted.method !== 'auth1')) {
        rememberProbeHost(email, host);
        return { ...interpreted, source: 'connections', host };
      }
    } catch (err) {
      // A definitive answer about the address is not an availability failure.
      if (err?.code === 'ERR_INVALID_EMAIL') throw err;
      log.warn(`Auth1 connections probe failed on ${host} for ${safeEmailRef(email)}: ${err.message}`);
    }
  }
  const check = await fetchCheckUserLoginMethod(email, fp, proxy);
  if (check) return { ...check, source: 'check_user_login_method', host: null };
  return {
    method: null,
    hasPassword: null,
    userExists: null,
    emailCode: false,
    oauth: [],
    raw: lastRaw || {},
    source: 'unknown',
    host: null,
  };
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
    throw new Error(`ERR_AUTH1_TOKEN_MISSING:${sliceRedactedJson(loginRes.data, 200)}`);
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
    throw new Error(`ERR_POSTAUTH_FAILED:${sliceRedactedJson(br.data, 200)}`);
  }
  const sessionToken = br.data.sessionToken;
  const accountId = br.data.accountId || 'unknown';
  log.info(`Windsurf PostAuth OK (${bl}): ${safeEmailRef(email)} accountHash=${logHash(accountId)} → using sessionToken as apiKey`);

  return {
    apiKey: sessionToken,
    name: email,
    email,
    // V-24: the address upstream just authenticated. A bound re-auth compares
    // this with the account row before the token may replace anything.
    identityEmail: normalizeLoginIdentity(email),
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
// (docs-internal/workflow-results/oauth-relogin-study/FEASIBILITY-BLUEPRINT.md §1.2/§5.3,
// tool-github-oauth-totp.md §1.1) establishes only that both hosts share the
// SAME Auth1 family statically; "same family" does NOT prove our PostAuth
// exchanger accepts a token sourced from the other host. This must be
// confirmed with a real account before relying on the fallback as live-effective.
async function windsurfLoginViaDevinHost(email, password, fingerprint, proxy) {
  // Step 1 — connections probe (app.devin.ai uses product:"devin").
  // Best-effort: a probe FAILURE must NOT abort — we still try the login,
  // exactly like the primary path tolerates a flaky connections endpoint.
  // A probe that SUCCEEDS and reports `has_password:false` is different: that
  // is the same terminal wrong-method answer as on windsurf.com, so the
  // password login is skipped instead of burning a guaranteed 401.
  try {
    const connBody = JSON.stringify({ product: 'devin', email });
    const connHeaders = buildJsonHeaders(fingerprint, connBody);
    const connRes = await httpsRequestRetrying(
      DEVIN_AUTH1_CONNECTIONS_URL, { method: 'POST', headers: connHeaders }, connBody, proxy,
      'Devin-host Auth1 connections'
    );
    const probed = interpretConnections(connRes.data);
    if (probed.hasPassword === false) {
      const err = new Error('ERR_NO_PASSWORD_OAUTH_ACCOUNT');
      err.code = 'ERR_NO_PASSWORD_OAUTH_ACCOUNT';
      err.method = probed.emailCode ? 'email_code' : 'oauth';
      err.oauthProviders = probed.oauth || [];
      err.detail = 'app.devin.ai reports this account has no password.';
      err.isAuthFail = false;
      throw err;
    }
  } catch (err) {
    if (err?.code === 'ERR_NO_PASSWORD_OAUTH_ACCOUNT') throw err;
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
    throw new Error(`ERR_AUTH1_TOKEN_MISSING:${sliceRedactedJson(loginRes.data, 200)}`);
  }
  log.info(`Devin-host Auth1 login OK: ${safeEmailRef(email)}`);

  // Step 3 — REUSE the existing PostAuth dual-path exchanger. See the
  // TODO(unverified) above: this is the hop whose cross-host acceptance is
  // not yet live-confirmed.
  const { res: br, label: bl } = await postAuthDualPath(auth1Token, fingerprint, proxy);
  if (br.status >= 400 || !br.data?.sessionToken) {
    throw new Error(`ERR_POSTAUTH_FAILED:${sliceRedactedJson(br.data, 200)}`);
  }
  const sessionToken = br.data.sessionToken;
  const accountId = br.data.accountId || 'unknown';
  log.info(`Devin-host PostAuth OK (${bl}): ${safeEmailRef(email)} accountHash=${logHash(accountId)} → using sessionToken as apiKey`);

  return {
    apiKey: sessionToken,
    name: email,
    email,
    identityEmail: normalizeLoginIdentity(email),
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
    // 403s from identitytoolkit carry just `{error:{message}}`; a Referer/
    // API-key restriction arrives as API_KEY_HTTP_REFERRER_BLOCKED, which the
    // friendly-error mapper (createFriendlyAuthError) resolves to a clear
    // ERR_HTTP_REFERRER_BLOCKED instead of the raw code.
    // The referrer restriction does NOT arrive as `error.message`. Google's real
    // envelope is `{error:{code:403, status:'PERMISSION_DENIED', message:'Requests
    // from referer <x> are blocked.', details:[{reason:'API_KEY_HTTP_REFERRER_BLOCKED'}]}}`
    // — a numeric code and a prose message, with the machine-readable reason buried in
    // details[]. Reading only message/code (as this did) means the mapping fires only
    // for a shape Google never sends, and the operator still gets the prose string as
    // their error "code". So prefer the structured reason, then fall back.
    const err = fbRes.data.error;
    const reason = Array.isArray(err.details)
      ? err.details.find((d) => d && typeof d.reason === 'string')?.reason
      : null;
    const msg = reason || err.message || err.code || 'Unknown Firebase error';
    // Keep the prose as the human detail when the reason carried the code, so the log
    // still says WHICH referer was rejected.
    throw createFriendlyAuthError('Firebase', msg, err.message || msg);
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
    identityEmail: normalizeLoginIdentity(email),
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
    // A terminal login-method answer is not an availability failure: the
    // account has no password, so the second host would be asked to run the
    // exact same impossible password login. Never fall back for these.
    if (primaryErr?.code === 'ERR_NO_PASSWORD_OAUTH_ACCOUNT' || primaryErr?.code === 'ERR_EMAIL_NOT_FOUND') {
      throw primaryErr;
    }
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

// One terminal "no password" answer, used both by the probe's first pass and
// by the post-rejection recheck. `method` lets the dashboard switch the form
// (email code vs OAuth-only) without a second probe, and `isAuthFail:false`
// keeps a wrong-method answer out of the per-email lockout.
function noPasswordError(probe) {
  const err = new Error('ERR_NO_PASSWORD_OAUTH_ACCOUNT');
  err.code = 'ERR_NO_PASSWORD_OAUTH_ACCOUNT';
  err.method = probe.emailCode ? 'email_code' : 'oauth';
  err.oauthProviders = probe.oauth || [];
  err.detail = probe.emailCode
    ? 'This account has no password. Log in with the emailed verification code, or with Google/GitHub, or paste an Auth Token from windsurf.com/show-auth-token.'
    : 'This account has no password and email-code login is disabled. Log in with Google/GitHub, or paste an Auth Token from windsurf.com/show-auth-token.';
  err.isAuthFail = false;
  err.statusCode = 400;
  return err;
}

// The original windsurf.com login path (login-method probe →
// Auth1 password/login → PostAuth, or legacy Firebase). Extracted from
// windsurfLogin so the public entry can wrap it with the opt-in
// app.devin.ai host fallback without altering this logic.
async function windsurfLoginPrimaryHost(email, password, fingerprint, proxy) {
  // Probe: /_devin-auth/connections is authoritative; CheckUserLoginMethod
  // only enriches when connections is unreachable. `hasPassword:null` means
  // both probes were silent — NOT "password-capable".
  const probe = await probeLoginMethod(email, proxy, fingerprint);

  if (probe.userExists === false) {
    const err = createFriendlyAuthError('Auth1', 'EMAIL_NOT_FOUND');
    // A nonexistent address is not a wrong credential; locking it would let a
    // typo (or an enumeration probe) ban a real operator for 15 minutes.
    throw err;
  }

  if (probe.hasPassword === false) {
    // Terminal wrong-method signal: this account has no password (registered
    // via Google/GitHub OAuth, or email-code only). It is NOT a brute-force
    // guess, so it must not count toward the email lockout, and it must never
    // reach password/login — the upstream 401 for such an account is not
    // evidence of a wrong password, only of a wrong method.
    throw noPasswordError(probe);
  }

  if (probe.hasPassword === true) {
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
      // The method WAS confirmed here, so the caller must not offer the
      // "this account may have no password" alternatives.
      if (e && typeof e === 'object') e.probeUnknown = false;
      throw e;
    }
  }

  // A known non-auth1 method (legacy firebase/oauth) is an explicit routing
  // answer: go straight to the legacy path instead of guessing Auth1.
  if (probe.method && probe.method !== 'auth1') {
    const result = await windsurfLoginViaFirebase(email, password, fingerprint, proxy);
    recordEmailSuccess(email);
    return result;
  }

  // Probe unknown (both hosts and the secondary probe silent): we have no
  // evidence the account lacks a password, so the operator-supplied password
  // still gets one attempt. Auth1 FIRST — the legacy Firebase
  // signInWithPassword endpoint is App-Check-gated upstream (measured
  // 2026-10-22: 401 "Firebase App Check token is invalid" for every
  // server-side caller), so leading with it only delays the real attempt.
  // Firebase stays as the last resort when Auth1 itself is unavailable.
  try {
    const result = await windsurfLoginViaAuth1(email, password, fingerprint, proxy);
    recordEmailSuccess(email);
    return result;
  } catch (auth1Err) {
    if (!auth1Err?.isAuthFail) {
      // Auth1 never judged the credential (network / 5xx / PostAuth). Try the
      // legacy path once; if it also fails, surface the Auth1 error, which is
      // the meaningful one.
      try {
        const result = await windsurfLoginViaFirebase(email, password, fingerprint, proxy);
        recordEmailSuccess(email);
        return result;
      } catch {
        throw auth1Err;
      }
    }

    // Auth1 positively rejected the credential. Before reporting "wrong
    // password", re-ask the method ONCE: a probe outage on the first call is
    // exactly how an email-code-only account was reported as
    // ERR_INVALID_CREDENTIALS (live 2026-10-21, 3.9.42). This recheck only
    // runs after a rejected password, so it costs nothing on the happy path.
    let recheck = null;
    try {
      recheck = await probeLoginMethod(email, proxy, fingerprint);
    } catch { /* stays unknown */ }
    if (recheck && recheck.hasPassword === false) {
      throw noPasswordError(recheck);
    }

    // One credential guess, counted once (the old Firebase→Auth1 chain could
    // have counted two).
    recordEmailFailure(email, auth1Err?.message);
    // Tell the caller the method was never confirmed: the password really was
    // rejected, but if the address is OAuth/email-code-only the operator
    // needs the alternative offered, not "wrong password" alone.
    auth1Err.probeUnknown = recheck ? recheck.hasPassword === null : true;
    auth1Err.alternatives = ['email_code', 'oauth', 'token'];
    throw auth1Err;
  }
}

// ─── Email-code login (accounts without a password) ───────────────────────
//
// For accounts whose probe says `has_password:false`, the only non-OAuth path
// is the emailed 6-digit code (recon .agent/loginrecon-20261022/LoginRecon.md §4.3):
//
//   POST /_devin-auth/email/start    {email, mode:'login', product:'Windsurf'}
//     → {email_verification_token}
//   POST /_devin-auth/email/complete {email_verification_token, code, mode:'login'}
//     → {token}                      (an Auth1 token, same kind password/login mints)
//   → postAuthDualPath(token) → session_token, used as the pool API key.
//
// The verification token is a bearer secret for one account. It stays in this
// module's memory keyed by an opaque flowId, never travels to the browser, and
// never appears in a log line. The code is equally secret: it is forwarded
// upstream and dropped.
//
// DESIGN GAP (Q2 F2, deliberately NOT implemented here): the resulting
// `devin-session-token$…` has no refresh path. refreshAllFirebaseTokens skips
// accounts without a refreshToken, reLoginAccount needs a stored password this
// flow never has (storeCredential:false), and the Auth1 token's TTL is
// unmeasured — so a retired session is only recoverable by re-adding the
// account. The design work that remains is an explicit "needs reauth" account
// state (or encrypted Auth1 storage once its TTL is known), not a retry here.
const EMAIL_FLOW_TTL_MS = 10 * 60 * 1000;
const EMAIL_FLOW_MAX_ATTEMPTS = 5;
const EMAIL_FLOW_MAX_ENTRIES = 200;
// Devin's own UI enforces a 30s resend cooldown; mirror it so a double-click
// loop cannot burn the upstream send quota (and the account's sender
// reputation) without an operator decision.
const EMAIL_CODE_RESEND_COOLDOWN_MS = 30 * 1000;
// A successful email/complete mints an Auth1 token that is single-use upstream,
// so it is the only thing that can be replayed when the PostAuth exchange
// fails. Keep it briefly: long enough to ride out a PostAuth blip, short enough
// that a forgotten flow cannot be used as a session minter (F6).
const EMAIL_FLOW_POSTAUTH_RETRY_MS = 2 * 60 * 1000;
const EMAIL_FLOW_POSTAUTH_MAX_ATTEMPTS = 3;

// Upstream `email/complete` failures are NOT all credential guesses (F5).
// Only a positive "the code is wrong" detail may feed the per-email lockout:
//   - an expired/consumed verification token (measured: 401
//     {"detail":"Invalid verification token"}, 6/6) says nothing about the
//     digits the user typed, and the token cannot be retried anyway;
//   - a 5xx / transport failure says nothing at all.
// Counting either as a wrong code locked PASSWORD login for 15 minutes after a
// code simply expired.
const EMAIL_CODE_MISMATCH_RE = /invalid verification code|invalid code|incorrect code|wrong code/i;
const EMAIL_FLOW_DEAD_RE = /invalid verification token|verification token|expired|already used|already consumed/i;

// 'expired'   → the verification token is dead upstream: drop the flow, retry
//               is impossible, no lockout.
// 'code'      → upstream positively says the digits are wrong: count the flow
//               attempt AND the email lockout.
// 'rejected'  → upstream 400/422 without a reason: count the flow attempt
//               (one flow must not be an unlimited oracle) but not the lockout.
// 'unavailable' → 403/404/405/429/5xx: availability, retry the same code.
function classifyEmailCompleteFailure(res, detail) {
  const text = String(detail || '');
  if (res.status === 401 || res.status === 410 || EMAIL_FLOW_DEAD_RE.test(text)) return 'expired';
  if (EMAIL_CODE_MISMATCH_RE.test(text)) return 'code';
  if (res.status === 400 || res.status === 422) return 'rejected';
  return 'unavailable';
}

const _emailFlows = new Map();
const _emailCodeSentAt = new Map();

export function _resetEmailFlowsForTests() {
  _emailFlows.clear();
  _emailCodeSentAt.clear();
}

function emailFlowError(code, detail, statusCode, extra = null) {
  const err = new Error(code);
  err.code = code;
  err.detail = detail;
  err.statusCode = statusCode;
  err.isAuthFail = false;
  if (extra) Object.assign(err, extra);
  return err;
}

// Same per-email lockout the password path uses, so a code-guessing loop is
// bounded by the operator's configured strike count. 400, not 429: the
// dashboard UI renders a 429 as an IP-wide ban overlay, and this lock is
// per-email.
function emailLockedError(lockMs) {
  return emailFlowError(
    'ERR_EMAIL_LOCKED',
    `Email temporarily locked after repeated failed logins; retry in ${Math.ceil(lockMs / 60000)} min.`,
    400,
    { retryAfterMs: lockMs },
  );
}

// ─── Login identity (V-24 / audit A23) ────────────────────────────────────
//
// A login result proves ONE thing about identity: the address that upstream
// authenticated. A bound re-auth (`accountId`) replaces the token on an
// existing row, so a result for a different address would install person B's
// session on person A's row and clear A's error/ban state on the way. The
// identity is therefore part of the login result and is compared before any
// token/status mutation; case and surrounding whitespace are not identity.
//
// Upstream reports `accountId` too, but the pool rows do not carry it, so it
// is not a comparable key here — the authenticated address is.

export { normalizeLoginIdentity };

/** Operator-facing masked address; never echoes the full identity. */
function maskIdentityEmail(email) {
  const s = String(email ?? '').trim();
  const at = s.indexOf('@');
  if (at <= 0) return s ? `${s[0]}***` : '';
  return `${s[0]}***${s.slice(at)}`;
}

/**
 * Throw unless `result` proves it belongs to `expectedEmail`.
 *
 * Called with the bound account's address BEFORE markAccountReauthenticated()
 * (api.js) and, for the email-code flow, before the single-use code is spent.
 * A result that carries no identity at all is refused on a bound path: the
 * token would replace a live credential on nothing but hope.
 */
export function assertLoginIdentity(result, expectedEmail) {
  const expected = normalizeLoginIdentity(expectedEmail);
  // An empty expectation is NOT a wildcard. A caller that has no verified
  // identity must take the explicit re-verification path instead of silently
  // skipping the check for a bound login.
  if (!expected) {
    const err = new Error('ERR_LOGIN_IDENTITY_UNVERIFIED');
    err.code = 'ERR_LOGIN_IDENTITY_UNVERIFIED';
    err.statusCode = 409;
    err.detail = 'This account has no verified login identity; re-verify it with a fresh login before binding a credential.';
    throw err;
  }
  const actual = loginResultIdentity(result);
  if (actual && actual === expected) return;
  const err = new Error('ERR_LOGIN_IDENTITY_MISMATCH');
  err.code = 'ERR_LOGIN_IDENTITY_MISMATCH';
  err.statusCode = 409;
  err.detail = actual
    ? `This login belongs to ${maskIdentityEmail(actual)}, not to the selected account (${maskIdentityEmail(expected)}).`
    : `The login did not report which account it belongs to, so it cannot be bound to ${maskIdentityEmail(expected)}.`;
  throw err;
}

function pruneEmailFlows(now) {
  for (const [id, flow] of _emailFlows) {
    if (now > flow.expiresAt) _emailFlows.delete(id);
  }
  // The resend-cooldown map is keyed by email and would otherwise keep one
  // entry per address forever on a long-lived process.
  for (const [email, sentAt] of _emailCodeSentAt) {
    if (now - sentAt > EMAIL_FLOW_TTL_MS) _emailCodeSentAt.delete(email);
  }
  if (_emailFlows.size < EMAIL_FLOW_MAX_ENTRIES) return;
  const oldest = [..._emailFlows.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, _emailFlows.size - EMAIL_FLOW_MAX_ENTRIES + 1);
  for (const [id] of oldest) _emailFlows.delete(id);
}

setInterval(() => pruneEmailFlows(Date.now()), 10 * 60 * 1000).unref?.();

function emailEndpointUrl(kind, host) {
  if (kind === 'start') return host === 'devin' ? DEVIN_AUTH1_EMAIL_START_URL : AUTH1_EMAIL_START_URL;
  return host === 'devin' ? DEVIN_AUTH1_EMAIL_COMPLETE_URL : AUTH1_EMAIL_COMPLETE_URL;
}

function emailEndpointBody(kind, host, { email, token, code }) {
  if (kind === 'start') {
    // Devin's bundle sends `{email, mode}`; windsurf.com adds `product`.
    return host === 'devin' ? { email, mode: 'login' } : { email, mode: 'login', product: 'Windsurf' };
  }
  return { email_verification_token: token, code, mode: 'login' };
}

function upstreamDetail(data) {
  const raw = data?.detail ?? data?.error ?? data?.message;
  if (Array.isArray(raw)) return raw.map(d => d?.msg || d?.type || JSON.stringify(d)).join('; ');
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return String(raw.message || raw.code || '');
  return '';
}

// POST one email endpoint, moving to the other login host only on an
// AVAILABILITY failure (network / 5xx / endpoint gone) and only when the
// existing DEVIN_CONNECT_LOGIN_HOST_FALLBACK switch is on. A 4xx is upstream
// answering (wrong code, expired token, rate limit) — retrying it on a second
// host would just double-spend the attempt, so it is returned as-is.
//
// `kind === 'start'` sends mail, so it is EXACTLY ONCE (F8): no 5xx backoff and
// no second host after a transport error. A 504 can arrive after the message
// was queued and a transport error leaves delivery unknown, so either retry
// sends a second code (measured: 3 sends / 7.0 s for one request). Only an
// explicit 404/405 — proof that host has no such endpoint — falls through.
async function requestEmailEndpoint(kind, preferredHost, payload, fingerprint, proxy) {
  const first = preferredHost || 'windsurf';
  const second = first === 'windsurf' ? 'devin' : 'windsurf';
  const hosts = isLoginHostFallbackEnabled() ? [first, second] : [first];
  const exactlyOnce = kind === 'start';
  let lastErr = null;
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    const url = emailEndpointUrl(kind, host);
    const body = JSON.stringify(emailEndpointBody(kind, host, payload));
    const headers = buildJsonHeaders(fingerprint, body);
    const label = `Auth1 email/${kind} (${host})`;
    try {
      const res = exactlyOnce
        ? await httpsRequest(url, { method: 'POST', headers }, body, proxy)
        : await httpsRequestRetrying(url, { method: 'POST', headers }, body, proxy, label);
      const endpointGone = res.status === 404 || res.status === 405;
      if (endpointGone && i < hosts.length - 1) {
        log.warn(`${label} unavailable (${res.status}); trying the other login host`);
        lastErr = new Error(`${label} upstream ${res.status}`);
        continue;
      }
      return { res, host };
    } catch (err) {
      lastErr = err;
      if (exactlyOnce || i === hosts.length - 1) throw err;
      log.warn(`${label} failed (${err.message}); trying the other login host`);
      continue;
    }
  }
  throw lastErr || new Error('ERR_EMAIL_ENDPOINT_UNREACHABLE');
}

/**
 * Ask Windsurf to email a login code.
 *
 * The upstream `email_verification_token` is stored server-side under a fresh
 * opaque flowId (TTL 10 min, single successful use) and is NOT part of the
 * returned object — only `{ flowId, sent: true }` reaches the browser.
 *
 * @param {string} email
 * @param {object} [proxy]
 * @returns {Promise<{flowId: string, sent: true, expiresInMs: number}>}
 */
export async function emailLoginStart(email, proxy = null, opts = {}) {
  const normalizedEmail = String(email || '').trim();
  if (!normalizedEmail) throw emailFlowError('ERR_EMAIL_REQUIRED', 'email is required', 400);

  const lockMs = checkEmailLocked(normalizedEmail);
  if (lockMs != null) throw emailLockedError(lockMs);

  // Send the code on the host that answered the method probe (or the one the
  // operator explicitly picked). A probe that only app.devin.ai could answer
  // is evidence windsurf.com is unreachable from this deployment; re-guessing
  // would push the request straight back into the outage. `opts.host` is an
  // explicit operator choice from the dashboard, not a blind fallback.
  const explicitHost = opts?.host === 'devin' ? 'devin' : (opts?.host === 'windsurf' ? 'windsurf' : null);
  const preferredHost = explicitHost || preferredEmailHost(normalizedEmail) || 'windsurf';

  const now = Date.now();
  const sendKey = normalizedEmail.toLowerCase();
  const sentAt = _emailCodeSentAt.get(sendKey);
  if (sentAt != null && now - sentAt < EMAIL_CODE_RESEND_COOLDOWN_MS) {
    throw emailFlowError(
      'ERR_EMAIL_CODE_COOLDOWN',
      'A verification code was just sent; wait before requesting another.',
      400,
      { retryAfterMs: EMAIL_CODE_RESEND_COOLDOWN_MS - (now - sentAt) },
    );
  }

  // Stamp the ATTEMPT, before the upstream call. A send that fails upstream
  // (throw / 4xx / 5xx) must not reset the window, otherwise a failing sender
  // can be hammered in a loop — every retry would reach an upstream that is
  // already refusing. The success path re-stamps on completion so the 30 s
  // window still measures from the send that actually went out.
  _emailCodeSentAt.set(sendKey, now);

  const fingerprint = generateFingerprint();
  let started;
  try {
    started = await requestEmailEndpoint('start', preferredHost, { email: normalizedEmail }, fingerprint, proxy);
  } catch (err) {
    // The transport layer rejects with a bare Error (no code), which used to
    // reach the route as HTTP 400 + a raw English message, breaking the
    // stable-code contract (F8). One send was attempted; whether the mail went
    // out is unknowable, so say so instead of inviting an immediate resend.
    if (err && typeof err.code === 'string' && err.code.startsWith('ERR_EMAIL_') && err.statusCode) throw err;
    log.warn(`Auth1 email/start transport failure: ${err?.message || err}`);
    throw emailFlowError(
      'ERR_EMAIL_START_FAILED',
      'The email endpoint failed before confirming the send — check the inbox before retrying.',
      502,
    );
  }
  const { res, host } = started;
  const detail = upstreamDetail(res.data);
  if (res.status >= 400 || detail) {
    throw emailFlowError(
      'ERR_EMAIL_START_FAILED',
      detail || `upstream ${res.status}`,
      res.status >= 500 ? 502 : 400,
    );
  }
  const token = res.data?.email_verification_token;
  if (typeof token !== 'string' || !token) {
    throw emailFlowError('ERR_EMAIL_START_NO_TOKEN', 'upstream did not return a verification token', 502);
  }

  pruneEmailFlows(now);
  const flowId = randomBytes(16).toString('hex');
  _emailFlows.set(flowId, {
    email: normalizedEmail,
    // V-24: the identity the code was sent to, bound at start so the exchange
    // can be refused before the single-use code is spent.
    identityEmail: normalizeLoginIdentity(normalizedEmail),
    token,
    host,
    createdAt: now,
    expiresAt: now + EMAIL_FLOW_TTL_MS,
    attempts: 0,
    used: false,
    inFlight: false,
    // Set only after upstream accepts the code; the sole retryable state when
    // the PostAuth exchange fails (F6). Never the verification token.
    auth1Token: null,
    verifiedAt: 0,
    postAuthAttempts: 0,
  });
  _emailCodeSentAt.set(sendKey, Date.now());
  log.info(`Email login code requested: ${safeEmailRef(normalizedEmail)} host=${host} flowHash=${logHash(flowId)}`);
  return { flowId, sent: true, expiresInMs: EMAIL_FLOW_TTL_MS, host };
}

/**
 * Verify the emailed code and finish the login.
 *
 * The code is single-use upstream, but the *exchange* is not the code: a
 * successful email/complete mints an Auth1 token that is kept on the flow for
 * EMAIL_FLOW_POSTAUTH_RETRY_MS, so a PostAuth failure can be retried without
 * asking the user for another email (F6). The flow is marked used only once the
 * session token exists.
 *
 * @param {string} flowId - opaque id returned by emailLoginStart
 * @param {string} code - the 6-digit code from the inbox
 * @param {object} [proxy]
 * @param {object} [opts]
 * @param {string} [opts.expectedIdentityEmail] - address of the account the
 *   caller is about to install this session on. A mismatch is refused HERE,
 *   before the upstream exchange, because the code cannot be replayed.
 */
export async function emailLoginComplete(flowId, code, proxy = null, opts = {}) {
  const id = String(flowId || '');
  const flow = _emailFlows.get(id);
  if (!flow) {
    throw emailFlowError('ERR_EMAIL_FLOW_NOT_FOUND', 'Verification flow not found — request a new code.', 404);
  }
  if (flow.used) {
    throw emailFlowError('ERR_EMAIL_FLOW_USED', 'This verification code was already used — request a new one.', 409);
  }
  const now = Date.now();
  if (now > flow.expiresAt) {
    _emailFlows.delete(id);
    throw emailFlowError('ERR_EMAIL_FLOW_EXPIRED', 'The verification code expired — request a new one.', 410);
  }
  if (flow.inFlight) {
    throw emailFlowError('ERR_EMAIL_FLOW_IN_USE', 'This verification code is already being checked.', 409);
  }
  // V-24: the flow's identity was bound at start. A caller binding the
  // exchange to a different account is refused before the code is spent —
  // after the exchange the code is gone, so a late check would cost the
  // operator another email for nothing.
  const expectedIdentity = normalizeLoginIdentity(opts?.expectedIdentityEmail);
  if (expectedIdentity && expectedIdentity !== (flow.identityEmail || normalizeLoginIdentity(flow.email))) {
    throw emailFlowError(
      'ERR_LOGIN_IDENTITY_MISMATCH',
      `This verification code was sent to ${maskIdentityEmail(flow.email)}, not to the selected account (${maskIdentityEmail(expectedIdentity)}). Request a code for the account you are re-authenticating.`,
      409,
    );
  }
  const normalizedCode = String(code ?? '').replace(/\s+/g, '');
  // 6 digits upstream; the bounds are wide on purpose so an upstream policy
  // change does not reject a valid code here.
  if (!/^\d{4,10}$/.test(normalizedCode)) {
    throw emailFlowError('ERR_EMAIL_CODE_INVALID', 'Enter the numeric verification code from the email.', 400);
  }
  const lockMs = checkEmailLocked(flow.email);
  if (lockMs != null) throw emailLockedError(lockMs);

  const fingerprint = generateFingerprint();
  let auth1Token = null;
  let completedHost = flow.host;
  flow.inFlight = true;
  try {
    // A code that upstream already accepted is spent: replaying its verification
    // token would only earn a 401. Retry the exchange with the stored Auth1
    // token instead, and only inside the short window.
    const reusable = typeof flow.auth1Token === 'string' && flow.auth1Token
      && flow.verifiedAt && now - flow.verifiedAt <= EMAIL_FLOW_POSTAUTH_RETRY_MS;
    if (reusable) {
      auth1Token = flow.auth1Token;
      log.info(`Email code already verified; retrying the session exchange: ${safeEmailRef(flow.email)} flowHash=${logHash(id)}`);
    } else {
      if (!flow.token) {
        // Spent verification token, retry window closed: nothing left to send.
        _emailFlows.delete(id);
        throw emailFlowError('ERR_EMAIL_FLOW_EXPIRED', 'The verification code was already used — request a new one.', 410);
      }
      let exchange;
      try {
        exchange = await requestEmailEndpoint(
          'complete', flow.host, { email: flow.email, token: flow.token, code: normalizedCode }, fingerprint, proxy,
        );
      } catch (err) {
        // Transport layer gave up (plain Error, no code). Upstream never judged
        // the digits: keep the flow and its attempt count, and say so with a
        // stable code (F5) instead of leaking a raw message as HTTP 400.
        if (err && typeof err.code === 'string' && err.code.startsWith('ERR_EMAIL_') && err.statusCode) throw err;
        log.warn(`Auth1 email/complete transport failure for ${safeEmailRef(flow.email)}: ${err?.message || err}`);
        throw emailFlowError(
          'ERR_EMAIL_VERIFY_UNAVAILABLE',
          'The verification service did not answer — the code was not checked. Try again.',
          502,
          { retryable: true },
        );
      }
      const { res, host } = exchange;
      completedHost = host;
      const detail = upstreamDetail(res.data);
      if (res.status >= 400 || detail) {
        const kind = classifyEmailCompleteFailure(res, detail);
        if (kind === 'expired') {
          // The verification token is dead upstream — a retry can only 401
          // again. Drop the flow and count NOTHING: this is not a code guess
          // and must never feed the 900 s lockout (F5).
          _emailFlows.delete(id);
          throw emailFlowError(
            'ERR_EMAIL_FLOW_EXPIRED',
            'The verification code expired or was already used — request a new one.',
            410,
          );
        }
        if (kind === 'unavailable') {
          // 5xx / transport / 429 / 403: upstream never judged the digits.
          // Keep the flow and its attempt count exactly as they were.
          log.warn(`Auth1 email/complete unavailable (${res.status}) for ${safeEmailRef(flow.email)}`);
          throw emailFlowError(
            'ERR_EMAIL_VERIFY_UNAVAILABLE',
            'The verification service did not answer — the code was not checked. Try again.',
            502,
            { retryable: true },
          );
        }
        flow.attempts += 1;
        // Only a positive "wrong code" answer is a credential guess and feeds
        // the per-email lockout the password path uses. An ambiguous 400/422
        // still burns a flow attempt so one flow cannot be an unlimited oracle.
        if (kind === 'code') recordEmailFailure(flow.email, 'email_code_rejected');
        if (flow.attempts >= EMAIL_FLOW_MAX_ATTEMPTS) {
          flow.used = true;
          flow.token = null;
        }
        throw emailFlowError(
          'ERR_EMAIL_CODE_REJECTED',
          detail || `upstream ${res.status}`,
          400,
          { isAuthFail: kind === 'code', attemptsRemaining: Math.max(0, EMAIL_FLOW_MAX_ATTEMPTS - flow.attempts) },
        );
      }
      auth1Token = res.data?.token;
      if (typeof auth1Token !== 'string' || !auth1Token) {
        throw emailFlowError(
          'ERR_EMAIL_VERIFY_UNAVAILABLE',
          'The verification service accepted the code but returned no session token. Try again.',
          502,
          { retryable: true },
        );
      }
      // The verification token is spent; the Auth1 token is the only thing a
      // retry may replay, and only for the exchange window.
      flow.token = null;
      flow.auth1Token = auth1Token;
      flow.verifiedAt = Date.now();
      flow.host = host;
      log.info(`Email code accepted: ${safeEmailRef(flow.email)} host=${host} flowHash=${logHash(id)}`);
    }

    flow.postAuthAttempts += 1;
    const postAuthAttempt = flow.postAuthAttempts;
    const remaining = Math.max(0, EMAIL_FLOW_POSTAUTH_MAX_ATTEMPTS - postAuthAttempt);
    const giveUp = () => {
      flow.used = true;
      flow.auth1Token = null;
    };
    let br;
    let label;
    try {
      ({ res: br, label } = await postAuthDualPath(auth1Token, fingerprint, proxy));
    } catch (e) {
      // Both PostAuth hosts failed at the transport/5xx layer. The code stays
      // valid for the retry window (F6).
      log.warn(`PostAuth unavailable after an accepted code (${safeEmailRef(flow.email)}): ${e.message}`);
      if (remaining === 0) giveUp();
      throw emailFlowError(
        'ERR_POSTAUTH_FAILED',
        'Windsurf accepted the code but the session exchange did not answer — retry the same code.',
        502,
        { retryable: remaining > 0, attemptsRemaining: remaining },
      );
    }
    if (br.status >= 400 || !br.data?.sessionToken) {
      log.warn(`PostAuth refused after an accepted code (${safeEmailRef(flow.email)}): HTTP ${br.status}`);
      if (remaining === 0) giveUp();
      throw emailFlowError(
        'ERR_POSTAUTH_FAILED',
        'Windsurf accepted the code but the session exchange was refused — retry the same code.',
        502,
        { retryable: remaining > 0, attemptsRemaining: remaining },
      );
    }
    // Only a real session token consumes the flow.
    flow.used = true;
    flow.auth1Token = null;
    recordEmailSuccess(flow.email);
    const accountId = br.data.accountId || 'unknown';
    log.info(`Email-code login OK (${label}): ${safeEmailRef(flow.email)} accountHash=${logHash(accountId)} → using sessionToken as apiKey`);
    return {
      apiKey: br.data.sessionToken,
      name: flow.email,
      email: flow.email,
      // V-24: the identity bound to this flow at start — the address the code
      // was mailed to, not whatever the caller claims at completion.
      identityEmail: flow.identityEmail || normalizeLoginIdentity(flow.email),
      apiServerUrl: '',
      sessionToken: br.data.sessionToken,
      auth1Token,
      viaEmailCode: true,
      ...(completedHost === 'devin' ? { viaHost: 'app.devin.ai' } : {}),
    };
  } finally {
    flow.inFlight = false;
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
    throw new Error(`Firebase token refresh: no idToken in response: ${sliceRedactedJson(res.data, 200)}`);
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
