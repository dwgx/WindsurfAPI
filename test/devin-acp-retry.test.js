// Run the ACP retry policy against an inert stdio peer. The temporary process
// counter detects whole-turn replay even when no callback receives text.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDevinAcpProcess } from '../src/devin-acp.js';

const ENV_KEYS = [
  'DEVIN_CLI_PATH', 'DEVIN_CLI_ACP_ARGS_JSON', 'DEVIN_TIMEOUT_MS',
  'DEVIN_OUTPUT_LIMIT_BYTES', 'DEVIN_CLI_WORKDIR', 'FAKE_ACP_COUNTER',
  'DEVIN_ACP_RETRY_BASE_MS',
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

// Each spawn increments a shared counter file, so the fake can behave
// differently on attempt 1 vs attempt 2 (attempts are separate processes).
function installFakeAcp(body, { timeoutMs = 5000, backoffMs = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-retry-'));
  tmpDirs.push(dir);
  const script = join(dir, 'fake-acp.mjs');
  const counter = join(dir, 'counter');
  writeFileSync(counter, '0', 'utf8');
  writeFileSync(script, body, 'utf8');
  process.env.DEVIN_CLI_PATH = process.execPath;
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
  process.env.DEVIN_TIMEOUT_MS = String(timeoutMs);
  process.env.FAKE_ACP_COUNTER = counter;
  process.env.DEVIN_ACP_RETRY_BASE_MS = String(backoffMs);
  return { dir, counter };
}

function attempts(counter) {
  return Number(readFileSync(counter, 'utf8'));
}

const PRELUDE = `
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const counterPath = process.env.FAKE_ACP_COUNTER;
let attempt = 0;
try { attempt = Number(readFileSync(counterPath, 'utf8')) || 0; } catch {}
attempt += 1;
writeFileSync(counterPath, String(attempt));
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } }); }
`;

function installPromptFake(body, options) {
  return installFakeAcp(`${PRELUDE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    ${body}
  }
});
`, options);
}

const SOCKET_ERROR = "send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'socket hang up' } });";
const COMPLETE = `
update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RECOVERED' } });
send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
`;
const TOOL_NOTICES = [
  ['an announced pending call', "update({ sessionUpdate: 'tool_call', toolCallId: 'wc', title: 'Stub', status: 'pending' });"],
  ['a call already running', "update({ sessionUpdate: 'tool_call', toolCallId: 'wc', title: 'Stub', status: 'in_progress' });"],
  ['an out-of-order tool update', "update({ sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'completed' });"],
  ['a permission request', `send({
    jsonrpc: '2.0', id: 'p', method: 'session/request_permission',
    params: { sessionId: 'session-1', toolCall: { toolCallId: 'wc' }, options: [
      { kind: 'reject_once', name: 'Decline', optionId: 'decline' },
    ] },
  });`],
];

describe('runDevinAcpProcess — one bounded transport retry', () => {
  for (const streamed of [false, true]) {
    const mode = streamed ? 'streamed' : 'buffered';
    const run = (onChunk) => runDevinAcpProcess('hi', {
      modelKey: 'swe-1.6', apiKey: 'k',
      ...(streamed && { onChunk: onChunk || (() => {}) }),
    });

    it(`retries once after a child exits before progress (${mode})`, async () => {
      const { counter } = installPromptFake(`
        if (attempt === 1) { process.exit(4); }
        ${COMPLETE}
      `);
      const chunks = [];
      const out = await run(chunk => chunks.push(chunk));
      assert.equal(out.text, 'RECOVERED');
      assert.equal(attempts(counter), 2);
      if (streamed) assert.deepEqual(chunks, [{ kind: 'message', text: 'RECOVERED' }]);
    });

    it(`retries once after an upstream transport RPC failure before progress (${mode})`, async () => {
      const { counter } = installPromptFake(`
        if (attempt === 1) { ${SOCKET_ERROR} return; }
        ${COMPLETE}
      `);
      const out = await run();
      assert.equal(out.text, 'RECOVERED');
      assert.equal(attempts(counter), 2);
    });

    for (const [label, notice] of TOOL_NOTICES) {
      it(`does not replay after ${label} (${mode})`, async () => {
        const { counter } = installPromptFake(`
          if (attempt === 1) {
            ${notice}
            ${SOCKET_ERROR}
            return;
          }
          ${COMPLETE}
        `);
        await assert.rejects(run, /socket hang up/);
        assert.equal(attempts(counter), 1);
      });
    }

    it(`does not retry deterministic JSON-RPC failures (${mode})`, async () => {
      const errors = [
        [-32700, 'Parse error', null],
        [-32600, 'Invalid request', null],
        [-32601, 'Method not found'],
        [-32602, 'Invalid params: unsupported capacity setting'],
        [-32000, 'Authentication required'],
        [-32002, 'Resource not found'],
        [-32800, 'Request cancelled'],
      ];
      for (const [code, message, id] of errors) {
        const { counter } = installPromptFake(`
          send({
            jsonrpc: '2.0', id: ${id === null ? 'null' : 'msg.id'},
            error: { code: ${code}, message: ${JSON.stringify(message)} },
          });
        `, { timeoutMs: 1500 });
        await assert.rejects(run, { message });
        assert.equal(attempts(counter), 1, `RPC code ${code} must be terminal`);
      }
    });
  }

  it('stops after one retry when the transport keeps failing', async () => {
    const { counter } = installPromptFake(SOCKET_ERROR);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      /socket hang up/,
    );
    assert.equal(attempts(counter), 2);
  });

  it('does not retry a tool-mapping failure', async () => {
    const { counter } = installPromptFake(`
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'tool_use' } });
    `);
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      { type: 'backend_tool_call_unmapped' },
    );
    assert.equal(attempts(counter), 1);
  });

  it('does not retry after a chunk already reached the client', async () => {
    const { counter } = installPromptFake(`
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL' } });
      ${SOCKET_ERROR}
    `);
    const chunks = [];
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k', onChunk: (c) => chunks.push(c) }),
      /socket hang up/,
    );
    assert.equal(attempts(counter), 1);
    assert.deepEqual(chunks, [{ kind: 'message', text: 'PARTIAL' }]);
  });

  it('does not start a retry whose backoff cannot fit in the turn deadline', async () => {
    const { counter } = installPromptFake(`
      if (attempt === 1) { ${SOCKET_ERROR} return; }
      ${COMPLETE}
    `, { timeoutMs: 1500, backoffMs: 1600 });
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      /socket hang up/,
    );
    assert.equal(attempts(counter), 1);
  });
});
