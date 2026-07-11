import { createHash } from 'crypto';
import { log } from './config.js';

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

// A body field only carries a usable scope signal when it's a string with
// non-whitespace content. An empty/whitespace value must NOT mint a scope:
// user:"" would otherwise hash to the constant sha256("") prefix
// (e3b0c44298fc1c14...), collapsing every distinct end user of a shared key
// into one :user: segment and re-enabling cross-tenant cascade/cache bleed.
// Returns the TRIMMED non-empty string, else ''. Trimming matters: returning the
// raw value made " alice " and "alice" hash into different :user: buckets, so the
// same end user got split tenant scopes across requests with incidental
// whitespace. (audit S6)
function usableSignal(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

// Extract a per-user / per-session signal from the request body so two
// different end users sharing one API key get different conversation pool
// scopes. v2.0.25 HIGH-3: chat & responses now look at body.user /
// conversation / previous_response_id / metadata.{conversation_id,session_id}.
//
// metadata.user_id is INTENTIONALLY NOT inspected here — handlers/messages.js
// has a specialized parser for it (Claude Code's JSON-encoded
// {device_id, session_id, account_uuid} shape) and appends its own
// `:user:<digest>` to keep the two extraction paths from double-stamping
// the same callerKey.
//
// The returned subkey is appended to the API-key callerKey so reuse stays
// pinned to (apiKey, user/session). Returns '' when no usable signal.
export function extractBodyCallerSubKey(body) {
  if (!body || typeof body !== 'object') return '';
  const user = usableSignal(body.user);
  if (user) return sha256Hex(user).slice(0, 16);
  const candidates = [
    usableSignal(body?.metadata?.conversation_id),
    usableSignal(body.conversation),
    usableSignal(body.previous_response_id),
    usableSignal(body?.metadata?.session_id),
  ].filter(Boolean);
  if (!candidates.length) return '';
  return sha256Hex(candidates.join('|')).slice(0, 16);
}

// IP + UA fallback used when an apiKey-mode caller has no explicit body
// user signal. Without this, every Claude Code / claudecode CLI on a
// self-hosted single-user setup hits "shared API key, no per-user scope"
// and cascade reuse stays disabled — exactly the symptom reported in
// #93 follow-up by zhangzhang-bit (claude-opus-4-6-thinking, msgs growing
// 33→97 across turns, reuse=false on every Cascade started).
//
// Two physical clients sharing one apiKey will land on different IP/UA
// hashes and stay isolated; same client across turns lands on the same
// hash and lets the cascade pool reuse the upstream session.
//
// v2.0.55 (audit H2): X-Forwarded-For is attacker-controllable and was
// being trusted by default. An attacker with the shared API key could
// spoof XFF + UA to land in another user's caller bucket and inherit
// their cascade-pool state. We now read socket.remoteAddress by default
// and only honour XFF when the operator opts in via
// TRUST_PROXY_X_FORWARDED_FOR=1. Operators behind a trusted reverse
// proxy (nginx LB, Cloudflare, etc.) should set the env var; everyone
// else gets a non-spoofable fingerprint by default.
const TRUST_PROXY_XFF = process.env.TRUST_PROXY_X_FORWARDED_FOR === '1';

// XFF-1 (audit P1): the LEFTMOST X-Forwarded-For value is fully attacker-
// controllable — a client just prepends any IP and it lands at the front of
// the list. Trusted reverse proxies (nginx `$proxy_add_x_forwarded_for`,
// Cloudflare, etc.) APPEND the peer they received the connection from to the
// RIGHT, so the trustworthy client IP is counted from the right by the number
// of trusted proxy hops in front of us (TRUST_PROXY_HOPS, default 1 = a single
// proxy). Taking the leftmost let an attacker with the shared key rotate the
// value on every request to dodge the brute-force lockout (each spoof lands in
// a fresh bucket, never reaching the 5-strike threshold) or aim a chosen IP to
// land in — and poison — another caller's cascade/cache bucket.
function trustedProxyHops() {
  const raw = Number(process.env.TRUST_PROXY_HOPS);
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

function clientIp(req) {
  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  if (!TRUST_PROXY_XFF) return remote;
  const parts = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) return remote;
  // The last `hops` entries were appended by our trusted proxy chain; the real
  // client IP is the entry just before them. If the header is shorter than the
  // configured hop count it can't be trusted — fall back to the socket peer.
  const idx = parts.length - trustedProxyHops();
  return (idx >= 0 ? parts[idx] : '') || remote;
}

function ipUaFingerprint(req) {
  const ip = clientIp(req);
  const ua = req?.headers?.['user-agent'] || '';
  if (!ip && !ua) return '';
  return sha256Hex(`${ip}\0${ua}`).slice(0, 16);
}

export function callerKeyFromRequest(req, apiKey = '', body = null) {
  const bodySubKey = body ? extractBodyCallerSubKey(body) : '';
  const hasUserInBody = !!(body && usableSignal(body.user));
  // Don't log the raw body.user — OpenAI's `user` field is often an end-user
  // email or stable account id (PII). bodySubKey is already its hash.
  log.info('[caller-key] hasUser=%s subKey=%s', hasUserInBody ? 'yes' : 'no', bodySubKey || '(none)');
  if (apiKey) {
    const base = `api:${sha256Hex(apiKey).slice(0, 32)}`;
    if (bodySubKey) return `${base}:user:${bodySubKey}`;
    const ipua = ipUaFingerprint(req);
    return ipua ? `${base}:client:${ipua}` : base;
  }
  const sessionId = req?.headers?.['x-dashboard-session'] || req?.headers?.['x-session-id'] || '';
  if (sessionId) {
    const base = `session:${sha256Hex(sessionId).slice(0, 32)}`;
    return bodySubKey ? `${base}:user:${bodySubKey}` : base;
  }
  const ip = clientIp(req);
  const ua = req?.headers?.['user-agent'] || '';
  const base = `client:${sha256Hex(`${ip}\0${ua}`).slice(0, 32)}`;
  return bodySubKey ? `${base}:user:${bodySubKey}` : base;
}

// NOTE: a `hasCallerScope()` export used to live here. It was DEAD (zero
// production imports — grep) and had silently diverged from the LIVE gate
// `hasPerUserScope()` in src/handlers/chat.js (the live one gates the guessed
// `:client:` bucket behind SINGLE_TENANT_CACHE; this dead twin trusted it
// unconditionally). Keeping a diverged, more-permissive copy exported was a
// cross-tenant-cache landmine if anyone had imported it. Removed 2026-07-11
// (audit S1). The authoritative scope gate is chat.js:hasPerUserScope.
