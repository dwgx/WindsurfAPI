// Stop-boundary generation for the LS pool core.
//
// What a start attempted during/after a stop does (decision, see also the
// receipt):
//   - DURING `stopLanguageServerAndWait` (the only stop with an async drain
//     window) a new start is refused synchronously with `err.code ===
//     'LS_STOPPING'`. Basis: index.js shutdown drains LS children and then
//     calls process.exit — an LS spawned mid-drain would be orphaned by the
//     exit. `stopLanguageServer` has no observable window (its body is
//     synchronous), so "during" cannot be entered there.
//   - AFTER a stop entry point settles, starts are admitted under a FRESH
//     generation: the pending/coalescing map and admission reservations were
//     opened by the stop boundary, so an explicit restart
//     (`stopLanguageServerAndWait(); startLanguageServer()`, the dashboard
//     restart caller) never joins a pre-stop promise.
//   - A start that was already queued or reserved when the boundary opened
//     rejects with `err.code === 'LS_START_INVALIDATED'`: it never reserves
//     after the clear, never spawns, never publishes `ready`, and never
//     returns a usable handle.
//
// Restart continuations follow the same rule (lifecycle rule, see also the
// receipt): every automatic restart INTENT belongs to exactly one stop
// generation, and a continuation may finish cleaning up its own old child but
// may never spawn or reschedule into a newer one.
//   - `scheduleLsRestart` captures the `_stopEpoch` it was created in and
//     registers one per-key record (timer + attempt count). Both global stop
//     entry points clear the captured timer and drop the attempt budget, so a
//     timer that is already dispatched re-checks its epoch and does nothing:
//     no spawn, no recursive retry, no budget change.
//   - A restart callback that has already entered `ensureLs` and is then
//     invalidated settles as a cancellation, not a failure: it schedules no
//     replacement retry and releases only the record it created (identity
//     check), so a newer generation's timer/budget survives.
//   - `restartLsForProxy` captures the epoch at entry. It awaits the old
//     child's exit, so a stop can open a boundary mid-restart; the restart
//     then releases its own `_stopping` record (identity-based) and rejects
//     with `err.code === 'LS_START_INVALIDATED'` — the documented
//     cancellation code, deliberately reused so callers treat a stop-won race
//     as "cancelled", not as a start failure — instead of resuming as a
//     post-stop start. Without a stop it still creates exactly one
//     replacement.
//   - Preserved: normal automatic restart with backoff, normal per-proxy
//     restart, and explicit fresh starts after a stop.
//
// Fakes only: child_process.spawn, net.createConnection (the port-in-use
// probe), http2.connect (the readiness probe) and — for the auto-restart
// scenarios — `setTimeout`/`clearTimeout` for the product's own backoff delays
// (every other delay falls through to the real scheduler), so no LS binary,
// port or network is touched. Each
// scenario imports a fresh module instance (query-string cache bust) so one
// scenario's pool cannot leak into the next. All barriers are
// promises/deferreds handed out by the fakes; the only polling is `waitFor`
// over scheduler counters the product does not expose as an event
// (admissionStats.poolWaits) and over microtask-delivered fake exits — both
// bounded and failure-reporting.
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import http2 from 'node:http2';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.LS_MAX_INSTANCES = '1';
process.env.LS_POOL_WAIT_MS = '3000';
process.env.LS_AUTO_RESTART = '0';
// Auto-restart scenarios flip LS_AUTO_RESTART to '1' before importing a fresh
// module instance. The base delay is distinctive so the timer seam below
// captures only the product's own backoff timers (delay, 2x, 4x).
const AUTO_RESTART_TEST_DELAY_MS = 4242;
process.env.LS_AUTO_RESTART_BASE_DELAY_MS = String(AUTO_RESTART_TEST_DELAY_MS);
process.env.LS_AUTO_RESTART_MAX_RETRIES = '2';
process.env.LS_MEMORY_GUARD = '0';
process.env.LS_IDLE_TTL_MS = '0';
process.env.LS_DATA_DIR = join(process.env.DATA_DIR || tmpdir(), 'ls-stop-generation-fixture');

const fake = {
  spawns: 0,
  children: [],
  holdPortProbes: false,
  holdExits: false,
  probes: [],
  probeWaiters: [],
  heldExits: [],
};

