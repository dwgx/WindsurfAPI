// Direct contract test for `src/stream-writer.js` — the ONE abort-aware bounded
// writer every SSE egress (chat, messages, responses, gemini) goes through.
//
// Until now the module had no direct test: its behaviour was only observable
// through four handlers, so a regression in the waiter bookkeeping would have to
// be caught by a full streaming integration suite (and KH-001 showed that seam is
// exactly where backpressure gets dropped). This file drives the module with a
// fully controlled writable and pins what its header promises:
//
//   * at most ONE outstanding drain wait per stream — no payload queue;
//   * the false-returning frame was already accepted and is NEVER resent;
//   * the wait races response 'drain'/'close'/'error' and the caller's abort
//     signal, settles exactly once, and detaches its own listeners;
//   * closed/aborted is re-checked before every write and after every wait;
//   * a half-open client is bounded: `onTimeout` runs once and the writer stops
//     arming waits, so the caller can tear the stream down;
//   * `enabled: false` keeps the legacy synchronous producer byte-identical.
//
// Deliberately no server and no `src/index.js`: the module has no imports of its
// own, so this suite stays hermetic and runs in milliseconds.
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import {
  MAX_DRAIN_BUDGETED_BYTES,
  MAX_DRAIN_WAIT_DEFAULT_MS,
  MAX_TIMER_MS,
  MIN_CLIENT_RATE_BPS_DEFAULT,
  clientGoneError,
  createBoundedWriter,
  drainDeadlineMs,
  resolveMaxDrainWaitMs,
  resolveMinClientRateBps,
} from '../src/stream-writer.js';

/**
 * A writable the test fully controls: it records every frame and every write
 * call, and hands out the verdicts the test queues (defaulting to `true`).
 */
function fakeRes({ verdicts = [], writeDefault = true } = {}) {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.writes = [];
  res.writeCalls = 0;
  res.write = (chunk) => {
    res.writeCalls += 1;
    res.writes.push(String(chunk));
    return verdicts.length ? verdicts.shift() : writeDefault;
  };
  res.end = (chunk) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
    return res;
  };
  return res;
}

/** Let queued microtasks and one macrotask turn run, without a fixed sleep. */
const pump = async (n = 2) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Resolve `promise` or fail the test if it is still parked after `ms`.
 *
 * The guard timer is deliberately ref'd: the writer's own drain timer is
 * `unref()`'d (it must never hold the process open), so the guard is what keeps
 * the loop alive long enough for a short injected bound to expire. Without it a
 * stalled wait would surface as a whole-file timeout instead of one failing test.
 */
