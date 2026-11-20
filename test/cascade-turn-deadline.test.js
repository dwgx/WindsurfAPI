// F3 (evidence/audit2/Cascade.md:280-296): the route budget did not cover the
// send phase. chat.js passes `maxWaitMs: budget.remainingMs()` — a DURATION —
// and the producer started its clock only after warmup + StartCascade + up to
// four Sends. Measured: a 100 ms budget took 310 ms behind a 250 ms Send, and
// the poll loop then received the full remainder again.
//
// The contract pinned here:
//   * ONE absolute turn deadline is captured at producer entry and every phase
//     (warmup, StartCascade, Send/retry, polling, detach admission) spends
//     from it;
//   * a slow Send cannot outlive the budget and the turn ends as a budget
//     stop, not as an idle/transport verdict;
//   * no new upstream attempt is started after the deadline (a timed-out
//     recovery StartCascade does not lead to a second Send);
//   * controls: a fast Send, a retried Send inside the budget, and a long
//     valid multi-poll answer still complete normally.
//
// The seam is the real `cascadeChat` against a fake HTTP/2 language server,
// with arrival timestamps recorded server-side so "after the deadline" is a
// measured fact rather than an inference from elapsed time.

import './setup-env.mjs';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { terminateRpcWithStatus } from './helpers/fake-grpc-trailers.mjs';

// Product imports are dynamic and come AFTER this block: src/client.js freezes
// CASCADE_TIMEOUTS at module load.
Object.assign(process.env, {
  GRPC_PROTOCOL: 'connect',
  CASCADE_POLL_INTERVAL_MS: '10',
  CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '1500',
  CASCADE_COLD_STALL_BASE_MS: '1500',
  CASCADE_WARM_STALL_MS: '1500',
  WINDSURFAPI_USER_JWT: '0',
  RESPONSE_CACHE_ENABLED: '0',
});

const { unwrapRequest, wrapEnvelope, endOfStreamEnvelope } = await import('../src/connect.js');
const { writeMessageField, writeStringField, writeVarintField } = await import('../src/proto.js');
const { isBudgetExceededError } = await import('../src/request-budget.js');
const { WindsurfClient } = await import('../src/client.js');

const MODEL_UID = 'claude-sonnet-4-6';
const MESSAGES = [{ role: 'user', content: 'hi' }];

