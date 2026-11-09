/**
 * OpenAI-compatible HTTP server with multi-account management.
 *
 *   POST /v1/chat/completions       — chat completions
 *   POST /v1/completions            — OpenAI legacy completions
 *   POST /v1/responses              - OpenAI Responses API
 *   GET  /v1/models                 — list models
 *   POST /auth/login                — add account (email+password / token / api_key)
 *   GET  /auth/accounts             — list all accounts
 *   DELETE /auth/accounts/:id       — remove account
 *   GET  /auth/status               — pool status summary
 *   GET  /health                    — health check
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  validateApiKey, isAuthenticated, getAccountList, getAccountCount,
  addAccountByEmail, addAccountByPastedSecret, removeAccount,
  configureBindHost, emitNoAuthWarnings, getDroughtSummary, ensureLsForAccount,
  checkLockout, failedAuthAttempt, successfulAuthAttempt,
} from './auth.js';
import { trustedClientIp } from './net-safety.js';
import { handleChatCompletions, normalizeOpenAIErrorBody, normalizeOpenAIErrorType } from './handlers/chat.js';
import { handleCompletions } from './handlers/completions.js';
import { handleMessages, handleCountTokens, validateMessagesRequest, validateCountTokensRequest, toAnthropicError } from './handlers/messages.js';
import { handleGemini, parseGeminiPath, geminiError } from './handlers/gemini.js';
import { handleResponses, handleGetResponse, handleDeleteResponse } from './handlers/responses.js';
import { handleModels } from './handlers/models.js';
import { createDeferredSseResponse } from './sse-commit.js';
import { createRequestBudget } from './request-budget.js';
import { resolveClineCompat, stripClineNamespace } from './handlers/cline-compat.js';
import { resolveCcCompat, stripCcNamespace } from './handlers/cc-compat.js';
import { isExperimentalEnabled, getBackendSwitch } from './runtime-config.js';
import { resolveModel, getModelInfo } from './models.js';
import { handleDashboardApi, preflightDashboardRequest, parseProxyUrl, validateProxyHost, verifyAdminRequest, validateDashboardRequestHost } from './dashboard/api.js';
import { recordRequest, updateRequest } from './dashboard/request-ring.js';
import { withStatsScope, finalizeStatsScope } from './dashboard/stats.js';
import { setAccountProxy } from './dashboard/proxy-config.js';
import { config, log } from './config.js';
import { getVersionInfo } from './version.js';
import { callerKeyFromRequest } from './caller-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const VERSION_INFO = getVersionInfo();

// 10 MB is way above any realistic chat-completions payload while still
// bounding worst-case memory from a malicious/broken client.
export const MAX_BODY_SIZE = 10 * 1024 * 1024;

// G1: Anthropic 官方要求客户端发 `anthropic-version` 请求头(如 2023-06-01)。
// 作为兼容代理我们取宽容路线:缺失不返 400,而是 warn + 回退默认版本(理由见
// SPEC-G1);未知版本也不硬失败(向前兼容),原样接受并回写。当前翻译层不因版本
// 分叉,故解析结果仅用于回写响应头 + 诊断日志。
const ANTHROPIC_DEFAULT_VERSION = '2023-06-01';
const ANTHROPIC_KNOWN_VERSIONS = new Set(['2023-06-01', '2023-01-01']);

// Single-token DEVIN_CONNECT deploys (DEVIN_CONNECT_TOKEN / WINDSURF_API_KEY)
// intentionally keep the account pool empty: the connect client falls back to
// the env token when `acct` is null. The HTTP prechecks below must therefore
// accept that deploy shape too, or every chat route 503s before the handler
// that knows how to use the token is reached.
function hasUsableAccount() {
  if (isAuthenticated()) return true;
  return getBackendSwitch('devinConnect')
    && !!(process.env.DEVIN_CONNECT_TOKEN || process.env.WINDSURF_API_KEY);
}

// 读取并归一 anthropic-version 请求头。返回生效版本字符串(缺失→默认)。
// Node 已把头名小写化,直接取 req.headers['anthropic-version']。
export function resolveAnthropicVersion(req) {
  const raw = req && req.headers ? String(req.headers['anthropic-version'] || '').trim() : '';
  if (!raw) {
    log.warn('anthropic-version header missing; defaulting to ' + ANTHROPIC_DEFAULT_VERSION);
    return ANTHROPIC_DEFAULT_VERSION;
  }
  if (!ANTHROPIC_KNOWN_VERSIONS.has(raw)) {
    // 向前兼容:未知/未来版本不拒绝,原样透传。
    log.warn('anthropic-version unrecognized: ' + raw.slice(0, 40) + ' (accepting as-is)');
  }
  return raw;
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      try { req.resume?.(); } catch {}
      reject(err);
    };
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        fail(Object.assign(new Error('Request body too large'), {
          statusCode: 413,
          code: 'ERR_REQUEST_BODY_TOO_LARGE',
        }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', fail);
  });
}

export function bodyTooLargePayload(style = 'openai') {
  if (style === 'dashboard') {
    return { ok: false, error: 'ERR_REQUEST_BODY_TOO_LARGE', message: 'Request body too large' };
  }
  if (style === 'legacy') {
    return { error: 'Request body too large' };
  }
  if (style === 'anthropic') {
    // D1: 413 maps to the dedicated request_too_large type (not
    // invalid_request_error), aligning with toAnthropicError(413).
    return { type: 'error', error: { type: 'request_too_large', message: 'Request body too large' } };
  }
  return { error: { message: 'Request body too large', type: 'invalid_request_error' } };
}

function sendBodyTooLargeIfNeeded(res, err, style = 'openai') {
  if (err?.statusCode !== 413 && err?.code !== 'ERR_REQUEST_BODY_TOO_LARGE') return false;
  json(res, 413, bodyTooLargePayload(style));
  return true;
}

// ─── Inbound Content-Encoding refusal (Q2 T04) ─────────────────────────────
//
// readBody() hands the raw bytes to JSON.parse as UTF-8; it has never
// decompressed anything. A compressed body therefore always ended as a
// confusing "Invalid JSON" 400 — and any future attempt to "fix" that by
// inflating the body would hand an attacker a gzip bomb (a few KB on the wire,
// gigabytes in memory). Refuse the encoding explicitly, BEFORE the body is
// read, and never decompress: the caller must resend uncompressed.
//
// The check keys on the header alone, so it also fires for a chunked request
// with no Content-Length (nothing about the body's declared size is trusted).
const SUPPORTED_CONTENT_ENCODINGS = new Set(['', 'identity']);

/** The unsupported Content-Encoding value on a request, or '' when usable. */
export function unsupportedContentEncoding(req) {
  const raw = String(req?.headers?.['content-encoding'] ?? '').trim();
  if (!raw) return '';
  return SUPPORTED_CONTENT_ENCODINGS.has(raw.toLowerCase()) ? '' : raw;
}

export function unsupportedContentEncodingPayload(encoding, style = 'openai') {
  const message = `Content-Encoding "${encoding}" is not supported. Send the request body uncompressed `
    + '(omit Content-Encoding, or send Content-Encoding: identity). This proxy does not decompress request bodies.';
  if (style === 'dashboard') {
    return { ok: false, error: 'unsupported_content_encoding', message };
  }
  if (style === 'legacy') {
    return { error: message, code: 'unsupported_content_encoding' };
  }
  if (style === 'anthropic') {
    return { type: 'error', error: { type: 'unsupported_content_encoding', message } };
  }
  if (style === 'gemini') {
    // Gemini's envelope needs a numeric code + status enum; the shared typed
    // string rides as `type` for clients that branch on it (unknown fields are
    // ignored by the Google SDKs).
    return { error: { code: 415, message, status: 'INVALID_ARGUMENT', type: 'unsupported_content_encoding' } };
  }
  return { error: { message, type: 'unsupported_content_encoding' } };
}

