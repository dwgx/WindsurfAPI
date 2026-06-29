import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDevinAcpProcess } from '../src/devin-acp.js';

// S4 coverage: the Devin ACP escape-hatch runner (src/devin-acp.js) had only
// happy-path + thought-chunk coverage. These tests exercise the error and
// boundary paths with a mocked stdio child (no real Devin CLI, no network).

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

// Write a fake `devin acp` stdio server and point the runner at it via env.
function installFakeAcp(source, { timeoutMs = 5000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-edge-'));
  tmpDirs.push(dir);
  const script = join(dir, 'fake-acp.mjs');
  writeFileSync(script, source, 'utf8');
  process.env.DEVIN_CLI_PATH = process.execPath;
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
  process.env.DEVIN_TIMEOUT_MS = String(timeoutMs);
  return script;
}

// Standard handshake preamble for fakes that only vary the prompt phase.
const HANDSHAKE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } }); }
`;

describe('Devin ACP runner — config + auth boundaries', () => {
  it('rejects with 503 backend_unavailable when no apiKey is supplied (never spawns)', async () => {
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: '' }),
      (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.type, 'backend_unavailable');
        return true;
      },
    );
  });

  it('rejects with 500 backend_misconfigured on malformed DEVIN_CLI_ACP_ARGS_JSON', async () => {
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_CLI_ACP_ARGS_JSON = '{not-json';
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 500);
        assert.equal(err.type, 'backend_misconfigured');
        return true;
      },
    );
  });

  it('rejects DEVIN_CLI_ACP_ARGS_JSON that is not a string array', async () => {
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([1, 2, 3]);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 500);
        assert.equal(err.type, 'backend_misconfigured');
        return true;
      },
    );
  });

  it('rejects with 503 backend_unavailable when the CLI binary is missing (ENOENT)', async () => {
    process.env.DEVIN_CLI_PATH = join(tmpdir(), 'no-such-devin-binary-xyz-123');
    process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify(['acp']);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.type, 'backend_unavailable');
        return true;
      },
    );
  });

  it('surfaces an authenticate RPC error as 502 backend_error', async () => {
    installFakeAcp(`${HANDSHAKE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } });
    return;
  }
  if (msg.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'invalid api key' } });
    return;
  }
});
`);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'bad-key' }),
      (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.type, 'backend_error');
        return true;
      },
    );
  });
});

describe('Devin ACP runner — process + protocol failure paths', () => {
  it('maps a non-zero CLI exit to 502 backend_error', async () => {
    installFakeAcp(`
process.exit(3);
`);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.type, 'backend_error');
        return true;
      },
    );
  });

  it('rejects with 502 when session/new does not return a sessionId', async () => {
    installFakeAcp(`${HANDSHAKE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
});
`);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.type, 'backend_error');
        assert.match(err.message, /sessionId/);
        return true;
      },
    );
  });

  it('enforces the output byte cap with 502 backend_output_too_large', async () => {
    process.env.DEVIN_OUTPUT_LIMIT_BYTES = '1024';
    installFakeAcp(`
process.stdout.write('x'.repeat(20000) + '\\n');
setTimeout(() => {}, 2000);
`);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.type, 'backend_output_too_large');
        return true;
      },
    );
  });

  it('times out a stalled prompt with 504 backend_timeout', async () => {
    // Handshake completes, but session/prompt never resolves. DEVIN_TIMEOUT_MS
    // drives the per-request timer (runTimeoutMs() has a 1000ms floor, so this
    // must stay >= 1000 or it silently falls back to the 10-minute default).
    installFakeAcp(`${HANDSHAKE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  // session/prompt: intentionally never answered.
});
`, { timeoutMs: 1000 });
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.status, 504);
        assert.equal(err.type, 'backend_timeout');
        return true;
      },
    );
  });

  it('aborts an in-flight prompt with 499 request_aborted when the signal fires', async () => {
    installFakeAcp(`${HANDSHAKE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  // session/prompt: never answered, wait for abort.
});
`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k', signal: ac.signal }),
      (err) => {
        assert.equal(err.status, 499);
        assert.equal(err.type, 'request_aborted');
        return true;
      },
    );
  });
});

describe('Devin ACP runner — request_permission auto-decline + content shapes', () => {
  it('auto-declines session/request_permission so the agent never blocks on local tools', async () => {
    // The runner must reply {outcome:'cancelled'} to permission prompts (it
    // exposes no local fs/terminal). If it failed to, the fake would hang and
    // the test would time out instead of returning REPLY.
    installFakeAcp(`${HANDSHAKE}
let asked = false;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    // Ask for permission first; only continue once the client answers.
    send({ jsonrpc: '2.0', id: 9001, method: 'session/request_permission', params: { sessionId: 'session-1', toolCall: { name: 'write_file' } } });
    return;
  }
  // The client's permission answer (id 9001) comes back as a result line.
  if (msg.id === 9001 && msg.result) {
    asked = true;
    if (msg.result.outcome !== 'cancelled') { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'WRONG_OUTCOME' } } } }); }
    else { update({ sessionUpdate: 'agent_message_chunk', content: { text: 'REPLY' } }); }
    // resolve the original prompt (id captured implicitly as 4 in the runner's sequence)
    send({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } });
    return;
  }
});
`);
    const result = await runDevinAcpProcess('do a thing', { modelKey: 'swe-1.6', apiKey: 'k' });
    assert.equal(result.text, 'REPLY');
  });

  it('joins array-of-parts content blocks into the reply text', async () => {
    installFakeAcp(`${HANDSHAKE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    update({ sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'AB' }, { type: 'text', text: 'CD' }] });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
});
`);
    const result = await runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' });
    assert.equal(result.text, 'ABCD');
    assert.equal(result.reasoning, '');
  });
});