afterEach(() => {
  delete process.env.WINDSURFAPI_CASCADE_TURN;
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plannerStepBody({ responseText = '', modifiedText = '', status = 3 }) {
  const fields = [];
  if (responseText) fields.push(writeStringField(1, responseText));
  if (modifiedText) fields.push(writeStringField(8, modifiedText));
  return Buffer.concat([
    writeVarintField(1, 15),
    writeVarintField(4, status),
    writeMessageField(20, Buffer.concat(fields)),
  ]);
}

function stepsBody(texts) {
  return Buffer.concat(texts.map((text) => writeMessageField(1, plannerStepBody({ responseText: text }))));
}

function connectErrorBody(message) {
  const bytes = Buffer.from(JSON.stringify({ error: { message } }));
  const frame = Buffer.alloc(5 + bytes.length);
  frame[0] = 2;
  frame.writeUInt32BE(bytes.length, 1);
  bytes.copy(frame, 5);
  return frame;
}

/**
 * Fake LS. `plan(method, state, payload)` returns
 * `{ delayMs, body, error }`; arrival timestamps are recorded before the delay.
 */
async function withFakeLs(plan, fn) {
  const requests = [];
  const state = { starts: 0, sends: 0, stepReads: 0, statusReads: 0 };
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    terminateRpcWithStatus(stream);
    stream.on('error', () => {});
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      let payload = Buffer.alloc(0);
      try { payload = unwrapRequest(Buffer.concat(chunks), headers); } catch {}
      const method = String(headers[':path'] || '').split('/').pop();
      requests.push({ method, at: Date.now() });
      if (method === 'StartCascade') state.starts++;
      if (method === 'SendUserCascadeMessage') state.sends++;
      if (method === 'GetCascadeTrajectorySteps') state.stepReads++;
      if (method === 'GetCascadeTrajectory') state.statusReads++;
      const step = plan(method, state, payload) || {};
      const send = () => {
        // The client may have cancelled at the deadline; a late response is
        // exactly what this fixture must tolerate.
        try {
          stream.respond({
            ':status': 200,
            'content-type': headers['content-type'] || 'application/connect+proto',
          });
          const body = step.error ? connectErrorBody(step.error) : (step.body || Buffer.alloc(0));
          stream.end(step.error ? body : Buffer.concat([wrapEnvelope(body, { compress: false }), endOfStreamEnvelope()]));
        } catch {}
      };
      if (step.delayMs > 0) setTimeout(send, step.delayMs);
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn({ port, requests, state });
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

// The deadline contract starts at producer entry, so the per-LS workspace
// handshake is not what these arms measure. Skipping it keeps the budget
// arithmetic deterministic on a slow checkout (the real warmup has its own
// never-finishes arm below).
class NoWarmClient extends WindsurfClient {
  warmupCascade() { return Promise.resolve(); }
}

async function runTurn({ port, maxWaitMs, onChunk, onEnd, signal, detach, Client = NoWarmClient, clockCapMs }) {
  const client = new Client('test-api-key', port, 'csrf-token');
  const opts = { onChunk, onEnd, signal, detach };
  if (maxWaitMs !== undefined) opts.maxWaitMs = maxWaitMs;
  const realNow = Date.now;
  let clockAnchor = null;
  // Test seam for the wall-clock/timer rounding boundary: once the turn's
  // first clock read happens, the wall clock is capped at `clockCapMs` from
  // there while the real timers keep running. This reproduces a deadline
  // timer that fires with a millisecond or two still reading as "left",
  // deterministically instead of waiting for a loaded scheduler to do it.
  if (clockCapMs !== undefined) {
    Date.now = () => {
      const now = realNow();
      if (clockAnchor === null) clockAnchor = now;
      return Math.min(now, clockAnchor + clockCapMs);
    };
  }
  const started = realNow();
  try {
    const chunks = await client.cascadeChat(MESSAGES, 0, MODEL_UID, opts);
    return {
      started,
      elapsed: realNow() - started,
      chunks,
      text: chunks.map((chunk) => chunk.text || '').join(''),
    };
  } catch (err) {
    return { started, elapsed: realNow() - started, err };
  } finally {
    if (clockCapMs !== undefined) Date.now = realNow;
  }
}

function idleStatus() {
  return writeVarintField(2, 1);
}

describe('F3 the route budget covers the whole turn', () => {
  for (const cause of ['abort', 'deadline']) {
    it(`a pending JWT lookup cannot send after ${cause}`, async (t) => {
      const budgetMs = 1000;
      const controller = new AbortController();
      const lookupStarted = Promise.withResolvers();
      const jwt = Promise.withResolvers();
      class PendingJwtClient extends NoWarmClient {
        _fetchUserJwtForChat() {
          lookupStarted.resolve();
          return jwt.promise;
        }
      }

      await withFakeLs((method) => {
        if (method === 'StartCascade') return { body: writeStringField(1, 'fixture-cascade') };
      }, async (server) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
        const turn = runTurn({
          port: server.port, Client: PendingJwtClient, maxWaitMs: budgetMs, signal: controller.signal,
        });
        assert.ok(await Promise.race([lookupStarted.promise.then(() => true), turn.then(() => false)]),
          'the turn must reach JWT preparation');

        if (cause === 'abort') {
          // Client cancellation still owns the result inside the RPC timeout tolerance.
          t.mock.timers.tick(budgetMs - 1);
          controller.abort();
        } else {
          t.mock.timers.tick(budgetMs);
        }
        const finishedBeforeJwt = await Promise.race([
          turn.then(() => true),
          new Promise(resolve => setImmediate(() => resolve(false))),
        ]);
        jwt.resolve(null);
        const result = await turn;
        assert.equal(server.state.sends, 0, 'a late JWT completion must never submit a generation');
        assert.ok(finishedBeforeJwt, 'the caller must finish while the shared JWT is still pending');
        if (cause === 'abort') {
          assert.equal(result.err?.name, 'AbortError');
          assert.equal(result.err.code, 'ABORT_ERR');
        } else {
          assert.ok(isBudgetExceededError(result.err), 'the caller must receive the route deadline error');
        }
      });
    });
  }

  it('an ordinary JWT lookup failure still submits one unsigned turn', async () => {
    class FailedJwtClient extends NoWarmClient {
      async _fetchUserJwtForChat() { throw new Error('fixture lookup failure'); }
    }
    await withFakeLs((method) => {
      if (method === 'StartCascade') return { body: writeStringField(1, 'fixture-cascade') };
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
    }, async (server) => {
      const result = await runTurn({ port: server.port, Client: FailedJwtClient });
      assert.equal(result.text, 'answer');
      assert.equal(server.state.sends, 1);
    });
  });

  it('checks the wall clock after the JWT resolves, before the deadline timer runs', async (t) => {
    const budgetMs = 1000;
    await withFakeLs((method) => {
      if (method === 'StartCascade') return { body: writeStringField(1, 'fixture-cascade') };
    }, async (server) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
      class ElapsedJwtClient extends NoWarmClient {
        async _fetchUserJwtForChat() {
          await Promise.resolve();
          t.mock.timers.setTime(Date.now() + budgetMs);
          return null;
        }
      }
      const result = await runTurn({ port: server.port, Client: ElapsedJwtClient, maxWaitMs: budgetMs });
      assert.equal(server.state.sends, 0, 'a completed lookup cannot grant time for a new Send');
      assert.ok(isBudgetExceededError(result.err));
    });
  });

  it('a slow Send cannot outlive the budget, and nothing is polled after it', async () => {
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { body: writeStringField(1, `cascade-${state.starts}`) };
      if (method === 'SendUserCascadeMessage') return { delayMs: 400 };
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
      return {};
    }, async (server) => {
      const budgetMs = 120;
      const result = await runTurn({ port: server.port, maxWaitMs: budgetMs });

      assert.ok(result.elapsed < 400,
        `a ${budgetMs}ms budget took ${result.elapsed}ms behind a 400ms Send`);
      assert.ok(isBudgetExceededError(result.err),
        `the turn must end as a budget stop, got: ${result.err?.message || JSON.stringify(result.text)}`);
      assert.equal(result.err.type, 'upstream_deadline_exceeded');

      const deadline = result.started + budgetMs;
      const late = server.requests.filter((request) => request.at > deadline + 60);
      assert.deepEqual(late.map((request) => request.method), [],
        'no upstream attempt may be issued after the deadline');
      assert.equal(server.state.sends, 1, 'the timed-out Send is not retried after the deadline');
      assert.equal(server.state.stepReads, 0, 'the poll loop must not run on an exhausted budget');
      assert.equal(server.state.statusReads, 0);
    });
  });

  it('a StartCascade that outlives the budget stops the turn before Send', async () => {
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { delayMs: 400, body: writeStringField(1, `cascade-${state.starts}`) };
      if (method === 'SendUserCascadeMessage') return {};
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
      return {};
    }, async (server) => {
      const budgetMs = 120;
      const result = await runTurn({ port: server.port, maxWaitMs: budgetMs });

      assert.ok(result.elapsed < 400, `StartCascade outlived the budget: ${result.elapsed}ms`);
      assert.ok(isBudgetExceededError(result.err), `expected a budget stop, got: ${result.err?.message}`);
      assert.equal(server.state.starts, 1);
      assert.equal(server.state.sends, 0, 'no Send may follow an expired StartCascade');
      assert.equal(server.state.stepReads, 0);
    });
  });

  it('a phase timer that fires on the last budget tick is still the budget stop', async () => {
    // B06 CI flake (release attempt 2): the same StartCascade case failed with
    // "expected a budget stop, got: gRPC unary timeout" after 120.24 ms. The
    // StartCascade timer is armed from an integer-millisecond wall clock; when
    // it fires, Date.now() can still read 1-2 ms of budget left because both
    // endpoints truncate. `throwIfSpent` treated that as "not spent" and
    // rethrew a transport error. Pin the boundary deterministically by capping
    // the wall clock one millisecond short of the budget while the real timer
    // runs its full remaining slice.
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { delayMs: 400, body: writeStringField(1, `cascade-${state.starts}`) };
      if (method === 'SendUserCascadeMessage') return {};
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
      return {};
    }, async (server) => {
      const budgetMs = 120;
      const result = await runTurn({ port: server.port, maxWaitMs: budgetMs, clockCapMs: budgetMs - 1 });

      assert.ok(result.elapsed < 400, `the capped clock stretched the turn: ${result.elapsed}ms`);
      assert.ok(isBudgetExceededError(result.err),
        `a timer firing on the last budget tick must be the budget stop, got: ${result.err?.message}`);
      assert.equal(result.err.type, 'upstream_deadline_exceeded');
      assert.equal(server.state.starts, 1);
      assert.equal(server.state.sends, 0, 'no Send may follow the expired StartCascade');
      assert.equal(server.state.stepReads, 0);
    });
  });

  it('a warmup that never finishes is bounded by the deadline and starts no RPC', async () => {
    class NeverWarmClient extends WindsurfClient {
      warmupCascade() { return new Promise(() => {}); }
    }
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { body: writeStringField(1, `cascade-${state.starts}`) };
      if (method === 'SendUserCascadeMessage') return {};
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
      return {};
    }, async (server) => {
      const budgetMs = 120;
      const outcome = await Promise.race([
        runTurn({ port: server.port, maxWaitMs: budgetMs, Client: NeverWarmClient }),
        sleep(1500).then(() => ({ hung: true })),
      ]);

      assert.equal(outcome.hung, undefined, 'the warmup await is outside the turn deadline');
      assert.ok(isBudgetExceededError(outcome.err), `expected a budget stop, got: ${outcome.err?.message}`);
      assert.ok(outcome.elapsed < 600, `warmup outlived the budget: ${outcome.elapsed}ms`);
      assert.deepEqual(server.requests.map((request) => request.method), [],
        'an exhausted warmup must not be followed by any upstream RPC');
    });
  });

  it('a recovery StartCascade cannot outlive the deadline and is not followed by a second Send', async () => {
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') {
        return state.starts === 1
          ? { body: writeStringField(1, 'cascade-1') }
          : { delayMs: 400, body: writeStringField(1, `cascade-${state.starts}`) };
      }
      if (method === 'SendUserCascadeMessage') {
        return state.sends === 1 ? { error: 'panel state not found for sessionId fixture' } : {};
      }
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
      return {};
    }, async (server) => {
      const budgetMs = 150;
      const result = await runTurn({ port: server.port, maxWaitMs: budgetMs });

      assert.ok(result.elapsed < 400,
        `the recovery StartCascade outlived the budget: ${result.elapsed}ms`);
      assert.ok(isBudgetExceededError(result.err), `expected a budget stop, got: ${result.err?.message}`);
      assert.equal(server.state.sends, 1, 'no second Send after the deadline');
      assert.equal(server.state.starts, 2, 'the recovery StartCascade was attempted inside the budget');
      assert.equal(server.state.stepReads, 0);
    });
  });

  it('ends its first poll wait at the original turn deadline without a trajectory read', async (t) => {
    const budgetMs = 200;
    const remainingMs = 5;
    const startedAt = Date.now();
    const controller = new AbortController();
    const pollScheduled = Promise.withResolvers();
    const terminal = Promise.withResolvers();
    let watchPollWait = false;

    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { body: writeStringField(1, `cascade-${state.starts}`) };
      if (method === 'SendUserCascadeMessage') {
        // Let the successful Send reply leave less than one poll interval.
        t.mock.timers.setTime(startedAt + budgetMs - remainingMs);
        watchPollWait = true;
      }
      if (method === 'GetCascadeTrajectory') return { body: writeVarintField(2, 2) };
      return {};
    }, async (server) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: startedAt });
      const schedule = globalThis.setTimeout;
      let pollDelay;
      t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        const timer = schedule(callback, delay, ...args);
        if (watchPollWait) {
          watchPollWait = false;
          pollDelay = delay;
          pollScheduled.resolve(true);
        }
        return timer;
      });
      const turn = runTurn({
        port: server.port, maxWaitMs: budgetMs, signal: controller.signal, onEnd: terminal.resolve,
      });
      let result;
      try {
        assert.equal(await Promise.race([pollScheduled.promise, turn.then(() => false)]), true,
          'the successful Send must reach its first poll wait');
        t.mock.timers.tick(remainingMs);
        // The timer callback resumes polling before the next immediate, and
        // onEnd runs before the separate generator metadata lookup.
        const ended = await Promise.race([
          terminal.promise,
          new Promise(resolve => setImmediate(resolve)),
        ]);
        assert.equal(ended?.endReason, 'max_wait', 'the poll phase must finish at the original deadline');
        assert.equal(server.state.stepReads, 0);
        assert.equal(server.state.statusReads, 0);
        assert.equal(ended.terminal.kind, 'empty');
        assert.equal(ended.terminal.status, 504);
        assert.equal(ended.terminal.code, 'windsurf_provider_deadline');
        result = await turn;
        assert.equal(result.err, undefined);
      } finally {
        try {
          if (!result) {
            controller.abort();
            if (pollDelay !== undefined) t.mock.timers.tick(pollDelay);
            await turn;
          }
        } finally {
          // The observer wraps the fake timer. Restore both in tracker order.
          t.mock.reset();
        }
      }
    });
  });

  it('control: a fast Send inside the budget completes normally', async () => {
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { body: writeStringField(1, `cascade-${state.starts}`) };
      if (method === 'SendUserCascadeMessage') return {};
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
      return {};
    }, async (server) => {
      const result = await runTurn({ port: server.port, maxWaitMs: 2000 });

      assert.equal(result.err, undefined, `turn failed: ${result.err?.message}`);
      assert.equal(result.text, 'answer');
      assert.equal(result.chunks.endReason, 'idle_done');
      assert.equal(result.chunks.terminal.ok, true);
      assert.ok(server.state.stepReads >= 1, 'the turn actually polled');
      assert.ok(result.elapsed < 2000);
    });
  });

  it('control: a retried Send inside the budget still recovers', async () => {
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { body: writeStringField(1, `cascade-${state.starts}`) };
      if (method === 'SendUserCascadeMessage') {
        return state.sends === 1 ? { error: 'panel state not found for sessionId fixture' } : {};
      }
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['recovered-answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
      return {};
    }, async (server) => {
      const result = await runTurn({ port: server.port, maxWaitMs: 3000 });

      assert.equal(result.err, undefined, `turn failed: ${result.err?.message}`);
      assert.equal(server.state.sends, 2, 'the panel-missing Send is retried once');
      assert.equal(server.state.starts, 2, 'the recovery opened a fresh cascade');
      assert.equal(result.text, 'recovered-answer');
      assert.equal(result.chunks.endReason, 'idle_done');
    });
  });

  it('control: a long valid multi-poll answer is not cut short by the deadline', async () => {
    const block = 'L'.repeat(8000);
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { body: writeStringField(1, `cascade-${state.starts}`) };
      if (method === 'SendUserCascadeMessage') return {};
      if (method === 'GetCascadeTrajectorySteps') {
        const read = state.stepReads;
        if (read === 1) return { body: stepsBody([block]) };
        if (read === 2) return { body: stepsBody([block, block]) };
        return { body: stepsBody([block, block, block]) };
      }
      if (method === 'GetCascadeTrajectory') {
        // ACTIVE while the answer is still growing, IDLE once it has settled.
        return { body: writeVarintField(2, state.stepReads <= 3 ? 2 : 1) };
      }
      return {};
    }, async (server) => {
      const result = await runTurn({ port: server.port });

      assert.equal(result.err, undefined, `turn failed: ${result.err?.message}`);
      assert.equal(result.text, block.repeat(3), 'every byte of a long answer is delivered once, in order');
      assert.equal(result.chunks.totalYielded, block.length * 3);
      assert.equal(result.chunks.endReason, 'idle_done');
      assert.equal(result.chunks.terminal.ok, true);
      assert.ok(result.elapsed > 30, 'the control really spanned several polls');
    });
  });

  it('detach admission is pinned to the absolute turn deadline, not the poll-window start', async () => {
    process.env.WINDSURFAPI_CASCADE_TURN = '1';
    const pins = [];
    await withFakeLs((method, state) => {
      if (method === 'StartCascade') return { body: writeStringField(1, `cascade-${state.starts}`) };
      // The Send spends part of the budget before the poll phase begins.
      if (method === 'SendUserCascadeMessage') return { delayMs: 150 };
      if (method === 'GetCascadeTrajectorySteps') return { body: stepsBody(['answer']) };
      if (method === 'GetCascadeTrajectory') return { body: idleStatus() };
      return {};
    }, async (server) => {
      const budgetMs = 600;
      const controller = new AbortController();
      const result = await runTurn({
        port: server.port,
        maxWaitMs: budgetMs,
        signal: controller.signal,
        detach: {
          forcedCause: null,
          hasToolCalls: () => false,
          admit: (snapshot, pin) => { pins.push(pin); },
        },
        onChunk: (chunk) => { if (chunk.text) controller.abort(); },
      });

      assert.equal(result.err?.name, 'AbortError', `expected the abort contract, got: ${result.err?.message || 'a result'}`);
      assert.equal(pins.length, 1, 'the turn was admitted for detach exactly once');
      const pin = pins[0];
      assert.equal(pin.deadline - pin.startedAt, budgetMs,
        'the admitted claim owns the turn for exactly the route budget');
      assert.ok(pin.deadline >= result.started + budgetMs - 20,
        `the claim deadline is earlier than the turn deadline: ${pin.deadline - result.started}ms`);
      assert.ok(pin.deadline <= result.started + budgetMs + 100,
        `the claim deadline includes the send phase: ${pin.deadline - result.started}ms for a ${budgetMs}ms budget`);
    });
  });
});
