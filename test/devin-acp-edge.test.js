import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

  it('surfaces an authenticate RPC error as 401 unauthorized (real dead-token shape)', async () => {
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
    // AC2 P0: "invalid api key" is a genuine auth failure → 401 unauthorized
    // (was a blanket 502 before transient-first classification landed). It still
    // routes to the pool's generic-error streak via reportRunFailure (401 is
    // neither 429/402 nor a 5xx internal-error), so a truly dead token is
    // disabled after the streak — but a transient blip in a 401 shell is caught
    // earlier by the CAPACITY / UPSTREAM_INTERNAL branches and never lands here.
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'bad-key' }),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.type, 'unauthorized');
        assert.equal(err.code, 'UNAUTHORIZED');
        return true;
      },
    );
  });
});

describe('Devin ACP runner — process + protocol failure paths', () => {
  for (const [scenario, result] of [
    ['a different major', { protocolVersion: 2 }],
    ['an omitted version', {}],
    ['a non-integer version', { protocolVersion: '1' }],
  ]) {
    it(`stops after initialize when a peer selects ${scenario}`, async () => {
      const script = installFakeAcp(`${HANDSHAKE}
import { appendFileSync } from 'node:fs';
rl.on('line', line => {
  const { id, method } = JSON.parse(line);
  appendFileSync(new URL('methods.log', import.meta.url), method + '\\n');
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: ${JSON.stringify(result)} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unexpected method' } });
  }
});
`);
      await assert.rejects(
        () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'fixture' }),
        { status: 502, type: 'backend_protocol_error', code: 'ACP_PROTOCOL_VERSION', retryable: false },
      );
      assert.equal(readFileSync(join(dirname(script), 'methods.log'), 'utf8'), 'initialize\n');
    });
  }

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
    // sets the turn deadline (runTimeoutMs() has a 1000ms floor, so this
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
  const allow = { optionId: 'allow', name: 'Allow', kind: 'allow_once' };
  const rejectOnce = { optionId: 'decline', name: 'Decline', kind: 'reject_once' };
  const rejectAlways = { optionId: 'deny', name: 'Deny', kind: 'reject_always' };
  const requests = [
    { id: 0, options: [allow, rejectAlways, rejectOnce] },
    { id: 'always', options: [allow, rejectAlways] },
    { id: 'allow-only', options: [allow] },
    { id: 'missing-options' },
    { id: 'invalid-id', options: [{ ...rejectOnce, optionId: '' }] },
    { id: 'ambiguous-id', options: [allow, { ...rejectOnce, optionId: allow.optionId }] },
  ];

  for (const streamed of [false, true]) {
    it(`auto-declines permission with an advertised reject option or RPC error (${streamed ? 'streamed' : 'buffered'})`, async () => {
      // The stub echoes the exact permission frames it receives as text after
      // every request is answered. It never executes a tool.
      installFakeAcp(`${HANDSHAKE}
const requests = ${JSON.stringify(requests)};
const answers = [];
let promptId;
function ask() {
  const { id, options } = requests[answers.length];
  send({
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: { sessionId: 'session-1', toolCall: { toolCallId: 'stub' }, options },
  });
}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    ask();
    return;
  }
  if (msg.id !== requests[answers.length]?.id) return;
  answers.push(msg);
  if (answers.length < requests.length) {
    ask();
    return;
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(answers) } });
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
});
`);
      const chunks = [];
      const result = await runDevinAcpProcess('hi', {
        modelKey: 'swe-1.6', apiKey: 'k',
        ...(streamed && { onChunk: chunk => chunks.push(chunk) }),
      });
      const replies = JSON.parse(result.text);
      assert.deepEqual(replies.slice(0, 2), [
        { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } } },
        { jsonrpc: '2.0', id: 'always', result: { outcome: { outcome: 'selected', optionId: rejectAlways.optionId } } },
      ]);
      for (const { id } of requests.slice(2)) {
        const reply = replies.find(frame => frame.id === id);
        assert.deepEqual(Object.keys(reply).sort(), ['error', 'id', 'jsonrpc']);
        assert.equal(reply.jsonrpc, '2.0');
        assert.equal(reply.error.code, -32602);
        assert.ok(reply.error.message);
      }
      if (streamed) assert.deepEqual(chunks, [{ kind: 'message', text: result.text }]);
    });
  }

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