function withDeadline(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still pending after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Assert a rejection is the repo-wide client-abort shape. */
function assertClientAbort(err) {
  assert.equal(err.name, 'AbortError');
  assert.equal(err.code, 'CLIENT_ABORTED');
  assert.equal(err.isClientAbort, true);
  return true;
}

/** No waiter of any kind may survive a settled or refused wait. */
function assertNoListeners(res) {
  assert.equal(res.listenerCount('drain'), 0, 'drain listener leaked');
  assert.equal(res.listenerCount('close'), 0, 'close listener leaked');
  assert.equal(res.listenerCount('error'), 0, 'error listener leaked');
}

describe('createBoundedWriter: at most one drain waiter per stream', () => {
  it('arms exactly one waiter, does not arm a second, and releases it on drain', async () => {
    const res = fakeRes({ verdicts: [false, false, true] });
    const ac = new AbortController();
    const w = createBoundedWriter({ res, signal: ac.signal, maxWaitMs: 5_000 });

    assert.equal(w.pending, null);
    assert.equal(w.write('frame-1'), false);
    const first = w.pending;
    assert.ok(first instanceof Promise, 'a false verdict must arm the drain wait');
    assert.equal(res.listenerCount('drain'), 1);
    assert.equal(res.listenerCount('close'), 1);
    assert.equal(res.listenerCount('error'), 1);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 1);

    // A second false verdict while the wait is outstanding must reuse it: the
    // module has no queue, so there is nothing else to wait for.
    assert.equal(w.write('frame-2'), false);
    assert.equal(w.pending, first, 'a second write must not replace the outstanding wait');
    assert.equal(res.listenerCount('drain'), 1, 'a second write must not arm a second waiter');
    assert.deepEqual(res.writes, ['frame-1', 'frame-2'], 'the false-returning frames are never resent');

    res.emit('drain');
    assert.equal(w.pending, null);
    assertNoListeners(res);
    // Settled by drain, not by abort: only the explicit removeEventListener in
    // finishDrain can drop this one.
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'abort listener leaked');

    await withDeadline(first, 2_000, 'drain wait');
    await w.awaitDrain(); // nothing outstanding, writer still live: must not throw
    assert.equal(w.gone(), false);
    assert.equal(w.write('frame-3'), true);
  });

  it('settles the wait on close and on error, detaching every listener', async () => {
    for (const event of ['close', 'error']) {
      const res = fakeRes({ writeDefault: false });
      const w = createBoundedWriter({ res, maxWaitMs: 5_000 });
      assert.equal(w.write('frame-1'), false);
      const pending = w.pending;
      assert.ok(pending);

      if (event === 'close') res.writableEnded = true; // a real close ends the response
      res.emit(event);

      assert.equal(w.pending, null, `'${event}' must settle the wait`);
      assertNoListeners(res);
      await withDeadline(pending, 2_000, `'${event}' to settle the wait`);
      assert.equal(w.timedOut, false, `'${event}' is not a timeout`);
      if (event === 'close') {
        await assert.rejects(w.awaitDrain(), assertClientAbort);
      } else {
        await w.awaitDrain(); // error alone is the caller's failure stage to classify
      }
    }
  });

  it('re-checks "gone" after arming, so a client lost during setup never parks the producer', async () => {
    const res = fakeRes({ writeDefault: false });
    const origOn = res.on.bind(res);
    let flipped = false;
    res.on = (event, handler) => {
      if (!flipped && event === 'drain') {
        flipped = true;
        res.writableEnded = true; // the client vanished between the verdict and the wait
      }
      return origOn(event, handler);
    };
    const w = createBoundedWriter({ res, maxWaitMs: 5_000 });

    assert.equal(w.write('frame-1'), false);
    assert.equal(w.pending, null, 'the post-arm re-check must settle the wait immediately');
    assert.equal(w.timedOut, false, 'this is a gone client, not a half-open timeout');
    assertNoListeners(res);
    await assert.rejects(w.awaitDrain(), assertClientAbort);
  });

  it('writeFrame holds the next frame behind the outstanding drain', async () => {
    const res = fakeRes({ verdicts: [false, true] });
    const w = createBoundedWriter({ res, maxWaitMs: 5_000 });

    assert.equal(w.write('frame-1'), false);
    let wrote = false;
    const frame = w.writeFrame('frame-2').then(() => { wrote = true; });
    await pump();
    assert.equal(wrote, false, 'writeFrame must not emit while the drain is pending');
    assert.deepEqual(res.writes, ['frame-1']);

    res.emit('drain');
    await withDeadline(frame, 2_000, 'writeFrame to resume');
    assert.deepEqual(res.writes, ['frame-1', 'frame-2']);
  });

  it('lets a throwing write propagate instead of reclassifying the socket', () => {
    const res = fakeRes();
    res.write = () => { throw new Error('socket is broken'); };
    const w = createBoundedWriter({ res, maxWaitMs: 5_000 });

    assert.throws(() => w.write('frame-1'), /socket is broken/);
    assert.equal(w.pending, null, 'a throwing write must not arm a waiter');
  });
});

