/**
 * Dashboard API route handlers.
 * All routes are under /dashboard/api/*.
 */

import { config, log } from '../config.js';
import { accountRef, buildSubprocessEnv } from '../log-safety.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  getAccountList, getAccountCount, getAccountListStats, getAccountPublic, addAccountByKey, addAccountByPastedSecret,
  countAccountList, ACCOUNT_STATE_VALUES, ACCOUNT_SORT_VALUES,
  removeAccount, setAccountStatus, resetAccountErrors, updateAccountLabel,
  markAccountReauthenticated, requestReauthCheck, setAccountCredentialEmail,
  isAuthenticated, probeAccount, ensureLsForAccount,
  refreshCredits, searchWebForAccount,
  setAccountBlockedModels, setAccountTokens, setAccountTier, setAccountSpendPolicy,
  getAccountInternal, isLocalBindHost, maskApiKey, safeEqualString,
  checkLockout, failedAuthAttempt, successfulAuthAttempt,
  getDroughtSummary, getPoolHealthWindow, getRateLimitHistory,
  getAccountRequests,
  getConnectSelectorPricing, isConnectSelectorBlockedByDrought,
  sanitizeLabelText,
} from '../auth.js';
import { restartLsForProxy } from '../langserver.js';
import { getLsStatus, stopLanguageServerAndWait, startLanguageServer, isLanguageServerRunning, getLsAdmissionStatus } from '../langserver.js';
import { getStats, getRequestLog, resetStats, recordRequest, exportStats, importStats } from './stats.js';
import { getConnectMetrics, resetConnectMetrics } from '../devin-connect-metrics.js';
import { getCascadeImageMetrics, resetCascadeImageMetrics } from '../cascade-image-metrics.js';
import { detachedRegistry, cascadeDetachEnabled } from '../detached-registry.js';
import { getStickyStats, isStickyEnabled } from '../account/sticky-session.js';
import { getResponseStoreStats } from '../response-store.js';
import { cacheStats, cacheClear } from '../cache.js';
import {
  getExperimental, setExperimental, getTunables, setTunables, getPrefs, setPrefs, getSystemPrompts, setSystemPrompts, resetSystemPrompt,
  getCredentials, setRuntimeCredentials,
  verifyPassword, getEffectiveApiKey, getEffectiveDashboardPasswordStored,
  getBackendSwitch, getBackendSwitchOverrides, setBackendSwitches,
  getBreakerTunables, getBreakerOverrides, setBreakerTunables,
  getQuotaTunables, getQuotaOverrides, setQuotaTunables,
} from '../runtime-config.js';
import { poolStats as convPoolStats, poolClear as convPoolClear } from '../conversation-pool.js';
import { getClineCompatStats } from '../handlers/cline-compat.js';
import { getCcCompatStats } from '../handlers/cc-compat.js';
import { getLogs, subscribeToLogs, unsubscribeFromLogs } from './logger.js';
import { getProxyConfig, getProxyConfigMasked, setGlobalProxy, setAccountProxy, removeProxy, getEffectiveProxy } from './proxy-config.js';
import { MODELS, MODEL_TIER_ACCESS as _TIER_TABLE, getTierModels as _getTierModels, filterModelKeysByCloudCatalog, resolveModel } from '../models.js';
import { buildConnectReachability } from '../handlers/models.js';
import { FREE_REACHABLE_SELECTORS, getLiveCatalog, getSnapshotSelectors, resolveConnectSelector } from '../devin-connect-models.js';
import { buildCatalogDiff } from './catalog-diff.js';
import { accountState, cooldownState } from './pool-events.js';
import {
  probeOutcomeEntry,
  summarizeProbeResults,
  startFleetJob,
  awaitFleetJob,
  getFleetJob,
  cancelFleetJob,
  publicFleetJob,
} from './fleet-jobs.js';
import { peekBillingFacts } from './devin-read.js';
import { readQuotaBurnDown } from './quota-burn-down.js';
import { readAcuUsageByOrg } from './acu-usage.js';
import { readBillingHealth } from './billing-health.js';
import { readModelReconciliation } from './model-reconcile.js';
import { buildAccountCards, preflightCapacity } from './devin-cards.js';
import {
  buildDevinPanel,
  buildQuotaSection,
  buildRuntimeSection,
  buildSessionsSection,
  buildTurnsSection,
  MAX_SCAN_ACCOUNTS,
  RUNTIME_SWITCH_KEYS,
} from './devin-panel.js';
import { listRequests, requestRingStats } from './request-ring.js';
import { windsurfLogin, refreshFirebaseToken, reRegisterWithCodeium, probeLoginMethod, emailLoginStart, emailLoginComplete, checkEmailLocked, assertLoginIdentity } from './windsurf-login.js';
import { getModelAccessConfig, setModelAccessMode, setModelAccessList, addModelToList, removeModelFromList, setDefaultModel } from './model-access.js';
import { checkMessageRateLimit } from '../windsurf-api.js';
import { getNativeBridgeConfigStatus } from '../cascade-native-bridge.js';
import { getNativeBridgeStats } from '../native-bridge-stats.js';
import { assertPublicUrlHost } from '../image.js';
import { validateHostFormat, resolveProxyConnectHost, trustedClientIp } from '../net-safety.js';
import { discoverWindsurfCredentials, isLoopbackAddress } from './local-windsurf.js';
import { parseAccountText, classifyToken } from './account-text-parser.js';
import {
  DOCKER_DEPLOYER_WINDOW_MS,
  detectDockerSelfUpdate,
  reconcileDockerSelfUpdateState,
  runDockerSelfUpdate,
} from './docker-self-update.js';
import { BatchImportParseError, parseBatchImportInput } from './import-parser.js';
import {
  DEFAULT_ATTESTATION_REPOSITORY,
  normalizeAttestationMode,
  parseGitHubRepository,
  verifyReleaseAttestation,
} from '../release-attestation.js';
import { detectSupervisor, gracefulRestart } from '../restart.js';
import { getActiveServer } from '../server-registry.js';
import { abortActiveSse } from '../sse-registry.js';
import { renameSyncWithRetry, writeJsonAtomic } from '../fs-atomic.js';
import { getVersionInfo } from '../version.js';

// Statuses an operator may write through PATCH /accounts/:id. Deliberately NOT
// ACCOUNT_STATE_VALUES (the read-side vocabulary): that list also carries the
// derived/evidence-gated states, and only these three are operator intent.
const PATCHABLE_ACCOUNT_STATUSES = Object.freeze(['active', 'disabled', 'error']);

// Test-only seam for exercising the route-level LS integrity gate without a
// real installer. Never set from production code.
let _langserverInstallScriptOverride = null;
export function __setLangserverInstallScriptForTests(path) {
  _langserverInstallScriptOverride = path ? String(path) : null;
}

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

// One row per hot-swappable backend switch: effective value + whether it came
// from runtime-config.json or is following the deployment env. Shared by
// GET/PUT /runtime-env-status and the Devin panel so the two can never report
// a different value for the same switch.
function runtimeSwitchRows() {
  const overrides = getBackendSwitchOverrides();
  const rows = {};
  for (const key of RUNTIME_SWITCH_KEYS) {
    rows[key] = {
      value: getBackendSwitch(key),
      override: overrides[key] === undefined ? null : overrides[key],
      source: overrides[key] === null || overrides[key] === undefined ? 'env' : 'config',
    };
  }
  return rows;
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

// ─── Batch-import diagnostics (V-25 / audit A24) ──────────────────────────
//
// A batch-import response used to echo the submitted line (`raw`) and the
// proxy string including its userinfo (`proxyRaw`). A failed import therefore
// returned the password / token / API key the operator had just pasted, in a
// JSON body the browser may cache — and the dashboard copied it into
// localStorage login history. Responses now carry structured diagnostics
// derived from the PARSED item (kind, line number, error code) plus a
// credential-free proxy label. Nothing here is a substring of the input.

/** `type://host:port` — never the username/password the proxy URL carried. */
function redactedProxyLabel(proxy) {
  if (!proxy || typeof proxy !== 'object' || !proxy.host) return null;
  const type = typeof proxy.type === 'string' && proxy.type ? proxy.type : 'http';
  const port = Number.isInteger(proxy.port) && proxy.port > 0 ? proxy.port : null;
  return `${type}://${proxy.host}${port ? `:${port}` : ''}`;
}

const IMPORT_KIND_LABELS = Object.freeze({
  email_password: 'email+password',
  token: 'token',
  api_key: 'api key',
  issue: 'unrecognized',
});

/** One-line human diagnostic that names the shape, not the secret. */
function describeImportItem(item) {
  const kind = IMPORT_KIND_LABELS[item?.kind] || IMPORT_KIND_LABELS.issue;
  const proxy = redactedProxyLabel(item?.proxy);
  return proxy ? `${kind} · proxy ${proxy}` : kind;
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

// ─── A04: mutation request gate ─────────────────────────
//
// Open-local dashboards (DASHBOARD_ALLOW_NO_AUTH=1 on a loopback bind) have no
// secret for a CSRF attacker to steal, so the only thing that stood between the
// operator's browser and any other web page was the CORS *response* policy —
// which does not stop a cross-site "simple" POST (`Content-Type: text/plain`)
// from reaching the handler. The handler used to accept that body as JSON and
// run the mutation. Every state-changing dashboard request now has to prove it
// is an operator mutation before any side effect:
//
//   1. JSON content type — a cross-origin request with this type needs a CORS
//      preflight, which the dashboard never grants to an unlisted origin.
//   2. Same-origin Origin/Host agreement — catches simple form/fetch posts
//      that bypass preflight.
//   3. Fetch Metadata (`Sec-Fetch-Site`/`Mode`/`Dest`) — rejects cross-site and
//      navigation/form requests even when Origin is missing.
//   4. Strict Host validation — on a loopback bind only loopback Host names
//      are accepted (DNS-rebinding defence); non-loopback names require
//      DASHBOARD_ALLOWED_HOSTS (a trusted X-Forwarded-Host is honoured only
//      when TRUST_PROXY_X_FORWARDED_FOR=1, but still has to pass that list).
//
// Non-browser clients (curl, scripts, the CLI) send no Origin/Sec-Fetch and
// remain usable after auth, but they must still declare a JSON content type
// when they carry a body. `/auth` is a credential probe, not a mutation, and
// stays outside the gate.

const SAFE_DASHBOARD_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const JSON_CONTENT_TYPE_RE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;

function dashboardHeader(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return String(value[0] ?? '');
  return typeof value === 'string' ? value : '';
}

function isJsonContentType(value) {
  return JSON_CONTENT_TYPE_RE.test(String(value ?? '').trim());
}

function stripHostBrackets(hostname) {
  return String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

// Parse a Host header (name[:port], [v6]:port) without accepting URL syntax.
function splitHostHeader(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\s/\\@?#]/.test(raw)) return null;
  let hostname = '';
  let port = '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return null;
    hostname = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':') || !/^\d{1,5}$/.test(rest.slice(1))) return null;
      port = rest.slice(1);
    }
  } else {
    const firstColon = raw.indexOf(':');
    const lastColon = raw.lastIndexOf(':');
    if (firstColon !== -1 && firstColon !== lastColon) return null; // bare IPv6 is not a valid Host
    if (lastColon !== -1) {
      hostname = raw.slice(0, lastColon);
      port = raw.slice(lastColon + 1);
      if (!/^\d{1,5}$/.test(port)) return null;
    } else {
      hostname = raw;
    }
  }
  hostname = stripHostBrackets(hostname);
  if (!hostname || hostname.length > 253) return null;
  if (!/^[a-z0-9._:-]+$/i.test(hostname)) return null;
  return { hostname, port };
}

function parseOriginHeader(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'null') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return {
      protocol: url.protocol,
      hostname: stripHostBrackets(url.hostname),
      port: url.port,
    };
  } catch {
    return null;
  }
}

function originMatchesHost(origin, host) {
  if (!origin || !host) return false;
  if (origin.hostname !== host.hostname) return false;
  const defaultPort = origin.protocol === 'https:' ? '443' : '80';
  return (origin.port || defaultPort) === (host.port || defaultPort);
}

function isLoopbackHostname(hostname) {
  const host = stripHostBrackets(hostname);
  if (host === 'localhost' || host === '::1' || host === '::ffff:7f00:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function explicitDashboardHosts() {
  const hosts = new Set();
  const configured = stripHostBrackets(config.host);
  if (configured && configured !== '0.0.0.0' && configured !== '::') hosts.add(configured);
  for (const entry of String(process.env.DASHBOARD_ALLOWED_HOSTS || '').split(',')) {
    const host = stripHostBrackets(entry);
    if (host) hosts.add(host);
  }
  return hosts;
}

function dashboardHostAllowed(hostname) {
  const host = stripHostBrackets(hostname);
  if (!host) return false;
  if (isLoopbackHostname(host)) return true;
  if (explicitDashboardHosts().has(host)) return true;
  // Loopback bind + a non-loopback Host is the DNS-rebinding case: the
  // browser resolved attacker.example to 127.0.0.1 and now sends
  // `Host: attacker.example` / `Origin: http://attacker.example`. Reject it
  // unless an operator explicitly allowlisted the name (checked above) or a
  // trusted proxy supplied X-Forwarded-Host (checked by the caller).
  if (isLocalBindHost()) return false;
  // Public bind: IP literals are unambiguous. A DNS name must either match
  // HOST/DASHBOARD_ALLOWED_HOSTS or, for backwards compatibility, is accepted
  // only when no explicit host allowlist was configured.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  return explicitDashboardHosts().size === 0;
}

function explicitlyAllowedCorsOrigin(origin) {
  const allow = String(process.env.DASHBOARD_CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s && s !== '*');
  return allow.includes(origin);
}

// Validate the Host / X-Forwarded-Host of EVERY dashboard API request (not
// just mutations): DNS rebinding can otherwise read cleartext account keys
// through GET /accounts/import-local with Host: attacker.example. Returns
// { host, trustProxy } or null after writing 403.
//
// A trusted proxy's X-Forwarded-Host is honoured only when the operator opted
// into TRUST_PROXY_X_FORWARDED_FOR AND supplied X-Forwarded-For, but the
// forwarded name must still pass the SAME allowlist as the raw Host. It used
// to short-circuit DASHBOARD_ALLOWED_HOSTS for every non-loopback value, which
// let any client that could reach the app directly set the header itself and
// walk past the list. X-Forwarded-Host may be a comma list; the right-most
// entry is the one appended by the nearest trusted proxy (same right-counting
// rule as XFF).
export function validateDashboardRequestHost(req, res) {
  const hostHeader = dashboardHeader(req, 'host');
  const forwardedHostRaw = dashboardHeader(req, 'x-forwarded-host');
  const forwardedFor = dashboardHeader(req, 'x-forwarded-for');
  // A trusted proxy is only trusted when the operator opted in AND actually
  // supplied the header the proxy appends. A browser cannot set either header
  // on a simple cross-site request.
  const trustProxy = process.env.TRUST_PROXY_X_FORWARDED_FOR === '1' && !!forwardedFor;
  const trustForwardedHost = trustProxy && !!forwardedHostRaw;
  const forwardedHost = trustForwardedHost
    ? forwardedHostRaw.split(',').map(s => s.trim()).filter(Boolean).pop() || ''
    : '';
  const effectiveHostValue = forwardedHost || hostHeader;
  let host = null;
  if (effectiveHostValue) {
    host = splitHostHeader(effectiveHostValue);
    if (!host || !dashboardHostAllowed(host.hostname)) {
      json(res, 403, {
        error: 'ERR_DASHBOARD_HOST_REJECTED',
        message: 'Request Host is not allowed for the dashboard',
      });
      return null;
    }
  }
  return { host, trustProxy };
}

// Returns true when the request may proceed; otherwise writes the 403/415
// response itself and returns false. Host validation runs for every method;
// the remaining origin/content-type/fetch-metadata checks are mutation-only.
function enforceDashboardMutationGate(method, subpath, req, res) {
  const hostState = validateDashboardRequestHost(req, res);
  if (!hostState) return false;

  const verb = String(method || '').toUpperCase();
  if (SAFE_DASHBOARD_METHODS.has(verb)) return true;
  if (subpath === '/auth') return true; // credential probe, no state change

  const headers = req?.headers || {};
  const contentType = dashboardHeader(req, 'content-type');
  // A real IncomingMessage always carries method/httpVersion/Host. Bare
  // handler-level unit fixtures (no HTTP shape) predate the gate and stay
  // callable; the moment they declare a content type or HTTP fields, the
  // gate applies exactly as it does in production.
  const looksLikeHttp = !!(req && (req.method || req.httpVersion || headers.host));
  const bodyMethod = verb === 'POST' || verb === 'PUT' || verb === 'PATCH';
  const contentLength = Number(dashboardHeader(req, 'content-length') || 0);
  const hasDeclaredBody = (Number.isFinite(contentLength) && contentLength > 0)
    || !!dashboardHeader(req, 'transfer-encoding');
  // Audit wording is "for bodies": an empty-body POST (e.g. the dashboard's
  // /self-update button before it had a payload) has nothing to parse, and
  // Node/HTTP still gives it a Content-Length of 0. Cross-site empty POSTs
  // are already stopped by Origin/Sec-Fetch-Site below; a declared or
  // present content type must always be JSON.
  const needsJsonContentType = !!contentType || (bodyMethod && looksLikeHttp && hasDeclaredBody);
  if (needsJsonContentType && !isJsonContentType(contentType)) {
    json(res, 415, {
      error: 'ERR_UNSUPPORTED_MEDIA_TYPE',
      message: 'Dashboard mutations require Content-Type: application/json',
    });
    return false;
  }

  let host = hostState.host;
  const originRaw = dashboardHeader(req, 'origin');
  const trustedCorsOrigin = !!originRaw && explicitlyAllowedCorsOrigin(originRaw);
  let origin = null;
  if (originRaw) {
    origin = parseOriginHeader(originRaw);
    if (!origin) {
      json(res, 403, {
        error: 'ERR_DASHBOARD_ORIGIN_REJECTED',
        message: 'Request Origin is invalid for a dashboard mutation',
      });
      return false;
    }
    if (!trustedCorsOrigin) {
      // A missing Host on a real HTTP/1.1 request is rejected by Node before
      // we get here. For handler-level fixtures, let a loopback Origin stand
      // in for the Host so same-origin tests do not need to fake transport
      // metadata.
      if (!host && isLoopbackHostname(origin.hostname)) {
        host = { hostname: origin.hostname, port: origin.port };
      }
      if (!originMatchesHost(origin, host)) {
        // A trusted reverse proxy may rewrite Host to the loopback upstream
        // while preserving the browser's public Origin. Only allow that when
        // the proxy actually supplied X-Forwarded-For (browser simple
        // requests cannot set it) and the Host is the loopback upstream.
        const proxyRewroteHost = hostState.trustProxy && host && isLoopbackHostname(host.hostname);
        if (!proxyRewroteHost) {
          json(res, 403, {
            error: 'ERR_DASHBOARD_ORIGIN_REJECTED',
            message: 'Cross-origin dashboard mutations are not allowed',
          });
          return false;
        }
      }
    }
  }

  const fetchSite = dashboardHeader(req, 'sec-fetch-site').toLowerCase();
  // An operator-allowlisted cross-origin dashboard is trusted for mutations;
  // its browser still sends Sec-Fetch-Site: cross-site by definition.
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none' && !trustedCorsOrigin) {
    json(res, 403, {
      error: 'ERR_DASHBOARD_FETCH_METADATA_REJECTED',
      message: 'Cross-site dashboard mutations are not allowed',
    });
    return false;
  }
  const fetchMode = dashboardHeader(req, 'sec-fetch-mode').toLowerCase();
  if (fetchMode === 'no-cors' || fetchMode === 'navigate') {
    json(res, 403, {
      error: 'ERR_DASHBOARD_FETCH_METADATA_REJECTED',
      message: 'Simple-form dashboard mutations are not allowed',
    });
    return false;
  }
  const fetchDest = dashboardHeader(req, 'sec-fetch-dest').toLowerCase();
  if (fetchDest && fetchDest !== 'empty') {
    json(res, 403, {
      error: 'ERR_DASHBOARD_FETCH_METADATA_REJECTED',
      message: 'Navigation dashboard mutations are not allowed',
    });
    return false;
  }

  return true;
}

