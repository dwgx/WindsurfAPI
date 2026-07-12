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
    // v2.0.58 — Drought mode: when every active account has weekly% < 5,
    // block premium models from routing (free-tier models still go
    // through). Default ON so the proxy stops burning upstream calls
    // that would 429 anyway. Can be turned off if operator prefers
    // graceful degradation over hard refusal.
    droughtRestrictPremium: true,
    // When enabled with STICKY_SESSION_ENABLED=1, the sticky session
    // binding ignores the model dimension — a user gets the same
    // upstream account regardless of which model they request.
    // Default OFF to preserve per-model isolation (avoids routing
    // requests through an account that may not entitle that model).
    stickyBindByUserOnly: false,
    // When enabled, a sticky-bound account that fails (rate_limit,
    // upstream_error, model_not_available) does NOT trigger account
    // rotation. The request fails back to the client immediately
    // instead of burning through other accounts in the pool.
    // Requires STICKY_SESSION_ENABLED=1. Default OFF.
    stickyNoFallback: false,
    // Native tool_call over the DEVIN_CONNECT wire. When ON, tool definitions
    // ride the calibrated protobuf #10 ToolDef field and responses decode the
    // native #6 ChatToolCall — instead of prompt emulation (<tool_call> markup).
    // Tags are VERIFIED (def "10,1,2,3" paid-confirmed, call tags static-disasm
    // pinned). Default ON: paid E2E on 2026-07-08 confirmed opus AND fable run
    // clean multi-turn on the native wire (mode=NATIVE, preamble off, zero empty
    // replies) — the native path also sidesteps the emulation tool-count ceiling
    // that made fable go empty. Flip to false to fall back to prompt emulation.
    nativeToolCall: true,
  },
  // v2.0.150 — operator-tunable numeric knobs. Kept out of `experimental`
  // (which coerces everything to boolean). Dashboard-settable.
  tunables: {
    // Weekly-quota % at or below which an account counts toward drought mode
    // (isDroughtMode + premium-model gating). Lower = more tolerant of low
    // balances before the pool is considered dry.
    droughtThresholdPercent: 5,
    // Login-lockout knobs, operator-tunable from the Settings page. A THRESHOLD
    // of 0 DISABLES that lockout entirely. Defaults match the historical
    // hardcoded values so behavior is unchanged until an operator lowers them.
    emailLockThreshold: 3,   // failed email logins before that email is locked
    emailLockMinutes: 15,    // how long an email stays locked
    ipLockThreshold: 5,      // failed dashboard auths before that IP is banned
    ipLockMinutes: 30,       // how long an IP stays banned
  },
  // v3.0.2 — backend routing switches, migrated from process.env so an
  // operator can hot-flip them from the Settings page WITHOUT a redeploy.
  // null means "not set → fall back to the corresponding env var, then the
  // historical default". This is the backward-compat contract: an old deploy
  // that only set env vars keeps its exact behaviour because every key here
  // starts null. NOTE the two credential-store env switches
  // (DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE / DEVIN_CONNECT_CRED_KEY) are
  // deliberately NOT here — they are a security boundary and must stay
  // env-only so a compromised dashboard can't self-authorize remote password
  // storage / key placement.
  backendSwitches: {
    devinConnect: null,       // DEVIN_CONNECT — pure-HTTP cloud egress kill-switch
    devinOnly: null,          // DEVIN_ONLY — Cascade retired, force Devin CLI
    devinCliMode: null,       // DEVIN_CLI_MODE — 'acp' | 'print' sub-mode
    allowClientTools: null,   // DEVIN_CLI_ALLOW_CLIENT_TOOLS — expose caller tools
    loginHostFallback: null,  // DEVIN_CONNECT_LOGIN_HOST_FALLBACK — devin.ai auth1 fallback
    autoRelogin: null,        // DEVIN_CONNECT_AUTO_RELOGIN — dead-token recovery
  },
  // v3.0.3 — circuit-breaker / rate-limit tunables migrated from the
  // WINDSURFAPI_* env vars + hardcoded auth.js constants so an operator can
  // hot-flip thresholds from Settings WITHOUT a redeploy. Same three-tier
  // contract as backendSwitches: null = "unset → env var, then historical
  // default". Every key starts null so an env-only deploy is byte-identical.
  breaker: {
    errorStreakThreshold: null, errorWindowMs: null,
    internalErrorThreshold: null, internalQuarantineMs: null,
    errorRecoveryMs: null, breakerEnabled: null, breakerBaseMs: null,
    breakerFactor: null, breakerMaxMs: null, breakerStreakStart: null,
    newAccountGraceMs: null, lastAccountExempt: null, newAccountBaseline: null,
    rlClientBackoffFloorMs: null, rlClientBackoffCeilMs: null, rlBurstMs: null,
    degradedServe: null,
  },
  // v3.0.3 — quota / on-demand spend policy. Governs what happens when an
  // account's INCLUDED weekly quota runs dry (applyQuotaSnapshot in auth.js).
  // Same three-tier contract as breaker: null = "unset → env var, then
  // historical default", so an env-only deploy is byte-identical. spendOnDemand
  // = when the included quota is dry, may the account keep serving by billing
  // to its prepaid on-demand ($) balance? Default true = keep serving (matches
  // the 52e255f behaviour). onDemandReserveUsd = a floor on that balance: once
  // balance <= reserve the account is treated as dry and cooled, so it is never
  // burned all the way to zero. Default 0 = no reserve (spend to the last cent).
  quota: {
    cooldownEnabled: null,   // WINDSURFAPI_QUOTA_COOLDOWN — master on/off for quota cooldown
    cooldownMs: null,        // WINDSURFAPI_QUOTA_COOLDOWN_MS — how long a dry account is cooled
    dryThreshold: null,      // WINDSURFAPI_QUOTA_DRY_THRESHOLD — weeklyPercent at/under = dry
    spendOnDemand: null,     // global default: burn on-demand balance when included quota dry
    onDemandReserveUsd: null,// global default: keep at least $X of on-demand balance in reserve
  },
  // Dashboard UI preferences shared across browsers/devices (persisted here,
  // not in each browser's localStorage). Booleans only; toggle from the
  // global Settings page.
  prefs: {
    // When true, clicking a Google/GitHub OAuth login button skips the
    // "open page / copy URL" chooser popup and opens the login page directly.
    // Set via the popup's "don't ask again" checkbox; cleared from Settings.
    oauthSkipChooser: false,
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

export function _resetRuntimeConfigForTests(patch = {}) {
  _state = deepMerge(structuredClone(DEFAULTS), patch);
  return getRuntimeConfig();
}

export function getExperimental() {
  // Return only known flags (defaults filled in), so any orphan keys left in an
  // old runtime-config.json by a pre-whitelist client don't leak back out.
  const out = { ...DEFAULTS.experimental };
  for (const k of Object.keys(DEFAULTS.experimental)) {
    if (typeof _state.experimental?.[k] === 'boolean') out[k] = _state.experimental[k];
  }
  return out;
}

export function isExperimentalEnabled(key) {
  return !!_state.experimental?.[key];
}

// Whitelist of valid experimental flags, derived from DEFAULTS so a new flag is
// covered automatically. A stale/hostile client can otherwise inject arbitrary
// boolean junk keys that persist forever.
const EXPERIMENTAL_KEYS = new Set(Object.keys(DEFAULTS.experimental));

export function setExperimental(patch) {
  if (!patch || typeof patch !== 'object') return getExperimental();
  const next = { ...(_state.experimental || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!EXPERIMENTAL_KEYS.has(k)) continue; // reject unknown keys
    next[k] = !!v; // coerce to boolean — never let truthy strings sneak in
  }
  _state.experimental = next;
  persist();
  return getExperimental();
}

export function getTunables() {
  return { ...(_state.tunables || {}) };
}

// Weekly-quota % threshold for drought mode. Clamped to [0, 100]; falls back
// to the default (5) when unset or out of range.
export function getDroughtThresholdPercent() {
  const v = Number(_state.tunables?.droughtThresholdPercent);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 5;
}

// Numeric tunables with their [min,max] clamps. Keeps setTunables data-driven
// so the Settings page and any new knob stay in one table.
const TUNABLE_BOUNDS = {
  droughtThresholdPercent: [0, 100],
  emailLockThreshold: [0, 50],
  emailLockMinutes: [0, 1440],
  ipLockThreshold: [0, 100],
  ipLockMinutes: [0, 1440],
};

export function setTunables(patch) {
  if (!patch || typeof patch !== 'object') return getTunables();
  const next = { ...(_state.tunables || {}) };
  for (const [key, [min, max]] of Object.entries(TUNABLE_BOUNDS)) {
    if (patch[key] == null) continue;
    const raw = patch[key];
    // Only accept a real number or a non-empty numeric string. Guard against
    // '' / '  ' / [] / false — all of which Number() coerces to 0 and would
    // SILENTLY disable a lockout (a cleared input box saving as "off").
    if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim() !== '')) continue;
    const v = Number(raw);
    if (Number.isFinite(v)) next[key] = Math.max(min, Math.min(max, v));
  }
  _state.tunables = next;
  persist();
  return getTunables();
}

