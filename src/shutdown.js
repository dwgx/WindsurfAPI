/**
 * SIGINT/SIGTERM shutdown, owned by one finalization promise.
 *
 * A signal admits one shutdown sequence, but that sequence has two entry points
 * into finalization: the HTTP close callback (drained) and the bounded deadline
 * (drain-timeout). `stopLanguageServerAndWait` clears the LS pool synchronously
 * and then awaits child exits, so a second, independent finalization would see
 * an empty pool and return immediately — requesting process.exit while the
 * first drain is still waiting for children to settle (audit 70defee2 P2).
 * Both callbacks therefore share one finalize promise: exactly one drain, zero
 * exits while it is pending, one exit after it settles. The deadline still
 * initiates finalization when HTTP never closes.
 *
 * Every side-effecting handle is injected so the callback order can be
 * exercised without a real server, LS child, clock or process.exit.
 */
export function createShutdownController({
  server,
  drainLanguageServer,
  stopLanguageServer = () => {},
  abortSse = () => 0,
  beginDetachDrain = () => {},
  log,
  exit = (code) => process.exit(code),
  drainTimeoutMs = 30_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let started = false;
  let finalizePromise = null;
  let deadlineTimer = null;

  const finalize = (reason) => {
    if (finalizePromise) return finalizePromise;
    if (deadlineTimer !== null) {
      clearTimer(deadlineTimer);
      deadlineTimer = null;
    }
    // Deferred one microtask so `finalizePromise` is assigned before the drain
    // runs: a drain that re-enters a callback cannot start a second drain.
    finalizePromise = Promise.resolve().then(async () => {
      try {
        // K7: shutdown DRAINS, it does not write the pool back. The periodic
        // dirty-flush keeps accounts.json current (≤30s stale) and status flips
        // save immediately, so a shutdown rewrite buys nothing — and it used to
        // clobber an operator's external accounts.json write, forcing the
        // "stop → wait for the flush hook → write → start" deploy dance.
        try {
          await drainLanguageServer();
        } catch {
          try { stopLanguageServer(); } catch {}
        }
        // Logging must not strand shutdown after the deadline is retired.
        // The exit request remains mandatory once the bounded drain settles.
        try { log.info(`Shutdown complete (${reason})`); }
        catch (e) {
          try { log.error(`Shutdown completion log failed: ${e?.message || e}`); } catch {}
        }
        exit(0);
      } catch (e) {
        // process.exit never returns in production; anything that does throw
        // here (a log sink, a test double) must not become an unhandled
        // rejection on the way out.
        try { log.error(`Shutdown finalization failed: ${e?.message || e}`); } catch {}
      }
    });
    return finalizePromise;
  };

  const shutdown = (signal) => {
    if (started) return;
    started = true;
    const inflight = server.getActiveRequests?.() ?? '?';
    const seconds = Math.round(drainTimeoutMs / 1000);
    log.info(`${signal} received — draining ${inflight} in-flight requests (up to ${seconds}s)...`);
    const abortedSse = abortSse('server shutting down');
    if (abortedSse) log.warn(`Aborted ${abortedSse} active SSE stream(s): server shutting down`);
    // Detach P1: entries are in-memory and hold no LS lease, but a drain must
    // refuse new admissions and drop what exists so a dying process does not
    // leave claims behind while the LS pool is being stopped.
    try { Promise.resolve(beginDetachDrain()).catch(() => {}); } catch {}
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    // Arm the deadline before close(): the close callback may finalize
    // synchronously, and finalize() retires the deadline it finds.
    deadlineTimer = setTimer(() => {
      log.warn('Drain timeout, forcing exit');
      void finalize('drain-timeout');
    }, drainTimeoutMs);
    server.close(() => {
      log.info('HTTP server closed, stopping language server');
      void finalize('drained');
    });
  };

  return shutdown;
}