function json(res, status, body, extraHeaders = null) {
  // Error envelopes carry `success: false`, the same key 2xx bodies use for
  // `success: true`, so a client can tell "this request failed" apart from
  // "this payload happens to have no success key" (#257). Scoped to non-2xx
  // statuses so no successful response body changes shape.
  const payload = status >= 400
    && body && typeof body === 'object' && !Array.isArray(body)
    && !Object.prototype.hasOwnProperty.call(body, 'success')
    ? { ...body, success: false }
    : body;
  const data = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Password',
  };
  // Authed card payloads (billing, models, pool) opt into `Cache-Control:
  // no-store`; the server-side TTL cache is independent of the browser cache.
  if (extraHeaders) Object.assign(headers, extraHeaders);
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

// Authed billing/model/pool JSON must never be stored by the browser.
const NO_STORE = Object.freeze({ 'Cache-Control': 'no-store' });

/**
 * Price annotation for the per-model usage table.
 *
 * The table is keyed by whatever model string the client sent, which is exactly
 * what a bill shows — but the PRICE belongs to the selector that string resolves
 * to, and only the live billing sync knows whether that selector is free right
 * now. Resolving server-side keeps the UI from re-implementing the alias ladder,
 * and keeps "0 credits" (a real free promo) distinct from "unknown" (no live
 * data): `freeNow: null` renders no badge at all rather than a paid one.
 */
export function buildModelBillingIndex(modelCounts = {}) {
  const out = {};
  for (const model of Object.keys(modelCounts || {})) {
    const key = resolveModel(model) || model;
    const resolution = resolveConnectSelector(key, { warnOnFallback: false });
    const selector = resolution?.mapped ? resolution.selector : null;
    const pricing = selector ? getConnectSelectorPricing(selector) : null;
    out[model] = {
      selector,
      freeNow: pricing ? pricing.freeNow : null,
      freeReason: pricing ? pricing.freeReason : null,
      costTier: pricing ? pricing.costTier : null,
      promoEndsAt: pricing ? pricing.promoEndsAt : null,
      promoLabel: pricing ? pricing.promoLabel : null,
      pricingFetchedAt: pricing ? pricing.pricingFetchedAt : null,
      pricingStale: pricing ? pricing.pricingStale : false,
    };
  }
  return out;
}

function parseBoundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getAccountsPayload(req) {
  const url = dashboardUrl(req);
  const qs = url.searchParams;
  const wantsPaged = qs.has('page') || qs.has('pageSize') || qs.has('offset') || qs.has('limit') || qs.has('view')
    || qs.has('filter') || qs.has('tier') || qs.has('q') || qs.has('status') || qs.has('sort') || qs.has('order');
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
  // Unknown values are ignored, never a 400: a stale bookmark must still list
  // the pool instead of blanking the table. `q` is a literal substring (no SQL
  // LIKE), so % and _ are ordinary characters. 200 chars bounds the work.
  const q = String(qs.get('q') ?? '').trim().slice(0, 200);
  const status = ACCOUNT_STATE_VALUES.includes(qs.get('status')) ? qs.get('status') : '';
  const sort = ACCOUNT_SORT_VALUES.includes(qs.get('sort')) ? qs.get('sort') : '';
  const order = qs.get('order') === 'asc' || qs.get('order') === 'desc' ? qs.get('order') : '';
  const stats = getAccountListStats();
  // D10: total comes from the SAME predicate the rows use (filter + tier + q +
  // status), not from a single stat that silently drops the other filters.
  const total = countAccountList({ filter, tier, q, status });
  const accounts = getAccountList({ view, offset, limit: pageSize, filter, tier, q, status, sort, order });
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
    q,
    status,
    sort,
    order,
    stats,
  };
}

// Query params shared by GET /accounts and GET /accounts/ids. Kept in one place
// so "select all N results" fetches exactly the rows the table is showing.
function accountFiltersFromQuery(qs) {
  return {
    filter: qs.get('filter') === 'flagged' ? 'flagged' : '',
    tier: ['pro', 'free', 'unknown', 'expired'].includes(qs.get('tier')) ? qs.get('tier') : '',
    q: String(qs.get('q') ?? '').trim().slice(0, 200),
    status: ACCOUNT_STATE_VALUES.includes(qs.get('status')) ? qs.get('status') : '',
    sort: ACCOUNT_SORT_VALUES.includes(qs.get('sort')) ? qs.get('sort') : '',
    order: qs.get('order') === 'asc' || qs.get('order') === 'desc' ? qs.get('order') : '',
  };
}

// Client IP for the dashboard lockout bucket + audit logs. Delegates to
// net-safety.js:trustedClientIp — the single source of truth shared with
// src/caller-key.js so the dashboard lockout and the caller-key fingerprint
// can't drift apart (audit S4; previously two byte-identical private copies
// kept in sync only by a comment). See trustedClientIp for the audit-H2
// (default-ignore XFF) and XFF-1 (count from the right) rationale.
function dashboardClientIp(req) {
  return trustedClientIp(req);
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
  if (storedDashboardPw) {
    // SEC-01 (audit 2026-10-22): an empty/blank header cannot match any
    // configured password, yet it used to reach verifyPassword → scryptSync
    // (N=2^14, ~20 ms of blocked event loop). Unlike a wrong NON-empty guess it
    // also never advanced the brute-force lockout, so unauthenticated callers
    // had a free CPU DoS. Reject before hashing; real guesses keep the exact
    // same verifyPassword path.
    if (!String(pw ?? '').trim()) return false;
    return verifyPassword(pw, storedDashboardPw);
  }
  // audit #1: the localhost API-key fallback (and the no-auth opt-in) let a
  // caller present the shared chat API key as the dashboard password. Gating on
  // isLocalBindHost() alone is unsafe: behind a same-host reverse proxy
  // (openresty → 127.0.0.1) the bind IS local for everyone. Gating on the raw
  // socket peer is ALSO unsafe there — the proxy connects from 127.0.0.1, so a
  // remote user proxied in still looks loopback. Use the TRUSTED client IP
  // (dashboardClientIp: real client when TRUST_PROXY_X_FORWARDED_FOR + hops are
  // configured, else the socket peer) so the convenience is genuinely local:
  //  - XFF trust configured (the recommended proxy setup, see the #7 warning):
  //    a remote client's real IP is non-loopback → fallback denied.
  //  - No proxy, genuine localhost: client IP is loopback → fallback allowed.
  //  - Proxy present but XFF trust OFF: can't verify the client, so the operator
  //    is told (startup #7 warning) to set TRUST_PROXY_X_FORWARDED_FOR=1 or a
  //    real DASHBOARD_PASSWORD; until then this convenience should not be relied
  //    on for isolation.
  const clientIp = dashboardClientIp(req);
  if (isLocalBindHost() && isLoopbackAddress(clientIp)) {
    const effectiveApiKey = getEffectiveApiKey();
    // H2 (Grok audit): the "chat API key doubles as the dashboard password"
    // convenience is now OPT-IN (default OFF). Even from a verified-local
    // client it's a footgun — a shared chat key becomes full operator access,
    // and a reverse-proxy misconfig (XFF trust off) can make a remote client
    // look loopback. Operators who genuinely want the single-secret local
    // convenience must set DASHBOARD_ALLOW_API_KEY_AS_PASSWORD=1. Otherwise the
    // dashboard requires a real DASHBOARD_PASSWORD.
    if (effectiveApiKey && process.env.DASHBOARD_ALLOW_API_KEY_AS_PASSWORD === '1') {
      return safeEqualString(pw, effectiveApiKey);
    }
    // AUTH-1: localhost with NO secret configured used to be treated as
    // authenticated for every caller. Default is now fail-closed; operators who
    // relied on the old open-local convenience must opt in with
    // DASHBOARD_ALLOW_NO_AUTH=1 (and even then only from a verified-local client).
    if (!effectiveApiKey) return process.env.DASHBOARD_ALLOW_NO_AUTH === '1';
    return false;
  }
  return false;
}

