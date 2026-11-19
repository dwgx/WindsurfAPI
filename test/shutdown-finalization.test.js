import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdownController } from '../src/shutdown.js';

// SIGINT/SIGTERM finalization is single-flight: the HTTP close callback and the
// bounded deadline both route into one drain+exit promise. These tests drive the
// real controller with an in-memory server, timer, drain and exit, so both
// callback orders and the repeated-signal guard are exercised without a real
// process, child, signal or clock.

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeHarness({ drain = 'pending', stopThrows = false, logThrows = false } = {}) {
  const logs = [];
  const log = {
    info: (m) => { if (logThrows && /Shutdown complete/.test(m)) throw new Error('log sink failed'); logs.push(['info', m]); },
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
  };

  // Fake clock: one deadline timer, cleared by clearTimeout like the real one.
  const timers = [];
  const setTimer = (cb, ms) => { timers.push({ cb, ms, cleared: false, fired: false }); return timers.length - 1; };
  const clearTimer = (id) => { if (timers[id]) timers[id].cleared = true; };
  // `force` models a deadline callback that was already dispatched before the
  // close-won finalization retired the timer: the promise guard, not only the
  // clearTimeout, has to absorb it.
  const fireDeadline = ({ force = false } = {}) => {
    const timer = timers[0];
    if (!timer || timer.fired || (timer.cleared && !force)) return false;
    timer.fired = true;
    timer.cb();
    return true;
  };

  // Fake LS drain. 'pending' keeps the bounded wait open until releaseDrain();
  // 'reject' models a drain that throws before the children settle.
  let drainCalls = 0;
  let releaseDrain = () => {};
  const pendingDrain = new Promise((resolve) => { releaseDrain = resolve; });
  const drainLanguageServer = () => {
    drainCalls++;
    if (drain === 'reject') return Promise.reject(new Error('drain failed'));
    if (drain === 'pending') return pendingDrain;
    return Promise.resolve();
  };
  let fallbackStops = 0;
  const stopLanguageServer = () => {
    fallbackStops++;
    if (stopThrows) throw new Error('sync stop failed');
  };

  const closeCallbacks = [];
  let closeCalls = 0;
  let idleClosed = 0;
  const server = {
    getActiveRequests: () => 2,
    closeIdleConnections: () => { idleClosed++; },
    close: (cb) => { closeCalls++; closeCallbacks.push(cb); },
  };

  let abortCalls = 0;
  const abortSse = () => { abortCalls++; return 1; };
  let detachCalls = 0;
  const beginDetachDrain = () => { detachCalls++; return Promise.resolve(); };

  const exits = [];
  const exit = (code) => { exits.push(code); };

  const shutdown = createShutdownController({
    server,
    drainLanguageServer,
    stopLanguageServer,
    abortSse,
    beginDetachDrain,
    log,
    exit,
    drainTimeoutMs: 30_000,
    setTimer,
    clearTimer,
  });

  return {
    shutdown,
    logs,
    timers,
    closeCallback: () => closeCallbacks[0]?.(),
    fireDeadline,
    releaseDrain: () => releaseDrain(),
    get drainCalls() { return drainCalls; },
    get fallbackStops() { return fallbackStops; },
    get closeCalls() { return closeCalls; },
    get idleClosed() { return idleClosed; },
    get abortCalls() { return abortCalls; },
    get detachCalls() { return detachCalls; },
    exits,
  };
}

const hasLog = (logs, level, pattern) => logs.some(([lvl, msg]) => lvl === level && pattern.test(msg));