// Accessors for the lockout knobs (0 = disabled). Read by auth.js /
// windsurf-login.js so a Settings change takes effect without restart.
export function getEmailLockThreshold() { const v = Number(_state.tunables?.emailLockThreshold); return Number.isFinite(v) && v >= 0 ? v : 3; }
export function getEmailLockMs() { const v = Number(_state.tunables?.emailLockMinutes); return (Number.isFinite(v) && v >= 0 ? v : 15) * 60 * 1000; }
export function getIpLockThreshold() { const v = Number(_state.tunables?.ipLockThreshold); return Number.isFinite(v) && v >= 0 ? v : 5; }
export function getIpLockMs() { const v = Number(_state.tunables?.ipLockMinutes); return (Number.isFinite(v) && v >= 0 ? v : 30) * 60 * 1000; }

// Dashboard UI preferences (booleans, shared across browsers). Unknown keys are
// ignored so a stale/hostile client can't inject arbitrary config.
const PREF_KEYS = Object.keys(DEFAULTS.prefs);

export function getPrefs() {
  const out = { ...DEFAULTS.prefs };
  for (const k of PREF_KEYS) {
    if (typeof _state.prefs?.[k] === 'boolean') out[k] = _state.prefs[k];
  }
  return out;
}

export function setPrefs(patch) {
  if (!patch || typeof patch !== 'object') return getPrefs();
  const next = { ...(_state.prefs || {}) };
  for (const k of PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = !!patch[k];
  }
  _state.prefs = next;
  persist();
  return getPrefs();
}