// H1 (Grok audit): reusable "is this an authenticated dashboard operator?"
// check for the account-management endpoints in server.js (/auth/login,
// /auth/accounts, DELETE /auth/accounts/:id). Those used to sit behind only the
// chat API key, so any chat client could add/list/delete pool accounts. They
// now require the SAME auth the dashboard does (dashboard password, or the
// opt-in localhost apiKey fallback) — a shared chat key alone is no longer
// enough to act as operator. Thin wrapper so the resolution order stays single-
// sourced in checkAuth.
export function verifyAdminRequest(req) {
  return checkAuth(req);
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
  if (storedDashboardPw) {
    // SEC-01: same empty-proof guard as checkAuth. A blank re-auth proof is
    // never valid and must not pay for scrypt before being refused.
    if (!String(proof ?? '').trim()) return false;
    return verifyPassword(proof, storedDashboardPw);
  }
  // audit #1: same gate as checkAuth — use the TRUSTED client IP, not the raw
  // socket peer (which is the proxy's 127.0.0.1 for everyone behind a same-host
  // reverse proxy), so a remote proxied caller can't reauth with the shared chat
  // key.
  const clientIp = dashboardClientIp(req);
  if (isLocalBindHost() && isLoopbackAddress(clientIp)) {
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
//
// ANY absolute URL scheme is accepted, not just http(s): the Windsurf desktop
// app's sign-in callback is `windsurf://codeium.windsurf?access_token=…` (F4).
// Testing only ^https?:// returned that whole 88-char URL as the "token", which
// then failed RegisterUser upstream.
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;

export function extractOAuthToken(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const pick = (params) => params.get('access_token') || params.get('token') || params.get('auth_token') || '';
  if (ABSOLUTE_URL_RE.test(raw)) {
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
// ALSO come from a trusted loopback client — not just a loopback BIND host. Behind a
// reverse proxy (openresty → app on 127.0.0.1) isLocalBindHost() is always true,
// so checking bind alone would let any authenticated REMOTE user silently
// persist their plaintext password, defeating the DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE
// gate. Mirror the /accounts/import-local double gate. Store is still a no-op
// unless DEVIN_CONNECT_CRED_KEY is set.
function credStoreGateOpen(wantStore, req) {
  if (wantStore !== true) return false;
  // Consistency with v2.0.55 AUTH-1 and checkAuth: the proxy is not the client.
  const remote = dashboardClientIp(req);
  if (isLocalBindHost() && isLoopbackAddress(remote)) return true;
  return process.env.DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE === '1';
}

async function processWindsurfLogin({ email, password, loginProxy, autoAdd, storeCredential: wantStore, req, accountId = null }) {
  if (!email || !password) {
    const err = new Error('ERR_EMAIL_PASSWORD_REQUIRED');
    err.statusCode = 400;
    err.code = 'ERR_EMAIL_PASSWORD_REQUIRED';
    throw err;
  }

  // Use provided proxy, or global proxy
  const proxy = loginProxy?.host ? loginProxy : getProxyConfig().global;
  const result = await windsurfLogin(email, password, proxy);
  return finalizeWindsurfLogin(result, { password, loginProxy, autoAdd, storeCredential: wantStore, req, accountId });
}

// Shared tail of every successful login (password, email code, pasted token):
// add the account to the pool — or, when `accountId` is set, REPLACE that
// account's token — persist the per-account proxy, optionally persist the
// password for auto-relogin, and shape the response. `password` is null for the
// email-code flow — there is nothing to store.
//
// `accountId` is the re-auth binding (SessionReauth): the operator proved
// control of an existing account by logging in, so the fresh token lands on
// that row. Adding it again would create a duplicate for the same person and
// leave the dead one in the list.
async function finalizeWindsurfLogin(result, { password, loginProxy, autoAdd, storeCredential: wantStore, req, accountId = null }) {
  const email = result.email || '';
  let account = null;
  let reauthenticated = false;
  // Whether the password the caller asked to store actually landed. null = not
  // asked / store unavailable, true = encrypted and persisted, false = the save
  // failed (busy store, missing key, record loss) and auto-relogin stays disarmed.
  let credentialStored = null;

  if (accountId) {
    const existing = getAccountInternal(accountId);
    if (!existing) throw Object.assign(new Error('ERR_ACCOUNT_NOT_FOUND'), { code: 'ERR_ACCOUNT_NOT_FOUND', statusCode: 404 });
    if (!result.apiKey) throw Object.assign(new Error('ERR_LOGIN_FAILED'), { code: 'ERR_LOGIN_FAILED', statusCode: 502 });
    // V-24 (audit A23): a bound login REPLACES this row's credential, so the
    // login must prove it belongs to this row's identity. This runs before
    // markAccountReauthenticated() — a token for someone else must not rotate
    // the key, clear error/ban state, or flip `reauth` back to `active`.
    assertLoginIdentity(result, existing.email);
    // A successful login IS the proof that the new key works, so a same-key
    // re-login is legitimate (`allowSameKey`). The refusal exists for the
    // operator asserting an UNCHANGED key without logging in.
    markAccountReauthenticated(accountId, {
      apiKey: result.apiKey,
      via: result.viaEmailCode ? 'email_code' : 'password',
      allowSameKey: true,
    });
    account = existing;
    reauthenticated = true;
  } else if (autoAdd !== false) {
    // `result.name` is upstream-supplied: sanitize (never assert) so a hostile
    // login response cannot fail the whole login via the caller-facing label
    // boundary inside addAccountByKey.
    account = addAccountByKey(result.apiKey, sanitizeLabelText(result.name) || email);
  }

  if (account) {
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
    if (password && credStoreGateOpen(wantStore, req)) {
      // True only after a credential was actually persisted. It used to start
      // true, so a store that is disabled (no DEVIN_CONNECT_CRED_KEY) reported
      // "stored" without ever calling the store (2026-09-17 review, F3).
      credentialStored = false;
      try {
        const { storeCredential, isCredStoreEnabled } = await import('../devin-connect-credentials.js');
        if (isCredStoreEnabled()) {
          credentialStored = storeCredential(email, password) === true;
          // Remember WHICH address the record is keyed by: the row can be
          // renamed, and re-login / removal must still find the secret.
          if (credentialStored) setAccountCredentialEmail(account.id, email);
          if (credentialStored) log.info(`Credential stored for auto-relogin: ${maskEmail(email)}`);
          else log.warn(`Credential NOT stored for ${maskEmail(email)} — auto-relogin stays disarmed for this account`);
        } else {
          log.warn(`Credential NOT stored for ${maskEmail(email)} — credential storage is disabled (no DEVIN_CONNECT_CRED_KEY); auto-relogin stays disarmed for this account`);
        }
      } catch (e) {
        // A failed save used to be invisible in the response: the user asked for
        // storage and got success back. Surface it instead of only warning.
        credentialStored = false;
        log.warn(`Could not persist credential for re-login: ${e.code || e.message}`);
      }
    }
  }

  return {
    success: true,
    // When autoAdd:false, the caller is doing a one-time login to retrieve the
    // upstream key without storing it (e.g. external tooling that wants the
    // raw key) — they need the full apiKey. When the key is in the pool the
    // response only echoes a masked form (the dashboard never needs the raw key
    // in the listing path; the explicit reveal-key endpoint covers the rare
    // per-account export case). A bound re-auth always masks: the row already
    // holds the key.
    ...(autoAdd === false && !reauthenticated
      ? { apiKey: result.apiKey }
      : { apiKey_masked: maskApiKey(result.apiKey) }),
    name: result.name,
    email: result.email,
    apiServerUrl: result.apiServerUrl,
    account: account ? { id: account.id, email: account.email, status: account.status } : null,
    // How the session was obtained, so the UI can show it instead of making
    // the operator guess which path ran.
    method: result.viaEmailCode ? 'email_code' : 'password',
    // The login replaced an existing account's token instead of adding a row.
    ...(reauthenticated ? { reauthenticated: true } : {}),
    ...(result.viaHost ? { viaHost: result.viaHost } : {}),
    ...(wantStore ? { credentialStored: credentialStored === true } : {}),
  };
}

/**
 * Install a pasted token on an EXISTING account (SessionReauth).
 *
 * The only accepted shape is a `devin-session-token$…` session token — that is
 * what the upstream login mints, and it is the only thing this pool routes with.
 * An `auth1_` value is a PostAuth intermediate and is rejected with its own
 * code; anything else is not a pool credential.
 *
 * Errors are thrown with `statusCode` so both routes answer with the same
 * contract: 404 unknown id, 409 wrong state, 400 unusable token.
 */
function applyReauthToken(id, rawToken, { via = 'token' } = {}) {
  const account = getAccountInternal(id);
  if (!account) throw Object.assign(new Error('ERR_ACCOUNT_NOT_FOUND'), { code: 'ERR_ACCOUNT_NOT_FOUND', statusCode: 404 });
  if (account.status === 'disabled' || account.status === 'banned') {
    throw Object.assign(new Error('ERR_REAUTH_NOT_APPLICABLE'), { code: 'ERR_REAUTH_NOT_APPLICABLE', statusCode: 409 });
  }
  const token = extractOAuthToken(String(rawToken ?? ''));
  if (!token) throw Object.assign(new Error('ERR_NO_TOKEN_IN_INPUT'), { code: 'ERR_NO_TOKEN_IN_INPUT', statusCode: 400 });
  const kind = classifyToken(token);
  if (kind === 'auth1') throw Object.assign(new Error('ERR_AUTH1_NOT_A_POOL_KEY'), { code: 'ERR_AUTH1_NOT_A_POOL_KEY', statusCode: 400 });
  if (kind !== 'session') throw Object.assign(new Error('ERR_REAUTH_TOKEN_INVALID'), { code: 'ERR_REAUTH_TOKEN_INVALID', statusCode: 400 });
  // A PASTED token is not proof of anything — unlike a completed login, the
  // operator can paste the very token upstream just retired. Installing the
  // same key on a reauth account is refused (409) so the state cannot be
  // "cleared" without a new credential; a different key is a real rotation.
  markAccountReauthenticated(id, { apiKey: token, via });
  return {
    success: true,
    reauthenticated: true,
    account: { id: account.id, email: account.email, method: account.method, status: account.status },
    apiKey_masked: maskApiKey(account.apiKey),
  };
}

// Marker set on the IncomingMessage by preflightDashboardRequest(). A Symbol
// (not a string key) so a handler-level fixture cannot forge it and an HTTP
// client can never set it: request headers live under req.headers.
const DASHBOARD_PREFLIGHT_PASSED = Symbol('dashboardPreflightPassed');

/**
 * Host/mutation/lockout/auth gate shared by `preflightDashboardRequest` and
 * `handleDashboardApi`. Returns true when the request may proceed; otherwise
 * writes the 403/415/429/401 response itself and returns false.
 *
 * Extracted from handleDashboardApi unchanged (S03/G05) so server.js can run
 * it BEFORE reading a /dashboard/api/* body: an unauthenticated mutation must
 * not be able to make the process buffer and JSON-parse up to the 10 MiB body
 * cap. Keeping one implementation is what keeps the two call sites from
 * drifting apart.
 */
function runDashboardRequestGate(method, subpath, req, res) {
  // A04: reject cross-site/simple-form mutations before auth counters, body
  // handling, or any route side effect. This is deliberately before the
  // lockout so a hostile page cannot spend a victim's auth attempts.
  if (!enforceDashboardMutationGate(method, subpath, req, res)) return false;

  // v2.0.56: brute-force lockout — apply BEFORE the auth check so the
  // password comparison itself can't be used as an oracle once the IP is
  // banned. /auth route is exempt (unauthenticated probe used by the UI
  // to learn whether auth is required) but still feeds the lockout when
  // it serves as a credential-verification endpoint.
  const clientIp = dashboardClientIp(req);
  const lock = checkLockout(clientIp);
  if (lock.blocked) {
    res.setHeader?.('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)));
    json(res, 429, {
      error: `Too many failed attempts. IP banned for ${Math.ceil(lock.retryAfterMs / 1000)}s.`,
      retryAfterMs: lock.retryAfterMs,
    });
    return false;
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
    json(res, 401, { error: 'Unauthorized. Set X-Dashboard-Password header.' });
    return false;
  }
  if (subpath !== '/auth') successfulAuthAttempt(clientIp);
  return true;
}

/**
 * Pre-body gate for /dashboard/api/*.
 *
 * server.js calls this BEFORE readBody() so an unauthenticated mutation is
 * rejected at the Host/mutation/lockout/auth boundary without touching the
 * request stream (S03/G05: the body read used to run first, letting an
 * anonymous caller force up to MAX_BODY_SIZE of buffering + JSON parsing per
 * request). Reuses the same gate handleDashboardApi runs.
 *
 * Returns true when the caller may proceed (and, for a mutation, read the
 * body); false when the rejection response was already written. OPTIONS
 * carries no body and is answered by handleDashboardApi's early 204 exactly
 * as before, so it passes through untouched.
 */
export function preflightDashboardRequest(method, subpath, req, res) {
  if (res) res._dashboardCorsOrigin = resolveCorsOrigin(req);
  if (method === 'OPTIONS') return true;
  if (!runDashboardRequestGate(method, subpath, req, res)) return false;
  if (req && typeof req === 'object') req[DASHBOARD_PREFLIGHT_PASSED] = true;
  return true;
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

  // server.js already ran preflightDashboardRequest() before reading the body;
  // running the gate again would re-validate the Host and double-count the
  // successful-auth reset. Direct callers (unit tests, in-process handlers)
  // never set the marker and still get the full gate here, exactly as before.
  if (!(req && req[DASHBOARD_PREFLIGHT_PASSED] === true)) {
    if (!runDashboardRequestGate(method, subpath, req, res)) return;
  }

  // ─── Auth ─────────────────────────────────────────────
  if (subpath === '/auth') {
    // The gate that used to declare clientIp now lives in
    // runDashboardRequestGate (and may have already run as the server.js
    // preflight). Re-resolve the same pure value for the probe's counter
    // updates — no lockout/auth side effect is repeated.
    const clientIp = dashboardClientIp(req);
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
      // Gate 1 (design §7.4) reads `admit` and `serve` from this block for the
      // two-week measurement. `enabled` separates "switch off" from "switch on
      // with no traffic"; the counters are process-lifetime and reset on
      // restart, so a scrape must accumulate deltas (docs/DETACH-ROLLOUT.md).
      detach: {
        enabled: cascadeDetachEnabled(),
        ...detachedRegistry.stats(),
      },
      poolBalance: (() => {
        const s = getAccountListStats();
        return { total: s.balanceTotal, accounts: s.balanceAccounts };
      })(),
    });
  }

  // Lightweight request ring for the dashboard's request-level view. Rows are
  // metadata-only (no headers/prompt/upstream body); the caller is a short hash.
  if (subpath === '/requests' && method === 'GET') {
    const u = new URL(req?.url || '/', 'http://localhost');
    const filter = {};
    for (const key of ['model', 'status', 'class']) {
      const value = u.searchParams.get(key);
      if (value !== null && value !== '') filter[key] = value;
    }
    const page = listRequests({
      cursor: u.searchParams.get('cursor'),
      limit: u.searchParams.get('limit'),
      filter,
    });
    return json(res, 200, { ...page, ring: requestRingStats() });
  }

  // Lightweight pool snapshot for the dashboard's pool-event notifier and the
  // cooldown card. Reads the in-memory pool only (zero upstream cost) and returns
  // the per-account state flags the client diffs into transition toasts
  // (healthy ↔ cooling ↔ capacity ↔ quota ↔ disabled). `ref` is a hash — never
  // the token prefix — and `upstream` is a cache-only billing overlay, so the
  // 20 s poll never triggers an upstream call.
  if (subpath === '/pool-events' && method === 'GET') {
    const now = Date.now();
    const accounts = getAccountList({ view: 'summary' }).map((a) => {
      const cooldown = cooldownState({
        rateLimitedUntil: a.rateLimitedUntil,
        quotaResetAt: a.quotaResetAt,
        capacityThrottled: a.capacityThrottled,
        now,
      });
      const token = getAccountInternal(a.id)?.apiKey || '';
      return {
        id: a.id,
        ref: accountRef(a.id),
        status: a.status,
        state: accountState({
          status: a.status,
          rateLimited: cooldown.rateLimited,
          capacityThrottled: cooldown.capacityThrottled,
          quotaCooled: cooldown.quotaCooled,
        }),
        tier: a.tier || 'unknown',
        balance: a.balance ?? null,
        errorCount: a.errorCount || 0,
        rateLimited: cooldown.rateLimited,
        capacityThrottled: cooldown.capacityThrottled,
        quotaCooled: cooldown.quotaCooled,
        cooldownUntil: cooldown.cooldownUntil,
        cooldownReason: cooldown.cooldownReason,
        cooldownRemainingMs: cooldown.cooldownRemainingMs,
        upstream: peekBillingFacts({ accountId: a.id, token }),
      };
    });
    return json(res, 200, { accounts, ts: now }, { 'Cache-Control': 'no-store' });
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

  // ─── Cline compatibility layer status ────────────────────
  // enabled = the master experimental toggle (detection path); stats.argRepairs =
  // how many tool-call arguments the compat layer has normalized since boot (both
  // the /v1/cline/* namespace and the detection path feed this counter). The
  // dedicated namespace works regardless of the toggle, so a nonzero counter with
  // enabled:false just means a partner is hitting /v1/cline/*.
  if (subpath === '/cline-compat' && method === 'GET') {
    return json(res, 200, { enabled: !!getExperimental().clineCompat, stats: getClineCompatStats() });
  }

  // ─── Claude Code compatibility layer status ──────────────
  // enabled = the master experimental toggle (detection path). stats counts what
  // the CC layer has done since boot: schemaNormalized (top-level combinators
  // stripped off tool schemas) and identityNeutralized (reserved). The dedicated
  // /v1/cc/* namespace works regardless of the toggle, so nonzero counts with
  // enabled:false just mean a Claude Code user is hitting /v1/cc/*.
  if (subpath === '/cc-compat' && method === 'GET') {
    return json(res, 200, { enabled: !!getExperimental().ccCompat, stats: getCcCompatStats() });
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
    const switches = runtimeSwitchRows();
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
    setBackendSwitches(body || {});
    return json(res, 200, { success: true, switches: runtimeSwitchRows() });
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
    // D6: a pending journal is confirmed only when the RUNNING process reports
    // the expected commit — the same identity /health publishes. Confirmation
    // is what clears the rollback point; anything else keeps the retry
    // evidence and reports the pending/failed state.
    const selfUpdate = reconcileSelfUpdateJournal();
    // Docker updates record the previous image before the deployer starts and
    // reconcile the deployer's exit code after the restart. No journal means
    // no Docker call at all.
    let dockerSelfUpdate = null;
    try {
      dockerSelfUpdate = await reconcileDockerSelfUpdateState();
    } catch (err) {
      log.warn(`self-update: docker state reconcile failed: ${err.message}`);
    }
    const withJournal = (payload) => ({
      ...payload,
      ...(selfUpdate ? { selfUpdate } : {}),
      ...(dockerSelfUpdate ? { dockerSelfUpdate } : {}),
    });
    try {
      const info = await gitStatus();
      if (info.updateError) {
        return json(res, 200, withJournal({
          ok: false,
          mode: 'git',
          ...info,
          error: info.updateError,
        }));
      }
      return json(res, 200, withJournal({ ok: true, mode: 'git', ...info }));
    } catch (err) {
      if (isSelfUpdateUnavailableError(err)) {
        // Git path is unavailable (most often docker). Fall back to
        // docker self-update via /var/run/docker.sock if the user
        // mounted it into the container; otherwise report the same
        // "manual command" hint we did before.
        const docker = await detectDockerSelfUpdateForRequest();
        if (docker.available) {
          return json(res, 200, withJournal({
            ok: true,
            mode: 'docker',
            image: docker.image,
            project: docker.project,
            workingDir: docker.workingDir,
          }));
        }
        return json(res, 200, withJournal({
          ok: false,
          available: false,
          reason: err.reason,
          error: err.code,
          dockerReason: docker.reason,
          dockerDetail: docker.detail,
        }));
      }
      return json(res, 200, withJournal({ ok: false, error: err.message }));
    }
  }
  if (subpath === '/self-update/rollback' && method === 'POST') {
    let releaseMutation;
    try {
      releaseMutation = acquireSelfUpdateMutation();
    } catch (err) {
      return json(res, 200, { ok: false, error: err.code || 'ERR_UPDATE_LOCK_FAILED', message: err.message });
    }
    if (!releaseMutation) {
      return json(res, 200, {
        ok: false,
        error: SELF_UPDATE_IN_PROGRESS,
        message: 'Another update or rollback is already in progress.',
      });
    }
    let mutationLockHandedOff = false;
    // 失败回滚：reset 到最近一次 /self-update 记录的 before commit，重启。
    // 与 forceReset 同级保护（AUTH-1）：本地领先或脏树时同样拒绝。
    try {
      try {
        // A previous rollback that is already confirmed by the running commit
        // has had its point cleared; reconcile first so this attempt reports
        // "no rollback point" instead of resetting to the same commit again.
        reconcileSelfUpdateJournal();
        const isCommitSha = value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
        const { readFile } = await import('node:fs/promises');
        const paths = rollbackPointPaths();
        const readPoint = async (path) => {
          try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; }
        };
        let beforeJson = await readPoint(paths.final);
        const pendingJson = await readPoint(paths.pending);
        let currentHead = '';
        if (isCommitSha(pendingJson?.commit) && isCommitSha(pendingJson?.after)) {
          currentHead = (await runGit(['rev-parse', 'HEAD'])).trim();
          if (currentHead === pendingJson.after) {
            // A crash can land after reset/merge but before pending→final rename.
            // The durable pending record is authoritative when its `after` SHA
            // matches current HEAD; promote best-effort and allow rollback now.
            beforeJson = pendingJson;
            try { promotePendingRollbackPoint(); } catch (err) {
              log.warn(err?.renamePublished
                ? `self-update: rollback point final file is visible, but its directory fsync failed during pending recovery: ${err.message}`
                : `self-update: pending rollback point is valid but promotion failed; pending remains available: ${err.message}`);
            }
          } else {
            // HEAD never reached the pending target, so this is an abandoned
            // pre-mutation record. Preserve the previous final rollback point.
            discardPendingRollbackPoint();
          }
        } else if (Object.keys(pendingJson || {}).length) {
          discardPendingRollbackPoint();
        }
        const beforeCommit = beforeJson?.commit;
        const afterCommit = beforeJson?.after;
        if (!beforeCommit) {
          return json(res, 200, { ok: false, error: 'ERR_NO_ROLLBACK_POINT', message: 'No previous update recorded.' });
        }
        if (!isCommitSha(beforeCommit) || !isCommitSha(afterCommit)) {
          return json(res, 200, {
            ok: false,
            error: 'ERR_INVALID_ROLLBACK_POINT',
            message: 'Rollback metadata must contain both the pre-update and post-update commit SHAs; refusing an unsafe legacy rollback point.',
          });
        }
        // M2: 校验当前 HEAD 仍是更新后的 commit（before.json 记录了 after）——
        // 若操作者更新后又提交了新代码，reset 会抹掉它，拒绝回滚。
        currentHead ||= (await runGit(['rev-parse', 'HEAD'])).trim();
        if (currentHead !== afterCommit) {
          return json(res, 200, { ok: false, error: 'ERR_HEAD_MOVED', message: 'HEAD moved since the update — refusing rollback that would discard newer commits.' });
        }
        // Supervisor detection is read-only and must happen before stash/reset.
        // A rejected rollback must leave the operator's working tree untouched.
        const sup = detectSelfUpdateSupervisor();
        if (!sup.supervised) {
          return json(res, 200, { ok: false, error: 'ERR_NO_SUPERVISOR', message: 'No process supervisor detected. Rollback would stop the gateway without relaunch.' });
        }
        const ignoredConflicts = await findIgnoredTargetPathConflicts(beforeCommit);
        if (ignoredConflicts.length) {
          return json(res, 200, {
            ok: false,
            error: 'ERR_IGNORED_PATH_CONFLICT',
            message: 'Rollback would overwrite ignored runtime data. Move or back up the listed paths manually before retrying.',
            conflictPaths: ignoredConflicts.slice(0, 20),
          });
        }
        // Rollback uses reset --hard, which can delete an untracked file or
        // directory that obstructs a path tracked by the target commit. Unlike
        // ordinary update checks, this destructive path must see untracked files
        // and require the same explicit force+stash protection.
        const dirty = (await runGit(['status', '--porcelain', '--untracked-files=all'])).trim();
        // D6: record the rollback intent durably BEFORE any mutation (stash or
        // reset). If the process dies between here and the restart, the journal
        // plus the untouched rollback point still describe what was attempted
        // and the rollback remains retryable. A journal write failure aborts
        // while the worktree is still unmodified.
        try {
          writeSelfUpdateJournal({
            version: 1,
            operation: 'rollback',
            state: 'pending-restart',
            phase: 'pre-reset',
            expectedCommit: beforeCommit,
            afterCommit,
            rollbackPointRetained: true,
            requestedAt: Date.now(),
          });
        } catch (journalErr) {
          return json(res, 200, {
            ok: false,
            error: 'ERR_UPDATE_JOURNAL_WRITE',
            message: `Could not durably record the rollback intent; nothing was changed: ${journalErr.message}`,
          });
        }
        const markJournalFailed = (reason, extra = {}) => {
          try {
            updateSelfUpdateJournal({ state: 'failed', reason, ...extra });
          } catch (journalErr) {
            log.warn(`self-update rollback: could not record ${reason}: ${journalErr.message}`);
          }
        };
        let protectiveStashOid = '';
        if (dirty) {
          const allowForce = !!(body && body.forceReset);
          if (!allowForce) {
            return json(res, 200, { ok: false, dirty: true, error: 'ERR_UNCOMMITTED_CHANGES', dirtyFiles: dirty.split('\n').slice(0, 20) });
          }
          try {
            protectiveStashOid = await createProtectiveStash('rollback-forceReset');
          } catch (err) {
            markJournalFailed('stash-failed', { error: err.message });
            return json(res, 200, {
              ok: false,
              error: 'ERR_STASH_FAILED',
              message: `Could not preserve local changes; rollback was not attempted: ${err.message}`,
            });
          }
        }
        let resetError = null;
        try {
          await runGit(['reset', '--hard', beforeCommit]);
        } catch (err) {
          resetError = err;
        }
        let rolledBackHead = '';
        let trackedAfter = '';
        try {
          rolledBackHead = (await runGit(['rev-parse', 'HEAD'])).trim();
          trackedAfter = (await runGit(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none'])).trim();
        } catch (inspectErr) {
          markJournalFailed('state-unknown', { error: inspectErr.message });
          return json(res, 200, {
            ok: false,
            error: 'ERR_ROLLBACK_STATE_UNKNOWN',
            message: `Rollback state could not be verified; the rollback point and any protective stash were preserved: ${inspectErr.message}`,
            stashed: !!protectiveStashOid,
          });
        }
        if (rolledBackHead !== beforeCommit || trackedAfter) {
          let restored = false;
          const unchangedAndClean = rolledBackHead === currentHead && !trackedAfter;
          if (protectiveStashOid && unchangedAndClean) {
            try {
              await restoreProtectiveStash(protectiveStashOid);
              restored = true;
            } catch (restoreErr) {
              log.warn(`self-update rollback: reset failed and exact protective stash ${protectiveStashOid.slice(0, 12)} could not be applied: ${restoreErr.message}`);
            }
          }
          markJournalFailed('reset-not-verified', {
            actual: rolledBackHead,
            trackedDirty: !!trackedAfter,
          });
          return json(res, 200, {
            ok: false,
            error: trackedAfter
              ? 'ERR_ROLLBACK_PARTIAL'
              : resetError
                ? (unchangedAndClean ? 'ERR_GIT_ROLLBACK_FAILED' : 'ERR_ROLLBACK_PARTIAL')
                : 'ERR_ROLLBACK_TARGET_MISMATCH',
            message: resetError
              ? `Git could not reset cleanly to the recorded rollback commit: ${resetError.message}`
              : `Git reported success but rollback state is HEAD ${rolledBackHead.slice(0, 12)} with ${trackedAfter ? 'tracked changes' : 'a different commit'}.`,
            expected: beforeCommit,
            actual: rolledBackHead,
            dirtyFiles: trackedAfter ? trackedAfter.split('\n').slice(0, 20) : undefined,
            stashed: !!protectiveStashOid,
            stashRestored: restored || undefined,
          });
        }
        if (resetError) {
          log.warn(`self-update rollback: Git returned an error after reaching the verified rollback state: ${resetError.message}`);
        }
        // D6: the rollback point is NOT deleted here. It is retry evidence
        // until the restarted process proves it serves beforeCommit; the
        // journal reconcile step clears it then. Deleting it before the
        // restart made a scheduler failure indistinguishable from a verified
        // healthy rollback.
        try {
          updateSelfUpdateJournal({ phase: 'reset-verified' });
        } catch (err) {
          log.warn(`self-update rollback: could not record the verified reset: ${err.message}`);
        }
        const restartScheduled = scheduleSelfUpdateRestart(() => {
          return Promise.resolve(gracefulRestart({
            reason: 'self-update-rollback',
            drainMs: 10000,
            server: getActiveServer(),
            abortSse: abortActiveSse,
            stopLs: () => stopLanguageServerAndWait({ perProcessTimeoutMs: 1500 }),
            exitCode: selfUpdateRestartExitCode(),
          })).catch((err) => {
            // The process may survive a failed restart; leave durable evidence
            // instead of an unhandled rejection, and keep the rollback point.
            try {
              updateSelfUpdateJournal({
                state: 'restart-failed',
                restartScheduled: true,
                error: String(err?.message || err),
              });
            } catch (journalErr) {
              log.warn(`self-update rollback: could not record the restart failure: ${journalErr.message}`);
            }
            throw err;
          });
        }, releaseMutation);
        mutationLockHandedOff = restartScheduled === true;
        if (mutationLockHandedOff) {
          try {
            updateSelfUpdateJournal({ state: 'pending-restart', phase: 'restart-scheduled', restartScheduled: true });
          } catch (err) {
            log.warn(`self-update rollback: could not record the scheduled restart: ${err.message}`);
          }
          return json(res, 200, {
            ok: true,
            state: 'pending-restart',
            verified: false,
            restartScheduled: true,
            rollbackPointRetained: true,
            expectedCommit: beforeCommit,
            rolledBackTo: beforeCommit.slice(0, 7),
          });
        }
        // The scheduler declined: the reset is on disk but nothing will
        // relaunch the gateway. That is NOT a successful rollback — say so,
        // and leave the point plus journal so it can be retried.
        try {
          updateSelfUpdateJournal({ state: 'restart-not-scheduled', restartScheduled: false });
        } catch (err) {
          log.warn(`self-update rollback: could not record the unscheduled restart: ${err.message}`);
        }
        return json(res, 200, {
          ok: false,
          error: 'ERR_RESTART_NOT_SCHEDULED',
          message: 'The rollback reset was applied, but no restart could be scheduled; the running process still serves the previous code. The rollback point was kept so this rollback can be retried.',
          state: 'restart-not-scheduled',
          verified: false,
          restartScheduled: false,
          rollbackPointRetained: true,
          expectedCommit: beforeCommit,
          rolledBackTo: beforeCommit.slice(0, 7),
        });
      } catch (err) {
        if (isSelfUpdateUnavailableError(err)) return json(res, 200, { ok: false, error: err.code || 'ERR_GIT_UNAVAILABLE' });
        return json(res, 200, { ok: false, error: err.code || err.message, message: err.code ? err.message : undefined });
      }
    } finally {
      if (!mutationLockHandedOff) releaseMutation();
    }
  }
  if (subpath === '/self-update' && method === 'POST') {
    let releaseMutation;
    try {
      releaseMutation = acquireSelfUpdateMutation();
    } catch (err) {
      return json(res, 200, { ok: false, error: err.code || 'ERR_UPDATE_LOCK_FAILED', message: err.message });
    }
    if (!releaseMutation) {
      return json(res, 200, {
        ok: false,
        error: SELF_UPDATE_IN_PROGRESS,
        message: 'Another update or rollback is already in progress.',
      });
    }
    let mutationLockHandedOff = false;
    try {
      try {
        const before = await gitStatus();
        reconcilePendingRollbackPoint(before.commitFull);
      // M1: resolve the update target before any write (including forceReset).
      // Normal OTA follows the newest RELEASE TAG, not origin/<branch> HEAD:
      // release notes, generated assets, and next-release work commonly land
      // after a tag. Treating any such commit as ERR_UNRELEASED made the
      // published release itself impossible to install as soon as the first
      // post-tag commit landed. forceUpdate remains the explicit escape hatch
      // for operators who intentionally want the untagged branch head.
        const safeBranch = safeUpdateBranch(before.branch);
        // A failed fetch is not permission to operate on stale refs. The docker
        // fallback still activates when git itself is unavailable; every source
        // checkout otherwise fails closed until branch and tag refs are current.
        await runGit(['fetch', '--quiet', '--no-tags', 'origin', safeBranch]);
        const forceGate = !!(body && body.forceUpdate);
        const targetState = await releaseUpdateState(safeBranch, before.commitFull, {
          followUnreleased: forceGate,
        });
        if (targetState.diverged) {
          return json(res, 200, {
            ok: false,
            error: 'ERR_DIVERGED',
            message: `Current HEAD and update target ${targetState.targetCommit.slice(0, 7)} have diverged; refusing a non-fast-forward update.`,
          });
        }
        // Guard: working tree must be clean (ignoring untracked files like
        // accounts.json, stats.json, runtime-config.json which live in the
        // repo root but aren't checked in). If tracked files were edited,
        // surface a friendly error instead of a raw git failure.
        const dirty = (await runGit(['status', '--porcelain', '-uno'])).trim();
        let resetTarget = before.commitFull;
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
          // AUTH-1: forceReset authorizes cleaning the working tree, not silently
          // deleting local commits. Failure to establish the ahead count is also
          // fail-closed: "unknown" must never be treated as zero before reset.
          let ahead;
          try {
            ahead = parseGitNonnegativeCount(
              await runGit(['rev-list', '--count', `origin/${safeBranch}..HEAD`]),
              `local commits ahead of origin/${safeBranch}`,
            );
          } catch (err) {
            return json(res, 200, {
              ok: false,
              dirty: true,
              error: 'ERR_LOCAL_COMMIT_CHECK_FAILED',
              message: `Could not verify whether local commits would be lost; reset was not attempted: ${err.message}`,
              dirtyFiles: dirty.split('\n').slice(0, 20),
            });
          }
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
          // A checkout can legitimately be past the latest release tag. Cleaning
          // its worktree must not downgrade it unless the separate hard-reset
          // opt-in explicitly authorizes dropping local commits.
          resetTarget = targetState.updateAvailable || (ahead > 0 && allowHardReset)
            ? targetState.targetCommit
            : before.commitFull;
        }

        const headTarget = dirty
          ? resetTarget
          : targetState.updateAvailable
            ? targetState.targetCommit
            : before.commitFull;
        const willChangeHead = headTarget !== before.commitFull;
        const willMutateWorktree = !!dirty || targetState.updateAvailable;
        if (willMutateWorktree) {
          const sup = detectSelfUpdateSupervisor();
          if (!sup.supervised) {
            return json(res, 200, {
              ok: false,
              error: 'ERR_NO_SUPERVISOR',
              message: 'No process supervisor detected. Update was not attempted because the gateway could not relaunch itself afterward.',
            });
          }
        }
        if (willMutateWorktree) {
          const ignoredConflicts = await findIgnoredTargetPathConflicts(headTarget);
          if (ignoredConflicts.length) {
            return json(res, 200, {
              ok: false,
              error: 'ERR_IGNORED_PATH_CONFLICT',
              message: 'The update would overwrite ignored runtime data. Move or back up the listed paths manually before retrying.',
              conflictPaths: ignoredConflicts.slice(0, 20),
            });
          }
        }
        if (willChangeHead) {
          try {
            // Write a durable PENDING point before stash/reset/merge while keeping
            // the previous successful final point intact. It is promoted only
            // after Git proves HEAD reached the exact expected commit.
            prepareRollbackPoint({ commit: before.commitFull, after: headTarget, ts: Date.now() });
          } catch (err) {
            return json(res, 200, {
              ok: false,
              error: 'ERR_ROLLBACK_POINT_WRITE',
              message: `Could not durably record the rollback point; update was not attempted: ${err.message}`,
              stashed: false,
            });
          }
        }

        let protectiveStashOid = '';
        if (dirty) {
          try {
            protectiveStashOid = await createProtectiveStash('self-update-forceReset');
          } catch (err) {
            if (willChangeHead) discardPendingRollbackPoint();
            return json(res, 200, {
              ok: false,
              error: 'ERR_STASH_FAILED',
              message: `Could not preserve local changes; reset was not attempted: ${err.message}`,
              stashed: false,
            });
          }
        }

        // execFile can't do `2>&1`; runGit includes stderr in thrown errors and
        // returns stdout for successful commands, which is what the UI displays.
        let pull;
        let mutationError = null;
        try {
          pull = dirty
            ? await runGit(['reset', '--hard', resetTarget]).then(() => 'hard-reset applied')
            : targetState.updateAvailable
              ? await runGit(['merge', '--ff-only', targetState.targetCommit])
              : `Already at latest published release ${targetState.latestTag || targetState.targetCommit.slice(0, 7)}`;
        } catch (err) {
          mutationError = err;
          pull = '';
        }

        let actualHead = before.commitFull;
        let trackedAfter = '';
        if (willMutateWorktree) {
          try {
            actualHead = (await runGit(['rev-parse', 'HEAD'])).trim();
            trackedAfter = (await runGit(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none'])).trim();
          } catch (inspectErr) {
            return json(res, 200, {
              ok: false,
              error: 'ERR_UPDATE_STATE_UNKNOWN',
              message: `Update state could not be verified; the rollback point and any protective stash were preserved: ${inspectErr.message}`,
              expected: headTarget,
              stashed: !!protectiveStashOid,
            });
          }
        }

        const reachedTargetClean = actualHead === headTarget && !trackedAfter;
        if (!reachedTargetClean) {
          const unchangedAndClean = actualHead === before.commitFull && !trackedAfter;
          let restored = false;
          if (unchangedAndClean) {
            if (willChangeHead) discardPendingRollbackPoint();
            if (protectiveStashOid) {
              try {
                await restoreProtectiveStash(protectiveStashOid);
                restored = true;
              } catch (restoreErr) {
                log.warn(`self-update: failed mutation could not apply exact protective stash ${protectiveStashOid.slice(0, 12)}: ${restoreErr.message}`);
              }
            }
          }

          let rollbackPointError = '';
          if (willChangeHead && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(actualHead) && actualHead !== before.commitFull) {
            try {
              // Exit status alone cannot establish ref state. Preserve an honest
              // rollback point for the commit Git actually reached, and never
              // apply a pre-mutation stash onto that changed commit.
              prepareRollbackPoint({ commit: before.commitFull, after: actualHead, ts: Date.now(), expected: headTarget });
              promotePendingRollbackPoint();
            } catch (pointErr) {
              rollbackPointError = pointErr.message;
              log.warn(pointErr?.renamePublished
                ? `self-update: honest partial-update rollback point is visible, but its directory fsync failed: ${pointErr.message}`
                : `self-update: failed to publish the honest partial-update rollback point; pending remains available: ${pointErr.message}`);
            }
          }

          const partial = !!trackedAfter || !unchangedAndClean;
          return json(res, 200, {
            ok: false,
            error: partial
              ? 'ERR_UPDATE_PARTIAL'
              : mutationError ? 'ERR_GIT_UPDATE_FAILED' : 'ERR_UPDATE_TARGET_MISMATCH',
            message: mutationError
              ? `Git did not reach a verified clean update state: ${mutationError.message}`
              : `Git reported success but the verified update state does not match ${headTarget.slice(0, 12)}.`,
            expected: headTarget,
            actual: actualHead || undefined,
            dirtyFiles: trackedAfter ? trackedAfter.split('\n').slice(0, 20) : undefined,
            rollbackPointError: rollbackPointError || undefined,
            stashed: !!protectiveStashOid,
            stashRestored: restored || undefined,
          });
        }
        if (mutationError) {
          log.warn(`self-update: Git returned an error after reaching the verified update state: ${mutationError.message}`);
          pull = dirty ? 'hard-reset applied (verified after Git error)' : 'fast-forward applied (verified after Git error)';
        }

        if (willChangeHead) {
          try {
            promotePendingRollbackPoint();
          } catch (err) {
            // The pending point is already durable and rollback knows how to
            // recover it after restart. Do not hide a successful Git update.
            log.warn(err?.renamePublished
              ? `self-update: rollback point final file is visible, but its directory fsync failed after successful update: ${err.message}`
              : `self-update: rollback point remains pending after successful update: ${err.message}`);
          }
        }
        const changed = willMutateWorktree;
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
        // D6: same durable journal as rollback. `{ok:true}` below now carries
        // state:'pending-restart' + verified:false until the restarted process
        // reports this commit on /health; a declined scheduler is reported as
        // restart-not-scheduled instead of a silent success.
        try {
          writeSelfUpdateJournal({
            version: 1,
            operation: 'update',
            state: 'pending-restart',
            phase: 'pre-restart',
            expectedCommit: actualHead,
            beforeCommit: before.commitFull,
            requestedAt: Date.now(),
          });
        } catch (err) {
          log.warn(`self-update: could not durably record the update journal: ${err.message}`);
        }
        const restartScheduled = scheduleSelfUpdateRestart(() => {
          // v3.4.x: drain in-flight requests before the LS stop + exit, via the
          // shared gracefulRestart path. The HTTP server handle is now reachable
          // from api.js through server-registry.js (registered in index.js), so
          // self-update no longer exits abruptly mid-request. Behaviour is
          // otherwise unchanged: same await-and-wait LS stop (audit H-4 — SIGTERM
          // lands before exit reparents surviving children to init) and the same
          // EX_TEMPFAIL exit code the supervisor relaunches on. If the server
          // handle is somehow unregistered, gracefulRestart simply skips the
          // drain step and still stops the LS and exits.
          log.info('self-update: exiting with restart-requested status for service supervisor');
          return Promise.resolve(gracefulRestart({
            reason: 'self-update',
            drainMs: 10000,
            server: getActiveServer(),
            abortSse: abortActiveSse,
            stopLs: () => stopLanguageServerAndWait({ perProcessTimeoutMs: 1500 }),
            exitCode: selfUpdateRestartExitCode(),
          })).catch((err) => {
            try {
              updateSelfUpdateJournal({
                state: 'restart-failed',
                restartScheduled: true,
                error: String(err?.message || err),
              });
            } catch (journalErr) {
              log.warn(`self-update: could not record the restart failure: ${journalErr.message}`);
            }
            throw err;
          });
        }, releaseMutation);
        mutationLockHandedOff = restartScheduled === true;
        try {
          updateSelfUpdateJournal({
            state: mutationLockHandedOff ? 'pending-restart' : 'restart-not-scheduled',
            phase: mutationLockHandedOff ? 'restart-scheduled' : 'pre-restart',
            restartScheduled: mutationLockHandedOff,
          });
        } catch (err) {
          log.warn(`self-update: could not record the restart scheduling result: ${err.message}`);
        }
      }
      return json(res, 200, {
        ok: true,
        changed,
        state: changed
          ? (mutationLockHandedOff ? 'pending-restart' : 'restart-not-scheduled')
          : 'unchanged',
        verified: !changed,
        restartScheduled: changed ? mutationLockHandedOff : false,
        before: before.commit,
        after: actualHead.slice(0, 7),
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
          const docker = await detectDockerSelfUpdateForRequest();
          if (docker.available) {
            const result = await runDockerSelfUpdateForRequest();
            if (result.ok) {
              mutationLockHandedOff = scheduleDockerSelfUpdateMutationRelease(releaseMutation) === true;
            }
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
        return json(res, 200, {
          ok: false,
          error: err.code || err.message,
          message: err.code ? err.message : undefined,
        });
      }
    } finally {
      if (!mutationLockHandedOff) releaseMutation();
    }
  }

  // ─── One-click restart ────────────────────────────────
  // Gracefully drain in-flight requests then exit with the supervisor-relaunch
  // code (75, same as self-update) so systemd/PM2/docker restart us. This sits
  // under the same ambient dashboard-auth gate as /self-update (the checkAuth()
  // guard at the top of this handler covers every non-/auth mutation) — a
  // mutating operator action, so a chat API key alone is not enough.
  if (subpath === '/restart' && method === 'POST') {
    // Precheck: refuse to exit if no supervisor will relaunch us. Exiting into
    // nothing would take the gateway down permanently on one dashboard click.
    const sup = detectSupervisor();
    if (!sup.supervised) {
      return json(res, 200, {
        ok: false,
        error: 'ERR_NO_SUPERVISOR',
        message: 'No process supervisor (systemd/PM2/docker) detected. Restart would stop the gateway without relaunch. Run under a supervisor or set WINDSURFAPI_RESTART_SUPERVISED=1.',
      });
    }
    // Respond FIRST so the client sees the ack before we start tearing down,
    // THEN trigger the drain+exit on a short delay so the response flushes —
    // mirrors how /self-update schedules its exit via setTimeout.
    log.info(`restart: dashboard requested restart (supervisor=${sup.kind})`);
    setTimeout(() => {
      void gracefulRestart({
        reason: `dashboard /restart (supervisor=${sup.kind})`,
        drainMs: 10000,
        server: getActiveServer(),
        abortSse: abortActiveSse,
        // await-and-wait variant so SIGTERM lands before process.exit reparents
        // surviving LS children to init (the H-4 orphan race).
        stopLs: () => stopLanguageServerAndWait({ perProcessTimeoutMs: 1500 }),
        exitCode: selfUpdateRestartExitCode(),
      });
    }, 500);
    return json(res, 200, { ok: true, restarting: true, supervisor: sup.kind });
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

  // GET /accounts/ids — the id list for "select all N results". Same filters as
  // the list, no paging: the client must never guess that "all" means "page 1".
  if (subpath === '/accounts/ids' && method === 'GET') {
    const f = accountFiltersFromQuery(dashboardUrl(req).searchParams);
    const ids = getAccountList({ view: 'summary', ...f, limit: Infinity }).map((a) => a.id);
    return json(res, 200, { ids, total: ids.length });
  }

  // POST /accounts/fleet-jobs — start an observable probe/refresh run.
  // The run is serial server-side; what the browser gets is a job id it can
  // poll for `done/total`, cancel, and read failures from after the fact.
  if (subpath === '/accounts/fleet-jobs' && method === 'POST') {
    const op = String(body?.op || '');
    if (op !== 'probe' && op !== 'refresh') return json(res, 400, { error: 'ERR_FLEET_OP_INVALID' });
    const rawIds = Array.isArray(body?.ids) ? body.ids : null;
    if (rawIds && rawIds.length > 1000) return json(res, 400, { error: 'ERR_FLEET_TOO_LARGE', max: 1000 });
    const ids = rawIds ? [...new Set(rawIds.filter((id) => typeof id === 'string' && id))] : null;
    const force = body?.force === true || body?.allowLsStart === true;
    const job = startFleetJob({ op, ids, force });
    return json(res, 200, { success: true, job: publicFleetJob(job, { since: 0 }) });
  }

  // GET /accounts/fleet-jobs/:id?since=N — delta poll. `since` is the item
  // count the caller already has, so a long run does not resend every row.
  const fleetJobMatch = subpath.match(/^\/accounts\/fleet-jobs\/([^/]+)$/);
  if (fleetJobMatch && method === 'GET') {
    const job = getFleetJob(fleetJobMatch[1]);
    if (!job) return json(res, 404, { error: 'ERR_FLEET_JOB_NOT_FOUND' });
    const since = Number(dashboardUrl(req).searchParams.get('since') ?? 0);
    return json(res, 200, { success: true, job: publicFleetJob(job, { since }) });
  }

  // POST /accounts/fleet-jobs/:id/cancel — stop scheduling new accounts.
  const fleetCancelMatch = subpath.match(/^\/accounts\/fleet-jobs\/([^/]+)\/cancel$/);
  if (fleetCancelMatch && method === 'POST') {
    const job = cancelFleetJob(fleetCancelMatch[1]);
    if (!job) return json(res, 404, { error: 'ERR_FLEET_JOB_NOT_FOUND' });
    return json(res, 200, { success: true, job: publicFleetJob(job, { since: 0 }) });
  }

  // POST /accounts/batch — one request for a bulk operation, per-item results.
  // Serial by design: parallel writes to the same pool trip the upstream
  // brute-force guard. Partial failure is a 200 with `failed[]`, never a 500
  // that hides the items that did succeed.
  if (subpath === '/accounts/batch' && method === 'POST') {
    const op = String(body?.op || '');
    if (!['enable', 'disable', 'probe', 'refresh', 'reset', 'delete'].includes(op)) {
      return json(res, 400, { error: 'ERR_BATCH_OP_INVALID' });
    }
    const rawIds = Array.isArray(body?.ids) ? body.ids : [];
    const ids = [...new Set(rawIds.filter((id) => typeof id === 'string' && id))];
    if (ids.length === 0) return json(res, 400, { error: 'ERR_BATCH_IDS_EMPTY' });
    if (ids.length > 1000) return json(res, 400, { error: 'ERR_BATCH_TOO_LARGE', max: 1000 });
    const results = [];
    for (const id of ids) {
      try {
        if (op === 'probe') {
          const r = await probeAccount(id, { allowLsStart: false, canary: false });
          results.push(probeOutcomeEntry(id, r));
        } else if (op === 'refresh') {
          const r = await refreshCredits(id);
          results.push(r?.ok ? { id, ok: true } : { id, ok: false, error: r?.error || 'ERR_REFRESH_FAILED' });
        } else {
          const ok = op === 'enable' ? setAccountStatus(id, 'active')
            : op === 'disable' ? setAccountStatus(id, 'disabled')
              : op === 'reset' ? resetAccountErrors(id)
                : removeAccount(id);
          results.push(ok ? { id, ok: true } : { id, ok: false, error: 'ERR_ACCOUNT_NOT_FOUND' });
        }
      } catch (err) {
        results.push({ id, ok: false, error: err.message || 'ERR_BATCH_ITEM_FAILED' });
      }
    }
    const failed = results.filter((r) => !r.ok && !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    if (op === 'delete') log.info(`dashboard accounts/batch delete: ${results.length - failed.length}/${ids.length} removed`);
    return json(res, 200, {
      success: true,
      op,
      results,
      failed,
      skipped,
      ...summarizeProbeResults(results),
    });
  }

  if (subpath === '/accounts' && method === 'POST') {
    try {
      const apiServerUrl = body.apiServerUrl || body.api_server_url || '';
      if (!body.api_key && !body.token) {
        return json(res, 400, { error: 'Provide api_key or token' });
      }

      // SessionReauth: a bound paste replaces an existing account's token. Same
      // helper as POST /accounts/:id/reauth {action:'token'} so the two entry
      // points cannot drift into different validation.
      if (body.accountId) {
        return json(res, 200, applyReauthToken(body.accountId, body.api_key || body.token, { via: 'token' }));
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
        ? await addAccountByPastedSecret(body.api_key, body.label, apiServerUrl, { unknownAsKey: true })
        : await addAccountByPastedSecret(body.token, body.label, apiServerUrl);

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
      // A bound re-auth can fail with 404/409/400; the unbound add path only
      // ever produced 400. Keep the code so the UI can react to it.
      return json(res, err.statusCode || 400, { error: err.code || err.message });
    }
  }

  // POST /accounts/import-text — smart bulk import. Paste mixed token formats
  // (session / show-auth-token URL / refresh-JWT / labeled pairs); the parser
  // classifies each and adds via addAccountByPastedSecret. auth1_ is skipped
  // (PostAuth intermediate, not a pool key). SECURITY: never logs the pasted
  // text or any token; results carry only id/email/kind, never raw token.
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
      for (const raw of (parsed.tokens || [])) {
        const kind = classifyToken(raw);
        // auth1_ is a PostAuth intermediate, not a pool key.
        if (kind === 'auth1') { results.skipped.push({ kind, reason: 'auth1_not_a_pool_key' }); continue; }
        // F3: everything else is a candidate. A show-auth-token /
        // OneTimeAuthToken value is a 47-char opaque string that classifyToken
        // cannot name; the old `kind === 'unknown'` skip dropped it silently,
        // so the documented "paste the token" import added nothing. The adder
        // routes a session token to the pool key and everything else through
        // RegisterUser, and reports a rejection per token instead of hiding it.
        try {
          const acc = await addAccountByPastedSecret(raw, '');
          results.added.push({ id: acc.id, email: acc.email, kind });
        } catch (e) { results.failed.push({ kind, error: e.message }); }
      }
      for (const pair of (parsed.tokenPairs || [])) {
        const pairKind = classifyToken(pair.token);
        if (pairKind === 'auth1') {
          results.skipped.push({ kind: pairKind, email: pair.email, reason: 'auth1_not_a_pool_key' });
          continue;
        }
        try {
          const acc = await addByKind(pair.token, pair.email || '');
          results.added.push({ id: acc.id, email: acc.email || pair.email, kind: pairKind });
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
    const remote = dashboardClientIp(req);
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
  // Local-only hardening: both the bind and trusted client must be loopback.
  // Use the same client identity as checkAuth, so same-host proxies cannot
  // expose local desktop credentials.
  if (subpath === '/accounts/import-local' && method === 'GET') {
    if (!isLocalBindHost()) {
      log.warn('local-windsurf import refused: dashboard not bound to loopback host');
      return json(res, 403, { error: 'ERR_LOCAL_IMPORT_NOT_AVAILABLE_PUBLIC_BIND' });
    }
    const remote = dashboardClientIp(req);
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

  // POST /accounts/probe-all — legacy blocking form. Kept for API clients and
  // the smoke matrix; the dashboard now uses /accounts/fleet-jobs so the run is
  // observable and cancellable. Same loop, one implementation.
  if (subpath === '/accounts/probe-all' && method === 'POST') {
    const force = body?.force === true || body?.allowLsStart === true;
    const started = startFleetJob({ op: 'probe', force });
    const job = await awaitFleetJob(started.id);
    const results = job?.items || [];
    return json(res, 200, { success: true, total: job?.total || 0, ...summarizeProbeResults(results), results });
  }

  // POST /accounts/:id/reauth — SessionReauth actions (never returns the key).
  //   {action:'probe'} → one free GetUserStatus probe. alive clears the state,
  //     UNAUTHORIZED keeps it, anything else (CAPACITY/UPSTREAM_INTERNAL) is
  //     transient and changes nothing. The operator-facing "Check token" button
  //     forces past the 60 s de-dupe.
  //   {action:'token'} → install a pasted session token on THIS account.
  const accountReauth = subpath.match(/^\/accounts\/([^/]+)\/reauth$/);
  if (accountReauth && method === 'POST') {
    const id = accountReauth[1];
    const action = String(body?.action || 'probe');
    try {
      if (action === 'probe') {
        if (!getAccountInternal(id)) return json(res, 404, { error: 'ERR_ACCOUNT_NOT_FOUND' });
        const result = await requestReauthCheck(id, { source: 'manual', force: body?.force !== false });
        if (result.reason === 'NOT_ELIGIBLE') return json(res, 409, { error: 'ERR_REAUTH_NOT_APPLICABLE' });
        return json(res, 200, result);
      }
      if (action === 'token') {
        return json(res, 200, applyReauthToken(id, body?.token ?? body?.api_key, { via: 'manual' }));
      }
      return json(res, 400, { error: 'ERR_REAUTH_ACTION_INVALID' });
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.code || err.message });
    }
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

  // POST /accounts/refresh-credits — legacy blocking form of the refresh run.
  // The dashboard uses /accounts/fleet-jobs (progress + cancel); this stays for
  // API clients and the smoke matrix and shares the same loop.
  if (subpath === '/accounts/refresh-credits' && method === 'POST') {
    const started = startFleetJob({ op: 'refresh' });
    const job = await awaitFleetJob(started.id);
    const results = (job?.items || []).map((item) => ({
      id: item.id,
      email: item.email,
      ok: item.ok,
      ...(item.ok ? {} : { error: item.error || 'ERR_REFRESH_FAILED' }),
    }));
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/refresh-credits — single-account refresh
  const creditRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-credits$/);
  if (creditRefresh && method === 'POST') {
    const r = await refreshCredits(creditRefresh[1]);
    return json(res, r.ok ? 200 : 400, r);
  }

  // POST /accounts/:id/web-search — run one upstream web search on this account.
  // Exposes GetWebSearchResults, which the repo has implemented and tested since it
  // was reverse-engineered but never called from anywhere. Costs no model credits:
  // it rides the account's own session token.
  //
  // Authentication is inherited, not re-implemented: every /dashboard/api/* route
  // except /auth passes through the checkAuth gate above, so this endpoint is only
  // reachable by an authenticated dashboard session.
  const webSearch = subpath.match(/^\/accounts\/([^/]+)\/web-search$/);
  if (webSearch && method === 'POST') {
    const r = await searchWebForAccount(webSearch[1], {
      query: body?.query,
      limit: body?.limit,
      domain: body?.domain,
    });
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
    // The operator may only write the three statuses they can act on. `banned`
    // and `reauth` are evidence-gated states — the ban detector and the
    // UNAUTHORIZED probe put an account there, and letting a hand-written string
    // forge that evidence would bypass the two-signal rule (a `banned` written
    // this way also skips bannedReason/bannedAt). Any other value is a typo that
    // used to be persisted verbatim: selection filters on `status === 'active'`
    // while resolveAccountState maps unknown statuses to 'active', so the account
    // became invisible-but-unroutable and the value survived restart.
    if (body.status !== undefined && !PATCHABLE_ACCOUNT_STATUSES.includes(body.status)) {
      return json(res, 400, { error: 'ERR_ACCOUNT_STATUS_INVALID' });
    }
    try {
      // `force:true` is the operator's explicit override of the reauth guard
      // (they replaced the token out-of-band); without it the refusal is a 409
      // so the UI can point at the re-authenticate action instead of silently
      // putting a retired key back in rotation.
      if (body.status !== undefined) setAccountStatus(id, body.status, { force: body.force === true });
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
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.code || err.message });
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
      allModels: filterModelKeysByCloudCatalog(),
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
    const stats = getStats();
    return json(res, 200, { ...stats, modelBilling: buildModelBillingIndex(stats.modelCounts) });
  }

  // GET /stats/log — newest-first request-log page + aggregates over the whole
  // filtered window. Filters are server-side and every aggregate is computed
  // from the same rows the table pages through, so the numbers reconcile.
  // `from`/`to` are epoch milliseconds (the browser sends them); limit is
  // clamped to 200, offset >= 0. Retention is stated in the response.
  if (subpath === '/stats/log' && method === 'GET') {
    const u = dashboardUrl(req);
    const num = (key) => {
      const raw = u.searchParams.get(key);
      if (raw == null || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    return json(res, 200, getRequestLog({
      from: num('from'),
      to: num('to'),
      model: u.searchParams.get('model') || null,
      account: u.searchParams.get('account') || null,
      status: u.searchParams.has('status') ? num('status') : null,
      limit: num('limit') ?? 50,
      offset: num('offset') ?? 0,
    }), NO_STORE);
  }

  // Account usage from app.devin.ai (quota burn-down card). GET-only reads
  // through the shared dashboard cache; `?account=<id>` selects a pool account;
  // with no id it uses the first active account, then the env-token deploy.
  // `?refresh=1` bypasses freshness but shares any in-flight request.
  if (subpath === '/usage' && method === 'GET') {
    const u = dashboardUrl(req);
    try {
      const result = await readQuotaBurnDown({
        id: u.searchParams.get('account') || undefined,
        force: u.searchParams.get('refresh') === '1',
      });
      const { httpStatus, ...payload } = result;
      // Preserve the upstream status marker for the browser. Without it a
      // forwarded upstream 401/429 is indistinguishable from the dashboard's
      // own password/IP-lock rejection, so the UI would clear a valid admin
      // session (or start a lockout) on a provider quota error.
      if (!result.ok) payload.httpStatus = httpStatus || 502;
      return json(res, result.ok ? 200 : (httpStatus || 502), payload, NO_STORE);
    } catch (err) {
      log.warn(`Dashboard usage read failed: ${err?.kind || err?.name || 'unexpected'}`);
      return json(res, 502, { ok: false, error: 'upstream' }, NO_STORE);
    }
  }

  // GET /usage/orgs — org-scoped ACU & usage (Q3). Resolves every active
  // Devin session-token account to its org, reads the ledger ONCE per org, and
  // returns a hash-only org handle. Accounts that share an org are grouped, so
  // the same ACUs are never counted twice. Per-org failures stay per-org; the
  // panel renders the orgs that answered.
  if (subpath === '/usage/orgs' && method === 'GET') {
    const u = dashboardUrl(req);
    try {
      const result = await readAcuUsageByOrg({
        force: u.searchParams.get('refresh') === '1',
      });
      const { httpStatus, ...payload } = result;
      if (!result.ok) payload.httpStatus = httpStatus || 502;
      return json(res, result.ok ? 200 : (httpStatus || 502), payload, NO_STORE);
    } catch (err) {
      log.warn(`Dashboard ACU usage read failed: ${err?.kind || err?.name || 'unexpected'}`);
      return json(res, 502, { ok: false, error: 'upstream', orgs: [] }, NO_STORE);
    }
  }

  // Billing health / pause banner (P0-2). Shares the `status` and `quota` cache
  // entries with /usage; a 403 is a gray "no permission", never a stale state.
  if (subpath === '/billing/health' && method === 'GET') {
    const u = dashboardUrl(req);
    try {
      const result = await readBillingHealth({
        id: u.searchParams.get('account') || undefined,
        force: u.searchParams.get('refresh') === '1',
      });
      const { httpStatus, ...payload } = result;
      // Preserve the upstream status marker for the browser. Without it a
      // forwarded upstream 401/429 is indistinguishable from the dashboard's
      // own password/IP-lock rejection, so the UI would clear a valid admin
      // session (or start a lockout) on a provider quota error.
      if (!result.ok) payload.httpStatus = httpStatus || 502;
      return json(res, result.ok ? 200 : (httpStatus || 502), payload, NO_STORE);
    } catch (err) {
      log.warn(`Dashboard billing health read failed: ${err?.kind || err?.name || 'unexpected'}`);
      return json(res, 502, { ok: false, error: 'upstream' }, NO_STORE);
    }
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
    // Sticky-session affinity counters ride along so an operator can verify
    // STICKY_SESSION_ENABLED is actually binding (hits/creates > 0) instead
    // of counting log lines — the only way to check before this.
    return json(res, 200, {
      ...getConnectMetrics(),
      poolHealth: getPoolHealthWindow(),
      sticky: { enabled: isStickyEnabled(), ...getStickyStats() },
      responseStore: getResponseStoreStats(),
      // Cascade replayed-history images: how many historical images rode field 6
      // vs how many were dropped (cap / bytes / truncated / no vision mode). The
      // drop path also logs `cascade_image_history_dropped`; this makes it
      // countable instead of grep-only.
      cascadeImages: getCascadeImageMetrics(),
    });
  }
  if (subpath === '/connect-metrics' && method === 'DELETE') {
    resetConnectMetrics();
    resetCascadeImageMetrics();
    return json(res, 200, { success: true });
  }

  // ─── Rate-limit history ───────────────────────────────
  // Bounded ring of the most recent markRateLimited events (upstream window vs
  // the clamped window that was actually applied), so an operator can see what
  // a lockout was really waiting for instead of grepping logs. `?limit=n`
  // returns the n most recent; the ring itself is capped at 500.
  if (subpath === '/rate-limit-history' && method === 'GET') {
    const url = dashboardUrl(req);
    const limit = parseBoundedInt(url.searchParams.get('limit'), 0, { min: 0, max: 500 });
    return json(res, 200, { events: getRateLimitHistory({ limit }) });
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
  // dashboardPassword is trimmed before validation and hashing; a non-empty
  // value that trims to nothing is rejected as blank (SEC-04).
  // Requires the caller to re-authenticate with the NEW dashboard
  // password on the next request — no session cookies, so the UI just
  // re-prompts. We don't accept the old-password proof here because the
  // caller already passed dashboard auth at the top of this function.
  //
  // V-21 (audit A22): validation AND commit are one transaction. The old
  // order validated+persisted `apiKey` and only then looked at
  // `dashboardPassword`, so a request answered with 400 had already rotated
  // the chat key. setRuntimeCredentials() validates every field first and
  // writes both in one atomic replace.
  if (subpath === '/settings/credentials' && method === 'PUT') {
    if (!body || typeof body !== 'object') {
      return json(res, 400, { error: 'Body must be a JSON object' });
    }
    const hasApiKey = Object.prototype.hasOwnProperty.call(body, 'apiKey');
    const hasPassword = Object.prototype.hasOwnProperty.call(body, 'dashboardPassword');
    let committed;
    try {
      committed = setRuntimeCredentials({
        ...(hasApiKey ? { apiKey: body.apiKey } : {}),
        ...(hasPassword ? { dashboardPassword: body.dashboardPassword } : {}),
      });
    } catch (err) {
      if (err?.code === 'ERR_CREDENTIAL_PERSIST_FAILED') {
        // The file write failed and both fields were rolled back; saying
        // "success" here would leave the operator with credentials that only
        // exist until the next restart.
        log.warn(`Settings: credential rotation was NOT persisted: ${err.cause?.message || err.message}`);
        return json(res, 500, { error: 'ERR_CREDENTIAL_PERSIST_FAILED' });
      }
      return json(res, 400, { error: err.message });
    }
    const out = {};
    if (hasApiKey) {
      out.apiKeyUpdated = true;
      out.apiKey_masked = maskApiKey(committed.apiKey || getEffectiveApiKey());
    }
    if (hasPassword) out.dashboardPasswordUpdated = true;
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
  // binary URL); falls back to `install-ls.sh` manifest mode (pinned
  // upstream release from ls-pins.json).
  if (subpath === '/langserver/update' && method === 'POST') {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pjoin } = await import('node:path');
    // install-ls.sh ships at the repo root, two levels above this file
    // (src/dashboard/api.js). Resolving by import.meta.url avoids any
    // dependence on cwd, so the endpoint works whether started from /app
    // (Docker), the repo root, or a deeper subdir.
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = _langserverInstallScriptOverride
      || pjoin(here, '..', '..', 'install-ls.sh');
    if (!existsSync(scriptPath)) {
      return json(res, 500, {
        ok: false,
        error: `install-ls.sh not found at ${scriptPath}`,
      });
    }
    const url = body && typeof body.url === 'string' ? body.url.trim() : '';
    const expectedSha256 = body && typeof body.sha256 === 'string'
      ? body.sha256.trim().toLowerCase()
      : '';
    // Defence-in-depth: only allow https URLs from a small allowlist of
    // hosts. Without this, an attacker who got past dashboard auth could
    // pipe an arbitrary URL into the install script and have curl write
    // bytes to LS_BINARY_PATH which is then chmod +x and exec'd as the
    // node user. Still gated by checkAuth above; this is a second layer.
    const allowedHosts = [
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'api.github.com',
    ];
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch {
        return json(res, 400, { ok: false, error: 'invalid url' });
      }
      if (parsed.protocol !== 'https:') {
        return json(res, 400, { ok: false, error: 'url must be https' });
      }
      if (!allowedHosts.includes(parsed.hostname)) {
        return json(res, 400, {
          ok: false,
          error: `url host not allowed; permitted: ${allowedHosts.join(', ')}`,
        });
      }
      // A05: a custom URL is an unpinned download. Without an operator-
      // supplied hash there is no trust anchor at all (the old route simply
      // omitted --sha256 and install-ls.sh warned then installed whatever
      // arrived). Require the 64-hex digest before spawning anything.
      if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
        return json(res, 400, {
          ok: false,
          error: 'ERR_LS_SHA256_REQUIRED',
          message: 'Custom URL updates require the expected SHA-256 (64 hex characters) in body.sha256',
        });
      }
    } else if (expectedSha256) {
      return json(res, 400, {
        ok: false,
        error: 'ERR_LS_SHA256_WITHOUT_URL',
        message: 'body.sha256 is only valid together with body.url',
      });
    }
    // --allowed-host is repeated so install-ls.sh revalidates EVERY redirect
    // hop against the same allowlist, not just the first URL.
    const args = url
      ? ['--url', url, '--sha256', expectedSha256, ...allowedHosts.flatMap(host => ['--allowed-host', host])]
      : [];
    // A05: a custom URL installs into a sibling staging path first. The route
    // re-hashes those bytes and only then renames them onto config.lsBinaryPath
    // and restarts LS. A buggy/swapped installer that exits 0 with wrong bytes
    // therefore cannot publish or execute them.
    const staged = !!url;
    const installTarget = staged
      ? `${config.lsBinaryPath}.staged.${process.pid}.${randomUUID()}`
      : config.lsBinaryPath;
    const cleanupStaged = () => {
      if (!staged) return;
      try { unlinkSync(installTarget); } catch { /* already gone */ }
    };
    const env = {
      ...buildSubprocessEnv(),
      LS_INSTALL_PATH: config.lsBinaryPath,
    };
    if (staged) env.LS_INSTALL_STAGE_PATH = installTarget;
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
      cleanupStaged();
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
        createReadStream(installTarget)
          .on('data', c => h.update(c))
          .on('end', () => resolve(h.digest('hex')))
          .on('error', () => resolve(null));
      });
    } catch { /* keep null */ }
    // A05: never publish/restart on an unverified binary. install-ls.sh already
    // checks the digest before its atomic rename, so this is a second,
    // independent gate at the process boundary: a bug or a swapped script
    // must not turn into an LS restart that executes attacker bytes.
    if (staged && afterSha !== expectedSha256) {
      cleanupStaged();
      return json(res, 409, {
        ok: false,
        error: 'ERR_LS_INTEGRITY_FAILED',
        message: 'Installed binary does not match the expected SHA-256; refusing to restart the language server',
        expectedSha256,
        actualSha256: afterSha,
        beforeSha: beforeSha ? beforeSha.slice(0, 16) : null,
      });
    }
    if (staged) {
      try {
        renameSyncWithRetry(installTarget, config.lsBinaryPath);
      } catch (err) {
        cleanupStaged();
        return json(res, 500, {
          ok: false,
          error: 'ERR_LS_INSTALL_COMMIT_FAILED',
          message: `Could not publish the verified language server: ${err.message}`,
        });
      }
      // A custom binary has no manifest metadata; drop the previous install's
      // sidecar so it cannot describe the new binary with stale hashes.
      try { unlinkSync(`${config.lsBinaryPath}.version.json`); } catch { /* none */ }
    }
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
  //
  // Each row carries `reachable`: can this deployment actually serve it right now. On a
  // DEVIN_CONNECT deployment that answer comes from the SAME predicate /v1/models uses
  // (buildConnectReachability), because the two used to disagree completely — on a
  // free-only pool this panel listed 163 models the account could not call and omitted
  // `swe-1-6-slow`, the only one it could. Measured zero overlap between the two views
  // (#234's last acceptance criterion).
  //
  // Rows are ANNOTATED, never dropped. The panel renders the allow/deny chips from this
  // list alone, so narrowing it would make an existing allow-list entry invisible AND
  // unremovable — the operator could not click a chip that is no longer rendered.
  // Annotating also answers #235 ("which models actually cost me quota"), which narrowing
  // would not: the reporter needs to SEE the paid ones, greyed, not have them vanish.
  if (subpath === '/models' && method === 'GET') {
    const isReachable = buildConnectReachability();
    // Pool-wide quota state, computed once per request from the same inputs the
    // drought banner uses. `dailyDry` is what turns a bare "QUOTA" chip into
    // "daily quota exhausted" — the state a Pro account actually sat in while the
    // panel called its only working models paid and a phantom selector free.
    const drought = getDroughtSummary();
    const dailyDry = typeof drought.lowestDailyPercent === 'number' && drought.lowestDailyPercent <= 0;
    // One resolver for every row producer below, so a synthesized row and a MODELS
    // row can never disagree about price or catalog membership.
    //
    // quotaState answers a DIFFERENT question from freeNow and that split is the
    // fix: freeNow is "would this debit quota", quotaState is "would the upstream
    // accept it right now". The old single `currentlyFree` boolean collapsed them,
    // which is why a model the catalog omits (swe-1-6-slow) could read as FREE.
    const pricingFields = (selector) => {
      const pricing = getConnectSelectorPricing(selector);
      let quotaState = null;
      if (!selector) quotaState = null; // not a Connect-namespace row
      else if (pricing.inLiveCatalog === false) quotaState = 'not_in_catalog';
      else if (pricing.freeNow === true) quotaState = 'free';
      else if (dailyDry) quotaState = 'blocked_daily';
      else if (isConnectSelectorBlockedByDrought(selector)) quotaState = 'blocked_weekly';
      else quotaState = 'unknown';
      return {
        // Upstream cost tier ("MODEL_COST_TIER_FREE" | LOW | MEDIUM | HIGH), null
        // when the account's Cascade catalog has not reported it.
        costTier: pricing.costTier,
        // ISO end of the active promotion, when the upstream sent one.
        promoEndsAt: pricing.promoEndsAt,
        // Tri-state price: true free, false billable, null no data. Never a guess.
        freeNow: pricing.freeNow,
        // Why freeNow is true: cost_tier_free | rate_zero | fallback_whitelist.
        freeReason: pricing.freeReason,
        // Upstream's own promo text ("83% off"), null when it sent none.
        promoLabel: pricing.promoLabel,
        // When the live pricing behind these fields was last synced, and whether
        // that is older than the staleness budget. The panel shows it next to a
        // FREE badge so "free" from a stopped sync is visibly old.
        pricingFetchedAt: pricing.pricingFetchedAt,
        pricingStale: pricing.pricingStale,
        // free | blocked_daily | blocked_weekly | not_in_catalog | unknown | null.
        quotaState,
      };
    };
    const models = filterModelKeysByCloudCatalog().map((id) => {
      const info = MODELS[id];
      const { reachable, selector } = isReachable(id);
      return {
        id,
        name: info.name,
        provider: info.provider,
        credit: typeof info.credit === 'number' ? info.credit : null,
        reachable,
        // The resolved upstream selector, or null when the name maps to nothing on this
        // transport. Surfaced for diagnosis: "unreachable" and "does not resolve at all"
        // look identical in the UI otherwise.
        connectSelector: selector,
        ...pricingFields(selector),
      };
    });
    // Selectors that ARE serveable but have no MODELS row (`swe-1-6-slow` is in neither the
    // frozen snapshot nor the live catalog, so it appears in no Cascade-derived list). They
    // are the whole point of the panel on a free deployment, so synthesize them here the
    // way /v1/models' third producer does. Name/provider fall back to the selector because
    // there is no MODELS entry to read them from.
    //
    // Gated on the transport: these are CONNECT-namespace selectors. Injecting one into a
    // Cascade deployment's panel advertises a model that transport cannot route, which is
    // the same category of error as the mismatch this whole route fixes — just pointing the
    // other way. Caught by the "backend off" case in
    // test/dashboard-models-connect-parity.test.js.
    if (getBackendSwitch('devinConnect')) {
      const seen = new Set(models.map((m) => m.id));
      const representedSelectors = new Set(models
        .map((m) => m.connectSelector)
        .filter(Boolean));

      // /v1/models has a second producer for selectors present in the live Connect
      // catalog but absent from the shared MODELS table. Mirror it here; otherwise
      // the public model API can advertise a live-only selector that the Dashboard
      // cannot display, price, or manage. Keep the row annotated rather than
      // filtering it out: a restricted account still needs to see that the selector
      // exists but is currently unreachable for its pool.
      for (const row of getLiveCatalog()) {
        const id = (typeof row === 'string' ? row : row?.selector)?.trim();
        if (!id || seen.has(id) || representedSelectors.has(id)) continue;
        seen.add(id);
        const { reachable, selector } = isReachable(id);
        if (selector) representedSelectors.add(selector);
        models.push({
          id,
          name: row?.label || id,
          provider: row?.provider || 'windsurf',
          credit: null,
          reachable,
          connectSelector: selector,
          ...pricingFields(selector),
        });
      }

      for (const selector of FREE_REACHABLE_SELECTORS) {
        if (seen.has(selector)) continue;
        seen.add(selector);
        // Reachability is resolved, not asserted. The static floor is unpaid-tier
        // ENTITLEMENT; whether this account's live catalog actually contains the
        // selector is a separate fact, and `swe-1-6-slow` fails it on the measured
        // Pro deployment (absent from the 240-selector catalog, 502 quota on call).
        // The row stays visible — an operator must be able to see and remove an
        // allow-list entry — but it is annotated as not-in-catalog instead of
        // being advertised as reachable+free, which is how the panel ended up
        // pointing clients at the one selector that could not run.
        const { reachable } = isReachable(selector);
        models.push({
          id: selector,
          name: selector,
          provider: 'windsurf',
          credit: null,
          reachable,
          connectSelector: selector,
          ...pricingFields(selector),
        });
      }
    }
    return json(res, 200, { models });
  }

  // Live-vs-snapshot catalog diff for the dashboard. Read-only; it reports set
  // differences and alias resolution, never entitlement.
  if (subpath === '/models/catalog' && method === 'GET') {
    return json(res, 200, buildCatalogDiff({
      live: getLiveCatalog(),
      snapshot: getSnapshotSelectors(),
      resolve: resolveConnectSelector,
    }));
  }

  // Live model reconciliation (P0-3): local /v1/models rows vs the live catalog
  // vs the committed snapshot, plus counts-only views of the account-scoped
  // model sources. Upstream failures degrade to `partial:true`; only an
  // in-process handleModels() failure is a 502.
  if (subpath === '/models/reconcile' && method === 'GET') {
    const u = dashboardUrl(req);
    try {
      const result = await readModelReconciliation({
        id: u.searchParams.get('account') || undefined,
        force: u.searchParams.get('refresh') === '1',
      });
      const { httpStatus, ...payload } = result;
      // Preserve the upstream status marker for the browser. Without it a
      // forwarded upstream 401/429 is indistinguishable from the dashboard's
      // own password/IP-lock rejection, so the UI would clear a valid admin
      // session (or start a lockout) on a provider quota error.
      if (!result.ok) payload.httpStatus = httpStatus || 502;
      return json(res, result.ok ? 200 : (httpStatus || 502), payload, NO_STORE);
    } catch (err) {
      log.warn(`Dashboard model reconciliation failed: ${err?.kind || err?.name || 'unexpected'}`);
      return json(res, 502, { ok: false, error: 'upstream' }, NO_STORE);
    }
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
      return json(res, 200, await processWindsurfLogin({ email, password, loginProxy, autoAdd, storeCredential, req, accountId: body?.accountId || null }));
    } catch (err) {
      // The UI needs `method` to switch the form (email code vs OAuth-only)
      // without a second probe, and `probeUnknown` to offer the alternatives
      // when the password was rejected but the login method was never
      // confirmed — the exact shape that made a passwordless account read as
      // "wrong password" on 3.9.42.
      return json(res, err.statusCode || 400, {
        error: err.code || err.message,
        isAuthFail: !!err.isAuthFail,
        firebaseCode: err.firebaseCode,
        ...(err.method ? { method: err.method } : {}),
        ...(err.oauthProviders?.length ? { oauthProviders: err.oauthProviders } : {}),
        ...(err.detail ? { detail: err.detail } : {}),
        ...(err.probeUnknown ? { probeUnknown: true } : {}),
        ...(err.alternatives ? { alternatives: err.alternatives } : {}),
      });
    }
  }

  // Login-method probe. The UI calls this BEFORE showing a password field:
  // `hasPassword:false` means the account can only log in with an emailed code
  // or OAuth, so a password attempt would be a guaranteed, misleading 401.
  // Dashboard auth is enforced above; this route never sees a credential.
  if (subpath === '/windsurf-login/probe' && method === 'POST') {
    const email = String(body?.email || '').trim();
    if (!email) return json(res, 400, { error: 'ERR_EMAIL_REQUIRED' });
    // Per-email rate limit, shared with the login path. 400 (not 429): the
    // dashboard renders 429 as an IP-wide ban overlay, and this lock is
    // per-email.
    const lockMs = checkEmailLocked(email);
    if (lockMs != null) return json(res, 400, { error: 'ERR_EMAIL_LOCKED', retryAfterMs: lockMs });
    try {
      const loginProxy = body?.proxy?.host ? body.proxy : getProxyConfig().global;
      const probe = await probeLoginMethod(email, loginProxy);
      return json(res, 200, {
        ok: true,
        email,
        userExists: probe.userExists,
        hasPassword: probe.hasPassword,
        method: probe.method,
        emailCode: probe.emailCode,
        oauth: probe.oauth,
        source: probe.source,
        // Which login host answered (`windsurf` | `devin` | null). The email
        // flow starts on the same host instead of guessing.
        host: probe.host || null,
      }, NO_STORE);
    } catch (err) {
      // A malformed address is the caller's error (400); anything else is an
      // upstream availability failure (502).
      return json(res, err.statusCode || 502, {
        ok: false,
        error: err.code || 'ERR_LOGIN_PROBE_FAILED',
        ...(err.detail ? { detail: err.detail } : {}),
      }, NO_STORE);
    }
  }

  // Ask Windsurf to email a login code. The upstream verification token stays
  // server-side, keyed by the returned opaque flowId — only {flowId, sent} is
  // returned, and neither the token nor the code is ever logged.
  //
  // `host:'devin'` is an explicit operator choice ("the windsurf.com mail never
  // arrived — retry on app.devin.ai"). It is allowlisted, never free text, and
  // it is not the automatic cross-host fallback (that stays behind
  // DEVIN_CONNECT_LOGIN_HOST_FALLBACK).
  if (subpath === '/windsurf-login/email/start' && method === 'POST') {
    const email = String(body?.email || '').trim();
    if (!email) return json(res, 400, { error: 'ERR_EMAIL_REQUIRED' });
    const host = body?.host === 'devin' ? 'devin' : (body?.host === 'windsurf' ? 'windsurf' : undefined);
    try {
      const loginProxy = body?.proxy?.host ? body.proxy : getProxyConfig().global;
      return json(res, 200, await emailLoginStart(email, loginProxy, { host }), NO_STORE);
    } catch (err) {
      // Stable code + machine-readable detail (F8). A transport failure used to
      // escape as a raw English message with no code; the UI then printed the
      // upstream text verbatim and the operator could not tell whether the mail
      // had been sent.
      return json(res, err.statusCode || 400, {
        error: err.code || err.message,
        ...(err.detail ? { detail: err.detail } : {}),
        ...(err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}),
        ...(err.retryable ? { retryable: true } : {}),
      }, NO_STORE);
    }
  }

  // Verify the emailed code and finish the login. Same response shape as
  // /windsurf-login, including the auto-add + credential-store tail.
  if (subpath === '/windsurf-login/email/complete' && method === 'POST') {
    const { flowId, code, proxy: loginProxy, autoAdd } = body || {};
    if (!flowId || !code) return json(res, 400, { error: 'ERR_EMAIL_FLOW_CODE_REQUIRED' });
    try {
      // V-24: when the caller binds the exchange to an account, the flow's own
      // identity must match it BEFORE the single-use code is spent. finalize
      // re-checks before any mutation; this early check keeps a mismatch from
      // costing the operator a second email.
      const boundAccount = body?.accountId ? getAccountInternal(body.accountId) : null;
      const result = await emailLoginComplete(
        flowId,
        code,
        loginProxy?.host ? loginProxy : getProxyConfig().global,
        { expectedIdentityEmail: boundAccount?.email },
      );
      // No password exists in this flow, so there is nothing for the credential
      // store to persist — pass storeCredential:false regardless of the request.
      return json(res, 200, await finalizeWindsurfLogin(result, {
        password: null, loginProxy, autoAdd, storeCredential: false, req,
        accountId: body?.accountId || null,
      }));
    } catch (err) {
      return json(res, err.statusCode || 400, {
        error: err.code || err.message,
        ...(err.detail ? { detail: err.detail } : {}),
        ...(err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}),
        ...(err.attemptsRemaining != null ? { attemptsRemaining: err.attemptsRemaining } : {}),
        ...(err.retryable ? { retryable: true } : {}),
        isAuthFail: !!err.isAuthFail,
      });
    }
  }

  // Import a token captured from the official sign-in page
  // (windsurf.com/editor/show-auth-token) or from any OAuth / deep-link
  // redirect, in ONE step.
  //
  // Stateless on purpose. `/oauth/callback` is the state-bound flow for CLI and
  // remote-onboarding clients; requiring a pending session here meant a valid
  // token failed with ERR_INVALID_STATE whenever the page had been opened by a
  // different button (or the session had expired). The token itself is the
  // credential — the state adds nothing to this path.
  //
  // `devin-session-token$…` is stored as the pool key; a Firebase idToken /
  // show-auth-token value goes through RegisterUser. `auth1_` is an
  // intermediate and is rejected. The raw input is NEVER echoed or logged.
  if (subpath === '/windsurf-login/token' && method === 'POST') {
    const raw = body?.token ?? body?.redirect_url ?? '';
    const label = String(body?.label || '').trim();
    if (!raw) return json(res, 400, { error: 'ERR_NO_TOKEN_IN_INPUT' });
    try {
      // extractOAuthToken keeps the actionable diagnostics (ERR_OAUTH_UPSTREAM,
      // ERR_INTERMEDIATE_CALLBACK) and returns a bare token unchanged.
      const token = extractOAuthToken(raw);
      if (!token) return json(res, 400, { error: 'ERR_NO_TOKEN_IN_INPUT' });
      // SessionReauth: a bound paste replaces the account's token instead of
      // adding a second row for the same person.
      if (body?.accountId) {
        const applied = applyReauthToken(body.accountId, token, { via: 'token' });
        return json(res, 200, { ...applied, method: 'token' }, NO_STORE);
      }
      const account = await addAccountByPastedSecret(token, label);
      scheduleAccountWarmup(account.id);
      return json(res, 200, {
        success: true,
        method: 'token',
        account: { id: account.id, email: account.email, status: account.status },
      }, NO_STORE);
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.code || err.message });
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
          // V-25: /windsurf-login returns the raw key for a one-time export
          // when autoAdd:false. A BATCH response has no such contract — every
          // row is keyed by an address whose password the caller just sent, so
          // a raw key here is only a leak. Mask it and keep the same shape.
          if (result && result.apiKey) {
            const { apiKey, ...rest } = result;
            results.push({ ...rest, apiKey_masked: maskApiKey(apiKey) });
          } else {
            results.push(result);
          }
        } catch (err) {
          results.push({
            success: false,
            email,
            error: err.code || String(err.message || 'ERR_LOGIN_FAILED').slice(0, 200),
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
      }, NO_STORE);
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
            // V-25: never `item.raw` — that string is the operator's pasted
            // line (password/token included). The kind label is derived from
            // the parsed shape, so it cannot contain any of the input.
            detail: describeImportItem(item),
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
            const account = await addAccountByPastedSecret(item.token, item.label);
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
            const account = await addAccountByPastedSecret(item.apiKey, item.label, item.apiServerUrl || '', { unknownAsKey: true });
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
          // V-25: `proxyRaw` carried user:pass@; the label drops the userinfo
          // and is what the dashboard shows / stores in login history.
          result.proxy = redactedProxyLabel(item.proxy);
          result.importKind = item.kind;
          results.push(result);
        } catch (err) {
          results.push({
            success: false,
            skipped: false,
            email: item.email || item.label || '',
            // Prefer the stable code; a bare Error message can carry upstream
            // prose, so it is bounded as a last resort.
            error: err.code || String(err.message || 'ERR_IMPORT_ITEM_FAILED').slice(0, 200),
            lineNumber: item.lineNumber,
            proxy: redactedProxyLabel(item.proxy),
            importKind: item.kind,
            detail: describeImportItem(item),
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
      }, NO_STORE);
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
        account = addAccountByKey(apiKey, sanitizeLabelText(name) || email || provider || 'OAuth');
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
      const account = await addAccountByPastedSecret(token, '');
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
        account = addAccountByKey(apiKey, sanitizeLabelText(name) || email || 'OTP');
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

  // ─── DevIn panel (page-level snapshot) ─────────────────
  // GET /devin/panel — one in-process snapshot for the Devin panel page:
  // runtime switches + LS/detach state, the merged per-account billed-turn
  // rings, the drought decision, and the quota/spend knobs. No upstream call
  // and no key material, so opening the page costs no quota. Sources the proxy
  // cannot read (Cascade trajectories, ACP sessions) are declared unavailable
  // with a machine-readable reason by the builder — never returned as empty
  // lists, which would read as "no sessions".
  if (subpath === '/devin/panel' && method === 'GET') {
    const now = Date.now();
    // Newest-used first, so MAX_SCAN_ACCOUNTS only drops accounts that never
    // served a turn. `lastUsed` is an ISO string (or null) on the summary view.
    const allAccounts = getAccountList({ view: 'summary' });
    const accounts = allAccounts
      .map((a) => ({ id: a.id, ref: accountRef(a.id), lastUsed: a.lastUsed ? Date.parse(a.lastUsed) : 0 }))
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
      .slice(0, MAX_SCAN_ACCOUNTS);
    const runtime = buildRuntimeSection({
      uptimeSec: Math.round(process.uptime()),
      startedAt: getStats().startedAt,
      switches: runtimeSwitchRows(),
      credStoreEnabled: !!(process.env.DEVIN_CONNECT_CRED_KEY || '').trim(),
      remoteCredStore: String(process.env.DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE || '').trim() === '1',
      langServer: getLsStatus(),
      detach: { enabled: cascadeDetachEnabled(), ...detachedRegistry.stats() },
    });
    const sessions = buildSessionsSection({
      turns: buildTurnsSection({ accounts, totalAccounts: allAccounts.length, readRequests: getAccountRequests, now }),
    });
    const quota = buildQuotaSection({
      drought: getDroughtSummary(),
      tunables: getQuotaTunables(),
      overrides: getQuotaOverrides(),
    });
    return json(res, 200, buildDevinPanel({ now, runtime, sessions, quota }), NO_STORE);
  }

  // ─── DevinMap cards (account drawer) ──────────────────
  // GET /accounts/:id/devin-cards — the three account-local cards (ACU ledger,
  // model entitlement, key rotation). No network: every field is read from the
  // stored account record plus the in-process credit ledger, so opening the
  // drawer never costs an upstream call. Auth is inherited from the gate above.
  const devinCards = subpath.match(/^\/accounts\/([^/]+)\/devin-cards$/);
  if (devinCards && method === 'GET') {
    const payload = buildAccountCards(devinCards[1]);
    return json(res, payload.ok ? 200 : (payload.httpStatus || 404), payload);
  }

  // GET /accounts/:id/requests — the account's own request history: billed
  // requests plus failed attempts attributed to it. Read-only, process-local,
  // no upstream call and no key material: rows carry model + token counts +
  // cost, or model + outcome + status for a failure. `total` is the ring size
  // (billed + failed), and `billed`/`failed` split it, so the drawer can print
  // "50 of 100" instead of implying the page is the whole history.
  const accountRequests = subpath.match(/^\/accounts\/([^/]+)\/requests$/);
  if (accountRequests && method === 'GET') {
    const acct = getAccountPublic(accountRequests[1], { view: 'summary' });
    if (!acct) return json(res, 404, { error: 'Account not found' });
    const u = new URL(req?.url || '/', 'http://localhost');
    const payload = getAccountRequests(acct.id, { limit: u.searchParams.get('limit') });
    return json(res, 200, { ok: true, accountRef: accountRef(acct.id), ...payload });
  }

  // POST /accounts/:id/capacity-preflight — on-demand selector capacity check
  // before a run. One upstream CheckUserMessageRateLimit call, memoized 60 s per
  // account+selector (DevinMap §6.4: never on page load). The local half is
  // always computed, so an upstream failure still explains the pool-side state.
  const capacityPreflight = subpath.match(/^\/accounts\/([^/]+)\/capacity-preflight$/);
  if (capacityPreflight && method === 'POST') {
    const result = await preflightCapacity({
      id: capacityPreflight[1],
      model: typeof body?.model === 'string' ? body.model : '',
      force: body?.force === true,
    });
    return json(res, result.ok ? 200 : (result.httpStatus || 400), result);
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
    log.info(`reveal-key: account ${revealKey[1]} (${maskEmail(acct.email) || 'no-email'}) revealed from ${dashboardClientIp(req) || 'unknown'}`);
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
const SELF_UPDATE_IN_PROGRESS = 'ERR_UPDATE_IN_PROGRESS';
const NO_RELEASE_TAG = 'ERR_NO_RELEASE_TAG';
const RELEASE_TAG_LOOKUP_FAILED = 'ERR_RELEASE_TAG_LOOKUP';
let gitExecFileForTest = null;
let rollbackPointWriterForTest = null;
let selfUpdateSupervisorDetectorForTest = null;
let selfUpdateRestartSchedulerForTest = null;
let dockerSelfUpdateOverridesForTest = null;
let releaseAttestationVerifierForTest = null;
let selfUpdateMutationInFlight = false;
// Hold the mutation lock for the whole out-of-band deployer window (flush
// delay + recreate + health gate + possible rollback + second gate), so a
// retry cannot start while the deployer is still mutating the stack.
const DOCKER_SELF_UPDATE_MUTATION_HOLD_MS = DOCKER_DEPLOYER_WINDOW_MS;

// EX_TEMPFAIL: non-zero is intentional. systemd Restart=on-failure and PM2
// autorestart both relaunch after this self-update-only exit, while normal
// SIGINT/SIGTERM shutdown keeps its separate successful exit path in index.js.
export function selfUpdateRestartExitCode() {
  return 75;
}

export function setGitExecFileForTest(execFile) {
  gitExecFileForTest = execFile;
}

export function setRollbackPointWriterForTest(writer) {
  rollbackPointWriterForTest = typeof writer === 'function' ? writer : null;
}

export function setSelfUpdateSupervisorDetectorForTest(detector) {
  selfUpdateSupervisorDetectorForTest = typeof detector === 'function' ? detector : null;
}

export function setSelfUpdateRestartSchedulerForTest(scheduler) {
  selfUpdateRestartSchedulerForTest = typeof scheduler === 'function' ? scheduler : null;
}

export function setDockerSelfUpdateForTest(overrides) {
  dockerSelfUpdateOverridesForTest = overrides && typeof overrides === 'object' ? overrides : null;
}

export function setReleaseAttestationVerifierForTest(verifier) {
  releaseAttestationVerifierForTest = typeof verifier === 'function' ? verifier : null;
}

function detectSelfUpdateSupervisor() {
  return (selfUpdateSupervisorDetectorForTest || detectSupervisor)();
}

function scheduleSelfUpdateRestart(callback, releaseMutation) {
  if (selfUpdateRestartSchedulerForTest) {
    return selfUpdateRestartSchedulerForTest(callback, releaseMutation);
  }
  const releaseOnExit = () => releaseMutation();
  process.once('exit', releaseOnExit);
  setTimeout(() => {
    Promise.resolve()
      .then(callback)
      .catch((err) => {
        // A rejecting restart must not become an unhandled rejection that
        // crashes the process after the HTTP response already went out. The
        // durable journal (written by the caller) is the retry evidence.
        log.warn(`self-update: restart callback failed: ${err?.message || err}`);
      })
      .finally(() => {
        process.off('exit', releaseOnExit);
        releaseMutation();
      });
  }, 800);
  return true;
}

function detectDockerSelfUpdateForRequest() {
  return (dockerSelfUpdateOverridesForTest?.detect || detectDockerSelfUpdate)();
}

function runDockerSelfUpdateForRequest() {
  return (dockerSelfUpdateOverridesForTest?.run || runDockerSelfUpdate)();
}

function scheduleDockerSelfUpdateMutationRelease(releaseMutation) {
  if (typeof dockerSelfUpdateOverridesForTest?.scheduleRelease === 'function') {
    return dockerSelfUpdateOverridesForTest.scheduleRelease(releaseMutation);
  }
  // The deployer sleeps for eight seconds and then runs compose out-of-band.
  // Keep both the in-process guard and repository lock owned across that
  // window. If compose fails and this process survives, a bounded timeout
  // eventually permits an operator retry; a successful recreate exits this
  // process first and releases through the exit hook.
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    process.off('exit', releaseOnce);
    releaseMutation();
  };
  const timer = setTimeout(releaseOnce, DOCKER_SELF_UPDATE_MUTATION_HOLD_MS);
  timer.unref?.();
  process.once('exit', releaseOnce);
  return true;
}

function makeSelfUpdateError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const SELF_UPDATE_LOCK_DIRNAME = 'windsurfapi-update.lock';
const ROLLBACK_POINT_FILENAME = 'self-update-before.json';
const ROLLBACK_POINT_PENDING_FILENAME = 'self-update-before.pending.json';

function repositoryGitDir(cwd = process.cwd()) {
  const dotGit = join(cwd, '.git');
  if (!existsSync(dotGit)) return '';
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const match = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/i);
    return match ? resolve(dirname(dotGit), match[1]) : '';
  } catch {
    return '';
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM still means the process exists; only ESRCH proves a stale owner.
    return err?.code !== 'ESRCH';
  }
}

function readUpdateLockOwner(lockDir) {
  try {
    const raw = readFileSync(join(lockDir, 'owner'), 'utf8').trim();
    const match = raw.match(/^(\d+)\s+([A-Za-z0-9._-]+)$/);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, token: match[2], legacy: false } : null;
  } catch {}
  // Backward compatibility for locks created by v3.9.23/update.sh. A live
  // legacy PID still blocks; a dead one can be recovered through the same
  // exclusive recovery-claim protocol below.
  try {
    const raw = readFileSync(join(lockDir, 'pid'), 'utf8').trim();
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, token: '', legacy: true } : null;
  } catch {
    return null;
  }
}

function sameUpdateLockOwner(left, right) {
  return !!left && !!right && left.pid === right.pid && left.token === right.token && left.legacy === right.legacy;
}

function removeUpdateLockDirectory(lockDir, ownerToken = null) {
  if (ownerToken !== null) {
    const owner = readUpdateLockOwner(lockDir);
    if (!owner || owner.legacy || owner.pid !== process.pid || owner.token !== ownerToken) return false;
  }
  try { unlinkSync(join(lockDir, 'recovery')); } catch {}
  try { unlinkSync(join(lockDir, 'owner')); } catch {}
  try { unlinkSync(join(lockDir, 'pid')); } catch {}
  try {
    rmdirSync(lockDir);
    return true;
  } catch {
    return false;
  }
}

function recoverStaleUpdateLock(lockDir) {
  const observed = readUpdateLockOwner(lockDir);
  if (!observed || processIsAlive(observed.pid)) return false;

  // Claim recovery *inside the still-existing stale directory*. O_EXCL makes
  // exactly one contender the recovery owner; losers cannot unlink/recreate a
  // lock that another contender has already acquired (the stale-lock ABA).
  const claimToken = `${process.pid}-${randomUUID()}`;
  const claimPath = join(lockDir, 'recovery');
  try {
    writeFileSync(claimPath, `${process.pid} ${claimToken}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }

  const quarantine = `${lockDir}.stale-${claimToken}`;
  try {
    if (!sameUpdateLockOwner(readUpdateLockOwner(lockDir), observed)) return false;
    renameSync(lockDir, quarantine);
  } catch {
    return false;
  } finally {
    // Before rename this removes only our own claim. After rename the old path
    // no longer exists, so cleanup continues against the quarantine below.
    try { unlinkSync(claimPath); } catch {}
  }
  removeUpdateLockDirectory(quarantine);
  return true;
}

function acquireRepositoryUpdateLock() {
  const gitDir = repositoryGitDir();
  if (!gitDir) return () => {};
  const lockDir = join(gitDir, SELF_UPDATE_LOCK_DIRNAME);
  const create = () => {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      return true;
    } catch (err) {
      if (err?.code === 'EEXIST') return false;
      throw makeSelfUpdateError('ERR_UPDATE_LOCK_FAILED', `Could not create update lock: ${err.message}`);
    }
  };
  if (!create()) {
    if (!recoverStaleUpdateLock(lockDir) || !create()) return null;
  }
  const ownerToken = randomUUID();
  try {
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${ownerToken}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Keep the numeric pid file for one-release interoperability with older
    // update.sh versions; ownership and release authority come from `owner`.
    writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (err) {
    removeUpdateLockDirectory(lockDir, ownerToken) || removeUpdateLockDirectory(lockDir);
    throw makeSelfUpdateError('ERR_UPDATE_LOCK_FAILED', `Could not initialize update lock: ${err.message}`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeUpdateLockDirectory(lockDir, ownerToken);
  };
}

function acquireSelfUpdateMutation() {
  if (selfUpdateMutationInFlight) return null;
  const releaseRepositoryLock = acquireRepositoryUpdateLock();
  if (!releaseRepositoryLock) return null;
  selfUpdateMutationInFlight = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    selfUpdateMutationInFlight = false;
    releaseRepositoryLock();
  };
}

function rollbackPointPaths({ ensureDir = false } = {}) {
  const dataDir = join(process.cwd(), 'data');
  if (ensureDir) mkdirSync(dataDir, { recursive: true });
  return {
    final: join(dataDir, ROLLBACK_POINT_FILENAME),
    pending: join(dataDir, ROLLBACK_POINT_PENDING_FILENAME),
  };
}

// ─── Durable self-update journal (D6) ─────────────────────
//
// `{ok:true}` used to mean only "git reset applied / deployer sidecar
// started". The restart (source) or recreate (docker) happens afterwards, and
// a scheduler/deployer failure was indistinguishable from a verified healthy
// rollback. This journal is written BEFORE the mutating restart is requested,
// survives a crash, and is confirmed only when the running process reports the
// commit `/health` would publish. The rollback point is retained until then,
// so a failed or never-scheduled restart stays retryable.
const SELF_UPDATE_JOURNAL_FILENAME = 'self-update-journal.json';
const SELF_UPDATE_PENDING_STATES = new Set([
  'pending-restart',
  'restart-not-scheduled',
  'restart-failed',
]);

function selfUpdateJournalPath() {
  return join(process.cwd(), 'data', SELF_UPDATE_JOURNAL_FILENAME);
}

function readSelfUpdateJournal() {
  try {
    const value = JSON.parse(readFileSync(selfUpdateJournalPath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSelfUpdateJournal(record) {
  const path = selfUpdateJournalPath();
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, record);
}

function updateSelfUpdateJournal(patch) {
  const next = { ...(readSelfUpdateJournal() || {}), ...patch, updatedAt: Date.now() };
  writeSelfUpdateJournal(next);
  return next;
}

let selfUpdateRunningCommitForTest = null;
export function setSelfUpdateRunningCommitForTest(fn) {
  selfUpdateRunningCommitForTest = typeof fn === 'function' ? fn : null;
}

// The commit the restarted process would serve on /health. Defaults to the
// build identity of the RUNNING process, which is exactly what /health
// publishes (server.js VERSION_INFO.commit).
function selfUpdateRunningCommit() {
  if (selfUpdateRunningCommitForTest) {
    try { return String(selfUpdateRunningCommitForTest() || ''); } catch { return ''; }
  }
  try { return String(getVersionInfo().commit || ''); } catch { return ''; }
}

function commitsCorrespond(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  if (!a || !b) return false;
  const shortest = Math.min(a.length, b.length);
  if (shortest < 7) return false;
  return (a.startsWith(b) || b.startsWith(a));
}

/**
 * Confirm a pending self-update journal against the running commit.
 *
 * Called on /self-update/check (and before a rollback attempt), i.e. after a
 * restart. A rollback is only "confirmed" when the process that answers now is
 * the commit the rollback reset to; that confirmation is what deletes the
 * rollback point. Anything else keeps both the journal and the point intact so
 * the operation remains retryable and its failure stays visible.
 */
export function reconcileSelfUpdateJournal() {
  const journal = readSelfUpdateJournal();
  if (!journal || !SELF_UPDATE_PENDING_STATES.has(journal.state)) return journal;
  const expected = journal.expectedCommit || journal.beforeCommit;
  const running = selfUpdateRunningCommit();
  if (!commitsCorrespond(running, expected)) return journal;
  const confirmed = {
    ...journal,
    state: 'confirmed',
    confirmedCommit: running,
    confirmedAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    writeSelfUpdateJournal(confirmed);
  } catch (err) {
    log.warn(`self-update: could not record journal confirmation: ${err.message}`);
    return journal;
  }
  if (journal.operation === 'rollback') {
    const paths = rollbackPointPaths();
    try { unlinkSync(paths.final); } catch {}
    try { unlinkSync(paths.pending); } catch {}
  }
  return confirmed;
}

function nulSeparatedGitPaths(output) {
  return String(output || '').split('\0').filter(Boolean);
}

function gitPathsConflict(left, right) {
  // Be conservative on case-insensitive worktrees: a differently-cased local
  // ignored path can still be the same filesystem object reset --hard replaces.
  const a = left.replace(/\/$/, '').toLowerCase();
  const b = right.replace(/\/$/, '').toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

async function findIgnoredTargetPathConflicts(targetCommit) {
  const treeOutput = await runGit(['ls-tree', '-r', '-z', '--name-only', targetCommit]);
  const targetPaths = nulSeparatedGitPaths(treeOutput);
  if (!targetPaths.length) return [];

  // First ask Git for a collapsed inventory of ignored roots. `--directory`
  // avoids descending into wholly ignored trees such as node_modules, while
  // still exposing partially ignored paths (for example data/accounts.json).
  // Matching roots case-insensitively here is deliberately independent of
  // core.ignorecase: the filesystem may be case-insensitive even when that
  // config is absent or stale.
  const targetRoots = [...new Set(targetPaths.map(path => path.split('/')[0]).filter(Boolean))];
  const targetRootsFolded = new Set(targetRoots.map(root => root.toLowerCase()));
  const inventoryOutput = await runGit([
    'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z',
  ]);
  const localRoots = [...new Set(nulSeparatedGitPaths(inventoryOutput)
    .map(path => path.replace(/\/$/, '').split('/')[0])
    .filter(root => root && targetRootsFolded.has(root.toLowerCase())))];
  if (!localRoots.length) return [];

  // Now enumerate only the actual local root spellings that can collide. This
  // keeps the precise ancestor/descendant test without scanning unrelated
  // ignored runtime data.
  const ignoredOutput = await runGit([
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
    ...localRoots.map(root => `:(top,literal)${root}`),
  ]);
  const ignoredPaths = nulSeparatedGitPaths(ignoredOutput);
  return [...new Set(ignoredPaths.filter(ignored => targetPaths.some(target => gitPathsConflict(ignored, target))))];
}

function validGitObjectId(value) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(value || ''));
}

function parseGitNonnegativeCount(output, label) {
  const value = String(output ?? '').trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw makeSelfUpdateError(
      'ERR_INVALID_GIT_COUNT',
      `Git returned an invalid count while checking ${label}; refusing to infer zero.`,
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw makeSelfUpdateError(
      'ERR_INVALID_GIT_COUNT',
      `Git returned an unsafe count while checking ${label}; refusing to continue.`,
    );
  }
  return count;
}

async function currentStashTip() {
  const output = (await runGit(['for-each-ref', '--format=%(objectname)', 'refs/stash'])).trim();
  if (!output) return '';
  if (!validGitObjectId(output)) {
    throw new Error('refs/stash did not resolve to one valid object ID');
  }
  return output;
}

function ownedStashOid(listing, marker) {
  const matches = String(listing || '').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0 || !line.slice(tab + 1).includes(marker)) return [];
    const oid = line.slice(0, tab);
    if (!validGitObjectId(oid)) throw new Error('protective stash has an invalid object ID');
    return [oid];
  });
  if (matches.length > 1) throw new Error('protective stash ownership is ambiguous');
  return matches[0] || '';
}

async function createProtectiveStash(label) {
  const beforeTip = await currentStashTip();
  const marker = `windsurfapi-${label}-${randomUUID()}`;
  await runGit(['stash', 'push', '--include-untracked', '-m', marker]);
  const listing = await runGit(['stash', 'list', '--format=%H%x09%gs']);
  const oid = ownedStashOid(listing, marker);
  if (oid) return oid;

  // `git stash push` legitimately exits zero with "No local changes to save"
  // when another actor cleans the tree between the dirty probe and this call.
  // In that case no stash belongs to us. If refs/stash changed anyway, a
  // concurrent/user stash won the race; abort rather than ever treating it as
  // our recovery object.
  const afterTip = await currentStashTip();
  if (afterTip !== beforeTip) {
    throw new Error('refs/stash changed, but the updater could not identify its own protective stash');
  }
  return '';
}

async function restoreProtectiveStash(oid) {
  if (!validGitObjectId(oid)) throw new Error('protective stash object ID is invalid');
  // Apply the exact object. Never `stash pop` the current top: normal Git
  // commands are not serialized by the updater lock, so a user may have added
  // another stash after ours. Keep the owned stash as a recoverable backup.
  await runGit(['stash', 'apply', oid]);
}

function prepareRollbackPoint(value) {
  const { pending } = rollbackPointPaths({ ensureDir: true });
  (rollbackPointWriterForTest || writeJsonAtomic)(pending, value);
}

function discardPendingRollbackPoint() {
  const { pending } = rollbackPointPaths();
  try { unlinkSync(pending); } catch {}
}

function promotePendingRollbackPoint() {
  const { pending, final } = rollbackPointPaths();
  renameSyncWithRetry(pending, final);
}

function reconcilePendingRollbackPoint(currentCommit) {
  const { pending } = rollbackPointPaths();
  let point;
  try { point = JSON.parse(readFileSync(pending, 'utf8')); } catch { return; }
  const validSha = value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
  if (!validSha(point?.commit) || !validSha(point?.after) || point.after !== currentCommit) {
    discardPendingRollbackPoint();
    return;
  }
  try {
    promotePendingRollbackPoint();
  } catch (err) {
    if (err?.renamePublished) {
      log.warn(`self-update: recovered rollback point final file is visible, but its directory fsync failed: ${err.message}`);
      return;
    }
    throw makeSelfUpdateError(
      'ERR_ROLLBACK_POINT_RECOVERY_FAILED',
      `A pending rollback point matches current HEAD but could not be recovered: ${err.message}`,
    );
  }
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
        if (err) {
          const failure = new Error((stderr || err.message).toString().slice(0, 500));
          // `git merge-base --is-ancestor` uses exit 1 for the ordinary
          // "not an ancestor" answer and other exit codes for indeterminate
          // failures. Preserve the numeric status so release discovery can skip
          // an off-branch tag without turning a real Git/protocol failure into a
          // false negative.
          if (Number.isInteger(err.code)) failure.gitExitCode = err.code;
          return reject(failure);
        }
        resolve(stdout.toString());
      });
    }).catch(reject);
  });
}

function stableReleaseVersion(tag) {
  const match = String(tag || '').match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? match.slice(1) : null;
}

function compareDecimalComponents(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareStableReleaseTags(left, right) {
  const a = stableReleaseVersion(left);
  const b = stableReleaseVersion(right);
  for (let i = 0; i < 3; i++) {
    const compared = compareDecimalComponents(a[i], b[i]);
    if (compared) return compared;
  }
  return 0;
}

function validRemoteTagName(tag) {
  return !!tag
    && !tag.startsWith('.')
    && !tag.endsWith('.')
    && !tag.startsWith('/')
    && !tag.endsWith('/')
    && !tag.includes('..')
    && !tag.includes('//')
    && !tag.includes('@{')
    && !/[\x00-\x20\x7f~^:?*[\\]/.test(tag);
}

function parseRemoteStableReleaseTags(output) {
  const byName = new Map();
  for (const line of String(output || '').split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/tags\/(.+)$/i);
    if (!match) throw new Error('remote tag enumeration returned a malformed record');
    const oid = match[1].toLowerCase();
    const peeled = match[2].endsWith('^{}');
    const name = peeled ? match[2].slice(0, -3) : match[2];
    if (!validRemoteTagName(name)) throw new Error('remote tag enumeration returned an invalid ref name');
    if (!stableReleaseVersion(name)) continue;

    const entry = byName.get(name) || { name, object: '', peeled: '' };
    const field = peeled ? 'peeled' : 'object';
    if (entry[field]) throw new Error(`remote tag enumeration duplicated ${name}${peeled ? '^{}' : ''}`);
    entry[field] = oid;
    byName.set(name, entry);
  }

  const candidates = [...byName.values()];
  for (const candidate of candidates) {
    if (!candidate.object) throw new Error(`remote tag ${candidate.name} has a peeled record without its tag ref`);
  }
  candidates.sort((left, right) => compareStableReleaseTags(right.name, left.name));
  return candidates;
}

async function materializeRemoteReleaseTag(candidate) {
  // Fetch the exact remote ref only into FETCH_HEAD. This retrieves annotated
  // tag objects when needed but never creates, overwrites, or prunes a local tag:
  // operator-owned and previously fetched tags remain untouched.
  await runGit(['fetch', '--quiet', '--no-tags', 'origin', `refs/tags/${candidate.name}`]);
  const fetchedObject = (await runGit(['rev-parse', 'FETCH_HEAD'])).trim().toLowerCase();
  if (!validGitObjectId(fetchedObject) || fetchedObject !== candidate.object) {
    throw new Error(`remote tag ${candidate.name} changed during verification`);
  }

  const fetchedCommit = (await runGit(['rev-parse', 'FETCH_HEAD^{commit}'])).trim().toLowerCase();
  if (!validGitObjectId(fetchedCommit)) throw new Error(`remote tag ${candidate.name} did not peel to a commit`);
  const objectType = (await runGit(['cat-file', '-t', fetchedObject])).trim();
  if (candidate.peeled) {
    if (objectType !== 'tag' || fetchedCommit !== candidate.peeled) {
      throw new Error(`annotated remote tag ${candidate.name} failed object/peeled-commit correspondence`);
    }
  } else if (objectType !== 'commit' || fetchedCommit !== fetchedObject) {
    // A standards-compliant ls-remote includes ^{} for an annotated tag. Treat
    // an omitted/mismatched peeled record as a protocol anomaly, not as a
    // lightweight release.
    throw new Error(`lightweight remote tag ${candidate.name} did not name one commit object`);
  }
  return { ...candidate, commit: fetchedCommit };
}

async function gitCommitIsAncestor(commit, ref) {
  try {
    await runGit(['merge-base', '--is-ancestor', commit, ref]);
    return true;
  } catch (err) {
    if (err?.gitExitCode === 1) return false;
    throw err;
  }
}

async function latestReleaseTag(branch) {
  // Query the remote tag namespace directly. `git fetch --tags` is additive:
  // when a mistaken/revoked release tag is deleted upstream, its local ref
  // survives and `git tag --list` keeps selecting it indefinitely. Remote refs
  // are the publication authority; local tags are neither read nor mutated.
  try {
    const output = await runGit(['ls-remote', '--tags', 'origin', 'refs/tags/v[0-9]*']);
    const remoteRef = `origin/${branch}`;
    for (const advertised of parseRemoteStableReleaseTags(output)) {
      const candidate = await materializeRemoteReleaseTag(advertised);
      if (await gitCommitIsAncestor(candidate.commit, remoteRef)) return candidate;
    }
    return { name: '', commit: '' };
  } catch (cause) {
    const err = makeSelfUpdateError(
      RELEASE_TAG_LOOKUP_FAILED,
      'Unable to verify published release tags; refusing an unverified update target.',
    );
    err.cause = cause;
    throw err;
  }
}

/**
 * D9 source-OTA attestation: verify the tag `releaseUpdateState` selected.
 * The candidate has already been materialized and proven reachable; this binds
 * its peeled commit to the signed release-attestation.json before any mutation
 * target is returned. `warn` is the default rollout so existing installs keep
 * updating; `required` makes missing material fatal.
 */
async function verifySelectedReleaseAttestation(release) {
  const mode = normalizeAttestationMode(process.env.WINDSURFAPI_UPDATE_ATTESTATION);
  let repository = '';
  try {
    const originUrl = (await runGit(['remote', 'get-url', 'origin'])).trim();
    const parsed = parseGitHubRepository(originUrl);
    if (parsed && parsed.toLowerCase() === DEFAULT_ATTESTATION_REPOSITORY.toLowerCase()) {
      repository = DEFAULT_ATTESTATION_REPOSITORY;
    }
  } catch {
    // A missing/unreadable origin is not a policy failure by itself: without a
    // canonical repository there is no attestation to download, and the mode
    // decides whether that absence is fatal (required) or a warning (warn).
    repository = '';
  }

  const options = {
    tag: release.name,
    commit: release.commit,
    mode,
    dir: process.env.WINDSURFAPI_ATTESTATION_DIR || '',
    repository,
  };
  const result = releaseAttestationVerifierForTest
    ? await releaseAttestationVerifierForTest(options)
    : await verifyReleaseAttestation(options);
  if (result?.warning) log.warn(`self-update attestation: ${result.warning}`);
  return result;
}

function safeUpdateBranch(branch) {
  const candidate = String(branch || '').trim();
  // `git rev-parse --abbrev-ref HEAD` returns the literal "HEAD" for a
  // detached checkout, which is normal for tag-based deployments. origin/HEAD
  // is not guaranteed to exist locally, so use this repository's canonical
  // release branch instead.
  return candidate !== 'HEAD' && /^[\w.\-\/]+$/.test(candidate) ? candidate : 'master';
}

async function releaseUpdateState(branch, currentCommit, { followUnreleased = false } = {}) {
  const remoteRef = `origin/${branch}`;
  const remoteHead = (await runGit(['rev-parse', remoteRef])).trim();
  const release = await latestReleaseTag(branch);
  const latestTag = release.name;
  if (!latestTag && !followUnreleased) {
    throw makeSelfUpdateError(
      NO_RELEASE_TAG,
      'No stable release tag is reachable from the update branch; use forceUpdate only if you intentionally want the branch head.',
    );
  }
  // D9: bind the selected release tag's peeled commit to the signed release
  // attestation before `releasedCommit` can become a mutation target.
  if (latestTag) await verifySelectedReleaseAttestation(release);
  const releasedCommit = release.commit;
  const targetCommit = followUnreleased ? remoteHead : releasedCommit;

  let unreleasedCount = 0;
  if (latestTag) {
    unreleasedCount = parseGitNonnegativeCount(await runGit([
      'rev-list', '--count', `${releasedCommit}..${remoteHead}`,
    ]), 'commits after the latest release');
  }

  const commitsToTarget = parseGitNonnegativeCount(await runGit([
    'rev-list', '--count', `${currentCommit}..${targetCommit}`,
  ]), 'commits from the current checkout to the update target');
  const commitsPastTarget = parseGitNonnegativeCount(await runGit([
    'rev-list', '--count', `${targetCommit}..${currentCommit}`,
  ]), 'commits past the update target');

  return {
    remoteHead,
    latestTag,
    releasedCommit,
    targetCommit,
    unreleasedCount,
    commitsToTarget,
    commitsPastTarget,
    updateAvailable: commitsToTarget > 0 && commitsPastTarget === 0,
    diverged: commitsToTarget > 0 && commitsPastTarget > 0,
  };
}

async function gitStatus() {
  const commit = (await runGit(['rev-parse', 'HEAD'])).trim();
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  let update = null;
  let updateError = '';
  try {
    const safeBranch = safeUpdateBranch(branch);
    await runGit(['fetch', '--quiet', '--no-tags', 'origin', safeBranch]);
    update = await releaseUpdateState(safeBranch, commit);
  } catch (err) {
    if (isSelfUpdateUnavailableError(err)) throw err;
    updateError = err?.code || err?.message || 'ERR_UPDATE_CHECK_FAILED';
  }
  const localMsg = (await runGit(['log', '-1', '--pretty=format:%s'])).trim();
  const target = update?.targetCommit || '';
  const remoteMsg = update?.updateAvailable
    ? (await runGit(['log', '-1', '--pretty=format:%s', target]).catch(() => '')).trim()
    : '';
  return {
    commit: commit.slice(0, 7),
    commitFull: commit,
    branch,
    localMessage: localMsg,
    // "remote" in the dashboard means the safe OTA target: latest release
    // tag by default. remoteHeadCommit is diagnostic only and may contain
    // release notes/generated assets/next-release work after that tag.
    remoteCommit: target ? target.slice(0, 7) : '',
    remoteHeadCommit: update?.remoteHead ? update.remoteHead.slice(0, 7) : '',
    remoteMessage: remoteMsg,
    behind: !!update?.updateAvailable,
    diverged: !!update?.diverged,
    latestTag: update?.latestTag || '',
    published: !!update?.latestTag,
    updateError,
    unreleasedCount: update?.unreleasedCount || 0,
  };
}

// Exported (and timeout-parameterised) so the RATE-RISK red→green test can pin
// the TLS-stage deadline in ms instead of waiting out the 10s default; the
// dashboard route below calls it with the default.
export async function testProxy({ host, port, username, password, type }, tlsTimeoutMs = 10_000) {
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
      // R-5 (RATE-RETRY audit): the CONNECT stage has a 10s timer, but the TLS
      // stage had none — a target that completes the tunnel and then goes
      // silent left this promise pending forever (the dashboard button spun).
      // destroy() alone emits no 'error' on a raw socket, so settle explicitly.
      tlsSock.setTimeout(tlsTimeoutMs, () => {
        tlsSock.destroy();
        reject(new Error('ERR_TIMEOUT'));
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