describe('shutdown finalization is single-flight', () => {
  test('close then deadline: one drain, no exit while the child is settling, one exit after', async () => {
    const h = makeHarness();
    h.shutdown('SIGTERM');
    assert.equal(h.drainCalls, 0, 'drain must not start before a finalization trigger');
    assert.equal(h.closeCalls, 1);
    assert.equal(h.idleClosed, 1);
    assert.equal(h.abortCalls, 1);
    assert.equal(h.detachCalls, 1);
    assert.equal(h.timers.length, 1, 'one deadline is armed');
    assert.equal(h.timers[0].ms, 30_000);

    h.closeCallback();
    await tick();
    assert.equal(h.drainCalls, 1);
    assert.deepEqual(h.exits, [], 'no exit while the bounded drain is pending');

    h.fireDeadline();
    await tick();
    assert.equal(h.drainCalls, 1, 'deadline must join the running finalization, not start a second drain');
    assert.deepEqual(h.exits, [], 'deadline must not exit while the first drain is pending');

    h.releaseDrain();
    await tick();
    await tick();
    assert.deepEqual(h.exits, [0], 'exactly one exit after the drain settles');
    assert.equal(h.timers[0].cleared, true, 'close-won finalization retires the deadline');
    assert.equal(hasLog(h.logs, 'info', /Shutdown complete \(drained\)/), true);
    assert.deepEqual(unhandled, []);
  });

  test('a deadline callback already dispatched after close won still joins the drain', async () => {
    const h = makeHarness();
    h.shutdown('SIGTERM');
    h.closeCallback();
    await tick();
    assert.equal(h.drainCalls, 1);

    assert.equal(h.fireDeadline({ force: true }), true);
    await tick();
    assert.equal(h.drainCalls, 1, 'the promise guard must absorb a deadline that outran clearTimeout');
    assert.deepEqual(h.exits, [], 'no exit while the close-won drain is pending');

    h.releaseDrain();
    await tick();
    await tick();
    assert.deepEqual(h.exits, [0]);
    assert.deepEqual(unhandled, []);
  });

  test('deadline then close: the late close callback joins the deadline finalization', async () => {
    const h = makeHarness();
    h.shutdown('SIGINT');
    h.fireDeadline();
    await tick();
    assert.equal(h.drainCalls, 1);
    assert.deepEqual(h.exits, [], 'no exit while the deadline drain is pending');

    h.closeCallback();
    await tick();
    assert.equal(h.drainCalls, 1, 'late HTTP close must not start a second drain');
    assert.deepEqual(h.exits, [], 'late HTTP close must not exit ahead of the pending drain');

    h.releaseDrain();
    await tick();
    await tick();
    assert.deepEqual(h.exits, [0]);
    assert.equal(hasLog(h.logs, 'info', /Shutdown complete \(drain-timeout\)/), true);
    assert.equal(hasLog(h.logs, 'warn', /Drain timeout, forcing exit/), true);
    assert.equal(hasLog(h.logs, 'info', /HTTP server closed/), true);
    assert.deepEqual(unhandled, []);
  });

  test('repeated signals and repeated callbacks still drain and exit once', async () => {
    const h = makeHarness();
    h.shutdown('SIGTERM');
    h.shutdown('SIGINT');
    h.shutdown('SIGTERM');
    assert.equal(h.closeCalls, 1, 'one shutdown sequence admits the server close once');
    assert.equal(h.abortCalls, 1);

    h.closeCallback();
    h.closeCallback();
    h.fireDeadline();
    await tick();
    assert.equal(h.drainCalls, 1);
    assert.deepEqual(h.exits, []);

    h.releaseDrain();
    await tick();
    await tick();
    assert.deepEqual(h.exits, [0]);

    // Everything that can still arrive after the exit request is a no-op.
    h.shutdown('SIGTERM');
    h.closeCallback();
    h.fireDeadline();
    await tick();
    assert.equal(h.drainCalls, 1);
    assert.deepEqual(h.exits, [0]);
    assert.deepEqual(unhandled, []);
  });

  test('deadline-only shutdown still finalizes when HTTP never closes', async () => {
    const h = makeHarness();
    h.shutdown('SIGTERM');
    assert.equal(h.fireDeadline(), true);
    await tick();
    assert.equal(h.drainCalls, 1);
    assert.deepEqual(h.exits, []);
    h.releaseDrain();
    await tick();
    await tick();
    assert.deepEqual(h.exits, [0]);
    assert.equal(hasLog(h.logs, 'info', /Shutdown complete \(drain-timeout\)/), true);
    assert.deepEqual(unhandled, []);
  });

  test('close-only shutdown retires the deadline so it cannot log a false timeout', async () => {
    const h = makeHarness();
    h.shutdown('SIGTERM');
    h.closeCallback();
    await tick();
    h.releaseDrain();
    await tick();
    await tick();
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.timers[0].cleared, true);
    assert.equal(h.fireDeadline(), false, 'cleared deadline must not run');
    await tick();
    assert.equal(h.drainCalls, 1);
    assert.deepEqual(h.exits, [0]);
    assert.equal(hasLog(h.logs, 'warn', /Drain timeout/), false);
  });

  test('a rejected drain falls back to the synchronous stop and still exits once', async () => {
    const h = makeHarness({ drain: 'reject' });
    h.shutdown('SIGTERM');
    h.closeCallback();
    await tick();
    await tick();
    assert.equal(h.drainCalls, 1);
    assert.equal(h.fallbackStops, 1);
    assert.deepEqual(h.exits, [0]);
    assert.deepEqual(unhandled, [], 'drain rejection must be handled inside finalization');
  });

  test('a throwing fallback stop still exits once without leaking a rejection', async () => {
    const h = makeHarness({ drain: 'reject', stopThrows: true });
    h.shutdown('SIGTERM');
    h.closeCallback();
    await tick();
    await tick();
    assert.equal(h.fallbackStops, 1);
    assert.deepEqual(h.exits, [0]);
    assert.deepEqual(unhandled, []);
  });

  test('a throwing log sink cannot strand shutdown after the drain settles', async () => {
    const h = makeHarness({ drain: 'resolved', logThrows: true });
    h.shutdown('SIGTERM');
    h.closeCallback();
    await tick();
    await tick();
    assert.deepEqual(h.exits, [0], 'a completion log failure must not suppress the one exit request');
    assert.deepEqual(unhandled, []);
    assert.equal(hasLog(h.logs, 'error', /Shutdown completion log failed/), true);
  });
});
