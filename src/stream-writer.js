/**
 * The ONE abort-aware bounded writer for SSE egress.
 *
 * `res.write()` returning false is an ordinary slow-reader signal: Node has
 * ACCEPTED the frame, the socket buffer is full, and the producer must not hand
 * it more until `'drain'`. Discarding that verdict — which every non-Cascade
 * exit used to do — buys the producer unbounded work with no backpressure at
 * all (KH-001). Every writer in this proxy now goes through this module so the
 * contract cannot drift between routes again:
 *
 *   * at most ONE outstanding drain wait per stream — there is no payload queue;
 *   * the false-returning frame was already accepted: it is NEVER resent;
 *   * the wait is raced against response close/error and the caller's abort
 *     signal, settles exactly once, and detaches its own listeners;
 *   * closed/aborted is re-checked before every write and after every wait, so a
 *     client that vanished while we waited receives no further bytes;
 *   * a half-open client (no 'drain' ever) is bounded: `onTimeout` runs, the
 *     writer stops accepting waits, and the caller tears the stream down;
 *   * that bound is proportional to the UNACKNOWLEDGED bytes (`fixed +
 *     pendingBytes / minClientRate`), not a fixed 120s and not a cumulative
 *     stream total: a frame the socket accepted buys no budget, and `'drain'`
 *     resets the backlog. The fixed part anchors at the wait's start — a later
 *     false write extends only the proportional term — so a stalled reader
 *     cannot slide the floor forward forever. A slow reader of a multi-megabyte
 *     frame keeps its full budget, while a stalled 4KB frame aborts in roughly
 *     the fixed wait.
 *
 * `enabled: false` keeps a legacy synchronous producer byte-identical to its old
 * behaviour: the verdict is still returned, but no drain waiter is armed (the
 * legacy gRPC channel consumes its callback synchronously and cannot hold its
 * producer, so arming there would let `onEnd` overtake an unfinished emission).
 */

/**
 * The fixed part of one drain wait. A stalled reader on a small frame is cut
 * off after this plus the time the bytes written so far need at the minimum
 * client rate (see `drainDeadlineMs`), so 30s here — not the historical fixed
 * 120s — is what makes a fully stalled 4KB frame abort early while a slow but
 * real reader of a 5MB frame keeps its full proportional budget.
 *
 * Overridable per deployment with WINDSURFAPI_MAX_DRAIN_MS (the fixed part).
 */
export const MAX_DRAIN_WAIT_DEFAULT_MS = 30_000;

/**
 * The slowest client the gateway budgets for, in bytes per second. 8 KiB/s is
 * the reference implementation's floor (new-api `streamMinClientRate`): every
 * byte written buys `1000 / rate` ms of extra drain wait, so a 5MB image gets
 * ~640s of budget and completes, while a stalled 4KB frame gets ~0.5s on top
 * of the fixed wait.
 *
 * Overridable with WINDSURFAPI_MIN_CLIENT_RATE_BPS.
 */
export const MIN_CLIENT_RATE_BPS_DEFAULT = 8 * 1024;
export const MIN_CLIENT_RATE_ENV = 'WINDSURFAPI_MIN_CLIENT_RATE_BPS';

/**
 * Node clamps a `setTimeout` delay above 2^31-1 ms to 1 ms, which would turn a
 * very large proportional budget into an immediate abort. Cap the delay here so
 * the budget degrades to "practically unbounded" instead of "instant timeout".
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Upper bound on the unacknowledged backlog that can buy drain time.
 * `pendingBytes` only accrues while no 'drain' has fired in the current wait,
 * so bytes beyond this bound belong to a client that has not taken a single
 * byte of the epoch — a half-open dead socket, not a slow reader. Without the
 * cap a fast upstream could queue minutes (or hours) of proportional budget on
 * a socket that will never drain, burning upstream quota for the whole wait.
 */
export const MAX_DRAIN_BUDGETED_BYTES = 4 * 1024 * 1024;

export function resolveMaxDrainWaitMs(raw = process.env.WINDSURFAPI_MAX_DRAIN_MS) {
  const parsed = parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_DRAIN_WAIT_DEFAULT_MS;
}