describe('createBoundedWriter: bounded half-open client', () => {
  it('runs onTimeout exactly once and refuses further bytes once the caller tears down', async () => {
    const res = fakeRes({ writeDefault: false });
    const timeouts = [];
    const w = createBoundedWriter({
      res,
      maxWaitMs: 25,
      // The module documents onTimeout as running BEFORE it stops arming, and the
      // caller owning the teardown. Model exactly that: mark the response ended.
      onTimeout: (info) => {
        timeouts.push(info);
        res.writableEnded = true;
      },
    });

    assert.equal(w.write('frame-1'), false);
    const pending = w.pending;
    assert.equal(res.listenerCount('drain'), 1);

    await withDeadline(pending, 2_000, 'half-open drain wait to expire');
    assert.equal(timeouts.length, 1, 'onTimeout must run exactly once');
    assert.equal(timeouts[0].maxWaitMs, 25);
    assert.equal(timeouts[0].pendingBytes, 'frame-1'.length);
    assert.equal(timeouts[0].minClientRateBps, MIN_CLIENT_RATE_BPS_DEFAULT);
    assert.equal(w.timedOut, true);
    assert.equal(w.pending, null);
    assertNoListeners(res);

    await assert.rejects(w.awaitDrain(), assertClientAbort);

    const callsBefore = res.writeCalls;
    assert.equal(w.write('frame-2'), true, 'a gone writer reports success: no bytes were needed');
    assert.equal(res.writeCalls, callsBefore, 'no bytes may reach a torn-down client');
  });

  it('stops arming waits after a timeout even when the caller has not torn down yet', async () => {
    const res = fakeRes({ writeDefault: false });
    const timeouts = [];
    const w = createBoundedWriter({
      res,
      maxWaitMs: 25,
      onTimeout: (info) => timeouts.push(info),
    });

    assert.equal(w.write('frame-1'), false);
    await withDeadline(w.pending, 2_000, 'half-open drain wait to expire');
    assert.equal(w.timedOut, true);
    assert.equal(timeouts.length, 1);

    // The real verdict is still reported (the frame was accepted), but no new
    // waiter may be armed behind a client that already proved half-open.
    assert.equal(w.write('frame-2'), false);
    assert.equal(w.pending, null, 'the writer must stop accepting waits');
    assert.equal(timeouts.length, 1, 'onTimeout must not run again');
    assertNoListeners(res);
  });
});

describe('createBoundedWriter: abort and teardown settlement', () => {
  it('settles as a client abort when the caller signal fires mid-wait', async () => {
    const res = fakeRes({ writeDefault: false });
    const ac = new AbortController();
    const w = createBoundedWriter({ res, signal: ac.signal, maxWaitMs: 5_000 });

    assert.equal(w.write('frame-1'), false);
    const pending = w.pending;
    assert.equal(getEventListeners(ac.signal, 'abort').length, 1);

    ac.abort();
    await withDeadline(pending, 2_000, 'abort to settle the drain wait');
    assert.equal(w.pending, null);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'abort listener leaked');
    assertNoListeners(res);
    assert.equal(w.gone(), true);
    await assert.rejects(w.awaitDrain(), assertClientAbort);

    const callsBefore = res.writeCalls;
    assert.equal(w.write('frame-2'), true);
    assert.equal(res.writeCalls, callsBefore);
  });

  it('refuses bytes before a write once the response has ended', () => {
    const res = fakeRes({ writeDefault: true });
    res.writableEnded = true;
    const w = createBoundedWriter({ res, maxWaitMs: 5_000 });

    assert.equal(w.gone(), true);
    assert.equal(w.write('frame-1'), true, 'a gone writer reports success: no bytes were needed');
    assert.equal(res.writeCalls, 0);
    assert.equal(w.pending, null);
    assertNoListeners(res);
  });

  it('dispose settles a parked producer and settle() never throws', async () => {
    const res = fakeRes({ writeDefault: false });
    const w = createBoundedWriter({ res, maxWaitMs: 5_000 });

    assert.equal(w.write('frame-1'), false);
    const pending = w.pending;
    w.dispose();
    assert.equal(w.gone(), true);
    await withDeadline(pending, 2_000, 'dispose to settle the drain wait');
    assert.equal(w.pending, null);
    assertNoListeners(res);
    await assert.rejects(w.awaitDrain(), assertClientAbort);
    await w.settle(); // the teardown variant must reach cleanup, not throw
  });

  it('settle() waits for an outstanding drain without throwing', async () => {
    const res = fakeRes({ writeDefault: false });
    const w = createBoundedWriter({ res, maxWaitMs: 5_000 });

    assert.equal(w.write('frame-1'), false);
    let done = false;
    const teardown = w.settle().then(() => { done = true; });
    await pump();
    assert.equal(done, false, 'settle() must actually wait for the drain');
    res.emit('drain');
    await withDeadline(teardown, 2_000, 'settle to finish');
    assert.equal(done, true);
  });

  it('clientGoneError carries the abort shape every producer recognises', () => {
    assertClientAbort(clientGoneError());
    assert.match(clientGoneError().message, /drain/);
    assert.equal(clientGoneError('custom reason').message, 'custom reason');
  });
});