// ─── Backend routing switches (v3.0.2 — env → runtime-config migration) ──
//
// Each switch has three-tier resolution:
//   1. runtime-config override (a boolean or, for devinCliMode, a string) wins
//   2. else the corresponding process.env var (the historical source)
//   3. else the historical default
// A null in _state.backendSwitches means "unset → fall through to env". This
// preserves old deploys exactly: they set only env, so every override is null
// and resolution is identical to the pre-migration env-only reads.

// Maps each switch key to its env var name. The env value is only consulted
// when the runtime-config override is null (unset).
const BACKEND_SWITCH_ENV = {
  devinConnect: 'DEVIN_CONNECT',
  devinOnly: 'DEVIN_ONLY',
  devinCliMode: 'DEVIN_CLI_MODE',
  allowClientTools: 'DEVIN_CLI_ALLOW_CLIENT_TOOLS',
  loginHostFallback: 'DEVIN_CONNECT_LOGIN_HOST_FALLBACK',
  autoRelogin: 'DEVIN_CONNECT_AUTO_RELOGIN',
};
const BACKEND_SWITCH_KEYS = new Set(Object.keys(BACKEND_SWITCH_ENV));

// Boolean switches read env as: exact "1" (whitespace-tolerant) = true. This
// matches every legacy call site (String(env.X||'').trim() === '1').
function envIsOne(env, name) {
  return String(env?.[name] ?? '').trim() === '1';
}

