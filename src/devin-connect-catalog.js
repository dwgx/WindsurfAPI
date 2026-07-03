/**
 * DEVIN_CONNECT catalog + entitlement probe.
 *
 * Two read-only unary RPCs on the same Connect-RPC transport as GetChatMessage
 * (server.codeium.com, `Basic <token>-<token>` auth, client metadata as proto
 * field #1). Neither issues a chat turn, so both are zero-billable:
 *
 *   - GetCliModelConfigs → the full model catalog. Each ClientModelConfig
 *     carries the selector (#22) that goes into GetChatMessageRequest.model
 *     (field #21), the friendly label (#1), provider (#10), and a short alias
 *     (#23.#23). This is the source of truth for src/devin-connect-models.js's
 *     hand-maintained SELECTOR_MAP — run it against a paid account and the
 *     catalog reveals every selector that account can name.
 *
 *   - GetUserStatus → the account's plan name (#2.#2, e.g. "Free"). The catalog
 *     itself lists all models regardless of tier (the entitlement wall is
 *     enforced server-side at chat time, NOT in the catalog), so planName is
 *     the reliable free-vs-paid signal.
 *
 * Wire shapes were calibrated against the live API on 2026-06-30 with a free
 * account: GetCliModelConfigs → 200, 24 configs; GetUserStatus → 200, plan
 * "Free". See memory devin-connect-response-protocol-2026-06-30.
 */

import https from 'https';
import { randomBytes } from 'crypto';
import { log } from './config.js';
import { parseFields, writeStringField, writeMessageField, writeVarintField } from './proto.js';
import { getConnectToken, classifyUpstreamError } from './devin-connect.js';

// Transport seam: defaults to https.request. Swappable in tests so the non-200
// classification path can be exercised without a real socket. Mirrors the
// __setRequestImpl seam in devin-connect.js.
let requestImpl = https.request;
export function __setCatalogRequestImpl(fn) { requestImpl = fn || https.request; }

const HOST = 'server.codeium.com';
const CATALOG_PATH = '/exa.api_server_pb.ApiServerService/GetCliModelConfigs';
const STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const CLIENT_NAME = 'chisel';
const CLIENT_VERSION = '2026.8.18';

// ── ClientModelConfig field numbers (calibrated from a live 200 response) ──
const F_LABEL = 1;       // friendly name, e.g. "Claude Opus 4.8 Medium"
const F_PROVIDER = 10;   // 1=SWE/Cognition 2=OpenAI 3=Anthropic 4=Google 7=Moonshot 9=Zhipu
const F_SELECTOR = 22;   // the value GetChatMessageRequest.model expects
const F_MODEL_INFO = 23; // ModelInfo submessage; #23.#23 is the short alias
const F_ALIAS = 23;      // inside ModelInfo: short alias e.g. "claude-opus-4.8"

const PROVIDER_NAMES = {
  1: 'cognition', 2: 'openai', 3: 'anthropic', 4: 'google', 7: 'moonshot', 9: 'zhipu',
};

/**
 * Build the ClientMetadata sub-message (proto field #1 of the request). Mirrors
 * src/devin-connect.js buildClientMetadata — the token is embedded SINGLE here;
 * the doubling is only for the HTTP Authorization header.
 */
function buildClientMetadata(token) {
  return Buffer.concat([
    writeStringField(1, CLIENT_NAME),
    writeStringField(2, CLIENT_VERSION),
    writeStringField(3, token),
    writeStringField(4, 'en'),
    writeStringField(5, 'windows'),
    writeStringField(7, CLIENT_VERSION),
    writeStringField(12, CLIENT_NAME),
    writeStringField(31, randomBytes(366).toString('hex')),
  ]);
}

/**
 * POST a unary Connect-RPC request (application/proto, raw body) and resolve the
 * raw response buffer. Rejects with a coded error on non-200.
 *
 * @param {string} path
 * @param {string} token
 * @param {object} [opts]
 * @param {Buffer} [opts.extraBody]  extra proto fields appended AFTER the
 *   client-metadata field #1 (e.g. AssignModel's model_uid). Default: none.
 */