describe('createBoundedWriter: legacy synchronous mode', () => {
  it('enabled:false returns the real verdict and arms no waiter', async () => {
    const res = fakeRes({ verdicts: [false, true] });
    const w = createBoundedWriter({ res, enabled: false, maxWaitMs: 5_000 });

    assert.equal(w.write('frame-1'), false, 'the verdict is still returned');
    assert.equal(w.pending, null, 'no drain waiter may be armed');
    assertNoListeners(res);

    // The legacy path is fully synchronous: writeFrame returns undefined and has
    // already written, it does not return a promise the caller could await.
    const verdict = w.writeFrame('frame-2');
    assert.equal(verdict, undefined);
    assert.deepEqual(res.writes, ['frame-1', 'frame-2']);
    await w.awaitDrain(); // nothing was ever outstanding
  });
});

describe('resolveMaxDrainWaitMs', () => {
  it('honours a positive override and falls back on invalid or empty input', () => {
    assert.equal(MAX_DRAIN_WAIT_DEFAULT_MS, 30_000);
    assert.equal(resolveMaxDrainWaitMs('2500'), 2_500);
    assert.equal(resolveMaxDrainWaitMs('1'), 1);
    for (const raw of ['0', '-5', '', '   ', 'abc', null]) {
      assert.equal(
        resolveMaxDrainWaitMs(raw),
        MAX_DRAIN_WAIT_DEFAULT_MS,
        `raw=${JSON.stringify(raw)} must fall back`,
      );
    }
  });

  it('reads WINDSURFAPI_MAX_DRAIN_MS when no argument is given', () => {
    const saved = process.env.WINDSURFAPI_MAX_DRAIN_MS;
    try {
      process.env.WINDSURFAPI_MAX_DRAIN_MS = '4321';
      assert.equal(resolveMaxDrainWaitMs(), 4_321);
      delete process.env.WINDSURFAPI_MAX_DRAIN_MS;
      assert.equal(resolveMaxDrainWaitMs(), MAX_DRAIN_WAIT_DEFAULT_MS);
    } finally {
      if (saved === undefined) delete process.env.WINDSURFAPI_MAX_DRAIN_MS;
      else process.env.WINDSURFAPI_MAX_DRAIN_MS = saved;
    }
  });
});

describe('resolveMinClientRateBps', () => {
  it('defaults to 8 KiB/s and honours a positive override', () => {
    assert.equal(MIN_CLIENT_RATE_BPS_DEFAULT, 8 * 1024);
    assert.equal(resolveMinClientRateBps('4096'), 4_096);
    for (const raw of ['0', '-1', '', 'nope', null]) {
      assert.equal(resolveMinClientRateBps(raw), MIN_CLIENT_RATE_BPS_DEFAULT);
    }
  });
});