function makeChild(label) {
  const proc = new EventEmitter();
  proc.pid = 41000 + fake.children.length;
  proc.label = label;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.signals = [];
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = (signal = 'SIGTERM') => {
    proc.signals.push(signal);
    const deliver = () => {
      if (proc.exitCode != null || proc.signalCode != null) return;
      proc.signalCode = signal;
      proc.emit('exit', null, signal);
    };
    if (fake.holdExits) fake.heldExits.push(deliver);
    else queueMicrotask(deliver);
    return true;
  };
  fake.children.push(proc);
  return proc;
}

childProcess.spawn = () => {
  fake.spawns += 1;
  return makeChild(`ls-${fake.spawns}`);
};

function notifyProbeWaiters() {
  for (let i = fake.probeWaiters.length - 1; i >= 0; i--) {
    const waiter = fake.probeWaiters[i];
    if (fake.probes[waiter.index]) {
      fake.probeWaiters.splice(i, 1);
      waiter.resolve(fake.probes[waiter.index]);
    }
  }
}

net.createConnection = () => {
  const socket = new EventEmitter();
  socket.setTimeout = () => socket;
  socket.destroy = () => {};
  const probe = {
    released: false,
    release() {
      if (probe.released) return;
      probe.released = true;
      socket.emit('error', Object.assign(new Error('synthetic ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    },
  };
  if (fake.holdPortProbes) {
    fake.probes.push(probe);
    notifyProbeWaiters();
  } else {
    queueMicrotask(probe.release);
  }
  return socket;
};

http2.connect = () => {
  const channel = new EventEmitter();
  channel.close = () => {};
  queueMicrotask(() => channel.emit('connect'));
  return channel;
};

// Timer seam for `scheduleLsRestart`. Only the product's backoff delays are
// captured; every other delay (wait loops, per-test timeouts, the stop
// backstops) goes to the real scheduler. `fire()` returns the value the
// product's timer callback returned, so a scenario can await the restart
// attempt itself instead of polling.
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const restartTimers = [];
const AUTO_RESTART_CAPTURED_DELAYS = new Set([
  AUTO_RESTART_TEST_DELAY_MS,
  AUTO_RESTART_TEST_DELAY_MS * 2,
  AUTO_RESTART_TEST_DELAY_MS * 4,
]);

globalThis.setTimeout = (fn, ms, ...args) => {
  if (AUTO_RESTART_CAPTURED_DELAYS.has(ms)) {
    const token = {
      ms,
      active: true,
      captured: true,
      fire: () => fn(...args),
      unref() { return this; },
    };
    restartTimers.push(token);
    return token;
  }
  return nativeSetTimeout(fn, ms, ...args);
};

globalThis.clearTimeout = (token) => {
  if (token && token.captured) {
    token.active = false;
    return;
  }
  return nativeClearTimeout(token);
};

syncBuiltinESMExports();

let importSeq = 0;
async function freshLs({ maxInstances = 1 } = {}) {
  process.env.LS_MAX_INSTANCES = String(maxInstances);
  importSeq += 1;
  return import(`../src/langserver.js?stop-generation-test=${importSeq}`);
}

function withTimeout(promise, label, timeoutMs = 4000) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForProbe(index, label) {
  if (!fake.holdPortProbes) throw new Error('holdPortProbes must be enabled before waiting for a probe');
  if (fake.probes[index]) return withTimeout(Promise.resolve(fake.probes[index]), label);
  const pending = new Promise(resolve => fake.probeWaiters.push({ index, resolve }));
  return withTimeout(pending, label);
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function releaseExits(count = Infinity) {
  const deliver = fake.heldExits.splice(0, count);
  for (const fire of deliver) fire();
}

// Let a stop observe real child exits instead of its unref'd SIGKILL backstop,
// then wait until every stopping record it created is released.
async function stopAndSettle(ls) {
  fake.holdExits = false;
  await ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 });
  await waitFor(() => ls.getLsStatus().pool.stopping === 0, 'final stopping record released');
}

function isInvalidated(error) {
  return error instanceof Error && error.code === 'LS_START_INVALIDATED';
}

function isStopping(error) {
  return error instanceof Error && error.code === 'LS_STOPPING';
}

const STOP_VARIANTS = [
  ['stopLanguageServer', (ls) => ls.stopLanguageServer()],
  ['stopLanguageServerAndWait', (ls) => ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 })],
];

beforeEach(() => {
  fake.spawns = 0;
  fake.children.length = 0;
  fake.holdPortProbes = false;
  fake.holdExits = false;
  fake.probes.length = 0;
  fake.probeWaiters.length = 0;
  fake.heldExits.length = 0;
  restartTimers.length = 0;
  // Only the auto-restart scenarios enable the real product scheduler; each
  // enables it right before importing a fresh module instance.
  process.env.LS_AUTO_RESTART = '0';
});

describe('LS stop boundary: queued/reserved starts cannot survive a stop', () => {
  for (const [stopName, stop] of STOP_VARIANTS) {
    it(`normal: ${stopName} stops the ready child and empties the pool`, async () => {
      const ls = await freshLs();
      const status = () => ls.getLsStatus().pool;
      const entry = await ls.ensureLs(null);
      assert.equal(entry.ready, true);
      assert.equal(fake.spawns, 1);
      const child = fake.children[0];

      await stop(ls);

      assert.deepEqual(child.signals, ['SIGTERM']);
      assert.equal(status().size, 0, 'pool cleared by the stop');
      await waitFor(() => status().stopping === 0, 'stopping record released once the child exits');

      // The stopped handle is not reusable: the next caller spawns a new child.
      const replacement = await ls.ensureLs(null);
      assert.notEqual(replacement, entry);
      assert.equal(fake.spawns, 2);
      await ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 });
      assert.equal(status().size, 0);
    });

    it(`queued: ${stopName} invalidates a waiter before it can reserve or spawn`, async () => {
      const ls = await freshLs();
      const status = () => ls.getLsStatus().pool;
      const holderProc = makeChild('fixture-holder');
      ls.__resetLsPoolForTests([{
        key: 'fixture-holder',
        proxy: null,
        port: 42999,
        csrfToken: 'fixture',
        ready: true,
        activeRequests: 1,
        process: holderProc,
        generation: 'fixture-holder-generation',
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        workspaceInit: null,
        sessionId: null,
      }]);

      const request = ls.ensureLs(null);
      await waitFor(() => ls.getLsStatus().admissionStats.poolWaits === 1, 'admission wait');
      assert.equal(status().size, 1, 'only the holder is in the pool');

      await stop(ls);
      assert.equal(status().size, 0, 'stop clears the pool');
      assert.deepEqual(holderProc.signals, ['SIGTERM']);

      await assert.rejects(request, (err) => isInvalidated(err));
      assert.equal(fake.spawns, 0, 'the queued start must not spawn after the boundary');
      await waitFor(() => status().stopping === 0, 'stopping record released once the child exits');
      assert.equal(status().size, 0);
      assert.equal(status().pending, 0);
    });

    it(`reserved: ${stopName} drops a childless reservation and the old start cannot spawn`, async () => {
      const ls = await freshLs();
      const status = () => ls.getLsStatus().pool;
      fake.holdPortProbes = true;
      const request = ls.ensureLs(null);
      const probe = await waitForProbe(0, 'port probe of the reserved start');

      assert.equal(status().size, 1, 'reservation placeholder is visible');
      assert.equal(status().starting, 1);
      assert.equal(status().ready, 0);
      assert.equal(status().pending, 1);
      assert.equal(fake.spawns, 0);

      await stop(ls);
      assert.equal(status().size, 0, 'childless reservation dropped');
      assert.equal(status().stopping, 0, 'stop must not keep a childless stopping reservation');

      probe.release();
      await assert.rejects(request, (err) => isInvalidated(err));
      assert.equal(fake.spawns, 0, 'old start must not spawn after the boundary');
      assert.equal(status().size, 0);

      // Capacity recovered: a proxy start is admissible again.
      const admission = ls.getLsAdmissionStatus({ host: '127.0.0.1', port: 9 });
      assert.equal(admission.effectivePoolSize, 0);
      assert.equal(admission.reason, 'can_start');
      assert.equal(admission.wouldStart, true);
    });

    it(`reserved_restart: ${stopName} lets an explicit restart use a fresh generation`, async () => {
      const ls = await freshLs();
      const status = () => ls.getLsStatus().pool;
      fake.holdPortProbes = true;
      const oldRequest = ls.ensureLs(null);
      const oldProbe = await waitForProbe(0, 'port probe of the reserved start');
      await stop(ls);
      oldProbe.release();
      await assert.rejects(oldRequest, (err) => isInvalidated(err));
      assert.equal(fake.spawns, 0, 'no pre-stop spawn leaked');

      // Dashboard restart caller: startLanguageServer() after the awaited stop.
      fake.holdPortProbes = false;
      const started = await ls.startLanguageServer();
      assert.equal(started.port, 42100);
      assert.equal(fake.spawns, 1, 'restart spawns exactly one child');
      assert.equal(status().ready, 1);
      assert.equal(status().pending, 0);

      await ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 });
      await waitFor(() => status().stopping === 0, 'stopping record released once the child exits');

      // Two same-key starts after the stop coalesce into one spawn.
      const first = ls.ensureLs(null);
      const second = ls.ensureLs(null);
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a, b, 'both callers share one generation');
      assert.equal(fake.spawns, 2, 'exactly one extra spawn');
      assert.equal(status().ready, 1);
      await ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 });
      await waitFor(() => status().stopping === 0, 'final stopping record released');
      assert.equal(status().size, 0);
    });
  }
});

