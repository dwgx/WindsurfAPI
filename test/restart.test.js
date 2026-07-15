import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSupervisor, gracefulRestart } from '../src/restart.js';

describe('detectSupervisor', () => {
  it('detects systemd via INVOCATION_ID', () => {
    const r = detectSupervisor({ INVOCATION_ID: 'abc123' });
    assert.deepEqual(r, { supervised: true, kind: 'systemd' });
  });

  it('detects systemd via JOURNAL_STREAM', () => {
    const r = detectSupervisor({ JOURNAL_STREAM: '8:12345' });
    assert.deepEqual(r, { supervised: true, kind: 'systemd' });
  });

  it('detects pm2 via pm_id', () => {
    const r = detectSupervisor({ pm_id: '0' });
    assert.deepEqual(r, { supervised: true, kind: 'pm2' });
  });

  it('detects pm2 via PM2_HOME', () => {
    const r = detectSupervisor({ PM2_HOME: '/root/.pm2' });
    assert.deepEqual(r, { supervised: true, kind: 'pm2' });
  });

  it('detects explicit override', () => {
    const r = detectSupervisor({ WINDSURFAPI_RESTART_SUPERVISED: '1' });
    assert.deepEqual(r, { supervised: true, kind: 'override' });
  });

  it('reports unsupervised when nothing matches', () => {
    // Pass an env object with no supervisor markers. Note: /.dockerenv is
    // filesystem-based, but CI/dev boxes running this test are not in docker.
    const r = detectSupervisor({});
    assert.deepEqual(r, { supervised: false, kind: null });
  });

  it('override value other than "1" is not honoured', () => {
    const r = detectSupervisor({ WINDSURFAPI_RESTART_SUPERVISED: '0' });
    assert.equal(r.supervised, false);
  });
});

describe('gracefulRestart', () => {
  it('calls exitFn with 75 AFTER server.close resolves', async () => {
    const order = [];
    let closeCb = null;
    const server = {
      close(cb) { closeCb = cb; setTimeout(() => { order.push('closed'); cb(); }, 5); },
    };
    let exitCode = null;
    const exitFn = (code) => { order.push('exit'); exitCode = code; };

    await gracefulRestart({ reason: 'test', drainMs: 1000, server, exitFn });

    assert.equal(exitCode, 75);
    assert.deepEqual(order, ['closed', 'exit']);
  });

  it('still exits after drainMs when the server never closes (bounded)', async () => {
    const server = { close() { /* never calls cb */ } };
    let exited = false;
    const exitFn = () => { exited = true; };
    const started = Date.now();

    await gracefulRestart({ reason: 'stuck', drainMs: 20, server, exitFn });

    assert.equal(exited, true);
    assert.ok(Date.now() - started >= 15, 'should wait ~drainMs before forcing exit');
  });

  it('awaits stopLs before exiting', async () => {
    const order = [];
    const stopLs = async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('ls-stopped');
    };
    const exitFn = () => order.push('exit');

    await gracefulRestart({ reason: 'test', stopLs, exitFn });

    assert.deepEqual(order, ['ls-stopped', 'exit']);
  });

  it('aborts active SSE first when a hook is provided', async () => {
    const order = [];
    const abortSse = () => { order.push('sse-aborted'); return 2; };
    const stopLs = async () => order.push('ls-stopped');
    const exitFn = () => order.push('exit');

    await gracefulRestart({ reason: 'test', abortSse, stopLs, exitFn });

    assert.deepEqual(order, ['sse-aborted', 'ls-stopped', 'exit']);
  });

  it('uses a custom exitCode when provided', async () => {
    let code = null;
    await gracefulRestart({ reason: 'test', exitFn: (c) => { code = c; }, exitCode: 42 });
    assert.equal(code, 42);
  });

  it('does not throw when server.close throws synchronously', async () => {
    const server = { close() { throw new Error('boom'); } };
    let exited = false;
    await gracefulRestart({ reason: 'test', drainMs: 50, server, exitFn: () => { exited = true; } });
    assert.equal(exited, true);
  });
});