describe('drainDeadlineMs', () => {
  it('is fixed + bytes/minClientRate', () => {
    const fixed = MAX_DRAIN_WAIT_DEFAULT_MS;
    assert.equal(drainDeadlineMs({ bytes: 0, fixedMs: fixed }), fixed);
    assert.equal(drainDeadlineMs({ bytes: 8 * 1024, fixedMs: fixed }), fixed + 1_000);
    assert.equal(drainDeadlineMs({ bytes: MAX_DRAIN_BUDGETED_BYTES, fixedMs: fixed }), fixed + 512_000);
  });

  it('bounds a stalled 4KB frame well under the old fixed 120s and a 5MB frame above it', () => {
    const small = drainDeadlineMs({ bytes: 4 * 1024 });
    const large = drainDeadlineMs({ bytes: 5 * 1024 * 1024 });
    assert.ok(small < 120_000, `4KB budget ${small} must be under the old 120s`);
    assert.ok(large > 120_000, `5MB budget ${large} must exceed the old 120s`);
  });

  it('caps the proportional term: a never-draining backlog cannot bank minutes per queued byte', () => {
    // pendingBytes only accrues while NO 'drain' has fired in the epoch, so a
    // backlog beyond MAX_DRAIN_BUDGETED_BYTES is by definition a client that
    // has not taken a single byte — granting it proportional time just keeps
    // upstream quota burning on a dead socket.
    const capped = drainDeadlineMs({ bytes: MAX_DRAIN_BUDGETED_BYTES });
    assert.equal(drainDeadlineMs({ bytes: 64 * 1024 * 1024 }), capped);
    assert.equal(drainDeadlineMs({ bytes: 1 << 30 }), capped);
    assert.ok(
      capped <= MAX_DRAIN_WAIT_DEFAULT_MS + 600_000,
      `capped budget ${capped} must stay under ~10 minutes at the default rate`,
    );
  });
});

