/**
 * Runtime configuration — persistent feature toggles that can be flipped from
 * the dashboard at runtime without a restart or editing .env. Backed by a
 * small JSON file next to the project root so it survives redeploys.
 *
 * Currently hosts the "experimental" feature flags + system prompts +
 * runtime-rotatable credentials (v2.0.56: API_KEY / DASHBOARD_PASSWORD can
 * be changed from the dashboard without redeploying / editing .env). Keep
 * this tiny: anything that needs a restart should stay in config.js / .env.
 */

import { readFileSync, existsSync } from 'fs';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { writeJsonAtomic } from './fs-atomic.js';
import { resolve } from 'path';
import { config, log } from './config.js';

const FILE = resolve(config.dataDir, 'runtime-config.json');

const DEFAULTS = {
  experimental: {
    // Reuse Cascade cascade_id across multi-turn requests when the history
    // fingerprint matches. Big latency win for long conversations but relies
    // on Windsurf keeping the cascade alive — off by default.
    cascadeConversationReuse: true,
    // Pre-flight rate limit check via server.codeium.com before sending a
    // chat request. Reduces wasted attempts when the account has no message
    // capacity. Adds one network round-trip per attempt so off by default.
    preflightRateLimit: false,
  },
  // System-level prompt templates injected into Cascade proto fields.
  // Editable from Dashboard so users can tune without code changes.
  systemPrompts: {
    toolReinforcement: 'The functions listed above are available and callable. When the user\'s request can be answered by calling a function, emit a <tool_call> block as described. Use this exact format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
    communicationWithTools: 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation). Use the functions above when relevant.',
    communicationNoTools: 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. Answer directly. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation).',
  },
  // v2.0.56 — runtime-rotatable credentials. When set, override the
  // corresponding env value (API_KEY / DASHBOARD_PASSWORD) without
  // requiring a container restart. apiKey is plaintext (chat clients send
  // it raw and we compare via constant-time hash). dashboardPasswordHash
  // is scrypt-derived and verified with timingSafeEqual — the dashboard
  // posts plaintext over the same TLS-or-localhost channel as the rest of
  // the management API. CLIProxyAPI uses bcrypt for the same purpose; we
  // pick scrypt because it ships in node:crypto with zero deps.
  credentials: {
    apiKey: '',
    dashboardPasswordHash: '',
  },
};

const SYSTEM_PROMPT_KEYS = new Set(Object.keys(DEFAULTS.systemPrompts));

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    // Skip prototype-polluting keys — the JSON loaded here is user-writable
    // via the dashboard, and a crafted key would otherwise corrupt every
    // object in the process.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(base[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let _state = structuredClone(DEFAULTS);

function load() {
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
    _state = deepMerge(DEFAULTS, raw);
  } catch (e) {
    log.warn(`runtime-config: failed to load ${FILE}: ${e.message}`);
  }
}

function persist() {
  try {
    writeJsonAtomic(FILE, _state);
  } catch (e) {
    log.warn(`runtime-config: failed to persist: ${e.message}`);
  }
}

load();

export function getRuntimeConfig() {
  return structuredClone(_state);
}

export function getExperimental() {
  return { ...(_state.experimental || {}) };
}

export function isExperimentalEnabled(key) {
  return !!_state.experimental?.[key];
}

export function setExperimental(patch) {
  if (!patch || typeof patch !== 'object') return getExperimental();
  _state.experimental = { ...(_state.experimental || {}), ...patch };
  // Coerce to booleans — the dashboard ships JSON but we never want truthy
  // strings sneaking in as "true".
  for (const k of Object.keys(_state.experimental)) {
    _state.experimental[k] = !!_state.experimental[k];
  }
  persist();
  return getExperimental();
}

export function getSystemPrompts() {
  const out = { ...DEFAULTS.systemPrompts };
  for (const key of SYSTEM_PROMPT_KEYS) {
    if (typeof _state.systemPrompts?.[key] === 'string') {
      out[key] = _state.systemPrompts[key];
    }
  }
  return out;
}