function rejectUnsupportedContentEncoding(req, res, style = 'openai') {
  const encoding = unsupportedContentEncoding(req);
  if (!encoding) return false;
  json(res, 415, unsupportedContentEncodingPayload(encoding, style));
  return true;
}

function contentEncodingErrorStyle(path) {
  if (isAnthropicPath(path)) return 'anthropic';
  if (typeof path === 'string'
      && (path === '/v1beta' || path.startsWith('/v1beta/')
        || /\/models\/[^:/]+:(generateContent|streamGenerateContent)$/.test(path))) return 'gemini';
  if (typeof path === 'string' && path.startsWith('/auth/')) return 'legacy';
  return 'openai';
}

/**
 * Bind an AbortController to the HTTP response so a client hang-up mid-await
 * tears down the in-flight upstream call.
 *
 * Stream translators (messages/gemini/responses) already abort via
 * captureRes._clientDisconnected. Chat and completions already bound this at
 * the route. The non-stream await on messages / gemini / responses did not —
 * hanging up left the upstream running (the same partial-path class as
 * Retry-After / include_usage). Guard on !writableEnded so a normal end is a
 * no-op.
 */
export function bindClientAbort(res) {
  const abortController = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abortController.abort(); });
  return abortController;
}

// ─── Credential carriers are SURFACE-scoped (Q2 T03) ───────────────────────
//
// Every accepted carrier used to authenticate every route: a Gemini query key
// (`?key=`) or `x-goog-api-key` opened /v1/chat/completions, and `x-api-key`
// opened any route. That let a credential minted for one protocol be replayed
// against another (and put a chat POST's key in the URL, where proxies log it).
// The carriers are now matched to the surface that actually defines them:
//
//   openai   : Authorization: Bearer only            (chat/completions/responses)
//   messages : Bearer + x-api-key                    (Anthropic SDK shape)
//   models   : Bearer + x-api-key + x-goog-api-key + ?key
//   gemini   : Bearer + x-goog-api-key + ?key        (Google GenAI SDK shape)
//   operator : Bearer + x-api-key                    (/auth/* — unchanged operator flow)
//   any      : every carrier                          (direct callers + /health)
//
// `any` is the default so a pure-function caller that does not know a route is
// not silently narrowed; the router always passes the surface explicitly.
const CREDENTIAL_CARRIERS = {
  openai: ['bearer'],
  messages: ['bearer', 'x-api-key'],
  models: ['bearer', 'x-api-key', 'x-goog-api-key', 'query'],
  gemini: ['bearer', 'x-goog-api-key', 'query'],
  operator: ['bearer', 'x-api-key'],
  any: ['bearer', 'x-api-key', 'x-goog-api-key', 'query'],
};

/**
 * Which carrier set applies to a request path. Operator surfaces (/auth/*) and
 * /health keep their historical carriers: the audit's scoping rule is about the
 * protocol API surfaces, and narrowing operator auth would break the documented
 * account-management flow.
 */
export function credentialSurfaceFor(path) {
  const p = typeof path === 'string' ? path : '';
  if (p === '/v1/messages' || p.startsWith('/v1/messages/')) return 'messages';
  // A generate call is Gemini-native even when it rides the /v1/models alias:
  // `/v1/models/{model}:generateContent` must use the Gemini carrier set, not
  // the looser `models` set, or x-api-key (an Anthropic carrier) would reach
  // handleGemini through the alias while /v1beta rejects it. Checked BEFORE the
  // `/v1/models/` prefix for exactly that reason.
  if (/\/models\/[^:/]+:(generateContent|streamGenerateContent)$/.test(p)) return 'gemini';
  if (p === '/v1/models' || p.startsWith('/v1/models/')) return 'models';
  if (p === '/v1beta' || p.startsWith('/v1beta/')) return 'gemini';
  if (p === '/health' || p === '/auth' || p.startsWith('/auth/')) return 'operator';
  return 'openai';
}

export function extractToken(req, surface = 'any') {
  const carriers = CREDENTIAL_CARRIERS[surface] || CREDENTIAL_CARRIERS.any;
  const allows = (carrier) => carriers.includes(carrier);
  // Anthropic SDK + OAI SDK compatibility: accept either header.
  const authHeader = String(req.headers['authorization'] || '').trim();
  // TOK-3 (audit P3): a comma used to blanket-clear the token — so a caller
  // sending `Authorization: Bearer my,key` (or a duplicate header Node joined
  // as `Bearer a, Bearer b`) was rejected AND the x-api-key fallback was
  // skipped, 401ing even when a correct x-api-key was present. Instead, parse
  // the Bearer credential and take only its FIRST comma-delimited segment: a
  // duplicate/injected `Bearer a, Bearer b` can't smuggle a second credential,
  // a stray comma no longer nukes auth, and — because we fall through when the
  // Bearer segment is empty — x-api-key still works.
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const first = m[1].split(',')[0].trim();
    if (first) return first;
  }
  if (allows('x-api-key')) {
    const xApiKey = req.headers['x-api-key'] || '';
    if (xApiKey) return xApiKey;
  }
  // Gemini-native auth: the Google GenAI SDK sends the key as `x-goog-api-key`
  // or a `?key=` query param, not Bearer/x-api-key. Accept both only where a
  // Gemini client can legitimately send them.
  if (allows('x-goog-api-key')) {
    const xGoog = String(req.headers['x-goog-api-key'] || '').trim();
    if (xGoog) return xGoog;
  }
  if (allows('query')) {
    try {
      const qKey = new URL(req.url, 'http://localhost').searchParams.get('key');
      if (qKey) return qKey.trim();
    } catch { /* malformed url → no query key */ }
  }
  return '';
}