describe('LS stop boundary: stale cleanup is generation-bound', () => {
  it('a stale child exit cannot clear the newer generation of the same key', async () => {
    const ls = await freshLs({ maxInstances: 2 });
    const status = () => ls.getLsStatus().pool;
    await ls.ensureLs(null);
    assert.equal(fake.spawns, 1);
    fake.holdExits = true;

    ls.stopLanguageServer(); // record A, child A intentionally killed (exit held)
    const recordA = status().stoppingInstances[0];
    assert.ok(recordA?.pid, 'stop tracks the live child it is killing');

    const replacement = await ls.ensureLs(null);
    assert.equal(replacement.ready, true);
    assert.equal(fake.spawns, 2);

    ls.stopLanguageServer(); // record B replaces record A under the same key
    const recordB = status().stoppingInstances[0];
    assert.ok(recordB?.pid);
    assert.notEqual(recordB.pid, recordA.pid);

    releaseExits(1); // only A's held exit fires
    assert.equal(status().stopping, 1, 'A must not clear B');
    assert.equal(status().stoppingInstances[0].pid, recordB.pid);

    releaseExits(); // B exits
    await waitFor(() => status().stopping === 0, 'B record released by its own exit');
    assert.equal(status().size, 0);
  });

  it('a stale pending finally cannot clear the new generation pending/pool entry', async () => {
    const ls = await freshLs();
    const status = () => ls.getLsStatus().pool;
    fake.holdPortProbes = true;
    const oldRequest = ls.ensureLs(null);
    const oldProbe = await waitForProbe(0, 'old generation port probe');

    await ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 });
    assert.equal(status().stopping, 0);

    const newRequest = ls.ensureLs(null);
    const newProbe = await waitForProbe(1, 'new generation port probe (old pending promise must not be reused)');
    assert.equal(status().pending, 1);
    assert.equal(status().size, 1);

    oldProbe.release();
    await assert.rejects(oldRequest, (err) => isInvalidated(err));
    assert.equal(fake.spawns, 0, 'old generation never spawned');
    assert.equal(status().pending, 1, 'stale finally must not delete the new pending promise');
    assert.equal(status().size, 1, 'stale cleanup must not delete the new reservation');

    newProbe.release();
    const entry = await newRequest;
    assert.equal(entry.ready, true);
    assert.equal(fake.spawns, 1);
    await ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 });
    await waitFor(() => status().stopping === 0, 'stopping record released');
    assert.equal(status().size, 0);
  });

  it('refuses a start while stopLanguageServerAndWait is draining, and admits it after', async () => {
    const ls = await freshLs();
    const status = () => ls.getLsStatus().pool;
    const entry = await ls.ensureLs(null);
    assert.equal(entry.ready, true);
    fake.holdExits = true;

    const stopping = ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 150 });
    await assert.rejects(ls.ensureLs(null), (err) => isStopping(err));
    await assert.rejects(ls.startLanguageServer(), (err) => isStopping(err));
    assert.equal(fake.spawns, 1, 'no child spawned during the drain');

    // The admission surface must agree with the refusal: no `can_start` while
    // the drain is in flight, and a distinguishable reason for the caller.
    const duringDrain = ls.getLsAdmissionStatus(null);
    assert.equal(duringDrain.ok, false);
    assert.equal(duringDrain.reason, 'stopping');
    assert.equal(duringDrain.errorType, 'ls_stopping');
    assert.equal(duringDrain.wouldStart, true);
    const drainPool = status();
    assert.equal(drainPool.canStartNewNonDefault, false);
    assert.equal(drainPool.blockReason, 'stopping');
    assert.equal(drainPool.stoppingInFlight, true);

    releaseExits();
    await stopping;
    assert.equal(status().stopping, 0);
    const afterDrain = ls.getLsAdmissionStatus(null);
    assert.equal(afterDrain.ok, true);
    assert.equal(afterDrain.reason, 'can_start');
    assert.equal(afterDrain.errorType, null);
    assert.equal(status().canStartNewNonDefault, true);
    assert.equal(status().blockReason, null);
    assert.equal(status().stoppingInFlight, false);

    const replacement = await ls.ensureLs(null);
    assert.equal(replacement.ready, true);
    assert.equal(fake.spawns, 2);
    // Let the cleanup stop observe a real exit instead of its unref'd SIGKILL
    // backstop (the test process has no other handle keeping the loop alive).
    fake.holdExits = false;
    await ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 });
    assert.equal(status().size, 0);
  });
});