export function resolveMinClientRateBps(raw = process.env[MIN_CLIENT_RATE_ENV]) {
  const parsed = parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MIN_CLIENT_RATE_BPS_DEFAULT;
}

/**
 * Deadline for one drain wait: `fixed + bytes / minClientRate`, in ms, where
 * `bytes` is clamped to `maxBudgetedBytes` so the proportional term stays
 * bounded, and the total is capped at the largest delay Node's timer accepts.
 * Pure so the formula can be asserted without waiting for a timer.
 */
export function drainDeadlineMs({
  bytes = 0,
  fixedMs = MAX_DRAIN_WAIT_DEFAULT_MS,
  minClientRateBps = MIN_CLIENT_RATE_BPS_DEFAULT,
  maxBudgetedBytes = MAX_DRAIN_BUDGETED_BYTES,
} = {}) {
  const fixed = Number.isFinite(fixedMs) && fixedMs > 0 ? fixedMs : 0;
  const rate = Number.isFinite(minClientRateBps) && minClientRateBps > 0
    ? minClientRateBps
    : MIN_CLIENT_RATE_BPS_DEFAULT;
  const written = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const budgeted = Number.isFinite(maxBudgetedBytes) && maxBudgetedBytes > 0
    ? Math.min(written, maxBudgetedBytes)
    : written;
  return Math.min(MAX_TIMER_MS, fixed + Math.ceil((budgeted * 1000) / rate));
}

/** The abort shape every awaiting producer in this repo already recognises. */
export function clientGoneError(message = 'stream aborted while waiting for the client to drain') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'CLIENT_ABORTED';
  err.isClientAbort = true;
  return err;
}

/**
 * @param {object}   opts
 * @param {object}   opts.res      Writable-ish response (real `ServerResponse` or a translator capture).
 * @param {AbortSignal|null} [opts.signal]  Handler-local abort signal (client gone / shutdown).
 * @param {boolean}  [opts.enabled=true]     Arm the drain waiter on a false verdict.
 * @param {number}   [opts.maxWaitMs]        Fixed part of one drain wait.
 * @param {number}   [opts.minClientRateBps] Slowest client budgeted, bytes/second.
 * @param {Function} [opts.onTimeout]        Called once when a drain wait expires, BEFORE the
 *                                           writer stops arming. The caller owns the teardown
 *                                           (error frame, abort, registry detach).
 */
