/**
 * Devin web backend (app.devin.ai) REST/SSE adapter — escape-hatch PATH B.
 *
 * Cascade's gRPC backend (server.self-serve.windsurf.com) is scheduled to retire
 * 2026-07-01 (see memory: cascade-retirement-2026-07-01). Two forward paths exist:
 *   PATH A — Devin CLI local subprocess (src/special-agent.js + src/devin-acp.js)
 *   PATH B — direct app.devin.ai REST/SSE (THIS FILE)
 *
 * SCOPE OF THIS SCAFFOLD: only the VERIFIED protocol surface is implemented.
 * Verified facts come from dao-devin-export v1.4.3 source + official docs and are
 * recorded in docs-internal/workflow-results/REF-devin-backend-protocol.md. Everything verified
 * here is READ-ONLY (auth probe + list/detail/event/org reads). The WRITE surface a
 * real reverse-proxy needs (create-session + send-prompt) is NOT present in any
 * verified source, so it is left as explicit TODO stubs that throw — never faked.
 *
 * Design notes:
 * - Zero npm deps; uses global fetch (Node >=20). `fetchImpl` is injectable so unit
 *   tests can mock the network and CI never touches app.devin.ai.
 * - Nothing here runs at import time and no function dials the network unless called.
 * - All values treated as data; no shell, no eval.
 *
 * ⚠️ STATUS (audit S3, 2026-07-11): this module is an intentional ROADMAP STUB —
 * it has ZERO production importers (grep `from './devin-backend.js'` in src/ →
 * none) and backend-router.selectBackend() NEVER returns BACKEND.DEVIN_REST, so
 * no request path reaches this code. The dedicated unit tests
 * (test/devin-backend*.test.js) were REMOVED because they inflated coverage on
 * unreachable code (all fake-green: they exercised these helpers against a mock
 * fetch, but nothing live calls them). Kept as the DEVIN_REST placeholder per
 * product decision. If/when this is wired into selectBackend, re-add tests THEN,
 * against the live route — not before. Do not "restore" the deleted tests.
 */

import { VERSION } from './version.js';

const DEFAULT_BASE_URL = 'https://app.devin.ai/api';
// Verified live REST base (P0, 2026-06-29): api.devin.ai/v3/organizations/{org}/...
// is a standard FastAPI surface reachable with the Windsurf session token. This is
// the CONFIRMED write/read API, distinct from the dao-derived app.devin.ai/api base
// above. See memory: devin-write-endpoint-cracked-2026-06-29.
const DEFAULT_REST_BASE_URL = 'https://api.devin.ai';

/**
 * Build the runtime config from env. Pure — no I/O, safe to call anytime.
 * Token/org are referenced by key name only and never logged by this module.
 *
 *   DEVIN_BACKEND_BASE_URL   override API base (default https://app.devin.ai/api)
 *   DEVIN_BACKEND_TOKEN      Bearer token (devin-session-token$… / JWT / auth1_…)
 *                            falls back to WINDSURF_API_KEY (same key system the
 *                            Devin CLI uses — see memory: devin-acp-live-verified)
 *   DEVIN_BACKEND_ORG_ID     org id, form `org-XXXX` (x-cog-org-id header)
 *   DEVIN_BACKEND_ENABLED=1  feature flag; off by default
 */
