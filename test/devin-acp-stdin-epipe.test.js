import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  runDevinAcpProcess,
  __setDevinAcpSpawnForTest,
} from '../src/devin-acp.js';

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
