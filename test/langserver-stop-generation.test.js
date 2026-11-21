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
// Fakes only: child_process.spawn, net.createConnection (the port-in-use
// probe) and http2.connect (the readiness probe) are replaced before
// importing the module, so no LS binary, port or network is touched. Each
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

    releaseExits();
    await stopping;
    assert.equal(status().stopping, 0);

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