function nativeBridgeCallerKeyForRequest(req, token, body, callerKey = '') {
  const key = callerKey || callerKeyFromRequest(req, token, body);
  const tokenAllowlist = String(process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!tokenAllowlist.length) return key;
  return tokenAllowlist.includes(String(token || '').trim()) ? `${key}:api_key_allowed` : key;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // Per-request dynamic responses must not be cached by intermediaries.
    // Some upstream aggregators (e.g. sub2api, #97) priority-cache responses
    // when they don't see an explicit Cache-Control directive and serve
    // stale content for fresh requests.
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

// F4: inject a top-level request_id into ERROR bodies only (status >= 400),
// reusing the exact value already emitted in the x-request-id/request-id
// header so a client can log/correlate the same id from either place. OpenAI
// and Anthropic both carry request_id in their error envelopes; success bodies
// stay header-only (both APIs omit it from success payloads). Non-object bodies
// pass through untouched, and an existing request_id is never clobbered.
export function withRequestId(status, body, requestId) {
  if (status < 400) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (body.request_id != null) return body;
  return { ...body, request_id: requestId };
}

function anthropicModelPayload(id, info) {
  return {
    type: 'model',
    id: info?.name || id,
    display_name: info?.name || id,
    created_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * Serve an OpenAI chat stream through the commit gate.
 *
 * Exported so the route wiring itself (not just the wrapper) can be tested:
 * `commitMs === 0` must restore the legacy raw-res shape, otherwise the gate
 * buffers the first frames and can rewrite a pre-content error.
 */
export function resolveStreamCommitMs(raw = process.env.WINDSURFAPI_STREAM_COMMIT_MS) {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 14_000) : undefined;
}

// O10: classify a failed stream with the same failure class the non-stream
// error rows carry (`result.body.error.code` — the DEVIN_CONNECT
// classification: RATE_LIMITED, CAPACITY, ...). Gemini's error envelope puts
// the HTTP-ish numeric status in `code` and the class in `__upstream_code`, so
// a string `code` wins and the generic 'error' is the fallback the non-stream
// expression already uses when no class survives.
function streamFailureClass(error) {
  if (!error || typeof error !== 'object') return 'error';
  if (typeof error.code === 'string' && error.code) return error.code;
  if (typeof error.__upstream_code === 'string' && error.__upstream_code) return error.__upstream_code;
  return 'error';
}

// O10: the streaming routes patch their ring row once the handler settles. A
// stream that fails after the commit gate still ends as HTTP 200, so `status`
// alone cannot classify it — the failure the gate observed supplies the class.
function streamRingDone(ringRow, reqStartedAt, res) {
  return (stream) => updateRequest(ringRow.id, {
    durationMs: Date.now() - reqStartedAt,
    status: res.statusCode,
    ...(stream?.failure ? { class: streamFailureClass(stream.failure) } : {}),
  });
}

export async function serveChatStream(res, result, {
  headers,
  requestId,
  commitMs,
  onDone = null,
  protocol = 'openai',
  isBootstrap = null,
  parseError = null,
  errorBody = null,
  mapError = null,
} = {}) {
  // Gemini's default response is a JSON array, not SSE. It cannot be parsed by
  // the deferred SSE gate, so forward it immediately (the gate would hold the
  // entire answer until upstream completion or the bootstrap cap).
  if (result.mode === 'array') {
    if (!res.headersSent) res.writeHead(result.status || 200, headers);
    try {
      await result.handler(res);
    } finally {
      onDone?.();
    }
    return;
  }
  if (commitMs === 0) {
    if (!res.headersSent) res.writeHead(result.status, headers);
    try {
      await result.handler(res);
    } finally {
      onDone?.();
    }
    return;
  }
  const streamRes = createDeferredSseResponse(res, {
    status: result.status,
    headers,
    protocol,
    requestId,
    bootstrapTimeoutMs: commitMs,
    ...(isBootstrap ? { isBootstrap } : {}),
    ...(parseError ? { parseError } : {}),
    ...(errorBody ? { errorBody } : {}),
    ...(mapError ? { mapError } : {}),
  });
  try {
    await result.handler(streamRes);
  } finally {
    streamRes.dispose();
    // A handler that throws after committing must not leave the socket open.
    if (res.headersSent && !res.writableEnded) res.end();
    onDone?.({ failure: streamRes.failure });
  }
}

async function route(req, res) {
  const { method } = req;
  let path = req.url.split('?')[0];
  // Tolerate a doubled `/v1/v1/` prefix some clients emit.
  if (path.startsWith('/v1/v1/')) path = path.slice(3);

  // Fallback request id for every exit that never reaches a route handler.
  //
  // Measured 2026-09-13 (L8 smoke lane): each route generated its own id and set its
  // own header, so the auth gate (`:412`), every 404 fallback (`:378`, `:397`, `:469`)
  // and the Gemini branch answered with NO request id. An operator holding only the
  // client-side error text could not match it to a log line. The per-route sites keep
  // their own ids (they override this header via writeHead) — this only guarantees the
  // pre-dispatch paths are never id-less. `x-request-id` is the vendor-neutral name the
  // other routes already emit; Anthropic's own `request-id` header still wins where set.
  const fallbackRequestId = 'req_' + randomUUID();
  res.setHeader('x-request-id', fallbackRequestId);

  // Cline compatibility layer resolution (see src/handlers/cline-compat.js).
  // The dedicated /v1/cline/* namespace is an explicit opt-in that a partner
  // points Cline at, so it activates the compat shims regardless of the master
  // toggle; we rewrite it to the canonical /v1/* path so every existing route
  // match below works unchanged. On the standard path, the shims only engage
  // when the master experimental.clineCompat toggle is on AND the request looks
  // like Cline. When inactive, clineCompat.active is false and the whole
  // pipeline stays byte-identical for every other client.
  const clineCompat = resolveClineCompat({
    path,
    headers: req.headers,
    masterEnabled: isExperimentalEnabled('clineCompat'),
  });
  if (clineCompat.source === 'endpoint') path = stripClineNamespace(path);

  // Claude Code compatibility layer resolution (see src/handlers/cc-compat.js).
  // Same two-source contract as Cline: the dedicated /v1/cc/* namespace activates
  // the CC shims regardless of the master toggle (rewritten to canonical /v1/* so
  // every route below matches unchanged); on the standard path the shims engage
  // only when experimental.ccCompat is on AND the request looks like Claude Code.
  // Unlike Cline, CC defaults to the Anthropic protocol, so ccCompat is threaded
  // into the messages/responses handlers below, not only the chat one. When
  // inactive, ccCompat.active is false and the whole pipeline is byte-identical.
  const ccCompat = resolveCcCompat({
    path,
    headers: req.headers,
    masterEnabled: isExperimentalEnabled('ccCompat'),
  });
  if (ccCompat.source === 'endpoint') path = stripCcNamespace(path);

  if (method === 'OPTIONS' && !path.startsWith('/dashboard/api/')) {
    // Public API (/v1/*) preflight: blanket `*`, no credentials — correct for an
    // open, key-authenticated API. Dashboard-API preflights are deliberately
    // excluded so they fall through to handleDashboardApi, whose OPTIONS handler
    // answers through the DASHBOARD_CORS_ORIGINS allowlist (matching the actual
    // dashboard responses instead of a blanket `*`). #9.
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    });
    return res.end();
  }
  if (path === '/health') {
    const counts = getAccountCount();
    const body = {
      status: 'ok',
      provider: 'WindsurfAPI bydwgx1337',
      version: VERSION_INFO.version,
      commit: VERSION_INFO.commit,
      commitMessage: VERSION_INFO.commitMessage,
      commitDate: VERSION_INFO.commitDate,
      branch: VERSION_INFO.branch,
      buildSource: VERSION_INFO.source,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      accounts: counts,
    };
    const qs = new URL(req.url, 'http://localhost').searchParams;
    if (qs.get('verbose') === '1' && validateApiKey(extractToken(req, 'operator'))) {
      try {
        const { poolStats } = await import('./conversation-pool.js');
        const { cacheStats } = await import('./cache.js');
        const { getLsStatus } = await import('./langserver.js');
        const { getSpecialAgentStatus } = await import('./special-agent.js');
        const { getNativeBridgeStats } = await import('./native-bridge-stats.js');
        const { getNativeBridgeConfigStatus } = await import('./cascade-native-bridge.js');
        body.conversationPool = poolStats();
        body.cache = cacheStats();
        body.lsPool = getLsStatus();
        body.specialAgent = getSpecialAgentStatus();
        body.nativeBridge = getNativeBridgeStats();
        body.nativeBridgeConfig = getNativeBridgeConfigStatus();
        // v2.0.57 Fix 5 — drought summary so monitoring can page on
        // "all accounts < 5% weekly" without screen-scraping per-account
        // credit dumps.
        body.drought = getDroughtSummary();
      } catch {}
    }
    return json(res, 200, body);
  }

  // ─── Dashboard ─────────────────────────────────────────
  if (path === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  if (path === '/dashboard' || path === '/dashboard/') {
    try {
      // Cookie-based skin selection. `dashboard_skin=sketch` serves the
      // experimental hand-drawn console; anything else (or no cookie)
      // serves the default UI. Each UI sets/unsets the cookie via its own
      // settings toggle, then reloads — server picks the right file based
      // on the next request's cookie. Vary: Cookie keeps intermediaries
      // from poisoning one user's skin onto another.
      const cookie = String(req.headers.cookie || '');
      const m = cookie.match(/(?:^|;\s*)dashboard_skin=([^;]+)/);
      const skin = m ? decodeURIComponent(m[1]) : '';
      const file = skin === 'sketch' ? 'index-sketch.html' : 'index.html';
      const html = readFileSync(join(__dirname, 'dashboard', file));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Vary': 'Cookie',
        'Cache-Control': 'no-cache',
      });
      return res.end(html);
    } catch {
      return json(res, 500, { error: 'Dashboard not found' });
    }
  }

  if (path.startsWith('/dashboard/api/')) {
    const subpath = path.slice('/dashboard/api'.length);
    // S03/G05: run the Host/mutation/lockout/auth gate BEFORE reading the
    // body. Previously the whole (up to MAX_BODY_SIZE) body was buffered and
    // JSON-parsed before handleDashboardApi's gate ran, so an unauthenticated
    // caller could force 10 MiB of work per request. handleDashboardApi skips
    // its copy of the gate when this preflight already passed; direct callers
    // (unit tests, in-process handlers) still get it there.
    if (!preflightDashboardRequest(method, subpath, req, res)) return;
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      if (rejectUnsupportedContentEncoding(req, res, 'dashboard')) return;
      let raw;
      try {
        raw = await readBody(req);
      } catch (err) {
        if (sendBodyTooLargeIfNeeded(res, err, 'dashboard')) return;
        return json(res, 400, { ok: false, error: 'Invalid JSON' });
      }
      // An empty body is a valid "no payload" POST (e.g. /self-update,
      // account status toggles) — treat it as {} instead of feeding
      // JSON.parse('') which throws and surfaced as a bogus "Invalid JSON"
      // on the dashboard's Update button (#self-update).
      const trimmed = String(raw ?? '').trim();
      if (trimmed) {
        try { body = JSON.parse(trimmed); } catch {
          return json(res, 400, { ok: false, error: 'Invalid JSON' });
        }
      }
    }
    return handleDashboardApi(method, subpath, body, req, res);
  }

  // ─── Dashboard i18n locale files ────────────────────────
  if (path.startsWith('/dashboard/i18n/')) {
    try {
      const localeFile = path.slice('/dashboard/i18n/'.length);
      // Security: only allow .json files with alphanumeric/hyphen names
      if (!localeFile.match(/^[a-zA-Z0-9\-]+\.json$/)) {
        return json(res, 400, { error: 'Invalid locale file' });
      }
      const filePath = join(__dirname, 'dashboard', 'i18n', localeFile);
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(content);
    } catch {
      return json(res, 404, withRequestId(404, { error: 'Locale file not found' }, fallbackRequestId));
    }
  }

  // ─── Dashboard data files (contributors, etc.) ──────────
  // Same shape as i18n: tight regex on the basename, served as JSON.
  // Used by both default and sketch UIs as the single source of truth
  // for hand-maintained roster data so the two skins stay in sync.
  if (path.startsWith('/dashboard/data/')) {
    try {
      const dataFile = path.slice('/dashboard/data/'.length);
      if (!dataFile.match(/^[a-zA-Z0-9\-]+\.json$/)) {
        return json(res, 400, { error: 'Invalid data file' });
      }
      const filePath = join(__dirname, 'dashboard', 'data', dataFile);
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(content);
    } catch {
      return json(res, 404, withRequestId(404, { error: 'Data file not found' }, fallbackRequestId));
    }
  }

  // ─── API endpoints (require API key) ────────────────────

  // D1 (audit2/Server.md S02): `/auth/*` is an operator surface. In the
  // documented open-local mode verifyAdminRequest authenticates purely from
  // the loopback socket, which a DNS-rebinding page also satisfies — so a
  // rebinding Host could list/add/delete pool accounts. Apply the same
  // Host/X-Forwarded-Host boundary as `/dashboard/api/*` BEFORE the API-key
  // gate, the brute-force counters, or any body read: a rejected Host has no
  // account delta and cannot spend auth attempts.
  if (path === '/auth' || path.startsWith('/auth/')) {
    if (!validateDashboardRequestHost(req, res)) return;
  }

  const credentialSurface = credentialSurfaceFor(path);
  const presentedToken = extractToken(req, credentialSurface);
  if (!validateApiKey(presentedToken)) {
    // v2.0.61 (#110): clearer error so operators know the issue is
    // configuration (no API_KEY set on a public-bind instance) rather
    // than a bad client header. The chat client side rarely shows a
    // verbose error so we cram the diagnosis into the message itself.
    const tokenSent = !!presentedToken;
    // Name only the carriers this surface actually accepts (T03). Telling a chat
    // caller to retry with x-api-key — which the same gate now rejects there —
    // would send them in a loop.
    const carrierHint = credentialSurface === 'gemini'
      ? '`Authorization: Bearer <key>`, `x-goog-api-key: <key>` or `?key=<key>`'
      : credentialSurface === 'models'
        ? '`Authorization: Bearer <key>`, `x-api-key: <key>`, `x-goog-api-key: <key>` or `?key=<key>`'
        : credentialSurface === 'messages' || credentialSurface === 'operator'
          ? '`Authorization: Bearer <key>` or `x-api-key: <key>`'
          : '`Authorization: Bearer <key>`';
    const message = tokenSent
      ? 'Invalid API key. Either the key is wrong, or the server has API_KEY configured to a different value than the one your client sent.'
      : `Missing API key. This server runs in fail-closed mode: requests must include ${carrierHint} matching the configured API_KEY env var. If you intend to run open (no auth), bind the server to localhost (HOST=127.0.0.1).`;
    // Q2 T02: the Anthropic SDK parses ONLY the Anthropic error envelope and
    // reads the request id from the `request-id` header. The shared gate used to
    // answer every family with the OpenAI {error:{type:'auth_error'}} body and
    // no Anthropic header, so a Claude client saw an unparseable 401. Keep the
    // OpenAI (and Gemini, which reuses it here) shape byte-identical.
    if (isAnthropicPath(path)) {
      res.setHeader('request-id', fallbackRequestId);
      return json(res, 401, withRequestId(401, {
        type: 'error',
        error: { type: 'authentication_error', message },
      }, fallbackRequestId));
    }
    return json(res, 401, withRequestId(401, { error: { message, type: 'auth_error' } }, fallbackRequestId));
  }

  // Q2 T04: refuse a compressed request body before any route reads it. The
  // check sits after the credential wall (an unauthenticated caller still gets
  // the 401 it earned) and before every no-account/route guard, so the answer
  // does not depend on pool state.
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH')
      && rejectUnsupportedContentEncoding(req, res, contentEncodingErrorStyle(path))) return;

  // ─── Auth management (admin — gated by API key above) ──

  if (path === '/auth/status') {
    // Chat-key-visible summary: authenticated + counts only, NO email list.
    // (Grok H1: listing/adding/deleting accounts requires operator auth below.)
    return json(res, 200, { authenticated: isAuthenticated(), ...getAccountCount() });
  }

  // H1 (Grok audit): account-pool management (list emails / add / delete) is an
  // OPERATOR action, not a chat action. A shared chat API key must NOT let any
  // caller run the pool. These endpoints now require dashboard-operator auth
  // (dashboard password, or the opt-in localhost apiKey fallback) IN ADDITION to
  // having passed the chat-key gate above. A bare chat key → 403.
  const isAccountMgmt = path === '/auth/accounts'
    || path.startsWith('/auth/accounts/')
    || (path === '/auth/login' && method === 'POST');
  if (isAccountMgmt) {
    // H-2 (ultracode audit 2026-07-13): these admin endpoints share the same
    // operator credential as /dashboard/api/* but previously had NO brute-force
    // lockout — an attacker holding a chat key could online-guess the operator
    // password here unlimited times, while the same guessing on /dashboard/api/*
    // gets banned after 5 tries. Wire the SAME lockout (same client-IP bucket,
    // trustedClientIp) so the two endpoints can't be played against each other.
    const clientIp = trustedClientIp(req);
    const lock = checkLockout(clientIp);
    if (lock.blocked) {
      res.setHeader?.('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)));
      return json(res, 429, { error: {
        message: `Too many failed operator-auth attempts. IP banned for ${Math.ceil(lock.retryAfterMs / 1000)}s.`,
        type: 'auth_error', code: 'locked_out',
      } });
    }
    if (!verifyAdminRequest(req)) {
      // Only count a real guess (non-empty password) toward the lockout, mirroring
      // dashboard/api.js — an empty header is the normal "no creds" case.
      if (String(req.headers['x-dashboard-password'] || '')) failedAuthAttempt(clientIp);
      return json(res, 403, { error: {
        message: 'Account-pool management (list/add/delete accounts) requires operator authentication. Send the dashboard password via the `x-dashboard-password` header (set DASHBOARD_PASSWORD, or use the dashboard UI). A chat API key alone is not sufficient.',
        type: 'auth_error',
        code: 'admin_required',
      } });
    }
    // Authenticated operator — clear any failed-attempt streak for this IP.
    successfulAuthAttempt(clientIp);
  }

  if (path === '/auth/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  // DELETE /auth/accounts/:id
  if (path.startsWith('/auth/accounts/') && method === 'DELETE') {
    const id = path.split('/')[3];
    const ok = removeAccount(id);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  if (path === '/auth/login' && method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'legacy')) return;
      return json(res, 400, { error: 'Invalid JSON' });
    }

    try {
      // ── bind proxy to account ──────────────────────
      async function parseAndValidateAccountProxy(proxyStr) {
        if (!proxyStr) return null;
        const parsed = parseProxyUrl(proxyStr);
        if (!parsed) {
          log.warn(`auth/login: ignoring invalid proxy format: ${String(proxyStr).slice(0, 80)}`);
          return null;
        }
        await validateProxyHost(parsed);
        return parsed;
      }

      function bindAccountProxy(accountId, parsedProxy) {
        if (parsedProxy) {
          setAccountProxy(accountId, parsedProxy);
          if (process.env.LS_PREWARM_ON_ACCOUNT_ADD === '1' || process.env.LS_PREWARM_PROXIES === '1') {
            ensureLsForAccount(accountId).then(r => {
              if (r && !r.ok) log.warn(`LS ensure skipped/failed: ${r.errorType || r.error}`);
            }).catch(e => log.warn(`LS ensure failed: ${e.message}`));
          }
        }
      }

      // Support batch: { accounts: [{token,proxy}, ...] }
      if (Array.isArray(body.accounts)) {
        const results = [];
        for (const acct of body.accounts) {
          try {
            const parsedProxy = await parseAndValidateAccountProxy(acct.proxy);
            let result;
            if (acct.api_key) {
              result = await addAccountByPastedSecret(acct.api_key, acct.label, '', { unknownAsKey: true });
            } else if (acct.token) {
              result = await addAccountByPastedSecret(acct.token, acct.label);
            } else if (acct.email && acct.password) {
              result = await addAccountByEmail(acct.email, acct.password);
            } else {
              results.push({ error: 'Missing credentials' });
              continue;
            }
            bindAccountProxy(result.id, parsedProxy);
            results.push({ id: result.id, email: result.email, status: result.status });
          } catch (err) {
            results.push({ email: acct.email, error: err.message });
          }
        }
        return json(res, 200, { results, ...getAccountCount() });
      }

      // Single account
      const parsedProxy = await parseAndValidateAccountProxy(body.proxy);
      let account;
      if (body.api_key) {
        account = await addAccountByPastedSecret(body.api_key, body.label, '', { unknownAsKey: true });
      } else if (body.token) {
        account = await addAccountByPastedSecret(body.token, body.label);
      } else if (body.email && body.password) {
        account = await addAccountByEmail(body.email, body.password);
      } else {
        return json(res, 400, { error: 'Provide api_key, token, or email+password' });
      }

      bindAccountProxy(account.id, parsedProxy);

      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      log.error('Login failed:', err.message);
      const status = /^ERR_PROXY_/i.test(err.message || '') ? 400 : 401;
      return json(res, status, { error: err.message });
    }
  }

  if (path === '/v1/models' && method === 'GET') {
    return json(res, 200, handleModels());
  }

  if (path.startsWith('/v1/models/') && method === 'GET') {
    const rawId = decodeURIComponent(path.slice('/v1/models/'.length));
    const modelKey = resolveModel(rawId);
    const info = getModelInfo(modelKey);
    if (!info) {
      return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `Model ${rawId} not found` } });
    }
    return json(res, 200, anthropicModelPayload(rawId, info));
  }

  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!hasUsableAccount()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'api_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'openai')) return;
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    }
    if (!Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
    }
    if (body.messages.length === 0) {
      return json(res, 400, { error: { message: 'messages must contain at least 1 item', type: 'invalid_request_error' } });
    }

    const reqStartedAt = Date.now();
    const token = extractToken(req, 'openai');
    const callerKey = callerKeyFromRequest(req, token, body);
    // Thread a client-disconnect AbortSignal into the handler context so a
    // caller that hangs up mid-flight tears down the in-flight upstream call
    // and — on the DEVIN_CONNECT path — stops the failover loop from hopping
    // fresh pooled accounts to a dead socket. Guard on !writableEnded so the
    // normal end-of-response 'close' is a no-op.
    const abortController = bindClientAbort(res);
    // One absolute deadline + upstream-turn budget per request, owned by the
    // route. Layers (queue admission, cascade poll, connect retries) receive
    // the remaining time and may only shorten their own bounds.
    const budget = createRequestBudget({ stream: body.stream === true });
    const result = await handleChatCompletions(body, {
      callerKey,
      nativeBridgeCallerKey: nativeBridgeCallerKeyForRequest(req, token, body, callerKey),
      signal: abortController.signal,
      budget,
      clineCompat,
      ccCompat,
    });
    const processingMs = Date.now() - reqStartedAt;
    const requestId = 'req_' + randomUUID();
    const ringRow = recordRequest({
      id: requestId,
      model: body.model,
      status: result.status,
      stream: !!result.stream,
      durationMs: processingMs,
      class: result.body?.error?.code || (result.status < 400 ? 'ok' : 'error'),
      caller: callerKey,
      protocol: 'openai',
    });
    const modelHeaders = {
      'x-request-id': requestId,
      'openai-model': body.model || '',
      // Actual upstream processing time — hvoy.ai and similar verifiers
      // treat a flat "0" as a fingerprint of a faking proxy.
      'openai-processing-ms': String(processingMs),
      'openai-version': '2020-10-01',
      // OpenAI always returns an organization header. We don't have a real
      // org id, but a stable synthetic one keeps the shape consistent so
      // the signature check doesn't pick up on the missing field.
      'openai-organization': 'org-windsurf-proxy',
    };
    if (result.stream) {
      // Commit gate: hold the first frames until a real payload arrives. A
      // pre-content upstream 429/500 then becomes a real HTTP status instead of
      // a 200 SSE error frame. Heartbeats/role-only primes are buffered (bounded
      // by the wrapper) and flushed with the first real frame.
      const commitMs = resolveStreamCommitMs();
      const streamHeaders = { 'Access-Control-Allow-Origin': '*', ...modelHeaders, ...result.headers };
      await serveChatStream(res, result, {
        headers: streamHeaders,
        requestId,
        commitMs,
        onDone: streamRingDone(ringRow, reqStartedAt, res),
      });
    } else {
      for (const [k, v] of Object.entries(modelHeaders)) res.setHeader(k, v);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      }
      // O10: normalize internal error.type to the official OpenAI vocabulary at
      // the egress boundary; no-op on success bodies. F4: inject the same
      // request_id emitted in x-request-id into the error body (status >= 400).
      normalizeOpenAIErrorBody(result.body, result.status);
      json(res, result.status, withRequestId(result.status, result.body, requestId));
    }
    return;
  }

  if (path === '/v1/completions' && method === 'POST') {
    if (!hasUsableAccount()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'api_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'openai')) return;
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    }
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return json(res, 400, { error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' } });
    }

    const reqStartedAt = Date.now();
    const token = extractToken(req, 'openai');
    const callerKey = callerKeyFromRequest(req, token, body);
    const abortController = bindClientAbort(res);
    const budget = createRequestBudget({ stream: false });
    const result = await handleCompletions(body, {
      callerKey,
      nativeBridgeCallerKey: nativeBridgeCallerKeyForRequest(req, token, body, callerKey),
      signal: abortController.signal,
      budget,
      clineCompat,
      ccCompat,
    });
    const processingMs = Date.now() - reqStartedAt;
    const requestId = 'req_' + randomUUID();
    const ringRow = recordRequest({
      id: requestId,
      model: body.model,
      status: result.status,
      stream: !!result.stream,
      durationMs: processingMs,
      class: result.body?.error?.code || (result.status < 400 ? 'ok' : 'error'),
      caller: callerKey,
      protocol: 'completions',
    });
    const modelHeaders = {
      'x-request-id': requestId,
      'openai-model': body.model || '',
      'openai-processing-ms': String(processingMs),
      'openai-version': '2020-10-01',
      'openai-organization': 'org-windsurf-proxy',
    };
    for (const [k, v] of Object.entries(modelHeaders)) res.setHeader(k, v);
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    }
    normalizeOpenAIErrorBody(result.body, result.status);
    json(res, result.status, withRequestId(result.status, result.body, requestId));
    return;
  }

  // v2.0.71 (#121 keh4l): some clients send `/v1/response` (singular)
  // by mistake — this exact alias avoids a confusing 404 and routes to
  // the canonical handler. The plural `/v1/responses` is the spec form.
  if (path === '/v1/response' && method === 'POST') {
    path = '/v1/responses';
  }

  if (path === '/v1/responses' && method === 'POST') {
    if (!hasUsableAccount()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'api_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'openai')) return;
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    }
    if (body.input == null) {
      return json(res, 400, { error: { message: 'input is required', type: 'invalid_request_error' } });
    }

    const reqStartedAt = Date.now();
    const token = extractToken(req, 'openai');
    const callerKey = callerKeyFromRequest(req, token, body);
    const abortController = bindClientAbort(res);
    const budget = createRequestBudget({ stream: body.stream === true });
    const result = await handleResponses(body, {
      context: {
        callerKey,
        nativeBridgeCallerKey: nativeBridgeCallerKeyForRequest(req, token, body, callerKey),
        ccCompat,
        signal: abortController.signal,
        budget,
      },
    });
    const processingMs = Date.now() - reqStartedAt;
    const requestId = 'req_' + randomUUID();
    const ringRow = recordRequest({
      id: requestId,
      model: body.model,
      status: result.status,
      stream: !!result.stream,
      durationMs: processingMs,
      class: result.body?.error?.code || (result.status < 400 ? 'ok' : 'error'),
      caller: callerKey,
      protocol: 'responses',
    });
    const modelHeaders = {
      'x-request-id': requestId,
      'openai-model': body.model || '',
      'openai-processing-ms': String(processingMs),
      'openai-version': '2020-10-01',
      'openai-organization': 'org-windsurf-proxy',
    };
    if (result.stream) {
      const commitMs = resolveStreamCommitMs();
      const streamHeaders = { 'Access-Control-Allow-Origin': '*', ...modelHeaders, ...result.headers };
      await serveChatStream(res, result, {
        headers: streamHeaders,
        requestId,
        commitMs,
        protocol: 'responses',
        // The Responses translator emits response.created/in_progress before any
        // content, and a pre-content failure as response.failed. Hold only the
        // lifecycle frames; commit on the first content item.
        isBootstrap: (obj) => obj?.type === 'response.created' || obj?.type === 'response.in_progress',
        parseError: (obj) => (obj?.type === 'response.failed' && obj.response?.error ? obj.response.error : null),
        errorBody: (error, status) => ({
          error: {
            message: error?.message || 'Upstream stream error',
            type: normalizeOpenAIErrorType(error?.type, status),
            ...(error?.code ? { code: error.code } : {}),
          },
        }),
        onDone: streamRingDone(ringRow, reqStartedAt, res),
      });
    } else {
      for (const [k, v] of Object.entries(modelHeaders)) res.setHeader(k, v);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      }
      // O10 + F4: /v1/responses is OpenAI-family — same egress normalize +
      // request_id injection as /v1/chat/completions.
      normalizeOpenAIErrorBody(result.body, result.status);
      json(res, result.status, withRequestId(result.status, result.body, requestId));
    }
    return;
  }

  // GET / DELETE /v1/responses/{id} — retrieve or drop a stored response.
  //
  // Matched with an explicit prefix + a strict id shape rather than a loose
  // startsWith slice: `path` is never URL-decoded anywhere in this router (see the
  // audit note on path normalization), and keeping the id charset closed means a
  // crafted suffix cannot smuggle a traversal segment or a second path component
  // into the store lookup. Anything that does not match falls through to the 404.
  if ((method === 'GET' || method === 'DELETE') && path.startsWith('/v1/responses/')) {
    const responseId = path.slice('/v1/responses/'.length);
    if (/^[A-Za-z0-9_-]{1,128}$/.test(responseId)) {
      const token = extractToken(req, 'openai');
      // Identity for a BODYLESS request.
      //
      // The original comment here claimed the ip/ua fingerprint was "exactly what a
      // chained POST with no `user` derives, so a client that can chain can also
      // retrieve". That was false, and it made both endpoints dead on arrival: any
      // client that CAN chain sends `user` / `prompt_cache_key` /
      // `safety_identifier`, so its POST callerKey carries a `:user:<hash>` segment
      // while a bodyless GET derives `:client:<ip+ua>` — a different key, so the
      // lookup always 404'd. And a client that sends none of them derives a
      // matching key but fails hasPerUserScope, so it 404'd too. Measured: every
      // client shape 404'd, with the record provably present under the POST
      // identity. Not even WINDSURFAPI_SINGLE_TENANT_CACHE=1 helped — mismatched
      // identity is the prior problem.
      //
      // The Responses retrieval API has no request body, so the identity signal has
      // to ride somewhere else. It goes in a HEADER, not the query string.
      //
      // Query params were the first cut and they leak PII: `user` is, per this
      // repo's own note at caller-key.js:107, "often an end-user email or stable
      // account id (PII)" that must not be logged — and the bundled TLS front end
      // logs the full URL verbatim (https-proxy.js:20 prints `${method} ${url}`),
      // as does essentially every reverse proxy, CDN, and browser history. Putting
      // the exact value that module refuses to log into the URL contradicts the
      // policy the same repo states.
      //
      // Headers carry it without that exposure. The vocabulary mirrors the POST
      // body's ENTIRE scope vocabulary — extractBodyCallerSubKey also honours
      // conversation / metadata.conversation_id / metadata.session_id, and omitting
      // those left clients using them unable to retrieve their own responses (the
      // same "covered only some of the cases" miss this fix was made to remove).
      // Read through the SAME extraction path, so a caller reproduces its scope
      // exactly. Absent every signal, behaviour is unchanged.
      const h = req.headers || {};
      const q = new URL(req.url, 'http://localhost').searchParams;
      // Header first; query kept as a documented fallback for clients that cannot
      // set headers, with the PII caveat spelled out in the README.
      // Header names use hyphens (`x-response-conversation-id`); the canonical
      // scope vocabulary uses underscores (`conversation_id`). The query fallback
      // accepts BOTH spellings: the README documents the six signals with the
      // header spelling and then says the same names work as query parameters, so
      // `?conversation-id=` was documented but 404'd while only `?conversation_id=`
      // worked.
      //
      // Precisely what this does and does not change. Per NAME it is a pure alias —
      // the underscore form wins, and either spelling of one name derives the same
      // identity. What it is NOT is "strictly more permissive": a spelling that was
      // previously inert can now FILL a scope slot, and a caller that supplies
      // several DIFFERENT scope vocabularies has all of them folded into one
      // identity, so adding a slot changes the derived key. That folding is
      // pre-existing — on master `?conversation=A&conversation_id=B` already
      // differed from `?conversation=A` alone, because both underscore spellings
      // were accepted — this just makes a third spelling able to reach it. The
      // practical rule for callers, now stated in the README, is to send ONE scope
      // signal and send it consistently.
      const pick = (name) => {
        const hyphen = name.replace(/_/g, '-');
        return h[`x-response-${hyphen}`] || q.get(name) || q.get(hyphen) || '';
      };
      const ident = {};
      for (const k of ['user', 'prompt_cache_key', 'safety_identifier', 'conversation']) {
        const v = pick(k);
        if (v) ident[k] = v;
      }
      const convId = pick('conversation_id');
      const sessId = pick('session_id');
      if (convId || sessId) {
        ident.metadata = {
          ...(convId ? { conversation_id: convId } : {}),
          ...(sessId ? { session_id: sessId } : {}),
        };
      }
      const callerKey = callerKeyFromRequest(req, token, Object.keys(ident).length ? ident : null);
      const result = (method === 'GET' ? handleGetResponse : handleDeleteResponse)(
        responseId, { context: { callerKey } },
      );
      const requestId = 'req_' + randomUUID();
      res.setHeader('x-request-id', requestId);
      res.setHeader('openai-version', '2020-10-01');
      res.setHeader('openai-organization', 'org-windsurf-proxy');
      normalizeOpenAIErrorBody(result.body, result.status);
      return json(res, result.status, withRequestId(result.status, result.body, requestId));
    }
  }

  // Anthropic Messages API — Claude Code compatibility
  if (path === '/v1/messages/count_tokens' && method === 'POST') {
    if (!hasUsableAccount()) {
      // D2: no-account gate is a transient capacity condition, not a fatal
      // server bug. 503 api_error was self-contradictory (503 isn't in the
      // Anthropic status set; api_error implies 500). 529 overloaded_error is
      // the official retryable status so SDKs back off and retry.
      return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'No active accounts available, please retry' } });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'anthropic')) return;
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    // E4: model is required by the official count_tokens API.
    const invalid = validateCountTokensRequest(body);
    if (invalid) return json(res, invalid.status, invalid.body);
    // G1: count_tokens is also an Anthropic-family endpoint — echo the version
    // header for symmetry with /v1/messages (no stream here, so setHeader).
    const anthropicVersion = resolveAnthropicVersion(req);
    const result = handleCountTokens(body);
    res.setHeader('anthropic-version', anthropicVersion);
    return json(res, result.status, result.body);
  }

  if (path === '/v1/messages' && method === 'POST') {
    if (!hasUsableAccount()) {
      // D2: see count_tokens above — transient capacity → 529 overloaded_error.
      return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'No active accounts available, please retry' } });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'anthropic')) return;
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' } });
    }
    // C1/C3/C4: enforce max_tokens (required, positive int) and cache_control
    // validity (ephemeral type, ttl ∈ {5m,1h}, ≤4 breakpoints) at the entry.
    const invalid = validateMessagesRequest(body);
    if (invalid) return json(res, invalid.status, invalid.body);
    const token = extractToken(req, 'messages');
    const callerKey = callerKeyFromRequest(req, token, body);
    // G1: read the anthropic-version request header (warn+default when missing,
    // accept-as-is when unknown). Passed into context as a seam for future
    // version-gated behavior; the translation layer does not branch on it today.
    const anthropicVersion = resolveAnthropicVersion(req);
    const reqStartedAt = Date.now();
    const requestId = 'req_' + randomUUID();
    const abortController = bindClientAbort(res);
    const budget = createRequestBudget({ stream: body.stream === true });
    const result = await handleMessages(body, {
      callerKey,
      nativeBridgeCallerKey: nativeBridgeCallerKeyForRequest(req, token, body, callerKey),
      anthropicVersion,
      ccCompat,
      signal: abortController.signal,
      budget,
    });
    const processingMs = Date.now() - reqStartedAt;
    const ringRow = recordRequest({
      id: requestId,
      model: body.model,
      status: result.status,
      stream: !!result.stream,
      durationMs: processingMs,
      class: result.body?.error?.code || (result.status < 400 ? 'ok' : 'error'),
      caller: callerKey,
      protocol: 'messages',
    });
    const anthropicHeaders = {
      'request-id': requestId,
      'anthropic-model': body.model || '',
      // G1: echo the effective version back so clients can confirm it.
      'anthropic-version': anthropicVersion,
    };
    if (result.stream) {
      const commitMs = resolveStreamCommitMs();
      await serveChatStream(res, result, {
        headers: { 'Access-Control-Allow-Origin': '*', ...anthropicHeaders, ...result.headers },
        requestId,
        commitMs,
        protocol: 'messages',
        isBootstrap: (obj) => obj?.type === 'message_start' || obj?.type === 'ping',
        parseError: (obj) => (obj?.type === 'error' && obj.error ? obj.error : null),
        errorBody: (error, status) => toAnthropicError(status, error?.type, error?.message).body,
        onDone: streamRingDone(ringRow, reqStartedAt, res),
      });
    } else {
      for (const [k, v] of Object.entries(anthropicHeaders)) res.setHeader(k, v);
      // Forward the handler's own headers. The STREAM branch above already spreads
      // `result.headers` into writeHead; this branch did not, so a non-stream 429
      // reached the client with no `Retry-After` at all — the header the Anthropic
      // SDK reads to decide how long to back off. /v1/responses has always
      // forwarded them here (see the same spot on that route), so this was a
      // per-route divergence rather than a deliberate policy.
      //
      // Set BEFORE the body so a handler header cannot silently lose to the
      // Anthropic-vocabulary ones above — those are the route's contract and win
      // on collision, which is why this loop does not overwrite them.
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          if (!(k in anthropicHeaders)) res.setHeader(k, v);
        }
      }
      // F4: inject request_id into Anthropic error bodies (status >= 400),
      // matching {type:'error', error:{...}, request_id}. O10 does NOT touch
      // Anthropic — toAnthropicError owns its own status vocabulary.
      json(res, result.status, withRequestId(result.status, result.body, requestId));
    }
    return;
  }

  // ── Google Gemini API (generativelanguage) v1beta frontend ──
  // POST /v1beta/models/{model}:generateContent        → non-stream
  // POST /v1beta/models/{model}:streamGenerateContent  → stream
  //   default wire format is a JSON array of GenerateContentResponse;
  //   ?alt=sse switches to an SSE stream (preferred by newer SDKs).
  // The {model} segment can carry dots/dashes; the method is the suffix
  // after the final ':'. A v1 alias path is accepted too.
  if (method === 'POST' && /\/models\/[^:/]+:(generateContent|streamGenerateContent)$/.test(path)) {
    if (!hasUsableAccount()) {
      return json(res, 503, { error: { code: 503, message: 'No active accounts. POST /auth/login to add accounts.', status: 'UNAVAILABLE' } });
    }
    const parsed = parseGeminiPath(path);
    if (!parsed) {
      return json(res, 404, { error: { code: 404, message: `${method} ${path} not found`, status: 'NOT_FOUND' } });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'openai')) return;
      return json(res, 400, { error: { code: 400, message: 'Invalid JSON', status: 'INVALID_ARGUMENT' } });
    }
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
      return json(res, 400, { error: { code: 400, message: 'contents must be a non-empty array', status: 'INVALID_ARGUMENT' } });
    }
    const wantStream = parsed.method === 'streamGenerateContent';
    const alt = new URL(req.url, 'http://localhost').searchParams.get('alt');
    const token = extractToken(req, credentialSurfaceFor(path));
    const callerKey = callerKeyFromRequest(req, token, body);
    const reqStartedAt = Date.now();
    const geminiHeaders = { 'request-id': 'req_' + randomUUID() };
    const abortController = bindClientAbort(res);
    const budget = createRequestBudget({ stream: wantStream });
    const result = await handleGemini(parsed.model, body, {
      callerKey,
      nativeBridgeCallerKey: nativeBridgeCallerKeyForRequest(req, token, body, callerKey),
      signal: abortController.signal,
      budget,
    }, { stream: wantStream, alt });
    const processingMs = Date.now() - reqStartedAt;
    const ringRow = recordRequest({
      id: geminiHeaders['request-id'],
      model: parsed.model,
      status: result.status,
      stream: !!result.stream,
      durationMs: processingMs,
      class: result.body?.error?.code || (result.status < 400 ? 'ok' : 'error'),
      caller: callerKey,
      protocol: 'gemini',
    });
    if (result.stream) {
      const commitMs = resolveStreamCommitMs();
      await serveChatStream(res, result, {
        headers: { 'Access-Control-Allow-Origin': '*', ...geminiHeaders, ...result.headers },
        requestId: geminiHeaders['request-id'],
        commitMs,
        protocol: 'gemini',
        isBootstrap: (obj) => Array.isArray(obj?.candidates)
          && obj.candidates.length > 0
          && obj.candidates.every((c) => !c?.finishReason && (c?.content?.parts || []).every((p) => !p?.text && !p?.functionCall)),
        parseError: (obj) => (obj?.error && typeof obj.error === 'object' ? obj.error : null),
        errorBody: (error, status) => geminiError(status, error?.type, error?.message).body,
        onDone: streamRingDone(ringRow, reqStartedAt, res),
      });
    } else {
      for (const [k, v] of Object.entries(geminiHeaders)) res.setHeader(k, v);
      // Same divergence as the Anthropic route above: the stream branch spreads
      // `result.headers`, this one dropped them, so a non-stream 429 carried no
      // `Retry-After` for the Gemini SDK to honour. Route-vocabulary headers win on
      // collision.
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          if (!(k in geminiHeaders)) res.setHeader(k, v);
        }
      }
      json(res, result.status, result.body);
    }
    return;
  }

  // D4: the Anthropic surface (/v1/messages*) must get an Anthropic-shaped
  // error body, not the OpenAI {error:{message,type}} shape, so SDK clients
  // parse it correctly instead of choking on an unknown envelope.
  if (isAnthropicPath(path)) {
    return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `${method} ${path} not found` } });
  }
  json(res, 404, { error: { message: `${method} ${path} not found`, type: 'not_found_error' } });
}

