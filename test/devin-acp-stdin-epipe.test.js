import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequestBudget } from '../src/request-budget.js';
import {
  runDevinAcpProcess,
  __setDevinAcpSpawnForTest,
} from '../src/devin-acp.js';

const envKeys = ['DEVIN_TIMEOUT_MS', 'DEVIN_ACP_RETRY_BASE_MS', 'DEVIN_ACP_CANCEL_GRACE_MS'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

// Audit finding regression: child.stdin had no 'error' listener. If the Devin
// CLI child dies mid-write, stdin.write raises EPIPE asynchronously as a stdin
// 'error' event; with no listener that becomes an uncaughtException and kills
// the WHOLE proxy (every tenant), not just the one request. These tests drive a
// fake child (EventEmitter stdio) through the spawn seam and assert the handler
// is attached and swallows the error instead of rethrowing.

// A minimal fake child that looks enough like a ChildProcess for makeAcpClient:
// stdout/stderr/stdin are EventEmitters, stdin is writable + captures writes,
// and kill() is a no-op. It never answers RPCs, so the handshake stalls until
// we tear it down — which is exactly the window the guard must survive.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.writes = [];
  stdin.write = (chunk) => { stdin.writes.push(String(chunk)); return true; };
  child.stdin = stdin;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

afterEach(() => {
  __setDevinAcpSpawnForTest(null); // restore the real spawn
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function attachRpcPeer(child, onRequest) {
  const capture = child.stdin.write;
  const send = (frame) => child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  child.stdin.write = (line) => {
    const message = JSON.parse(line);
    queueMicrotask(() => onRequest(message, send));
    return capture(line);
  };
}

const HANDSHAKE = {
  initialize: { protocolVersion: 1 },
  authenticate: {},
  'session/new': { sessionId: 'session-1' },
};

// Drive each write through the same stdio framing as the CLI. The fixture can
// deliver a notification from a retired child at an exact retry handshake step.
function budgetPeer(budget, onRequest = () => {}) {
  process.env.DEVIN_ACP_RETRY_BASE_MS = '0';
  const children = [];
  const prompts = [];
  __setDevinAcpSpawnForTest(() => {
    const child = makeFakeChild();
    const attempt = children.push(child);
    attachRpcPeer(child, (message, send) => {
      if (message.method === 'session/prompt') prompts.push([attempt, budget.turnsUsed]);
      if (onRequest({ attempt, child, message, send })) return;
      if (Object.hasOwn(HANDSHAKE, message.method)) {
        send({ id: message.id, result: HANDSHAKE[message.method] });
      } else if (message.method === 'session/prompt') {
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      }
    });
    return child;
  });
  return { children, prompts };
}

const routeDeadline = { code: 'DEADLINE_EXCEEDED', type: 'upstream_deadline_exceeded' };
const reset = { code: 'ECONNRESET', message: 'first connection reset' };
const toolProgress = {
  method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'fixture' } },
};

describe('Devin ACP — route budget at prompt issuance', () => {
  const run = (budget, opts) => runDevinAcpProcess('hi', { apiKey: 'k', budget, ...opts });

  it('rejects an expired route before spawn and gives client cancellation priority', async () => {
    let now = 0;
    const budget = createRequestBudget({ deadlineMs: 1000, now: () => now });
    const { children } = budgetPeer(budget);
    now = 1000;
    await assert.rejects(run(budget), routeDeadline);
    await assert.rejects(run(budget, { signal: AbortSignal.abort() }), { status: 499 });
    assert.equal(budget.turnsUsed, 0);
    assert.equal(children.length, 0);
  });

  it('clamps the handshake to the route clock without spending a turn', async () => {
    let now = 0;
    const budget = createRequestBudget({ deadlineMs: 1000, now: () => now });
    const { children, prompts } = budgetPeer(budget, ({ message }) => {
      if (message.method === 'session/new') now = 1000;
    });
    await assert.rejects(run(budget), routeDeadline);
    assert.equal(children.length, 1);
    assert.deepEqual(prompts, []);
    assert.equal(budget.turnsUsed, 0);
  });

  it('ends a silent prompt on the route deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    t.mock.method(performance, 'now', () => Date.now());
    const budget = createRequestBudget({ deadlineMs: 1000 });
    const { prompts } = budgetPeer(budget, ({ message }) => message.method === 'session/prompt');
    const controller = new AbortController();
    const ended = assert.rejects(run(budget, { signal: controller.signal }), routeDeadline);
    await new Promise(setImmediate);
    assert.deepEqual(prompts, [[1, 1]]);
    t.mock.timers.tick(1000);
    await new Promise(setImmediate);
    controller.abort(); // Release a broken implementation still waiting for a reply.
    await ended;
  });

  it('preserves a shorter local limit when route time remains', async (t) => {
    let local = 0;
    t.mock.method(performance, 'now', () => local);
    process.env.DEVIN_TIMEOUT_MS = '1000';
    const budget = createRequestBudget({ deadlineMs: 5000, now: () => 0 });
    const { prompts } = budgetPeer(budget, ({ message }) => {
      if (message.method === 'session/prompt') local = 1100;
    });
    await assert.rejects(run(budget), { status: 504, type: 'backend_timeout' });
    assert.deepEqual(prompts, [[1, 1]]);
  });

  it('does not charge a handshake-only retry or an unwritable prompt', async () => {
    const budget = createRequestBudget({ upstreamTurnCap: 1 });
    const { children, prompts } = budgetPeer(budget, ({ attempt, child, message }) => {
      if (attempt === 1 && message.method === 'session/new') child.stdin.writable = false;
    });
    assert.equal((await run(budget)).stopReason, 'end_turn');
    assert.equal(children.length, 2);
    assert.deepEqual(prompts, [[2, 1]]);
  });

  it('charges each issued prompt and admits a retry after early transport failure', async () => {
    const budget = createRequestBudget({ upstreamTurnCap: 2 });
    const { prompts } = budgetPeer(budget, ({ attempt, message, send }) => {
      if (attempt === 1 && message.method === 'session/prompt') {
        send({ id: message.id, error: reset });
        return true;
      }
      // Activity on the new child's setup is not evidence about the old child.
      if (attempt === 2 && message.method === 'session/new') send(toolProgress);
    });
    assert.equal((await run(budget)).stopReason, 'end_turn');
    assert.deepEqual(prompts, [[1, 1], [2, 2]]);
    assert.equal(budget.turnsRemaining, 0);
  });

  it('rejects a retry after the first issued prompt spent the last turn', async () => {
    const budget = createRequestBudget({ upstreamTurnCap: 1 });
    const { children, prompts } = budgetPeer(budget, ({ message, send }) => {
      if (message.method === 'session/prompt') {
        send({ id: message.id, error: reset });
        return true;
      }
    });
    await assert.rejects(run(budget), routeDeadline);
    assert.equal(children.length, 1);
    assert.deepEqual(prompts, [[1, 1]]);
  });

  it('skips backoff when the route has less time left than the retry delay', async () => {
    const budget = createRequestBudget({ deadlineMs: 5000, now: () => 0 });
    const { children, prompts } = budgetPeer(budget, ({ message, send }) => {
      if (message.method === 'session/prompt') {
        send({ id: message.id, error: reset });
        return true;
      }
    });
    process.env.DEVIN_ACP_RETRY_BASE_MS = '5500';
    await assert.rejects(run(budget), { status: 502, ...reset });
    assert.equal(children.length, 1);
    assert.deepEqual(prompts, [[1, 1]]);
  });

  it('refuses a retry whose setup spends the remaining route time', async () => {
    let now = 0;
    const budget = createRequestBudget({ deadlineMs: 5000, now: () => now });
    const { children, prompts } = budgetPeer(budget, ({ attempt, message, send }) => {
      if (attempt === 1 && message.method === 'session/prompt') {
        now = 4800;
        send({ id: message.id, error: reset });
        return true;
      }
      if (attempt === 2 && message.method === 'session/new') now = 5000;
    });
    await assert.rejects(run(budget), routeDeadline);
    assert.equal(children.length, 2);
    assert.deepEqual(prompts, [[1, 1]]);
  });

  it('checks the shared cap again at issuance when another consumer takes the last turn', async () => {
    const budget = createRequestBudget({ upstreamTurnCap: 1 });
    const { prompts } = budgetPeer(budget, ({ message }) => {
      if (message.method === 'session/new') budget.takeTurnOrThrow('other consumer');
    });
    await assert.rejects(run(budget), routeDeadline);
    assert.deepEqual(prompts, []);
    assert.equal(budget.turnsUsed, 1);
  });

  it('surfaces the original transport error after late activity during the retry handshake', async () => {
    const budget = createRequestBudget({ upstreamTurnCap: 2 });
    let oldSend;
    let delivered = false;
    const { children, prompts } = budgetPeer(budget, ({ attempt, message, send }) => {
      if (attempt === 1 && message.method === 'session/prompt') {
        oldSend = send;
        send({ id: message.id, error: reset });
        return true;
      }
      if (attempt === 2 && message.method === 'session/new') {
        oldSend(toolProgress);
        delivered = true;
      }
    });
    await assert.rejects(run(budget), { status: 502, type: 'backend_error', ...reset });
    assert.equal(delivered, true);
    assert.equal(children.length, 2);
    assert.deepEqual(prompts, [[1, 1]]);
    assert.equal(budget.turnsUsed, 1);
  });
});