export function getDevinBackendConfig(env = process.env) {
  const baseUrl = String(env.DEVIN_BACKEND_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  const restBaseUrl = String(env.DEVIN_BACKEND_REST_BASE_URL || DEFAULT_REST_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  return {
    baseUrl,
    restBaseUrl,
    token: String(env.DEVIN_BACKEND_TOKEN || env.WINDSURF_API_KEY || '').trim(),
    orgId: String(env.DEVIN_BACKEND_ORG_ID || '').trim(),
    enabled: env.DEVIN_BACKEND_ENABLED === '1',
  };
}

export function isDevinBackendEnabled(env = process.env) {
  return getDevinBackendConfig(env).enabled;
}

/**
 * Assemble the standard auth headers.
 *   Authorization: Bearer <token>          (verified — all calls)
 *   x-cog-org-id:  <orgId>                 (verified — all calls; omitted if unset,
 *                                           e.g. the post-auth call that *derives* it)
 *   Accept / User-Agent / Content-Type     (sane defaults)
 *
 * `extra` is merged last so callers can add e.g. Accept: text/event-stream for SSE.
 */
export function buildDevinHeaders(cfg, extra = {}) {
  if (!cfg || !cfg.token) {
    throw Object.assign(new Error('Devin backend token is not configured'), {
      status: 401,
      type: 'backend_misconfigured',
    });
  }
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': `WindsurfAPI/${VERSION}`,
  };
  if (cfg.orgId) headers['x-cog-org-id'] = cfg.orgId;
  return { ...headers, ...extra };
}

/**
 * The org path segment. dao uses `org-{bare}` where {bare} is the org id with any
 * leading `org-` stripped, so `org-abc` and `abc` both yield `org-abc`.
 */
export function orgPathSegment(orgId) {
  const bare = String(orgId || '').replace(/^org-/, '');
  if (!bare) {
    throw Object.assign(new Error('Devin backend orgId is not configured'), {
      status: 400,
      type: 'backend_misconfigured',
    });
  }
  return `org-${bare}`;
}

function joinUrl(baseUrl, path) {
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Low-level JSON request helper. Injectable `fetchImpl` keeps tests offline.
 * Returns parsed JSON on 2xx; throws a tagged Error otherwise.
 */
async function requestJson(cfg, method, path, { body, extraHeaders, fetchImpl, baseUrl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw Object.assign(new Error('fetch is not available'), { status: 500, type: 'backend_misconfigured' });
  }
  const url = joinUrl(baseUrl || cfg.baseUrl, path);
  const headers = buildDevinHeaders(cfg, extraHeaders);
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);

  const res = await fetchFn(url, init);
  if (!res.ok) {
    // Capture FastAPI {"detail": ...} when present — it carries the validation/
    // permission reason (e.g. 422 field errors, 403 token-scope message).
    let detail;
    try { detail = (await res.json())?.detail; } catch { /* non-JSON body */ }
    const err = new Error(`Devin backend ${method} ${path} failed: ${res.status}`);
    err.status = res.status === 401 || res.status === 403 ? res.status : (res.status === 422 ? 422 : 502);
    err.type = 'backend_error';
    if (detail !== undefined) err.detail = detail;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// VERIFIED READ surface
// ---------------------------------------------------------------------------

/**
 * Liveness + entitlement probe. POST /users/post-auth with a Bearer token and an
 * empty body returns {org_id, org_name, email}. Zero-cost (no model billed), so it
 * doubles as "is this token still alive and what org does it map to" after 7/1.
 *
 * NOTE: callers must NOT hit the real network in unit tests — pass a mock fetchImpl.
 * Returns the parsed org info; does not mutate cfg.
 */
export async function probePostAuth(cfg, { fetchImpl } = {}) {
  // x-cog-org-id is intentionally not required here: this call derives org_id.
  const probeCfg = { ...cfg, orgId: '' };
  return requestJson(probeCfg, 'POST', '/users/post-auth', { body: {}, fetchImpl });
}

/** GET /org-{bare}/v2sessions — session list (primary). */
export async function listSessions(cfg, { fetchImpl } = {}) {
  const seg = orgPathSegment(cfg.orgId);
  return requestJson(cfg, 'GET', `/${seg}/v2sessions`, { fetchImpl });
}

/** GET /sessions — session list (verified fallback when v2sessions is unavailable). */
export async function listSessionsFallback(cfg, { fetchImpl } = {}) {
  return requestJson(cfg, 'GET', '/sessions', { fetchImpl });
}

/** GET /sessions/{devinId} — single session detail. */
export async function getSession(cfg, devinId, { fetchImpl } = {}) {
  const id = encodeURIComponent(String(devinId || ''));
  if (!id) throw Object.assign(new Error('devinId is required'), { status: 400, type: 'bad_request' });
  return requestJson(cfg, 'GET', `/sessions/${id}`, { fetchImpl });
}

/** GET /events/first-load/{devinId} — first-screen events for a session. */
export async function getFirstLoadEvents(cfg, devinId, { fetchImpl } = {}) {
  const id = encodeURIComponent(String(devinId || ''));
  if (!id) throw Object.assign(new Error('devinId is required'), { status: 400, type: 'bad_request' });
  return requestJson(cfg, 'GET', `/events/first-load/${id}`, { fetchImpl });
}

/** GET /organizations/{orgId} — org settings. */
export async function getOrganization(cfg, { fetchImpl } = {}) {
  const id = encodeURIComponent(String(cfg.orgId || ''));
  if (!id) throw Object.assign(new Error('orgId is required'), { status: 400, type: 'bad_request' });
  return requestJson(cfg, 'GET', `/organizations/${id}`, { fetchImpl });
}

/**
 * Build (do NOT open) the SSE event-stream URL + headers for a session.
 * GET /events/{devinId}/stream with Accept: text/event-stream.
 *
 * Returned as {url, headers} rather than an open connection so the caller owns the
 * fetch/abort lifecycle and tests can assert the URL/headers without a live socket.
 */
export function buildEventStreamRequest(cfg, devinId) {
  const id = encodeURIComponent(String(devinId || ''));
  if (!id) throw Object.assign(new Error('devinId is required'), { status: 400, type: 'bad_request' });
  return {
    url: joinUrl(cfg.baseUrl, `/events/${id}/stream`),
    headers: buildDevinHeaders(cfg, { Accept: 'text/event-stream' }),
  };
}

// ---------------------------------------------------------------------------
// VERIFIED WRITE/READ surface — api.devin.ai/v3 (P0, 2026-06-29)
// ---------------------------------------------------------------------------
//
// createSession is the standard FastAPI endpoint confirmed live with the
// Windsurf session token. Field schema verified by 422 probing (no session
// created during probing — an int-typed prompt is rejected pre-creation):
//   prompt        string   REQUIRED
//   title         string   optional
//   tags          string[] optional
//   max_acu_limit int      optional
//   playbook_id   string   optional
//   knowledge_ids string[] optional
//   secret_ids    string[] optional
// Any other field is ignored by the server.
//
// sendPrompt is NOT a v3 REST endpoint: POST /sessions/{id}/messages exists but
// returns 403 for a Windsurf session token. Prompts/streaming go over ACP
// (src/devin-acp.js, live-verified). sendPrompt therefore delegates to ACP and
// is intentionally left throwing here until P3 wires the ACP path through.

const V3_SESSION_FIELDS = ['prompt', 'title', 'tags', 'max_acu_limit', 'playbook_id', 'knowledge_ids', 'secret_ids'];

/** Org segment for v3: the API expects the full `org-XXXX` form. */
function v3OrgPath(cfg) {
  return `/v3/organizations/${orgPathSegment(cfg.orgId)}/sessions`;
}

/**
 * Create a new agent session via the verified v3 REST endpoint.
 *   POST https://api.devin.ai/v3/organizations/{org}/sessions
 *
 * @param {object} cfg   backend config from getDevinBackendConfig()
 * @param {object} opts  { prompt (required), title?, tags?, max_acu_limit?,
 *                         playbook_id?, knowledge_ids?, secret_ids? }
 * @returns {Promise<object>} full session object (session_id, url, status, ...)
 */
export async function createSession(cfg, opts = {}) {
  const prompt = opts?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('createSession requires a non-empty string prompt'), {
      status: 400,
      type: 'bad_request',
    });
  }
  // Whitelist known fields only; the server ignores extras but we keep the body
  // tight and predictable.
  const body = {};
  for (const f of V3_SESSION_FIELDS) {
    if (opts[f] !== undefined) body[f] = opts[f];
  }
  return requestJson(cfg, 'POST', v3OrgPath(cfg), {
    body,
    baseUrl: cfg.restBaseUrl,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * Read sessions via the verified v3 REST endpoint (Windsurf token is read-capable
 * here). Used to poll a created session's status/result.
 *   GET https://api.devin.ai/v3/organizations/{org}/sessions?session_ids={id}
 *   GET .../sessions?limit={n}
 *
 * @returns {Promise<{items: object[], end_cursor: any, has_next_page: boolean, total: number}>}
 */
export async function listSessionsV3(cfg, { sessionIds, limit, fetchImpl } = {}) {
  const params = new URLSearchParams();
  if (Array.isArray(sessionIds)) for (const id of sessionIds) params.append('session_ids', String(id));
  else if (sessionIds) params.append('session_ids', String(sessionIds));
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return requestJson(cfg, 'GET', `${v3OrgPath(cfg)}${qs ? `?${qs}` : ''}`, {
    baseUrl: cfg.restBaseUrl,
    fetchImpl,
  });
}

/** Convenience: fetch a single session by id via v3, or null if not found. */
export async function getSessionV3(cfg, sessionId, { fetchImpl } = {}) {
  const id = String(sessionId || '').trim();
  if (!id) throw Object.assign(new Error('sessionId is required'), { status: 400, type: 'bad_request' });
  const res = await listSessionsV3(cfg, { sessionIds: id, fetchImpl });
  const items = Array.isArray(res?.items) ? res.items : [];
  return items.find(s => s?.session_id === id) || items[0] || null;
}

const NOT_IMPLEMENTED = (name) => Object.assign(
  new Error(`${name} is not implemented: Devin backend write endpoint is unverified`),
  { status: 501, type: 'not_implemented' },
);

/**
 * Send a prompt to an existing session. NOT a v3 REST endpoint — prompts go over
 * ACP (POST /sessions/{id}/messages returns 403 for Windsurf tokens). P3 wires
 * this through src/devin-acp.js; until then it throws rather than guess a route.
 *
 * @param {object} cfg        backend config
 * @param {string} sessionId  id from createSession()
 * @param {object} opts       { prompt, ... }
 */
// eslint-disable-next-line no-unused-vars
export async function sendPrompt(cfg, sessionId, opts = {}) {
  throw NOT_IMPLEMENTED('sendPrompt');
}

export const __testing = { joinUrl, requestJson, DEFAULT_BASE_URL, DEFAULT_REST_BASE_URL, V3_SESSION_FIELDS, v3OrgPath };