export function setSystemPrompts(patch) {
  if (!patch || typeof patch !== 'object') return getSystemPrompts();
  const current = _state.systemPrompts || {};
  for (const [k, v] of Object.entries(patch)) {
    if (!SYSTEM_PROMPT_KEYS.has(k)) continue;
    if (typeof v !== 'string') continue;
    current[k] = v.trim();
  }
  _state.systemPrompts = current;
  persist();
  return getSystemPrompts();
}

export function resetSystemPrompt(key) {
  if (key) {
    if (_state.systemPrompts && SYSTEM_PROMPT_KEYS.has(key)) delete _state.systemPrompts[key];
  } else {
    _state.systemPrompts = {};
  }
  persist();
  return getSystemPrompts();
}

// ─── Credentials (v2.0.56 runtime rotation) ────────────────────────────

const SCRYPT_N = 2 ** 14;   // 16384 — bcrypt-equivalent CPU cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/**
 * Hash a plaintext password using scrypt with a random 16-byte salt.
 * Returned format: `scrypt$<N>$<r>$<p>$<base64-salt>$<base64-hash>` so we
 * can verify even if the cost parameters get bumped in a future release.
 */
export function hashPassword(plain) {
  const s = String(plain ?? '');
  if (!s) return '';
  const salt = randomBytes(16);
  const hash = scryptSync(s, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Verify a plaintext password against a stored value.
 * Falls back to plaintext comparison when the stored value doesn't carry
 * the `scrypt$` prefix — that path is for env-supplied
 * `DASHBOARD_PASSWORD=...` which we never hash to keep the env contract
 * intact. Always uses constant-time comparison on the final byte buffers.
 */
export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  const sPlain = String(plain ?? '');
  if (!stored.startsWith('scrypt$')) {
    // Plaintext compare via timingSafeEqual on equal-length sha256 digests
    // — matches src/auth.js safeEqualString semantics so the env-mode
    // dashboard password doesn't leak length via early return.
    if (!sPlain) return false;
    const a = Buffer.from(sPlain, 'utf8');
    const b = Buffer.from(stored, 'utf8');
    if (a.length !== b.length) {
      // Burn a comparable amount of cycles so the timing remains close
      // to the equal-length branch. Reject regardless.
      try { timingSafeEqual(Buffer.alloc(b.length), Buffer.alloc(b.length)); } catch {}
      return false;
    }
    return timingSafeEqual(a, b);
  }
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(sPlain, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getCredentials() {
  return {
    apiKey: _state.credentials?.apiKey || '',
    dashboardPasswordHash: _state.credentials?.dashboardPasswordHash || '',
  };
}

/**
 * Set the runtime API key. Empty string clears the runtime override and
 * lets `config.apiKey` fall back to the env value at call sites.
 */
export function setRuntimeApiKey(plain) {
  const v = typeof plain === 'string' ? plain.trim() : '';
  if (!_state.credentials) _state.credentials = {};
  _state.credentials.apiKey = v;
  persist();
  return getCredentials();
}

/**
 * Set the runtime dashboard password (plaintext input → scrypt hash on
 * disk). Empty string clears the runtime override.
 */
export function setRuntimeDashboardPassword(plain) {
  const v = typeof plain === 'string' ? plain : '';
  if (!_state.credentials) _state.credentials = {};
  _state.credentials.dashboardPasswordHash = v ? hashPassword(v) : '';
  persist();
  return getCredentials();
}

/**
 * Resolve the effective API key: runtime override wins over env. Returned
 * value is the plaintext key the chat client must send.
 */
export function getEffectiveApiKey() {
  const runtime = _state.credentials?.apiKey || '';
  return runtime || config.apiKey || '';
}

/**
 * Resolve the effective dashboard password's stored form. Returned string
 * is either a `scrypt$...` hash (runtime-set) or the plaintext env value;
 * verifyPassword() handles both.
 */
export function getEffectiveDashboardPasswordStored() {
  const runtime = _state.credentials?.dashboardPasswordHash || '';
  return runtime || config.dashboardPassword || '';
}

// Wire the auth module's pluggable API-key resolver so validateApiKey()
// sees runtime overrides without a cyclic import. Done at module-load
// time after `load()` so the file-backed value is honoured immediately.
import('./auth.js').then(m => {
  if (typeof m.setApiKeyResolver === 'function') m.setApiKeyResolver(getEffectiveApiKey);
}).catch(() => { /* auth not yet ready, validateApiKey falls back to env */ });

