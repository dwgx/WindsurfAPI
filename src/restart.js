/**
 * One-click restart plumbing.
 *
 * Two concerns, both dependency-light and unit-testable (all side-effecting
 * handles are injected — server / stopLs / exitFn / abortSse):
 *
 *  - detectSupervisor(): is there a process supervisor that will relaunch us
 *    after we exit? Exiting with no supervisor would take the gateway down
 *    into nothing, so the /restart endpoint refuses in that case.
 *  - gracefulRestart(): abort SSE → drain in-flight (bounded) → stop the LS
 *    pool → exit with a supervisor-relaunch code (75 / EX_TEMPFAIL, matching
 *    selfUpdateRestartExitCode()).
 */

import { existsSync } from 'node:fs';
import { log } from './config.js';

/**
 * Detect whether we're running under a process supervisor that will relaunch
 * the gateway after a non-zero exit.
 *
 * @param {NodeJS.ProcessEnv} [env] injected for testability
 * @returns {{ supervised: boolean, kind: 'systemd'|'pm2'|'docker'|'override'|null }}
 */
export function detectSupervisor(env = process.env) {
  // Explicit operator override wins first — lets someone run under a
  // supervisor we don't auto-detect (runit, s6, supervisord, a bespoke wrapper)
  // opt in rather than getting a false refusal.
  if (env.WINDSURFAPI_RESTART_SUPERVISED === '1') {
    return { supervised: true, kind: 'override' };
  }
  // systemd exports INVOCATION_ID for every service instance; JOURNAL_STREAM is
  // present when stdout/stderr are wired to the journal (also systemd).
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) {
    return { supervised: true, kind: 'systemd' };
  }
  // PM2 sets pm_id on each managed process; PM2_HOME points at its runtime dir.
  if (env.pm_id != null || env.PM2_HOME) {
    return { supervised: true, kind: 'pm2' };
  }
  // Docker with a restart policy (--restart / restart:) relaunches the
  // container's PID 1 on exit. We can't read the restart policy from inside,
  // but /.dockerenv is a reliable "we're in a container" marker; the operator
  // is responsible for the restart policy just as with systemd's Restart=.
  try {
    if (existsSync('/.dockerenv')) {
      return { supervised: true, kind: 'docker' };
    }
  } catch { /* existsSync should never throw, but never let detection crash */ }
  return { supervised: false, kind: null };
}

/**
 * Gracefully drain then exit so a supervisor relaunches us.
 *
 * Ordering: abort SSE → close the HTTP server (wait for in-flight, bounded by
 * drainMs) → stop the LS pool (awaited so SIGTERM lands before we exit and
 * reparent surviving children to init) → exit.
 *
 * Everything with a side effect is injected so this is unit-testable without a
 * real server, real LS children, or a real process.exit.
 *
 * @param {object}   opts
 * @param {string}   opts.reason       human label for the logs
 * @param {number}   [opts.drainMs]    max time to wait for in-flight drain (default 10s)
 * @param {object}   [opts.server]     http.Server-like with close(cb); null skips drain
 * @param {Function} [opts.stopLs]     async LS graceful-stop; awaited if provided
 * @param {Function} [opts.abortSse]   abort-active-SSE hook; called first if provided
 * @param {Function} [opts.exitFn]     exit function (default process.exit)
 * @param {number}   [opts.exitCode]   exit code (default 75 / EX_TEMPFAIL)
 */
export async function gracefulRestart({
  reason,
  drainMs = 10000,
  server = null,
  stopLs = null,
  abortSse = null,
  exitFn = process.exit,
  exitCode = 75,
} = {}) {
  log.info(`restart: begin graceful restart (${reason || 'unspecified'})`);

  // (a) Abort in-flight SSE streams so long-lived streaming responses don't
  // pin the drain for the full drainMs window.
  if (typeof abortSse === 'function') {
    try {
      const n = abortSse('server restarting');
      if (n) log.warn(`restart: aborted ${n} active SSE stream(s)`);
    } catch (e) {
      log.warn(`restart: abortSse failed (continuing): ${e.message}`);
    }
  }

  // (b) Close the HTTP server and wait for in-flight requests, bounded by
  // drainMs so a stuck request can never hang the restart forever.
  if (server && typeof server.close === 'function') {
    const inflight = server.getActiveRequests?.();
    log.info(`restart: draining${inflight != null ? ` ${inflight}` : ''} in-flight request(s) (up to ${drainMs}ms)`);
    try {
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    } catch { /* best-effort */ }
    await new Promise((resolve) => {
      let done = false;
      const finish = (why) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        log.info(`restart: drain ${why}`);
        resolve();
      };
      const timer = setTimeout(() => finish('timeout — forcing exit'), drainMs);
      try {
        server.close(() => finish('complete'));
      } catch (e) {
        log.warn(`restart: server.close threw (continuing): ${e.message}`);
        finish('close-error');
      }
    });
  }

  // (c) Stop the LS pool and wait for children to actually exit, so SIGTERM
  // lands before process.exit reparents survivors to init (the H-4 orphan
  // race — orphan language_server processes hold pool ports).
  if (typeof stopLs === 'function') {
    try {
      log.info('restart: stopping LS pool before exit');
      await stopLs();
    } catch (e) {
      log.warn(`restart: stopLs failed (continuing): ${e.message}`);
    }
  }

  // (d) Exit with the supervisor-relaunch code.
  log.info(`restart: exiting with code ${exitCode} for supervisor relaunch`);
  return exitFn(exitCode);
}
