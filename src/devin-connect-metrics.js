/**
 * DEVIN_CONNECT operational counters — in-memory, lifetime-of-process.
 *
 * WHY: the DEVIN_CONNECT recovery machinery (re-login, failover, liveness,
 * cooldowns) only emitted log lines. During an incident there was no way to
 * answer "how many tokens died?", "how often are we failing over?", or "is
 * auto-relogin even succeeding?" without grepping logs. These counters make
 * that state queryable (dashboard /connect-metrics) so it can be watched and
 * alarmed on.
 *
 * Deliberately NOT persisted: they're health/rate signals, not billing — a
 * restart resetting them is correct (you want "since this process started").
 * Counting is cheap and side-effect-free; callers bump on the event path.
 */

const _counters = {
  // re-login (same-account token recovery via stored credentials)
  relogin_ok: 0,
  relogin_fail: 0,
  // cross-account failover hops taken after a dead/unrecoverable token
  failover_hops: 0,
  // requests that exhausted all failover hops / pooled accounts
  failover_exhausted: 0,
  // cross-account failover hops taken because THIS account hit a quota/rate
  // dry-well (QUOTA_EXHAUSTED / RATE_LIMITED) while the pool still had a healthy
  // account — the request moves on instead of surfacing 402/429 to the client (R1)
  quota_failover_hops: 0,
  // session tokens observed dead (UNAUTHORIZED, not revived on same account)
  dead_tokens: 0,
  // requests rejected because the whole pool was rate-limited/unavailable
  pool_exhausted: 0,
  // streaming requests replayed after a pre-emit transient blip
  transient_replays: 0,
  // accounts cooled down for running out of credit/quota
  quota_exhausted: 0,
  // requests where the MODEL was temporarily at capacity ("high demand"); a
  // transient soft cooldown, not an account fault (P0 #56/#57)
  capacity_throttled: 0,
  // upstream returned a transient backend fault ("an internal error occurred
  // (trace ID/error ID: ...)"), often in a 401/403 shell, on a provably-alive
  // token; classified UPSTREAM_INTERNAL → streak-quarantine, NOT a re-login or
  // entitlement wall (#56/#57 shape, internal-error class)
  upstream_internal: 0,
  // liveness probe pre-emptively recovered a dying token
  liveness_recovered: 0,
  // router-model (adaptive/arena-*) AssignModel resolution failed → fell back
  assign_model_failed: 0,
  // credential store was read back through a resilience tier (JSON repair or
  // per-record regex salvage) instead of a clean parse — a single corrupt byte
  // would otherwise wipe the whole fleet's stored relogin credentials (C6)
  cred_store_repaired: 0,
};
let _startedAt = Date.now();

/** Increment a named counter by n (default 1). Unknown names are ignored. */
export function bumpConnect(name, n = 1) {
  if (Object.prototype.hasOwnProperty.call(_counters, name)) _counters[name] += n;
}

/**
 * Snapshot of all counters plus credential-store decrypt health (folded in so
 * a single endpoint answers "is recovery healthy?"). uptimeMs lets a scraper
 * compute rates without a separate clock.
 */
export function getConnectMetrics() {
  let cred = { decryptFailures: 0, lastDecryptError: null };
  try {
    // Lazy require to avoid a load-time cycle (credentials.js → config → ...).
    // Synchronous access via the module's getter when it's already loaded.
    const m = _credHealthRef;
    if (m) cred = m();
  } catch { /* leave defaults */ }
  return {
    uptimeMs: Date.now() - _startedAt,
    ..._counters,
    credDecryptFailures: cred.decryptFailures,
    credLastDecryptError: cred.lastDecryptError,
  };
}

// The credentials module registers its health getter here at import time so we
// avoid a static import cycle while still surfacing cred health in one place.
let _credHealthRef = null;
export function __registerCredHealth(fn) { _credHealthRef = fn || null; }

/** Reset counters (tests / dashboard DELETE). */
export function resetConnectMetrics() {
  for (const k of Object.keys(_counters)) _counters[k] = 0;
  _startedAt = Date.now();
}
