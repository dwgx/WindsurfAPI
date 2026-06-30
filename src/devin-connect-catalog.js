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
import { parseFields, writeStringField, writeMessageField } from './proto.js';
import { getConnectToken } from './devin-connect.js';

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
 */
function unaryCall(path, token, { signal, timeoutMs = 30000 } = {}) {
  const body = writeMessageField(1, buildClientMetadata(token));
  const authHeader = `Basic ${token}-${token}`;
  return new Promise((resolve, reject) => {
    const req = https.request({
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
          const code = res.statusCode === 401 || res.statusCode === 403 ? 'UNAUTHORIZED'
            : res.statusCode === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
          reject(Object.assign(new Error(`${path} HTTP ${res.statusCode}: ${text}`), { code, status: res.statusCode }));
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
