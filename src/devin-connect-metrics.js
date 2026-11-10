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
  // cross-account failover hops taken because the upstream refused THIS selector
  // for THIS account ("This model is no longer available for your account").
  // Sibling of quota_failover_hops, deliberately separate: a spike here means the
  // upstream retired a model for part of the pool, not that anyone is out of
  // credit. No errorCount / re-login / reauth is involved (see
  // finalizeConnectAccount's SELECTOR_NOT_ELIGIBLE arm).
  selector_failover_hops: 0,
  // upstream refused a specific selector for one account. Scoped to the
  // (account, selector) pair: the token is alive and every other selector keeps
  // working, so this counter moving is NOT an account-health signal. It counts the
  // REFUSAL, not the routing latch: with no eligible peer the latch is deliberately
  // skipped (the account must keep surfacing the honest 403) and the refusal still
  // counts here.
  selector_ineligible: 0,
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
  // the upstream request VALIDATOR refused the request (gRPC invalid_argument /
  // failed_precondition) — an unsupported image / model capability (measured
  // 2026-10-25, evidence/AccountMatrix.md §7.1) or a malformed message/tool
  // shape. Surfaced to the client as 400 invalid_request_error, never retried,
  // and NEVER an account penalty: the token is alive and the account is healthy.
  // A spike means callers are sending a shape the selected model cannot take;
  // the client-facing message names supports_images in /v1/models.
  request_rejected: 0,
  // upstream returned an unclassified error, or the gRPC `internal` class that
  // classifyUpstreamError documents as a PERMANENT CLIENT mistake (short
  // fingerprint / gzipped body). Neither is an account fault, so it is recorded
  // as a health event only — never an errorCount eviction (same treatment as
  // CONTENT_BLOCKED). A spike here means callers are sending bad requests.
  upstream_error: 0,
  // upstream socket ended mid-answer with no end-of-stream frame → the reply was
  // TRUNCATED. A transport fault (ECONNRESET class), not an account fault, so it
  // is a health event only — never an errorCount eviction. A spike here means the
  // network path to the upstream is dropping connections, and callers are seeing
  // `response.incomplete` / retried turns rather than silent half answers.
  stream_truncated: 0,
  // upstream stall / transport / configuration faults (idle TIMEOUT, absolute
  // DEADLINE_EXCEEDED, NO_TOKEN). Health events only — never an errorCount
  // eviction, since none of them says the ACCOUNT is unhealthy. A spike here means
  // the upstream is stalling or the deployment is misconfigured, not that the pool
  // is dying.
  transport_fault: 0,
  // an error code finalizeConnectAccount did not classify. DENY-BY-DEFAULT: the
  // blame chain is an allow-list of named verdicts, so an unknown code takes the
  // health-window path (reportInternalError) and never charges the errorCount
  // budget. This counter is the visibility that the old silent `else reportError`
  // lacked: a spike means devin-connect.js (or Node's socket layer — EPROTO,
  // HPE_*, ERR_SSL_* are produced by https.request itself) emitted a code with no
  // explicit blame decision. Add an arm rather than widening an enumeration.
  unclassified_fault: 0,
  // the LOCAL frame queue hit its cap because the consumer was slower than the
  // upstream stream (QUEUE_OVERFLOW in devin-connect.js). Not an account fault —
  // the upstream and its token are healthy — so it carries no errorCount penalty.
  // A spike means DEVIN_CONNECT_MAX_QUEUE_FRAMES/BYTES or a downstream writer is
  // the bottleneck, not the pool.
  queue_overflow: 0,
  // Inline images dropped with an image-only ASSISTANT turn (#272). The drop is
  // deliberate — the upstream ignores #10 on role=assistant (measured 2026-10-21)
  // — but it used to be silent. A non-zero value means a client is replaying
  // images on assistant turns and those images will not reach the model.
  assistant_images_dropped: 0,
  // Image blocks dropped because the live catalog EXPLICITLY declares
  // `supports_images=false` for the resolved selector (C3-01). /v1/models has
  // advertised that bit since 3.9.23; this counter is the request-path proof
  // that it now governs forwarding. The text turn is preserved, so a non-zero
  // value means the client sent images to a model the upstream calls text-only
  // and the caller got an answer without them. Deliberately NOT an errorCount
  // signal: the request succeeds, and a catalog bit must never degrade account
  // health. Absence of the bit is unknown and never counted (see
  // getConnectSelectorImageCapability).
  images_dropped_capability: 0,
  // Turns where the model NARRATED a tool call in visible text, then finished
  // with `stop` and zero tool calls (#236 "form A"). Log-only detector: nothing
  // is retried or rewritten, because the shape cannot be told apart from a
  // legitimate prose answer without a real capture. A spike here is that capture.
  prose_tool_intent: 0,
  // Remote http(s) image_url blocks resolved to data URLs before the connect
  // wire was built (inlineRemoteImages). `inlined` moving means clients use
  // hosted image URLs; a matching rise in `fetch_failed` means those fetches are
  // being refused/blocked/oversized and the image was dropped (text still sent).
  remote_images_inlined: 0,
  remote_image_fetch_failed: 0,
  // A remote image_url reached the SYNCHRONOUS wire builder unresolved, i.e. a
  // direct buildGetChatMessageRequest() caller skipped streamChat's resolver.
  // The image is not sent; the log line names the host. Production should stay 0.
  remote_image_unresolved: 0,
  // Requests that asked for `parallel_tool_calls:false` (OpenAI) /
  // `tool_choice.disable_parallel_tool_use` (Anthropic) while the #11
  // `disable_parallel_tool_calls` passthrough was OFF, i.e. the hint was accepted
  // and served but not honoured — the upstream may return several calls in one
  // turn. Counted per request, because the log line for it is once per process.
  //
  // Non-zero is EXPECTED, not a fault: Codex CLI 0.164 sends the hint on every
  // request (evidence/ClientSandboxes.md §3.3 C1). It is the signal that would
  // justify calibrating #11 (DEVIN_CONNECT_TOOL_CHOICE=1 or a tag override).
  // Deliberately NOT an errorCount signal: nothing failed, and a caller preference
  // must never degrade account health.
  parallel_tool_calls_hint_ignored: 0,
  // liveness probe pre-emptively recovered a dying token
  liveness_recovered: 0,
  // SessionReauth: accounts benched because a free GetUserStatus probe confirmed
  // the session token was retired, and the ways back out. A `reauth_required`
  // that never finds a matching `reauth_ok` is a token nobody re-authenticated.
  reauth_required: 0,
  reauth_cleared: 0,
  reauth_ok: 0,
  reauth_fail: 0,
  // router-model (adaptive/arena-*) AssignModel resolution failed → fell back
  assign_model_failed: 0,
  // credential store was read back through a resilience tier (JSON repair or
  // per-record regex salvage) instead of a clean parse — a single corrupt byte
  // would otherwise wipe the whole fleet's stored relogin credentials (C6)
  cred_store_repaired: 0,
  // an account-gone cleanup (conversation-pool invalidateFor / detached
  // evictForAccount / user-JWT epoch bump) rejected or threw (G14). The
  // cleanup is fire-and-forget by design, but a failure leaves stale
  // pool/detached/JWT state behind — this counter plus the
  // `account cleanup "<op>" failed` warn makes that observable instead of
  // silent. A non-zero value means an operator should check whether a
  // removed/banned account is still resumable.
  account_cleanup_failed: 0,
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
