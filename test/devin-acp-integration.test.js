import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleChatCompletions } from '../src/handlers/chat.js';
import {
  getModelAccessConfig,
  setModelAccessList,
  setModelAccessMode,
} from '../src/dashboard/model-access.js';

// S3 coverage: PRODUCT-LEVEL integration of the ACP escape hatch.
//
// The existing suites cover the two ends separately:
//   - special-agent-routing.test.js mocks `runDevinAcp` at the HTTP boundary.
//   - devin-acp-edge.test.js drives the REAL runner against a fake subprocess.
// Neither joins both ends. These tests run the FULL real path —
//   handleChatCompletions -> handleSpecialAgentChatCompletion -> real
//   runDevinAcp -> real runDevinAcpProcess -> fake `devin acp` subprocess
// — so account-pool credential injection, response shaping, SSE framing and
// HTTP error mapping are all exercised together with no mocked seam in the
// middle. The fake stdio server stands in for the real Devin CLI binary: no
// real account, no real binary, no network.

const ENV_KEYS = [
  'WINDSURFAPI_SPECIAL_AGENT_BACKEND',
  'DEVIN_CLI_ENABLED',
  'DEVIN_CLI_MODE',
  'DEVIN_CLI_PATH',
  'DEVIN_CLI_ACP_ARGS_JSON',
  'DEVIN_CLI_USE_ACCOUNT_POOL',
  'DEVIN_TIMEOUT_MS',
  'DEVIN_OUTPUT_LIMIT_BYTES',
  'DEVIN_CLI_WORKDIR',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const originalModelAccess = getModelAccessConfig();
const tmpDirs = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  setModelAccessMode(originalModelAccess.mode || 'all');
  setModelAccessList(originalModelAccess.list || []);
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Install a fake `devin acp` stdio server, enable the acp backend, and point
// the real runner at it via env. `timeoutMs` drives DEVIN_TIMEOUT_MS (floor
// 1000ms in runTimeoutMs()).
function installAcpBackend(source, { timeoutMs = 5000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-int-'));
  tmpDirs.push(dir);
  const script = join(dir, 'fake-acp.mjs');
  writeFileSync(script, source, 'utf8');
  process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
  process.env.DEVIN_CLI_MODE = 'acp';
  process.env.DEVIN_CLI_PATH = process.execPath;
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
  process.env.DEVIN_TIMEOUT_MS = String(timeoutMs);
  return script;
}

function poolContext(account, hooks = {}) {
  return {
    specialAgent: {
      checkoutAccount: hooks.checkoutAccount || (() => account),
      releaseAccount: hooks.releaseAccount || (() => {}),
      // Intentionally NOT overriding runDevinAcp: the REAL runner must run.
    },
  };
}

// A fake that completes the full handshake and echoes back, as its visible
// reply, the prompt text AND the api_key/server it was authenticated with.
// That lets a test prove end-to-end that the account-pool credential reached
// the ACP authenticate frame and that the model hint reached session/prompt.
const ECHO_FAKE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } }); }
let seenKey = '';
let seenServer = '';
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') {
    seenKey = msg.params?._meta?.api_key || '';
    seenServer = msg.params?._meta?.api_server_url || '';
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    const promptText = (msg.params?.prompt || []).map(p => p.text || '').join('');
    update({ sessionUpdate: 'agent_thought_chunk', content: { text: 'thinking...' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { text: 'KEY=' + seenKey + '|SERVER=' + seenServer + '|PROMPT<' + promptText + '>' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { totalTokens: 7 } } });
    return;
  }
});
`;

// A minimal fake that just replies with a fixed message after the handshake.
// Used where the test only cares about routing/shape, not credential echo.
function fixedReplyFake(reply) {
  return `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } }); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    update({ sessionUpdate: 'agent_message_chunk', content: { text: ${JSON.stringify(reply)} } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
});
`;
}

describe('ACP integration — full HTTP -> ACP -> response path', () => {
  it('runs swe-1.6 end-to-end and injects the account-pool credential into the ACP authenticate frame', async () => {
    installAcpBackend(ECHO_FAKE);
    let released = '';
    const account = {
      id: 'acct-pool-1',
      apiKey: 'pool-key-abc123',
      apiServerUrl: 'https://server.self-serve.windsurf.com',
    };
    const result = await handleChatCompletions(
      { model: 'swe-1.6', messages: [{ role: 'user', content: 'integration ping' }] },
      poolContext(account, { releaseAccount: (k) => { released = k; } }),
    );

    assert.equal(result.status, 200);
    const content = result.body.choices[0].message.content;
    // Proves the pool credential flowed all the way to ACP authenticate.
    assert.match(content, /KEY=pool-key-abc123/);
    assert.match(content, /SERVER=https:\/\/server\.self-serve\.windsurf\.com/);
    // Proves the user prompt + model hint reached session/prompt.
    assert.match(content, /PROMPT<[\s\S]*Model requested by caller: swe-1\.6[\s\S]*integration ping[\s\S]*>/);
    // Thought chunk must NOT leak into the visible reply.
    assert.doesNotMatch(content, /thinking\.\.\./);
    assert.equal(result.body.model, 'swe-1.6');
    assert.ok(result.body.usage.completion_tokens > 0);
    // The borrowed account must be returned to the pool by its apiKey.
    assert.equal(released, 'pool-key-abc123');
  });

  it('routes every special_agent model id through the real ACP runner', async () => {
    // swe-1.6 is covered above; verify the rest of the catalog reaches ACP too.
    for (const model of ['swe-1.6-fast', 'adaptive', 'arena-fast', 'arena-smart']) {
      installAcpBackend(fixedReplyFake(`REPLY_FOR_${model}`));
      const result = await handleChatCompletions(
        { model, messages: [{ role: 'user', content: `hello ${model}` }] },
        poolContext({ id: 'a', apiKey: 'k', apiServerUrl: '' }),
      );
      assert.equal(result.status, 200, `${model} should return 200`);
      assert.equal(result.body.choices[0].message.content, `REPLY_FOR_${model}`);
      assert.equal(result.body.model, model);
    }
  });

  it('omits api_server_url from the authenticate frame when the pool account has none', async () => {
    installAcpBackend(ECHO_FAKE);
    const result = await handleChatCompletions(
      { model: 'swe-1.6', messages: [{ role: 'user', content: 'no server url' }] },
      poolContext({ id: 'a', apiKey: 'key-only', apiServerUrl: '' }),
    );
    assert.equal(result.status, 200);
    const content = result.body.choices[0].message.content;
    assert.match(content, /KEY=key-only/);
    assert.match(content, /SERVER=\|/); // empty server segment
  });
});

describe('ACP integration — streaming (SSE)', () => {
  // NOTE on streaming semantics: the special-agent path does NOT stream token
  // deltas from ACP. It runs the ACP request to completion, then re-frames the
  // final text as a buffered SSE (streamFromText in special-agent.js). So an
  // incremental token stream from special_agent is NOT supported today; the
  // SSE contract here is "one buffered content delta + finish + [DONE]". This
  // test pins that real behavior end-to-end so a future real-streaming change
  // is a conscious, test-visible decision.
  it('serves a buffered SSE stream from the real ACP runner for stream:true requests', async () => {
    installAcpBackend(fixedReplyFake('STREAMED_ACP_BODY'));
    const result = await handleChatCompletions(
      { model: 'swe-1.6', stream: true, messages: [{ role: 'user', content: 'stream please' }] },
      poolContext({ id: 'a', apiKey: 'k', apiServerUrl: '' }),
    );

    assert.equal(result.status, 200);
    assert.equal(result.stream, true);
    assert.match(result.headers['Content-Type'], /text\/event-stream/);

    const writes = [];
    const res = {
      writableEnded: false,
      write(chunk) { writes.push(String(chunk)); },
      end() { this.writableEnded = true; },
    };
    await result.handler(res);
    const joined = writes.join('');
    assert.match(joined, /STREAMED_ACP_BODY/);
    assert.match(joined, /"object":"chat\.completion\.chunk"/);
    assert.match(joined, /finish_reason":"stop"/);
    assert.match(joined, /data: \[DONE\]/);
    assert.equal(res.writableEnded, true);
  });
});

describe('ACP integration — error propagation to HTTP status', () => {
  it('maps an ACP session/prompt RPC error to a non-2xx HTTP response (502)', async () => {
    installAcpBackend(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'model overloaded' } }); return; }
});
`);
    const result = await handleChatCompletions(
      { model: 'swe-1.6', messages: [{ role: 'user', content: 'will fail' }] },
      poolContext({ id: 'a', apiKey: 'k', apiServerUrl: '' }),
    );
    assert.equal(result.status, 502);
    assert.equal(result.body.error.type, 'backend_error');
    assert.equal(result.body.error.backend, 'devin-cli');
  });

  it('maps a missing sessionId from session/new to 502 backend_error', async () => {
    installAcpBackend(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
});
`);
    const result = await handleChatCompletions(
      { model: 'swe-1.6', messages: [{ role: 'user', content: 'no session' }] },
      poolContext({ id: 'a', apiKey: 'k', apiServerUrl: '' }),
    );
    assert.equal(result.status, 502);
    assert.equal(result.body.error.type, 'backend_error');
  });

  it('maps a stalled ACP prompt to 504 backend_timeout', async () => {
    installAcpBackend(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  // session/prompt: intentionally never answered.
});
`, { timeoutMs: 1000 });
    const result = await handleChatCompletions(
      { model: 'swe-1.6', messages: [{ role: 'user', content: 'stall' }] },
      poolContext({ id: 'a', apiKey: 'k', apiServerUrl: '' }),
    );
    assert.equal(result.status, 504);
    assert.equal(result.body.error.type, 'backend_timeout');
  });

  it('returns 503 pool_exhausted when the account pool has no account (never spawns ACP)', async () => {
    installAcpBackend(ECHO_FAKE);
    const result = await handleChatCompletions(
      { model: 'swe-1.6', messages: [{ role: 'user', content: 'no account' }] },
      poolContext(null, { checkoutAccount: () => null }),
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error.type, 'pool_exhausted');
  });

  it('maps a missing Devin CLI binary (ENOENT) to 503 backend_unavailable', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_PATH = join(tmpdir(), 'no-such-devin-binary-int-987');
    process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify(['acp']);
    const result = await handleChatCompletions(
      { model: 'swe-1.6', messages: [{ role: 'user', content: 'no binary' }] },
      poolContext({ id: 'a', apiKey: 'k', apiServerUrl: '' }),
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error.type, 'backend_unavailable');
  });
});