describe('Devin ACP — output belongs to the pending prompt', () => {
  const message = text => ({ method: 'session/update', params: {
    update: { sessionUpdate: 'agent_message_chunk', content: { text } },
  } });
  const thought = text => ({ method: 'session/update', params: {
    update: { sessionUpdate: 'agent_thought_chunk', content: { text } },
  } });

  for (const mode of ['buffered', 'streaming']) {
    const run = (budget, chunks) => runDevinAcpProcess('hi', {
      apiKey: 'k', budget, onChunk: mode === 'streaming' ? chunk => chunks.push(chunk) : null,
    });

    for (const [label, update] of [['message', message], ['thought', thought]]) {
      it(`uses a retired ${label} during backoff as a replay barrier only (${mode})`, async () => {
        const budget = createRequestBudget({ upstreamTurnCap: 2 });
        const chunks = [];
        let wasRetired;
        const { prompts } = budgetPeer(budget, ({ attempt, child, message: request, send }) => {
          if (attempt === 1 && request.method === 'session/prompt') {
            send({ id: request.id, error: reset });
            // Deliver after the attempt has unwound but before the retry timer
            // can fire, independent of the host's speed.
            queueMicrotask(() => queueMicrotask(() => {
              wasRetired = child.killed;
              send(update('retired'));
            }));
            return true;
          }
        });
        process.env.DEVIN_ACP_RETRY_BASE_MS = '1';
        await assert.rejects(run(budget, chunks), { status: 502, ...reset });
        assert.equal(wasRetired, true);
        assert.deepEqual(prompts, [[1, 1]]);
        assert.deepEqual(chunks, []);
      });
    }

    it(`suppresses frames following the failed prompt response in the same pipe read (${mode})`, async () => {
      const budget = createRequestBudget({ upstreamTurnCap: 2 });
      const chunks = [];
      const { prompts } = budgetPeer(budget, ({ attempt, message: request, child }) => {
        if (attempt === 1 && request.method === 'session/prompt') {
          const frames = [{ id: request.id, error: reset }, thought('retired'), message('retired')];
          child.stdout.emit('data', frames.map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n').join(''));
          return true;
        }
      });
      await assert.rejects(run(budget, chunks), { status: 502, ...reset });
      assert.deepEqual(prompts, [[1, 1]]);
      assert.deepEqual(chunks, []);
    });

    it(`returns only the replacement prompt's content after issuance (${mode})`, async () => {
      const budget = createRequestBudget({ upstreamTurnCap: 2 });
      const chunks = [];
      let oldSend;
      const { prompts } = budgetPeer(budget, ({ attempt, message: request, send }) => {
        if (request.method !== 'session/prompt') return;
        if (attempt === 1) {
          oldSend = send;
          send({ id: request.id, error: reset });
          return true;
        }
        oldSend(thought('retired reasoning'));
        oldSend(message('retired reply'));
        send(thought('chosen reasoning'));
        send(message('chosen reply'));
        send({ id: request.id, result: { stopReason: 'end_turn' } });
        return true;
      });
      const result = await run(budget, chunks);
      assert.deepEqual(prompts, [[1, 1], [2, 2]]);
      assert.equal(result.reasoning, 'chosen reasoning');
      assert.equal(result.text, 'chosen reply');
      assert.deepEqual(chunks, mode === 'buffered' ? [] : [
        { kind: 'thought', text: 'chosen reasoning' }, { kind: 'message', text: 'chosen reply' },
      ]);
    });
  }
});

describe('Devin ACP — stdin EPIPE guard (audit finding)', () => {
  it('attaches an stdin error listener as soon as the child is spawned', async () => {
    const child = makeFakeChild();
    __setDevinAcpSpawnForTest(() => child);

    // Kick off the runner; it spawns synchronously then awaits the initialize
    // RPC (never answered here). By the next tick the child is constructed and
    // its listeners are wired. We abort so the pending promise settles cleanly.
    const ac = new AbortController();
    const p = runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k', signal: ac.signal });
    p.catch(() => {}); // swallow the eventual abort rejection

    await new Promise(r => setImmediate(r));
    assert.ok(
      child.stdin.listenerCount('error') >= 1,
      'stdin must have an error listener so an EPIPE cannot become an uncaughtException',
    );

    ac.abort();
    await assert.rejects(p);
  });

  it('does not rethrow when stdin emits an EPIPE error (would crash the proxy)', async () => {
    const child = makeFakeChild();
    __setDevinAcpSpawnForTest(() => child);

    const ac = new AbortController();
    const p = runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k', signal: ac.signal });
    p.catch(() => {});
    await new Promise(r => setImmediate(r));

    // Simulate the child dying mid-write: EventEmitter.emit('error') THROWS the
    // error if and only if there is no 'error' listener. So a clean emit here is
    // itself the proof that our guard is present and swallowed it.
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    assert.doesNotThrow(() => child.stdin.emit('error', epipe));

    // A non-EPIPE stdin error must also be swallowed (logged at warn, no throw).
    const other = Object.assign(new Error('write EACCES'), { code: 'EACCES' });
    assert.doesNotThrow(() => child.stdin.emit('error', other));

    ac.abort();
    await assert.rejects(p);
  });

  it('installs a real process-level safety net: no uncaughtException escapes', async () => {
    const child = makeFakeChild();
    __setDevinAcpSpawnForTest(() => child);

    const ac = new AbortController();
    const p = runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k', signal: ac.signal });
    p.catch(() => {});
    await new Promise(r => setImmediate(r));

    let uncaught = null;
    const onUncaught = (err) => { uncaught = err; };
    process.once('uncaughtException', onUncaught);
    try {
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      // Give any (buggy) rethrow a tick to surface as an uncaughtException.
      await new Promise(r => setImmediate(r));
      assert.equal(uncaught, null, 'stdin EPIPE must not surface as an uncaughtException');
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }

    ac.abort();
    await assert.rejects(p);
  });
});

describe('Devin ACP — prompt timing and cancellation', () => {
  it('replies to a permission request received during cancellation with a nested cancelled outcome', async () => {
    process.env.DEVIN_ACP_CANCEL_GRACE_MS = '250';
    const child = makeFakeChild();
    const controller = new AbortController();
    attachRpcPeer(child, (message, send) => {
      if (Object.hasOwn(HANDSHAKE, message.method)) {
        send({ id: message.id, result: HANDSHAKE[message.method] });
      } else if (message.method === 'session/prompt') {
        controller.abort();
        // Simulates bytes already on the wire when the client cancels.
        send({
          id: 'permission', method: 'session/request_permission',
          params: { sessionId: 'session-1', toolCall: { toolCallId: 'stub' }, options: [
            { kind: 'reject_once', name: 'Decline', optionId: 'decline' },
          ] },
        });
      }
    });
    __setDevinAcpSpawnForTest(() => child);

    await assert.rejects(
      runDevinAcpProcess('hi', { apiKey: 'k', signal: controller.signal }),
      { status: 499, type: 'request_aborted' },
    );
    const frames = child.stdin.writes.map(line => JSON.parse(line));
    assert.deepEqual(frames.slice(-2), [
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-1' } },
      { jsonrpc: '2.0', id: 'permission', result: { outcome: { outcome: 'cancelled' } } },
    ]);
    child.emit('close', 0);
  });

  it('shares one monotonic deadline covering the first prompt and the retry handshake', async (t) => {
    process.env.DEVIN_TIMEOUT_MS = '1000';
    process.env.DEVIN_ACP_RETRY_BASE_MS = '0';
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const children = [];
    __setDevinAcpSpawnForTest(() => {
      const child = makeFakeChild();
      children.push(child);
      const isRetry = children.length === 2;
      attachRpcPeer(child, (message, send) => {
        if (Object.hasOwn(HANDSHAKE, message.method)) {
          if (isRetry && message.method === 'session/new') now = 1050;
          send({ id: message.id, result: HANDSHAKE[message.method] });
          return;
        }
        if (message.method !== 'session/prompt') return;
        if (isRetry) {
          send({ id: message.id, result: { stopReason: 'end_turn' } });
        } else {
          now = 400;
          send({ id: message.id, error: { code: -32603, message: 'socket hang up' } });
        }
      });
      return child;
    });

    await assert.rejects(
      runDevinAcpProcess('hi', { apiKey: 'k' }),
      { status: 504, type: 'backend_timeout' },
    );
    assert.equal(children.length, 2);
    const methods = children[1].stdin.writes.map(line => JSON.parse(line).method);
    assert.deepEqual(methods, ['initialize', 'authenticate', 'session/new']);
  });

  it('propagates a client abort during backoff without spawning another child', async () => {
    process.env.DEVIN_TIMEOUT_MS = '5000';
    process.env.DEVIN_ACP_RETRY_BASE_MS = '2500';
    const controller = new AbortController();
    let spawns = 0;
    __setDevinAcpSpawnForTest(() => {
      spawns++;
      const child = makeFakeChild();
      attachRpcPeer(child, (message, send) => {
        if (Object.hasOwn(HANDSHAKE, message.method)) {
          send({ id: message.id, result: HANDSHAKE[message.method] });
        } else if (message.method === 'session/prompt') {
          send({ id: message.id, error: { code: -32603, message: 'socket hang up' } });
          setImmediate(() => controller.abort());
        }
      });
      return child;
    });

    await assert.rejects(
      runDevinAcpProcess('hi', { apiKey: 'k', signal: controller.signal }),
      { status: 499, type: 'request_aborted' },
    );
    assert.equal(spawns, 1);
  });

  it('does not replay when a tool update is received during retry backoff', async () => {
    process.env.DEVIN_TIMEOUT_MS = '5000';
    process.env.DEVIN_ACP_RETRY_BASE_MS = '100';
    let spawns = 0;
    __setDevinAcpSpawnForTest(() => {
      const child = makeFakeChild();
      const attempt = ++spawns;
      attachRpcPeer(child, (message, send) => {
        if (Object.hasOwn(HANDSHAKE, message.method)) {
          send({ id: message.id, result: HANDSHAKE[message.method] });
        } else if (message.method === 'session/prompt' && attempt === 1) {
          send({ id: message.id, error: { code: -32603, message: 'socket hang up' } });
          setImmediate(() => send({
            method: 'session/update',
            params: { sessionId: 'session-1', update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'stub', status: 'completed',
            } },
          }));
        } else if (message.method === 'session/prompt') {
          send({ id: message.id, result: { stopReason: 'end_turn' } });
        }
      });
      return child;
    });

    await assert.rejects(runDevinAcpProcess('hi', { apiKey: 'k' }), /socket hang up/);
    assert.equal(spawns, 1);
  });
});
