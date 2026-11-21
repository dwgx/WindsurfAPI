import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDevinAcpProcess, classifyAcpError } from '../src/devin-acp.js';

// AC2 P0 + P1: prove the ACP path is transient-first (never burns a healthy
// account on a retryable upstream hiccup) and that abort sends a graceful
// `session/cancel` notification before SIGTERM. All against a FAKE stdio child
// — no real Devin CLI, no account, no network.

const ENV_KEYS = [
  'DEVIN_CLI_PATH',
  'DEVIN_CLI_ACP_ARGS_JSON',
  'DEVIN_TIMEOUT_MS',
  'DEVIN_OUTPUT_LIMIT_BYTES',
  'DEVIN_CLI_WORKDIR',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const tmpDirs = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function installFakeAcp(source, { timeoutMs = 5000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-trans-'));
  tmpDirs.push(dir);
  const script = join(dir, 'fake-acp.mjs');
  writeFileSync(script, source, 'utf8');
  process.env.DEVIN_CLI_PATH = process.execPath;
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
  process.env.DEVIN_TIMEOUT_MS = String(timeoutMs);
  return { dir, script };
}

const HANDSHAKE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } }); }
`;

// A fake that completes the handshake then returns a chosen RPC error on
// session/prompt. Lets us drive each upstream fault shape end-to-end.
function promptErrorFake(message) {
  return `${HANDSHAKE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: ${JSON.stringify(message)} } }); return; }
});
`;
}

describe('classifyAcpError — transient-first ordering (unit)', () => {
  it('preserves standard RPC request errors even when the message mentions account state', () => {
    for (const [code, message] of [
      [-32700, 'Parse error in rate limit configuration'],
      [-32600, 'Invalid request: token was not a string'],
      [-32601, 'Method not found: model.capacity'],
      [-32602, 'Invalid params: unsupported capacity setting'],
    ]) {
      assert.deepEqual(classifyAcpError(message, code), {
        code: String(code), type: 'backend_protocol_error', status: 502, retryable: false,
      });
    }
  });

  it('classifies high-demand/capacity as a retryable 429 capacity_error', () => {
    const c = classifyAcpError("We're currently facing high demand for this model. Please try again later.");
    assert.equal(c.code, 'CAPACITY');
    assert.equal(c.type, 'capacity_error');
    assert.equal(c.status, 429);
    assert.equal(c.retryable, true);
  });

  it('classifies "model temporarily unavailable" / "overloaded" as capacity (widened pattern)', () => {
    assert.equal(classifyAcpError('The model is temporarily unavailable').code, 'CAPACITY');
    assert.equal(classifyAcpError('server is busy, overloaded').code, 'CAPACITY');
  });

  it('classifies "internal error occurred (trace ID ...)" as NON-retryable upstream_internal, not a dead token', () => {
    const c = classifyAcpError('an internal error occurred (trace ID: abc-123)');
    assert.equal(c.code, 'UPSTREAM_INTERNAL');
    assert.equal(c.type, 'upstream_internal');
    assert.equal(c.status, 502);
    assert.equal(c.retryable, false);
  });

  it('does NOT let an internal-error blip read as unauthorized (transient-first wins over a 401 shell)', () => {
    const c = classifyAcpError('unauthorized: an internal error occurred');
    assert.equal(c.code, 'UPSTREAM_INTERNAL');
  });

  it('does NOT let a capacity blip read as unauthorized', () => {
    const c = classifyAcpError('unauthorized — we are currently facing high demand');
    assert.equal(c.code, 'CAPACITY');
  });

  it('classifies a genuine auth failure as 401 unauthorized', () => {
    const c = classifyAcpError('invalid api key');
    assert.equal(c.code, 'UNAUTHORIZED');
    assert.equal(c.type, 'unauthorized');
    assert.equal(c.status, 401);
    assert.equal(c.retryable, false);
  });

  it('classifies explicit rate-limit as 429 rate_limited', () => {
    const c = classifyAcpError('rate limit exceeded: too many requests');
    assert.equal(c.code, 'RATE_LIMITED');
    assert.equal(c.status, 429);
  });

  it('falls back to 502 backend_error for an unrecognised fault', () => {
    const c = classifyAcpError('something weird went sideways');
    assert.equal(c.type, 'backend_error');
    assert.equal(c.status, 502);
    assert.equal(c.retryable, false);
  });
});

describe('runDevinAcpProcess — transient-first error surfacing (fake child)', () => {
  it('maps a high-demand prompt error to 429 capacity_error (retryable, not a dead token)', async () => {
    installFakeAcp(promptErrorFake("We're currently facing high demand for this model. Please try again later."));
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 429);
        assert.equal(err.type, 'capacity_error');
        assert.equal(err.code, 'CAPACITY');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  it('maps an "internal error occurred" prompt error to 502 upstream_internal and preserves the message', async () => {
    installFakeAcp(promptErrorFake('an internal error occurred (trace ID: zz-9)'));
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.type, 'upstream_internal');
        assert.equal(err.code, 'UPSTREAM_INTERNAL');
        // message must keep "internal error" so reportRunFailure (special-agent)
        // routes it to reportInternalError (sticky quarantine), not generic.
        assert.match(err.message, /internal error/i);
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  it('maps a genuine auth failure on session/prompt to 401 unauthorized', async () => {
    installFakeAcp(promptErrorFake('permission_denied: invalid token'));
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.type, 'unauthorized');
        return true;
      },
    );
  });
});

describe('runDevinAcpProcess — graceful session/cancel on abort (P1)', () => {
  it('sends a session/cancel notification for the live session before SIGTERM', async () => {
    // The fake records every line it receives to a file. After we abort an
    // in-flight prompt, that file must contain a session/cancel notification
    // (no id) carrying the active sessionId — proving graceful cancel fired
    // before the process was killed.
    const evidence = join(mkdtempSync(join(tmpdir(), 'windsurfapi-acp-evi-')), 'rx.log');
    tmpDirs.push(join(evidence, '..'));
    installFakeAcp(`
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', line => {
  appendFileSync(${JSON.stringify(evidence)}, line + '\\n');
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-XYZ' } }); return; }
  // session/prompt: never answered — we want the abort path. A session/cancel
  // notification arriving here is logged above before we exit.
  if (msg.method === 'session/cancel') { setTimeout(() => process.exit(0), 50); return; }
});
`);
    const ac = new AbortController();
    // Event-driven abort. A fixed wall-clock timer here races the real node
    // subprocess cold-start + handshake: under concurrent load (the full suite
    // spawns many child processes) that startup can exceed the window, so the
    // abort fires before session/new resolves — the runner hasn't armed
    // `activeSessionId`, takes the immediate-SIGTERM branch, and no
    // session/cancel is ever sent (child dies before recording anything).
    // Instead, wait until the fake has recorded the in-flight session/prompt
    // frame — proof the handshake completed and the runner called setSessionId —
    // THEN abort. Deterministic regardless of load. A generous deadline is a
    // last-resort so a genuinely stuck handshake can't hang the test.
    const aborter = (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(evidence)) {
          try {
            const seen = readFileSync(evidence, 'utf8')
              .trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
            if (seen.some(m => m.method === 'session/prompt')) break;
          } catch { /* mid-append: retry on next tick */ }
        }
        await new Promise(r => setTimeout(r, 10));
      }
      ac.abort();
    })();
    await assert.rejects(
      () => runDevinAcpProcess('cancel me', { modelKey: 'swe-1.6', apiKey: 'k', signal: ac.signal }),
      (err) => {
        assert.equal(err.status, 499);
        assert.equal(err.type, 'request_aborted');
        return true;
      },
    );
    await aborter;
    // Give the fake a moment to flush its append before we read.
    await new Promise(r => setTimeout(r, 200));
    assert.ok(existsSync(evidence), 'fake recorded received frames');
    const lines = readFileSync(evidence, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    const cancel = lines.find(m => m.method === 'session/cancel');
    assert.ok(cancel, 'a session/cancel notification was sent on abort');
    assert.equal(cancel.id, undefined, 'session/cancel is a notification (no id)');
    assert.equal(cancel.params?.sessionId, 'session-XYZ', 'cancel targets the live session id');
  });

  it('still aborts with 499 even if session/cancel cannot be delivered (best-effort)', async () => {
    // Prompt is never answered; abort fires. Even if the child ignores
    // session/cancel, the runner must still reject 499 and not hang.
    installFakeAcp(`${HANDSHAKE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  // ignore session/prompt and session/cancel
});
`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k', signal: ac.signal }),
      (err) => {
        assert.equal(err.status, 499);
        assert.equal(err.type, 'request_aborted');
        return true;
      },
    );
    assert.ok(Date.now() - started < 4000, 'aborted promptly, did not hang');
  });
});