export function createBoundedWriter({
  res,
  signal = null,
  enabled = true,
  maxWaitMs = resolveMaxDrainWaitMs(),
  minClientRateBps = resolveMinClientRateBps(),
  onTimeout = null,
} = {}) {
  let pending = null;
  let settleCurrent = null;
  let timedOut = false;
  let disposed = false;
  const fixedWaitMs = Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : MAX_DRAIN_WAIT_DEFAULT_MS;
  const minRate = Number.isFinite(minClientRateBps) && minClientRateBps > 0
    ? minClientRateBps
    : MIN_CLIENT_RATE_BPS_DEFAULT;
  // Only UNACKNOWLEDGED bytes buy stall budget: a frame whose `res.write()`
  // returned true was accepted by the socket and must not accrue a wait. The
  // set is emptied by `'drain'` (the kernel accepted the backlog), so a healthy
  // long stream never accumulates minutes-to-hours of budget it does not need.
  let pendingBytes = 0;
  let extendDrain = null;
  const deadlineMs = () => drainDeadlineMs({
    bytes: pendingBytes,
    fixedMs: fixedWaitMs,
    minClientRateBps: minRate,
  });

  const gone = () => !!disposed || res.writableEnded === true || signal?.aborted === true;

  const beginDrain = () => {
    if (pending) return pending;
    if (!enabled || timedOut || gone()) return null;
    let settleDrain = () => {};
    const operation = new Promise((resolve) => { settleDrain = resolve; });
    let settled = false;
    let timer = null;
    // The fixed part of the budget anchors at THIS wait's start, not at each
    // re-arm: otherwise every false write while the wait is outstanding would
    // slide the 30s floor forward and a chatty-but-stalled client would never
    // hit it. New bytes extend only the proportional term — deadline = start +
    // fixed + unacknowledged/rate, so each re-arm re-derives the delay from
    // the anchored deadline.
    const waitStartMs = Date.now();
    const armTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (settled || timedOut || gone()) return;
      const delay = Math.max(0, waitStartMs + deadlineMs() - Date.now());
      timer = setTimeout(onDrainTimeout, delay);
      // Never keep the process alive for a wait that belongs to one request.
      timer.unref?.();
    };
    const finishDrain = () => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      // The backlog is settled (drained, closed, aborted or timed out): no
      // unacknowledged bytes remain, so the next wait starts from zero.
      pendingBytes = 0;
      if (extendDrain === armTimer) extendDrain = null;
      if (pending === operation) pending = null;
      if (settleCurrent === finishDrain) settleCurrent = null;
      // Some embedders hand this handler a minimal writable; only real streams
      // carry the EventEmitter alias.
      res.removeListener?.('drain', finishDrain);
      res.removeListener?.('close', finishDrain);
      res.removeListener?.('error', finishDrain);
      signal?.removeEventListener?.('abort', finishDrain);
      settleDrain();
    };
    // Half-open client: no 'drain' ever arrives. Bound the wait, hand control
    // back to the caller, and stop arming new waits behind it.
    const onDrainTimeout = () => {
      if (settled) return;
      timedOut = true;
      try {
        onTimeout?.({
          maxWaitMs: fixedWaitMs,
          minClientRateBps: minRate,
          pendingBytes,
          // Total budget this wait was given: fixed + unacknowledged/rate.
          budgetMs: drainDeadlineMs({ bytes: pendingBytes, fixedMs: fixedWaitMs, minClientRateBps: minRate }),
        });
      } catch { /* teardown is the caller's, never ours */ }
      finishDrain();
    };
    pending = operation;
    settleCurrent = finishDrain;
    extendDrain = armTimer;
    armTimer();
    res.on?.('drain', finishDrain);
    res.on?.('close', finishDrain);
    res.on?.('error', finishDrain);
    signal?.addEventListener?.('abort', finishDrain, { once: true });
    // The client may already be gone by the time we start waiting.
    if (gone()) finishDrain();
    return operation;
  };

  /**
   * Write one frame. Returns the real verdict (true when the writer is already
   * gone, because no bytes were needed). A false verdict arms the single drain
   * wait; the frame itself was accepted and is never resent.
   *
   * A throwing write is left to propagate: the caller's failure stages own its
   * diagnosis, and re-classifying it here would change how a broken socket is
   * reported.
   */
  const write = (text) => {
    if (gone()) return true;
    const ok = res.write(text) !== false;
    if (!ok && enabled && !timedOut) {
      // Only a frame the socket did NOT accept buys stall budget. A true
      // verdict is already acknowledged, so it must not accrue a wait.
      pendingBytes += Buffer.isBuffer(text) ? text.length : Buffer.byteLength(String(text), 'utf8');
      if (pending) extendDrain?.();
      else beginDrain();
    }
    return ok;
  };

  /**
   * Awaits the outstanding drain, if any. Throws once the writer is gone so the
   * awaiting producer stops instead of feeding a closed socket.
   */
  const awaitDrain = async () => {
    while (pending) await pending;
    if (gone()) throw clientGoneError();
  };

  /** Teardown variant: same wait, but never throws (a failure stage must reach its cleanup). */
  const settle = async () => {
    while (pending) await pending;
  };

  /**
   * Sequential emission: wait for any outstanding drain, then write once.
   * Returns undefined on the unarmed (legacy) path so that consumer stays fully
   * synchronous.
   */
  const writeFrame = (text) => {
    if (!enabled) {
      write(text);
      return undefined;
    }
    return awaitDrain().then(() => { write(text); });
  };

  const dispose = () => {
    disposed = true;
    // Settle (never hang) a producer parked on this writer.
    settleCurrent?.();
    pendingBytes = 0;
  };

  return {
    write,
    writeFrame,
    awaitDrain,
    settle,
    dispose,
    gone,
    get pending() { return pending; },
    get timedOut() { return timedOut; },
    // Budget for the next drain wait: fixed + the unacknowledged bytes at the
    // minimum client rate, capped at the largest timer delay.
    get deadlineMs() { return deadlineMs(); },
    get pendingBytes() { return pendingBytes; },
  };
}