function unaryCall(path, token, { signal, timeoutMs = 30000, extraBody } = {}) {
  const body = extraBody
    ? Buffer.concat([writeMessageField(1, buildClientMetadata(token)), extraBody])
    : writeMessageField(1, buildClientMetadata(token));
  const authHeader = `Basic ${token}-${token}`;
  return new Promise((resolve, reject) => {
    const req = requestImpl({
      hostname: HOST, port: 443, path, method: 'POST',
      headers: {
        'Content-Type': 'application/proto',
        'Connect-Protocol-Version': '1',
        'Content-Length': body.length,
        'User-Agent': 'connect-es/2.0.0',
        authorization: authHeader,
        Accept: '*/*',
      },
      signal,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          const text = raw.toString('utf8').slice(0, 200);
          // Transient-first: the upstream wraps capacity ("high demand") and
          // backend ("internal error occurred (trace ID: ...)") faults inside a
          // 401/403 auth-shell on the unary probe path too — not just on
          // GetChatMessage. Classifying by HTTP status alone would read such a
          // blip as UNAUTHORIZED, and the liveness probe (probeAndRecoverConnect
          // Account) only force-re-logins on UNAUTHORIZED → a live token gets a
          // needless re-login on a momentary hiccup (the #56/#57 母题). Route the
          // body+code+status through the shared classifier so CAPACITY /
          // UPSTREAM_INTERNAL / RATE_LIMITED are surfaced as their transient
          // codes, and only a genuine auth death stays UNAUTHORIZED. Best-effort
          // JSON parse to recover the Connect-RPC error code when present.
          let upstreamCode = null;
          // Connect-RPC unary errors are top-level {"code","message"}; the
          // GetChatMessage trailer path uses nested {"error":{"code"}}. Accept
          // either so the transient signal (unavailable/resource_exhausted)
          // survives regardless of which shape the upstream sends here.
          try {
            const parsed = JSON.parse(text);
            upstreamCode = parsed?.error?.code || parsed?.code || null;
          } catch { /* text body */ }
          const { code, message } = classifyUpstreamError(text, upstreamCode, res.statusCode);
          reject(Object.assign(new Error(`${path} HTTP ${res.statusCode}: ${message}`), { code, status: res.statusCode }));
          return;
        }
        resolve(raw);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    const timer = setTimeout(() => { req.destroy(Object.assign(new Error('catalog probe timeout'), { code: 'TIMEOUT' })); }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}

/** Read the first length-delimited subfield as UTF-8, or '' if absent. */
function strField(fields, num) {
  const f = fields.find((x) => x.field === num && x.wireType === 2);
  return f ? f.value.toString('utf8') : '';
}

/** Read the first varint subfield as Number, or null if absent. */
function intField(fields, num) {
  const f = fields.find((x) => x.field === num && x.wireType === 0);
  return f ? Number(f.value) : null;
}

/**
 * Decode a GetCliModelConfigsResponse into a flat list of model entries.
 *
 * @param {Buffer} raw
 * @returns {Array<{selector,label,provider,providerId,alias,isFreeDefault}>}
 */
export function decodeCatalog(raw) {
  const configs = parseFields(raw).filter((f) => f.field === 1 && f.wireType === 2);
  const out = [];
  for (const c of configs) {
    const fields = parseFields(c.value);
    const selector = strField(fields, F_SELECTOR);
    if (!selector) continue;
    const label = strField(fields, F_LABEL);
    const providerId = intField(fields, F_PROVIDER);
    let alias = '';
    const info = fields.find((x) => x.field === F_MODEL_INFO && x.wireType === 2);
    if (info) {
      try { alias = strField(parseFields(info.value), F_ALIAS); } catch { /* keep '' */ }
    }
    // swe-1-6-slow uniquely carries the free context-window default (#18=200000
    // + #24=1) and lacks the is_premium flag (#4). It's the one selector every
    // tier can run; flag it so callers can pick a safe default.
    const isFreeDefault = selector === 'swe-1-6-slow';
    out.push({
      selector,
      label,
      providerId,
      provider: PROVIDER_NAMES[providerId] || (providerId == null ? 'unknown' : String(providerId)),
      alias,
      isFreeDefault,
    });
  }
  return out;
}

/** Decode GetUserStatusResponse → plan name (#2.#2). Lowercased; '' if absent. */
export function decodePlanName(raw) {
  const top = parseFields(raw);
  const lvl1 = top.find((x) => x.field === 2 && x.wireType === 2);
  if (!lvl1) return '';
  try {
    return strField(parseFields(lvl1.value), 2).trim().toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Fetch the live model catalog for a session token.
 *
 * @param {object} [opts]
 * @param {string} [opts.token]  session token; defaults to env (getConnectToken)
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.env]
 * @returns {Promise<Array>} decodeCatalog() entries
 */
export async function fetchCatalog({ token, signal, env = process.env } = {}) {
  const sessionToken = token || getConnectToken(env);
  if (!sessionToken) throw Object.assign(new Error('DEVIN_CONNECT: no session token configured'), { code: 'NO_TOKEN' });
  const raw = await unaryCall(CATALOG_PATH, sessionToken, { signal });
  const models = decodeCatalog(raw);
  log.info(`DEVIN_CONNECT catalog: ${models.length} models`);
  return models;
}

/**
 * Fetch the account's plan/tier name for a session token.
 *
 * @returns {Promise<{plan:string, isPaid:boolean}>}
 */
export async function fetchUserStatus({ token, signal, env = process.env } = {}) {
  const sessionToken = token || getConnectToken(env);
  if (!sessionToken) throw Object.assign(new Error('DEVIN_CONNECT: no session token configured'), { code: 'NO_TOKEN' });
  const raw = await unaryCall(STATUS_PATH, sessionToken, { signal });
  const plan = decodePlanName(raw);
  // "free" (and empty) ⇒ free tier; anything else (pro/team/teams/enterprise)
  // ⇒ paid. The catalog lists all models regardless, so this is the gate.
  const isPaid = !!plan && plan !== 'free';
  return { plan: plan || 'unknown', isPaid };
}

export const __testing = { buildClientMetadata, strField, intField, PROVIDER_NAMES };

/**
 * Zero-billable liveness check for a DEVIN_CONNECT session token.
 *
 * Reuses GetUserStatus (a free seat-management RPC — no model inference, no
 * token billing) purely to learn whether the session_id is still accepted
 * upstream. A 200 means alive; UNAUTHORIZED (401/403) means the server retired
 * the session_id and the account is dead until re-login.
 *
 * This is the early-warning probe: run it on a schedule (or before handing an
 * account a real request) so a dead token is caught — and recovered via
 * re-login — before a user request ever lands on it.
 *
 * @param {object} opts
 * @param {string} opts.token  session token to probe (required for pooled accounts)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{alive:boolean, plan?:string, code?:string, error?:string}>}
 *   Never throws — failures are returned as { alive:false, code, error }.
 */
export async function checkSessionLiveness({ token, signal, env = process.env } = {}) {
  try {
    const { plan } = await fetchUserStatus({ token, signal, env });
    return { alive: true, plan };
  } catch (e) {
    return { alive: false, code: e.code || 'UPSTREAM_ERROR', error: e.message };
  }
}

// ─── AssignModel — router-model resolution ──────────────────────────────────
//
// "Router" models (adaptive, arena-*) are not real model_uids — they're a
// router that the server resolves to a concrete model per request. The Windsurf
// client detects is_model_router=true and makes an AssignModel unary RPC FIRST,
// gets back a ModelAssignment{ model_uid, assignment_jwt, harness_uids }, then
// issues GetChatMessage with the RESOLVED model_uid. WindsurfAPI never made that
// hop, so every router model was rejected upstream (D4 §6).
//
// Wire calibration status (recon P2-apiserver-methods-fields.md §1):
//   - method path + ResponseMsg shape (AssignModelResponse{ assignment },
//     ModelAssignment{ model_uid, assignment_jwt, harness_uids }) are VERIFIED
//     from binary strings.
//   - all TAG NUMBERS are UNKNOWN (prost left no constants). Same situation as
//     billing/vision: we use the most-likely tag-1-first layout as the default
//     and let an operator override every tag via env once a real AssignModel
//     round-trip is captured on a paid account. Defaults are isolated so a wrong
//     guess is one env var away from fixed, never a code change.
const ASSIGN_MODEL_PATH = '/exa.api_server_pb.ApiServerService/AssignModel';

// Default tag guesses (override via DEVIN_CONNECT_ASSIGN_TAGS). Field NAMES are
// verified; only the integer tags are guessed (sequential from 1, the prost
// default when fields are declared in order with no explicit gaps).
const ASSIGN_TAGS_DEFAULT = Object.freeze({
  req_model_uid: 2,      // request: model_uid string (after client-meta #1)
  resp_assignment: 1,    // AssignModelResponse.assignment (message)
  asg_model_uid: 1,      // ModelAssignment.model_uid (string)
  asg_jwt: 2,            // ModelAssignment.assignment_jwt (string)
  asg_harness: 3,        // ModelAssignment.harness_uids (repeated string)
});

/**
 * Parse DEVIN_CONNECT_ASSIGN_TAGS overrides, e.g.
 *   "req_model_uid=2,resp_assignment=1,asg_model_uid=1,asg_jwt=2,asg_harness=3"
 * Unknown keys / non-positive-int tags are ignored. Returns the default map with
 * any valid overrides applied.
 */
export function parseAssignTags(env = process.env) {
  const map = { ...ASSIGN_TAGS_DEFAULT };
  const raw = String(env.DEVIN_CONNECT_ASSIGN_TAGS || '').trim();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [key, tag] = pair.split('=').map((s) => s.trim());
    const n = Number.parseInt(tag, 10);
    if (key in ASSIGN_TAGS_DEFAULT && Number.isInteger(n) && n > 0) map[key] = n;
  }
  return map;
}

/**
 * Is this model name a router that needs an AssignModel hop before chat?
 * `adaptive` and the `arena-*` family are the known routers (D4 §6). Extendable
 * via DEVIN_CONNECT_ROUTER_MODELS (comma-separated names/prefixes, `*` suffix
 * for prefix match).
 */
export function isRouterModel(name, env = process.env) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  const extra = String(env.DEVIN_CONNECT_ROUTER_MODELS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const patterns = ['adaptive', 'arena-*', ...extra];
  return patterns.some((p) =>
    p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p);
}

/** Encode the AssignModel request body (the extra fields after client-meta #1). */
export function encodeAssignModelRequest(modelUid, tags = ASSIGN_TAGS_DEFAULT) {
  return writeStringField(tags.req_model_uid, String(modelUid));
}

/**
 * Decode an AssignModelResponse → { model_uid, assignment_jwt, harness_uids }.
 * Returns null if the response carries no assignment (server's documented
 * "AssignModel returned empty assignment" case).
 */
export function decodeAssignModelResponse(raw, tags = ASSIGN_TAGS_DEFAULT) {
  const top = parseFields(raw);
  const asg = top.find((x) => x.field === tags.resp_assignment && x.wireType === 2);
  if (!asg) return null;
  const fields = parseFields(asg.value);
  const model_uid = strField(fields, tags.asg_model_uid);
  if (!model_uid) return null; // empty assignment
  const assignment_jwt = strField(fields, tags.asg_jwt);
  const harness_uids = fields
    .filter((x) => x.field === tags.asg_harness && x.wireType === 2)
    .map((x) => x.value.toString('utf8'));
  return { model_uid, assignment_jwt, harness_uids };
}

/**
 * Resolve a router model uid → a concrete ModelAssignment via the AssignModel
 * unary RPC. Throws a coded error on transport failure or an empty assignment so
 * the caller can fall back / surface a clean message instead of letting the
 * router uid hit GetChatMessage (where it's rejected).
 *
 * @returns {Promise<{model_uid, assignment_jwt, harness_uids}>}
 */
export async function assignModel({ token, modelUid, signal, env = process.env } = {}) {
  const sessionToken = token || getConnectToken(env);
  if (!sessionToken) throw Object.assign(new Error('DEVIN_CONNECT: no session token configured'), { code: 'NO_TOKEN' });
  if (!modelUid) throw Object.assign(new Error('AssignModel: modelUid required'), { code: 'BAD_REQUEST' });
  const tags = parseAssignTags(env);
  const raw = await unaryCall(ASSIGN_MODEL_PATH, sessionToken, {
    signal,
    extraBody: encodeAssignModelRequest(modelUid, tags),
  });
  const assignment = decodeAssignModelResponse(raw, tags);
  if (!assignment) {
    throw Object.assign(new Error(`AssignModel returned empty assignment for '${modelUid}'`), { code: 'ASSIGN_EMPTY' });
  }
  log.info(`DEVIN_CONNECT AssignModel: router '${modelUid}' → '${assignment.model_uid}'`);
  return assignment;
}