/**
 * Resolve a backend switch to its effective value.
 *
 * @param {string} key one of BACKEND_SWITCH_KEYS
 * @param {object} [env] env source (injectable for tests / pure call sites).
 *                       Defaults to process.env.
 * @returns {boolean|string} boolean for the flag switches; 'acp'|'print' for
 *                           devinCliMode.
 */
export function getBackendSwitch(key, env = process.env) {
  const override = _state.backendSwitches?.[key];
  if (key === 'devinCliMode') {
    // String enum: runtime override wins if it's a valid mode, else env, else
    // the historical 'print' default.
    if (override === 'acp' || override === 'print') return override;
    const raw = String(env?.DEVIN_CLI_MODE ?? '').trim().toLowerCase();
    return raw === 'acp' ? 'acp' : 'print';
  }
  // Boolean switches: an explicit boolean override wins; otherwise env.
  if (typeof override === 'boolean') return override;
  const envName = BACKEND_SWITCH_ENV[key];
  return envName ? envIsOne(env, envName) : false;
}

export function getBackendSwitches(env = process.env) {
  const out = {};
  for (const key of BACKEND_SWITCH_KEYS) out[key] = getBackendSwitch(key, env);
  return out;
}

/**
 * Read the raw override map (null = unset). Used by the dashboard so it can
 * distinguish "operator set this" from "falling back to env".
 */
export function getBackendSwitchOverrides() {
  const out = {};
  for (const key of BACKEND_SWITCH_KEYS) {
    const v = _state.backendSwitches?.[key];
    out[key] = v === undefined ? null : v;
  }
  return out;
}

/**
 * Apply a patch to the backend switches. Whitelisted keys only. A value of
 * null CLEARS the override (falls back to env). Booleans are coerced for the
 * flag switches; devinCliMode accepts only 'acp' | 'print'. Everything else
 * for a given key is ignored (leaves the prior override untouched).
 */
export function setBackendSwitches(patch) {
  if (!patch || typeof patch !== 'object') return getBackendSwitchOverrides();
  const next = { ...(_state.backendSwitches || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!BACKEND_SWITCH_KEYS.has(k)) continue; // reject unknown keys
    if (v === null) { next[k] = null; continue; } // explicit clear → env fallback
    if (k === 'devinCliMode') {
      const m = String(v).trim().toLowerCase();
      if (m === 'acp' || m === 'print') next[k] = m; // ignore junk
      continue;
    }
    next[k] = !!v; // boolean switches — coerce; truthy strings never sneak in
  }
  _state.backendSwitches = next;
  persist();
  return getBackendSwitchOverrides();
}