describe('LS stop boundary: restart continuations belong to one generation', () => {
  for (const [stopName, stop] of STOP_VARIANTS) {
    it(`auto: ${stopName} cancels a pre-stop scheduled automatic restart`, async () => {
      process.env.LS_AUTO_RESTART = '1';
      const ls = await freshLs();
      const status = () => ls.getLsStatus().pool;
      const entry = await ls.ensureLs(null);
      assert.equal(entry.ready, true);
      assert.equal(fake.spawns, 1);

      // The crash handler is real product code: it schedules the product timer.
      entry.process.emit('exit', 1, null);
      assert.equal(restartTimers.length, 1, 'an unexpected exit schedules exactly one auto-restart');
      assert.equal(restartTimers[0].active, true);
      assert.deepEqual(ls.getRestartStats(), { default: 1 }, 'attempt budget of the crashed generation');

      await stop(ls);

      // Even a timer that was already dispatched must do nothing post-stop.
      await restartTimers[0].fire();
      assert.equal(fake.spawns, 1, 'a pre-stop automatic restart must not spawn after the stop');
      assert.equal(status().size, 0, 'the stopped pool stays empty');
      assert.equal(status().pending, 0, 'the fired callback left no pending start');
      assert.equal(restartTimers[0].active, false, 'the stop cleared the captured product timer');
      assert.deepEqual(ls.getRestartStats(), {}, 'the cancelled intent leaves no attempt budget');

      const replacement = await ls.ensureLs(null);
      assert.equal(replacement.ready, true);
      assert.equal(fake.spawns, 2, 'an explicit post-stop start still spawns');
      await stopAndSettle(ls);
    });
  }

  it('auto: no-stop control executes exactly one captured restart', async () => {
    process.env.LS_AUTO_RESTART = '1';
    const ls = await freshLs();
    const status = () => ls.getLsStatus().pool;
    const entry = await ls.ensureLs(null);
    entry.process.emit('exit', 1, null);
    assert.equal(restartTimers.length, 1);
    assert.equal(restartTimers[0].active, true);

    await restartTimers[0].fire();

    assert.equal(fake.spawns, 2, 'exactly one replacement child');
    assert.equal(status().ready, 1);
    assert.equal(status().pending, 0);
    assert.equal(restartTimers.length, 1, 'a successful restart schedules no further timer');
    assert.deepEqual(ls.getRestartStats(), {}, 'a successful restart clears the attempt budget');
    await stopAndSettle(ls);
  });

  it('auto: an in-flight restart callback invalidated by a stop does not retry', async () => {
    process.env.LS_AUTO_RESTART = '1';
    const ls = await freshLs();
    const status = () => ls.getLsStatus().pool;
    const entry = await ls.ensureLs(null);
    entry.process.emit('exit', 1, null);
    const timer = restartTimers[0];

    fake.holdPortProbes = true;
    const attempt = timer.fire();
    const probe = await waitForProbe(0, 'port probe of the in-flight restart attempt');
    assert.equal(fake.spawns, 1, 'the attempt is waiting before its spawn');
    assert.equal(status().starting, 1, 'its placeholder is reserved');

    await ls.stopLanguageServerAndWait({ perProcessTimeoutMs: 50 });
    probe.release();
    await attempt;

    assert.equal(fake.spawns, 1, 'the invalidated attempt must not spawn');
    assert.equal(restartTimers.length, 1, 'an invalidated callback must not schedule a retry');
    assert.deepEqual(ls.getRestartStats(), {}, 'the new generation starts with a clean attempt budget');
    assert.deepEqual(
      { size: status().size, pending: status().pending, stopping: status().stopping },
      { size: 0, pending: 0, stopping: 0 },
    );

    fake.holdPortProbes = false;
    const replacement = await ls.ensureLs(null);
    assert.equal(replacement.ready, true);
    assert.equal(fake.spawns, 2, 'a fresh explicit start after the stop still works');
    await stopAndSettle(ls);
  });

  it('auto: a stale restart callback cannot clear a newer generation timer or budget', async () => {
    process.env.LS_AUTO_RESTART = '1';
    const ls = await freshLs();
    const status = () => ls.getLsStatus().pool;
    const first = await ls.ensureLs(null);
    first.process.emit('exit', 1, null);
    const staleTimer = restartTimers[0];

    // Put the stale generation's callback inside ensureLs, parked on its probe.
    fake.holdPortProbes = true;
    const staleAttempt = staleTimer.fire();
    const staleProbe = await waitForProbe(0, 'port probe of the stale restart attempt');

    await ls.stopLanguageServer();

    // A newer generation runs its own start and its own crash restart.
    fake.holdPortProbes = false;
    const replacement = await ls.ensureLs(null);
    assert.equal(fake.spawns, 2);
    replacement.process.emit('exit', 1, null);
    assert.equal(restartTimers.length, 2, 'the new generation schedules its own timer');
    const freshTimer = restartTimers[1];
    assert.equal(freshTimer.active, true);

    // The old callback settles as a cancellation and must not touch new state.
    staleProbe.release();
    await staleAttempt;
    assert.equal(restartTimers.length, 2, 'the stale callback scheduled no retry');
    assert.equal(freshTimer.active, true, 'stale cleanup must not cancel the newer timer');
    assert.deepEqual(ls.getRestartStats(), { default: 1 }, 'the new generation owns a fresh budget');

    await freshTimer.fire();
    assert.equal(fake.spawns, 3, 'the newer generation restarts normally');
    assert.equal(status().ready, 1);
    await stopAndSettle(ls);
  });

  for (const [stopName, stop] of STOP_VARIANTS) {
    it(`per-proxy restart: ${stopName} cancels a restart waiting on the old child`, async () => {
      const ls = await freshLs();
      const status = () => ls.getLsStatus().pool;
      const entry = await ls.ensureLs(null);
      assert.equal(entry.ready, true);
      assert.equal(fake.spawns, 1);

      fake.holdExits = true;
      const restarting = ls.restartLsForProxy(null).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      // The product releases the conversation session before SIGTERM, so wait
      // for the held kill itself (the fake is the only observable event here)
      // before opening the stop.
      await waitFor(() => fake.heldExits.length === 1, 'the restart holds its own SIGTERM');
      assert.equal(status().stopping, 1, 'the restart holds its own stopping record');
      assert.equal(status().size, 0, 'the restart removed its entry before awaiting the old exit');

      await stop(ls);
      releaseExits();
      const outcome = await restarting;

      assert.equal(outcome.ok, false, 'a pre-stop per-proxy restart must not resume as a new start');
      assert.equal(outcome.error.code, 'LS_START_INVALIDATED', 'documented cancellation code');
      assert.equal(fake.spawns, 1, 'the cancelled restart must not spawn');
      assert.deepEqual(
        { size: status().size, pending: status().pending, stopping: status().stopping },
        { size: 0, pending: 0, stopping: 0 },
        'the restart released its own stopping record; no pool entry or spawn remains',
      );

      const replacement = await ls.ensureLs(null);
      assert.equal(replacement.ready, true);
      assert.equal(fake.spawns, 2, 'an explicit post-stop start still spawns');
      await stopAndSettle(ls);
    });
  }

  it('per-proxy restart: no-stop control creates exactly one replacement', async () => {
    const ls = await freshLs();
    const status = () => ls.getLsStatus().pool;
    const entry = await ls.ensureLs(null);
    fake.holdExits = true;
    const restarting = ls.restartLsForProxy(null);
    await waitFor(() => fake.heldExits.length === 1, 'the restart holds its own SIGTERM');
    assert.equal(status().stopping, 1, 'the restart holds its own stopping record');
    releaseExits();
    const replacement = await restarting;

    assert.notEqual(replacement, entry);
    assert.equal(replacement.ready, true);
    assert.equal(fake.spawns, 2, 'exactly one replacement child');
    assert.equal(status().stopping, 0, 'the restart released its own stopping record');
    assert.equal(status().size, 1);
    await stopAndSettle(ls);
  });
});