describe('createBoundedWriter: proportional drain budget', () => {
  const MB = 1024 * 1024;

  it('a slow reader of a 5MB frame survives past the old fixed 120s', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
      const res = fakeRes({ writeDefault: false });
      const w = createBoundedWriter({ res, maxWaitMs: 30_000 });
      assert.equal(w.write('x'.repeat(5 * MB)), false);
      assert.equal(w.pendingBytes, 5 * MB);
      assert.ok(w.deadlineMs > 120_000, `budget ${w.deadlineMs} must exceed the old fixed 120s`);

      // Past the old fixed deadline, the wait is still live: the 5MB frame has
      // earned ~640s of proportional budget.
      mock.timers.tick(130_000);
      assert.equal(w.timedOut, false, 'a 5MB frame must not abort at the old 120s');

      res.emit('drain');
      assert.equal(w.pending, null);
      assert.equal(w.pendingBytes, 0, 'drain acknowledges the backlog');
      assert.equal(w.deadlineMs, 30_000, 'the budget resets to the fixed wait');
      await w.awaitDrain();
      assert.equal(w.timedOut, false);
      assertNoListeners(res);
    } finally {
      mock.timers.reset();
    }
  });

  it('a fully stalled 4KB frame aborts at fixed + 4KB/rate, not at 120s', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
      const res = fakeRes({ writeDefault: false });
      const timeouts = [];
      const w = createBoundedWriter({
        res,
        maxWaitMs: 30_000,
        onTimeout: (info) => timeouts.push(info),
      });
      assert.equal(w.write('x'.repeat(4 * 1024)), false);
      const budget = w.deadlineMs;
      assert.ok(budget < 120_000, `4KB budget ${budget} must be under the old 120s`);
      assert.equal(budget, 30_000 + 500);

      mock.timers.tick(budget - 1);
      assert.equal(w.timedOut, false, 'the wait must not expire one ms early');
      mock.timers.tick(1);
      assert.equal(w.timedOut, true, 'the stalled 4KB frame aborts at its budget');
      assert.equal(timeouts.length, 1, 'onTimeout must run exactly once');
      assert.equal(timeouts[0].pendingBytes, 4 * 1024);
      assert.ok(timeouts[0].budgetMs < 120_000);
      assertNoListeners(res);

      // The writer stops arming waits; no second timeout, no leaked listener.
      assert.equal(w.write('frame-2'), false);
      assert.equal(w.pending, null);
      assert.equal(timeouts.length, 1);
      assertNoListeners(res);
    } finally {
      mock.timers.reset();
    }
  });

  it('a healthy long stream never accrues stall budget', () => {
    const res = fakeRes({ writeDefault: true });
    const w = createBoundedWriter({ res, maxWaitMs: 1_000, minClientRateBps: 1_024 });
    for (let i = 0; i < 100; i += 1) w.write('x'.repeat(1024));
    assert.equal(w.pendingBytes, 0, 'accepted writes buy no budget');
    assert.equal(w.deadlineMs, 1_000);
    assert.equal(w.pending, null);
  });

  it('re-arming on a later false write extends only the proportional term, not the fixed floor', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
      const res = fakeRes({ verdicts: [false, false] });
      const timeouts = [];
      const w = createBoundedWriter({
        res,
        maxWaitMs: 1_000,
        minClientRateBps: 1_024,
        onTimeout: (info) => timeouts.push(info),
      });
      // First false write at t=0: the wait's anchored deadline is
      // start + fixed + bytes/rate = 0 + 1000 + 1024 = 2000ms.
      assert.equal(w.write('x'.repeat(1_024)), false);
      assert.equal(w.pendingBytes, 1_024);

      // A second false write at t=1500 joins the SAME backlog: the deadline
      // extends by the new bytes' proportional term only (2048B total at
      // 1KiB/s = 2000ms, plus the fixed 1000ms = 3000ms from the wait's START),
      // so the anchored deadline is t=3000 — NOT t=1500 + 3000 = 4500, which is
      // what re-arming the whole formula from now would give.
      mock.timers.tick(1_500);
      assert.equal(w.write('x'.repeat(1_024)), false);
      assert.equal(w.pendingBytes, 2_048);
      assert.equal(w.deadlineMs, 3_000, 'the total-budget formula is unchanged');

      mock.timers.tick(1_499); // t=2999 — one ms before the anchored deadline
      assert.equal(w.timedOut, false, 'the wait must survive until its anchored deadline');
      mock.timers.tick(1);     // t=3000
      assert.equal(w.timedOut, true, 'the anchored deadline must fire on time');
      assert.equal(timeouts.length, 1, 'onTimeout must run exactly once');
      assertNoListeners(res);
    } finally {
      mock.timers.reset();
    }
  });

  it('resets the backlog on drain instead of carrying it across waits', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
      const res = fakeRes({ verdicts: [false, false] });
      const w = createBoundedWriter({ res, maxWaitMs: 1_000, minClientRateBps: 1_024 });
      assert.equal(w.write('x'.repeat(1_024)), false);
      assert.equal(w.pendingBytes, 1_024);
      assert.equal(w.deadlineMs, 2_000, '1KB at 1 KiB/s plus the fixed wait');

      res.emit('drain');
      assert.equal(w.pendingBytes, 0);
      assert.equal(w.deadlineMs, 1_000, 'drain must not leave a carried horizon');

      // A later stall starts from its own bytes, not the earlier 1KB.
      assert.equal(w.write('x'.repeat(2 * 1_024)), false);
      assert.equal(w.pendingBytes, 2 * 1_024);
      assert.equal(w.deadlineMs, 3_000);
    } finally {
      mock.timers.reset();
    }
  });

  it('caps the timer delay at the largest value Node accepts', () => {
    assert.equal(MAX_TIMER_MS, 2_147_483_647);
    // The budgeted-bytes clamp normally keeps delays far below MAX_TIMER_MS;
    // reach the timer clamp by opting out of the backlog bound explicitly.
    assert.equal(
      drainDeadlineMs({ bytes: Number.MAX_SAFE_INTEGER, maxBudgetedBytes: Number.MAX_SAFE_INTEGER }),
      MAX_TIMER_MS,
    );
    // A non-positive cap is treated as "no backlog bound" — still clamped.
    assert.equal(drainDeadlineMs({ bytes: Number.MAX_SAFE_INTEGER, maxBudgetedBytes: 0 }), MAX_TIMER_MS);
  });
});