// ─── Circuit-breaker / rate-limit tunables (v3.0.3 env→runtime-config) ──
// Table-driven. Each entry: env var, kind, historical default, [min,max] for
// the OVERRIDE path. The ENV path replicates each helper's ORIGINAL guard
// exactly (env-only deploys unchanged); only an explicit override is clamped.
// breakerBaseMs def:null means "resolve to errorRecoveryMs" (dynamic default).
const BREAKER_TUNABLES = {
  errorStreakThreshold:   { env: 'WINDSURFAPI_ERROR_STREAK_THRESHOLD',   kind: 'int',   def: 3,       min: 1,    max: 50 },
  errorWindowMs:          { env: 'WINDSURFAPI_ERROR_WINDOW_MS',          kind: 'int',   def: 1800000, min: 1000, max: 86400000 },
  internalErrorThreshold: { env: 'WINDSURFAPI_INTERNAL_ERROR_THRESHOLD', kind: 'int',   def: 2,       min: 1,    max: 50 },
  // L1 (2026-07-10): internal-error quarantine window. Cut from the historical
  // 300000 (5min) to 120000 (2min), toward KiroStudio's hard-won short-cooldown
  // philosophy (RESEARCH-RATELIMIT-DYNAMIC capped short cooldowns at 90s because
  // a longer window "把小号池下一个卡住请求压死数分钟"). An upstream internal
  // error is a TRANSIENT backend fault that self-heals in seconds~a minute; 5min
  // was punitive. 2min (not 90s) keeps the value clean in the minute-granular
  // settings UI. In a multi-account pool this lets a quarantined account rejoin
  // 3min sooner; in a single-account pool F1' (tier exemption) + L2 (degraded-
  // serve) already prevent the blackout, so this is defence-in-depth. Env/
  // override still accept any value in [1s, 24h].
  internalQuarantineMs:   { env: 'WINDSURFAPI_INTERNAL_QUARANTINE_MS',   kind: 'int',   def: 120000,  min: 1000, max: 86400000 },
  errorRecoveryMs:        { env: 'WINDSURFAPI_ERROR_RECOVERY_MS',        kind: 'int',   def: 900000,  min: 1000, max: 86400000 },
  breakerEnabled:         { env: 'WINDSURFAPI_BREAKER',                  kind: 'bool',  def: true },
  breakerBaseMs:          { env: 'WINDSURFAPI_BREAKER_BASE_MS',          kind: 'int',   def: null,    min: 1000, max: 86400000 },
  breakerFactor:          { env: 'WINDSURFAPI_BREAKER_FACTOR',           kind: 'float', def: 1.5,     min: 1.1,  max: 10 },
  breakerMaxMs:           { env: 'WINDSURFAPI_BREAKER_MAX_MS',           kind: 'int',   def: 3600000, min: 1000, max: 86400000 },
  breakerStreakStart:     { env: 'WINDSURFAPI_BREAKER_STREAK_START',     kind: 'int',   def: 2,       min: 1,    max: 50 },
  newAccountGraceMs:      { env: 'WINDSURFAPI_NEW_ACCOUNT_GRACE_MS',     kind: 'int',   def: 600000,  min: 0,    max: 86400000 },
  lastAccountExempt:      { env: 'WINDSURFAPI_LAST_ACCOUNT_EXEMPT',      kind: 'bool',  def: true },
  newAccountBaseline:     { env: 'WINDSURFAPI_NEW_ACCOUNT_BASELINE',     kind: 'bool',  def: true },
  // F3 (2026-07-10): client-replay mitigation. When we surface a 429 to an agent
  // client (Claude Code honours Retry-After for its auto-retry backoff), floor the
  // advertised Retry-After so the client waits a useful minimum instead of hot-
  // looping (a 1s hint = immediate re-hammer), and ceil it so an over-long upstream
  // reset window can't freeze the client for minutes. def 30000 (30s) as of
  // 2026-07-12: the 429 mitigation is ON by default — a floor of 30s breaks the
  // "immediate re-hammer → re-cooldown → lock" loop that benched the account pool
  // under Claude Code / OpenCode auto-retry. Set 0 to disable the floor (revert to
  // the old byte-identical behaviour). Ceil default 600000 (10min) is a pure safety
  // clamp that only ever shortens an absurd hint.
  rlClientBackoffFloorMs: { env: 'WINDSURFAPI_RL_CLIENT_BACKOFF_FLOOR_MS', kind: 'int', def: 30000,  min: 0,    max: 600000 },
  rlClientBackoffCeilMs:  { env: 'WINDSURFAPI_RL_CLIENT_BACKOFF_CEIL_MS',  kind: 'int', def: 600000, min: 1000, max: 86400000 },
  // F2 (2026-07-10): duration of the account-wide cooldown applied to a BARE 429
  // (RATE_LIMITED with no upstream reset window). def 15000 (15s) as of 2026-07-12
  // — the historical value was 300000 (5min). KiroStudio's production data
  // (PLAN-RETRY-AMPLIFICATION-FIX-0708) showed bare bursts self-heal in seconds, so
  // benching an account for 5min on a transient burst was a small-pool sinkhole.
  // The breaker's exponential backoff still lengthens the cooldown if the SAME
  // account keeps tripping, so a genuine (non-transient) limit isn't under-served.
  // Set 300000 to revert. A 429 WITH a parsed reset window still honours the
  // upstream value (model-scoped), unaffected by this.
  rlBurstMs:              { env: 'WINDSURFAPI_RL_BURST_MS',                kind: 'int', def: 15000,  min: 1000, max: 86400000 },
  // L2 (2026-07-10): degraded-serve fallback. When the hard account filter leaves
  // ZERO candidates (whole entitled pool transiently throttled), serve the least-
  // bad transiently-cooled account instead of returning 429. def TRUE as of
  // 2026-07-12 (the 429 mitigation is on): serving a slightly-cooled account beats
  // blacking out the whole pool with a 429. This is the architectural replacement
  // for the isLastUsableAccount exemption patch: it covers a single-account pool
  // AND any all-throttled pool without a special "last account" rule. STRICT scope
  // (see pickDegradedFallback): only transient rateLimitedUntil qualifies — never
  // quota dry-wells, dead accounts, or tier-ineligible ones, so it can't turn a
  // real fault into a degraded gamble. Set false to revert to hard fast-429.
  degradedServe:          { env: 'WINDSURFAPI_DEGRADED_SERVE',            kind: 'bool', def: true },
};
const BREAKER_KEYS = new Set(Object.keys(BREAKER_TUNABLES));

