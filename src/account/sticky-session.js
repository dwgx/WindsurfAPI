/**
 * Sticky Session Manager.
 *
 * Binds a caller (identified by callerKey + modelKey) to a specific account
 * so that multi-turn conversations stay on the same upstream account. This
 * prevents context loss when the conversation pool reuses a cascade_id that
 * is only valid on the originating account.
 *
 * Design:
 *   - (callerKey, modelKey) → accountId binding with configurable TTL
 *   - Model dimension prevents cross-model collision: the same session
 *     using opus and sonnet can be bound to different accounts
 *   - Binding is created when a successful response is returned
 *   - On next request, getApiKey checks the binding first
 *   - If the bound account is unavailable (rate limited, etc.),
 *     the stale binding is immediately cleared so retries don't
 *     keep hitting the same unavailable account
 *   - Bindings are cleared on session reset or TTL expiry
 *   - The binding table is in-memory only (no persistence needed)
 *
 * Why this matters:
 *   Multi-turn conversations (Claude Code "fix → test → fix again")
 *   currently re-select an account on every request. If the chosen account
 *   runs out of quota or hits RPM mid-conversation, the cascade_id from
 *   the previous turn is invalid on the new account — context is lost.
 *   Sticky binding prevents this by keeping the same account for the
 *   duration of a conversation.
 *
 * Configure via env:
 *   STICKY_SESSION_ENABLED=1     — enable (default: 0, opt-in)
 *   STICKY_SESSION_TTL_MS=1800000 — binding TTL in ms (default: 30 min)
 *   STICKY_SESSION_MAX=10000     — max concurrent bindings (default: 10000)
 *
 * Related issues: #93, #133 (context loss mid-task)
 */

const ENABLED = process.env.STICKY_SESSION_ENABLED === '1';

const TTL_MS = (() => {
  const n = parseInt(process.env.STICKY_SESSION_TTL_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;  // 30 minutes
})();

const MAX_BINDINGS = (() => {
  const n = parseInt(process.env.STICKY_SESSION_MAX || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10000;
})();

// Map<bindingKey, { accountId, apiKey, createdAt, lastAccess }>
// bindingKey = callerKey + '\0' + modelKey
const _bindings = new Map();
const _stats = {
  hits: 0, misses: 0, creates: 0,
  expires: 0, evictions: 0, fallbacks: 0,
};

/**
 * Build the internal map key from caller + model dimensions.
 * Using \0 delimiter (valid in Map keys but never appears in user input).
 */
function bindingKey(callerKey, modelKey) {
  return callerKey + '\0' + (modelKey || '*');
}

// ── Periodic cleanup ─────────────────────────────────────────────
// Clean expired bindings every 5 minutes so memory doesn't grow
// unbounded. The per-lookup path also checks TTL, so this is a safety
// net, not the primary enforcement.
let _cleanupTimer = null;
function ensureCleanupTimer() {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, binding] of _bindings) {
      if (now - binding.lastAccess > TTL_MS) {
        _bindings.delete(key);
        _stats.expires++;
      }
    }
  }, 5 * 60 * 1000).unref();
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Check if sticky sessions are enabled.
 */
export function isStickyEnabled() {
  return ENABLED;
}

/**
 * Look up the bound account for a caller + model pair.
 *
 * @param {string} callerKey - Caller identity key (e.g. session id, IP hash)
 * @param {string} [modelKey] - Model being requested
 * @returns {{ accountId: string, apiKey: string } | null}
 */
export function getStickyBinding(callerKey, modelKey = '') {
  if (!ENABLED || !callerKey) return null;
  ensureCleanupTimer();

  const key = bindingKey(callerKey, modelKey);
  const binding = _bindings.get(key);
  if (!binding) {
    _stats.misses++;
    return null;
  }

  const now = Date.now();
  if (now - binding.lastAccess > TTL_MS) {
    _bindings.delete(key);
    _stats.expires++;
    return null;
  }

  binding.lastAccess = now;
  _stats.hits++;
  return { accountId: binding.accountId, apiKey: binding.apiKey };
}

/**
 * Set (or refresh) a sticky binding.
 *
 * @param {string} callerKey
 * @param {string} modelKey
 * @param {string} accountId
 * @param {string} apiKey
 */
export function setStickyBinding(callerKey, modelKey, accountId, apiKey) {
  if (!ENABLED || !callerKey || !accountId) return;
  ensureCleanupTimer();

  // Evict oldest if at capacity
  if (_bindings.size >= MAX_BINDINGS && !_bindings.has(bindingKey(callerKey, modelKey))) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, b] of _bindings) {
      if (b.lastAccess < oldestTime) {
        oldestTime = b.lastAccess;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      _bindings.delete(oldestKey);
      _stats.evictions++;
    }
  }

  const key = bindingKey(callerKey, modelKey);
  const now = Date.now();
  const existing = _bindings.get(key);

  _bindings.set(key, {
    accountId,
    apiKey,
    createdAt: existing?.createdAt || now,
    lastAccess: now,
  });

  if (!existing) _stats.creates++;
}

/**
 * Clear the sticky binding for a caller+model pair.
 * Called when the bound account becomes unavailable (rate limited, banned, etc.)
 *
 * @param {string} callerKey
 * @param {string} [modelKey]
 */
export function clearStickyBinding(callerKey, modelKey = '') {
  if (!ENABLED || !callerKey) return;
  _bindings.delete(bindingKey(callerKey, modelKey));
}

/**
 * Clear all bindings for a caller (all models).
 * Called on session reset or disconnection.
 *
 * @param {string} callerKey
 */
export function clearCallerBindings(callerKey) {
  if (!ENABLED || !callerKey) return;
  const prefix = callerKey + '\0';
  for (const key of _bindings.keys()) {
    if (key.startsWith(prefix)) _bindings.delete(key);
  }
}

/**
 * Reset all bindings. Useful for testing or full session reset.
 */
export function resetAllBindings() {
  _bindings.clear();
}

/**
 * Get stats for monitoring.
 * @returns {{ hits: number, misses: number, creates: number, expires: number, evictions: number, fallbacks: number, size: number }}
 */
export function getStickyStats() {
  return { ..._stats, size: _bindings.size };
}