// D4: paths under the Anthropic Messages surface. Fallback 404/500 handlers use
// this to choose the Anthropic error envelope over the default OpenAI one.
function isAnthropicPath(path) {
  return typeof path === 'string' && path.startsWith('/v1/messages');
}

export function startServer() {
  const activeRequests = new Set();
  const bindHost = config.host || '0.0.0.0';
  configureBindHost(bindHost);
  emitNoAuthWarnings(bindHost);

  const server = http.createServer(async (req, res) => {
    activeRequests.add(res);
    res.on('close', () => activeRequests.delete(res));
    try {
      // One accounting scope per HTTP request: it joins the attempt row
      // (recordRequest, called at various depths of the chat handlers) with the
      // usage block (recordTokenUsage, called at a different depth and possibly
      // before the row) without relying on a shared "last row" pointer that
      // concurrent requests would race. The final response status is stamped on
      // the last attempt before the scope closes.
      await withStatsScope(async (scope) => {
        try {
          await route(req, res);
        } finally {
          // A throw before headers is answered by the outer catch below; only a
          // response that actually went out carries a status worth recording.
          if (res.headersSent || res.writableEnded) scope.status = res.statusCode;
          finalizeStatsScope(scope);
        }
      });
    } catch (err) {
      log.error('Handler error:', err);
      if (!res.headersSent) {
        // D4: Anthropic surface gets the Anthropic error envelope; everything
        // else keeps the OpenAI-shaped {error:{message,type}} body.
        const path = String(req.url || '').split('?')[0];
        if (isAnthropicPath(path)) {
          json(res, 500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } });
        } else {
          json(res, 500, { error: { message: 'Internal error', type: 'server_error' } });
        }
      }
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let retryCount = 0;
  const maxRetries = 10;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount > maxRetries) {
        log.error(`Port ${config.port} still in use after ${maxRetries} retries. Exiting.`);
        process.exit(1);
      }
      log.warn(`Port ${config.port} in use, retry ${retryCount}/${maxRetries} in 3s...`);
      setTimeout(() => server.listen(config.port, bindHost), 3000);
    } else {
      log.error('Server error:', err);
    }
  });

  server.getActiveRequests = () => activeRequests.size;

  server.listen({ port: config.port, host: bindHost }, () => {
    log.info(`Server on http://${bindHost}:${config.port}`);
    log.info('  POST /v1/chat/completions');
    log.info('  POST /v1/completions');
    log.info('  POST /v1/responses');
    log.info('  GET  /v1/responses/{id}   (retrieve stored)');
    log.info('  DEL  /v1/responses/{id}');
    log.info('  POST /v1/messages         (Anthropic)');
    log.info('  POST /v1/messages/count_tokens');
    log.info('  POST /v1beta/models/{model}:generateContent       (Gemini)');
    log.info('  POST /v1beta/models/{model}:streamGenerateContent (Gemini)');
    log.info('  GET  /v1/models');
    log.info('  POST /auth/login          (add account)');
    log.info('  GET  /auth/accounts       (list accounts)');
    log.info('  DELETE /auth/accounts/:id (remove account)');
  });
  return server;
}