// Breaker bool env semantics: default ON, only literal '0' turns off (matches
// legacy `env.X !== '0'`). UNSET env stays default (true).
function breakerEnvNotZero(env, name) {
  return String(env?.[name] ?? '').trim() !== '0';
}

// Resolve one knob: override (clamped) → env (legacy guard) → historical default.
export function getBreakerTunable(key, env = process.env) {
  const spec = BREAKER_TUNABLES[key];
  if (!spec) return undefined;
  const override = _state.breaker?.[key];
  if (spec.kind === 'bool') {
    if (typeof override === 'boolean') return override;
    if (env?.[spec.env] != null && String(env[spec.env]).trim() !== '')
      return breakerEnvNotZero(env, spec.env);
    return spec.def;
  }
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(spec.min, Math.min(spec.max, override));
  }
  // env path replicates ORIGINAL guard (factor strict >1; grace >=0; ms >=1000;
  // thresholds >=1) with NO max clamp — env-only deploy unchanged.
  const raw = Number(env?.[spec.env]);
  const strict = key === 'breakerFactor';
  const floor = strict ? 1 : spec.min;
  if (Number.isFinite(raw) && (strict ? raw > floor : raw >= floor)) return raw;
  return (spec.def == null && key === 'breakerBaseMs')
    ? getBreakerTunable('errorRecoveryMs', env) : spec.def;
}
export function getBreakerTunables(env = process.env) {
  const out = {}; for (const k of BREAKER_KEYS) out[k] = getBreakerTunable(k, env); return out;
}
export function getBreakerOverrides() {
  const out = {};
  for (const k of BREAKER_KEYS) { const v = _state.breaker?.[k]; out[k] = v === undefined ? null : v; }
  return out;
}
// Apply patch. Whitelist only. null CLEARS (env fallback). Bools coerced;
// numerics clamped to [min,max]. Empty/whitespace string IGNORED (never coerced
// to 0) so a cleared box can't silently disable a safety knob (same as setTunables).
export function setBreakerTunables(patch) {
  if (!patch || typeof patch !== 'object') return getBreakerOverrides();
  const next = { ...(_state.breaker || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!BREAKER_KEYS.has(k)) continue;
    if (v === null) { next[k] = null; continue; }
    const spec = BREAKER_TUNABLES[k];
    if (spec.kind === 'bool') { next[k] = !!v; continue; }
    if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) continue;
    const n = Number(v);
    if (Number.isFinite(n)) next[k] = Math.max(spec.min, Math.min(spec.max, n));
  }
  _state.breaker = next; persist(); return getBreakerOverrides();
}

// ─── v3.0.3: quota / on-demand spend tunables ──────────────────────────────
// Migrated from the WINDSURFAPI_QUOTA_* env vars in auth.js. Same three-tier
// resolution (override → env → historical default) so env-only deploys are
// unchanged. bool env semantics match the legacy `env.X !== '0'` guard.
const QUOTA_TUNABLES = {
  cooldownEnabled:    { env: 'WINDSURFAPI_QUOTA_COOLDOWN',       kind: 'bool',  def: true },
  cooldownMs:         { env: 'WINDSURFAPI_QUOTA_COOLDOWN_MS',    kind: 'int',   def: 1800000, min: 1000, max: 86400000 },
  dryThreshold:       { env: 'WINDSURFAPI_QUOTA_DRY_THRESHOLD',  kind: 'int',   def: 0,       min: 0,    max: 100 },
  spendOnDemand:      { env: 'WINDSURFAPI_SPEND_ON_DEMAND',      kind: 'bool',  def: true },
  onDemandReserveUsd: { env: 'WINDSURFAPI_ON_DEMAND_RESERVE_USD',kind: 'float', def: 0,       min: 0,    max: 100000 },
};
const QUOTA_KEYS = new Set(Object.keys(QUOTA_TUNABLES));

// Resolve one quota knob: override (clamped) → env (legacy guard) → default.
export function getQuotaTunable(key, env = process.env) {
  const spec = QUOTA_TUNABLES[key];
  if (!spec) return undefined;
  const override = _state.quota?.[key];
  if (spec.kind === 'bool') {
    if (typeof override === 'boolean') return override;
    if (env?.[spec.env] != null && String(env[spec.env]).trim() !== '')
      return breakerEnvNotZero(env, spec.env);
    return spec.def;
  }
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(spec.min, Math.min(spec.max, override));
  }
  // env path replicates the ORIGINAL auth.js guard (ms/threshold >= min) with
  // no max clamp so an env-only deploy is byte-identical.
  const raw = Number(env?.[spec.env]);
  if (Number.isFinite(raw) && raw >= spec.min) return raw;
  return spec.def;
}
export function getQuotaTunables(env = process.env) {
  const out = {}; for (const k of QUOTA_KEYS) out[k] = getQuotaTunable(k, env); return out;
}
export function getQuotaOverrides() {
  const out = {};
  for (const k of QUOTA_KEYS) { const v = _state.quota?.[k]; out[k] = v === undefined ? null : v; }
  return out;
}
// Apply patch. Whitelist only. null CLEARS (env fallback). Bools coerced;
// numerics clamped. Empty/whitespace string IGNORED (never coerced to 0) so a
// cleared box can't silently flip a safety knob (same guard as setTunables).
export function setQuotaTunables(patch) {
  if (!patch || typeof patch !== 'object') return getQuotaOverrides();
  const next = { ...(_state.quota || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!QUOTA_KEYS.has(k)) continue;
    if (v === null) { next[k] = null; continue; }
    const spec = QUOTA_TUNABLES[k];
    if (spec.kind === 'bool') { next[k] = !!v; continue; }
    if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) continue;
    const n = Number(v);
    if (Number.isFinite(n)) next[k] = Math.max(spec.min, Math.min(spec.max, n));
  }
  _state.quota = next; persist(); return getQuotaOverrides();
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

// Upper bound on a stored prompt override. These ride into Cascade proto fields
// on every request; an unbounded blob would waste memory/bandwidth. Generous
// enough for a large system prompt.
const SYSTEM_PROMPT_MAX_LEN = 20000;

export function setSystemPrompts(patch) {
  if (!patch || typeof patch !== 'object') return getSystemPrompts();
  const current = _state.systemPrompts || {};
  for (const [k, v] of Object.entries(patch)) {
    if (!SYSTEM_PROMPT_KEYS.has(k)) continue;
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    // Empty override => drop the key so getSystemPrompts falls back to the
    // built-in default, rather than persisting an empty string that would
    // blank out the prompt entirely.
    if (trimmed === '') { delete current[k]; continue; }
    current[k] = trimmed.slice(0, SYSTEM_PROMPT_MAX_LEN);
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
  // v2.0.58: same hook for drought-mode premium restriction so toggling
  // the flag from the dashboard takes effect without a restart.
  if (typeof m.setDroughtRestrictResolver === 'function') {
    m.setDroughtRestrictResolver(() => isExperimentalEnabled('droughtRestrictPremium'));
  }
}).catch(() => { /* auth not yet ready, validateApiKey falls back to env */ });

