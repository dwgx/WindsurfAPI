import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { bindClientAbort } from '../src/server.js';
import { __resetDevinAcpProbeCache, __setDevinAcpSpawnForTest } from '../src/devin-acp.js';
import { createRequestBudget } from '../src/request-budget.js';
import { getSpecialAgentStatus, runDevinAcp } from '../src/special-agent.js';
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
  'DEVIN_ONLY',
  'DEVIN_ACP_PROBE',
  'DEVIN_ACP_CANCEL_GRACE_MS',
  'DEVIN_MAX_PROCS',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const originalModelAccess = getModelAccessConfig();
const tmpDirs = [];

beforeEach(() => {
  // The proactive availability probe (default ON) caches its verdict keyed on
  // the resolved CLI path. Reset between tests so a prior test's path verdict
  // never leaks into the next. installAcpBackend points at process.execPath
  // (node --version exits 0 → available), so the real path still runs.
  __resetDevinAcpProbeCache();
});

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

  it('cancels the real buffered runner when the HTTP client closes mid-prompt', async t => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '1';
    process.env.DEVIN_ACP_PROBE = '0';
    process.env.DEVIN_ACP_CANCEL_GRACE_MS = '250';
    const response = new EventEmitter();
    response.writableEnded = false;
    const { signal } = bindClientAbort(response);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { writable: true });
    child.kill = () => child.emit('close', 0);
    const frames = [];
    const replies = {
      initialize: { protocolVersion: 1 },
      authenticate: {},
      'session/new': { sessionId: 'stub-session' },
      'session/prompt': { stopReason: 'end_turn' },
    };
    child.stdin.write = (line) => {
      const frame = JSON.parse(line);
      frames.push(frame);
      queueMicrotask(() => {
        if (frame.method === 'session/prompt') response.emit('close');
        if (frame.method === 'session/cancel') child.emit('close', 0);
        if (Object.hasOwn(replies, frame.method)) {
          child.stdout.emit('data', JSON.stringify({
            jsonrpc: '2.0', id: frame.id, result: replies[frame.method],
          }) + '\n');
        }
      });
      return true;
    };
    __setDevinAcpSpawnForTest(() => child);
    t.after(() => __setDevinAcpSpawnForTest(null));

    const settled = [];
    const result = await handleChatCompletions({
      model: 'swe-1.6', messages: [{ role: 'user', content: 'close during a prompt' }],
    }, {
      ...poolContext({ id: 'stub-account', apiKey: 'k', settleReservation: refund => settled.push(refund) }),
      signal,
    });
    assert.equal(result.status, 499);
    assert.equal(result.body.error.code, 'client_disconnect');
    assert.equal(frames.filter(frame => frame.method === 'session/prompt').length, 1);
    assert.deepEqual(frames.filter(frame => frame.method === 'session/cancel'), [
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'stub-session' } },
    ]);
    assert.deepEqual(settled, [true]);
  });

  it('clamps the ACP process-slot wait to the route deadline and refunds that checkout', async t => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '1';
    process.env.DEVIN_ACP_PROBE = '0';
    process.env.DEVIN_MAX_PROCS = '1';
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });

    const started = Promise.withResolvers();
    const hold = new AbortController();
    let spawns = 0;
    __setDevinAcpSpawnForTest(() => {
      spawns++;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { writable: true, write: started.resolve });
      child.kill = () => child.emit('close', 0);
      return child;
    });
    t.after(() => {
      hold.abort();
      __setDevinAcpSpawnForTest(null);
    });
    const holdingSlot = assert.rejects(runDevinAcp('hold slot', { apiKey: 'k', signal: hold.signal }), { status: 499 });
    await started.promise;

    const budget = createRequestBudget({ deadlineMs: 10 });
    const settled = [];
    const queued = handleChatCompletions({
      model: 'swe-1.6', messages: [{ role: 'user', content: 'wait for slot' }],
    }, {
      ...poolContext({ id: 'stub-account', apiKey: 'k', settleReservation: refund => settled.push(refund) }),
      budget,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getSpecialAgentStatus().queued, 1);
    t.mock.timers.tick(10);
    const result = await queued;
    assert.equal(result.status, 504);
    assert.equal(result.body.error.code, 'windsurf_provider_deadline');
    assert.deepEqual(settled, [true]);
    assert.equal(budget.turnsUsed, 0);
    assert.equal(spawns, 1);
    assert.equal(getSpecialAgentStatus().queued, 0);
    hold.abort();
    await holdingSlot;
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
  it('maps a transient "overloaded" ACP error to 429 capacity_error (transient-first, account NOT burned)', async () => {
    // AC2 P0: the upstream wraps capacity faults in an RPC error. The ACP path
    // must classify them transient-first so reportRunFailure cools the account
    // down (markRateLimited) instead of feeding the disable-streak. Surfaced as
    // 429 capacity_error end-to-end through the HTTP boundary.
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
    assert.equal(result.status, 429);
    assert.equal(result.body.error.type, 'capacity_error');
    assert.equal(result.body.error.backend, 'devin-cli');
  });

  it('maps an unrecognised ACP RPC error to 502 backend_error (legacy fallback unchanged)', async () => {
    installAcpBackend(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'malformed prompt blob' } }); return; }
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

  // GAP-ACP-01: a clean exit (code 0) WHILE a request is in flight must settle
  // the pending promise instead of silently dropping it. Before the fix, the
  // close handler called cleanup() on code 0, clearing the pending map without
  // rejecting — the awaiting caller hung until the (already cleared) timeout
  // that never fires, permanently leaking the concurrency slot. The proof:
  // the call RETURNS (with a 502, well under the timeout) and the account is
  // released, rather than hanging until DEVIN_TIMEOUT_MS.
  it('GAP-ACP-01: a clean process exit mid-prompt settles the request and releases the slot', async () => {
    // Fake completes the handshake, then on session/prompt exits 0 WITHOUT
    // ever sending the result frame.
    installAcpBackend(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') { process.exit(0); }
});
`, { timeoutMs: 10_000 });

    let released = false;
    const started = Date.now();
    const result = await handleChatCompletions(
      { model: 'swe-1.6', messages: [{ role: 'user', content: 'clean exit' }] },
      poolContext({ id: 'a', apiKey: 'k', apiServerUrl: '' }, { releaseAccount: () => { released = true; } }),
    );
    const elapsed = Date.now() - started;
    assert.equal(result.status, 502, 'clean exit before result maps to 502');
    assert.equal(result.body.error.type, 'backend_error');
    assert.ok(released, 'account slot was released (not leaked)');
    assert.ok(elapsed < 9_000, `returned in ${elapsed}ms, well under the 10s timeout (did not hang)`);
  });
});

// DEVIN_ONLY end-to-end: Cascade is retired, so a model that would normally
// take the Cascade Connect-RPC flow (e.g. claude-sonnet-4.6) must instead run
// through the real Devin ACP runner — with no WINDSURFAPI_SPECIAL_AGENT_BACKEND
// set, because DEVIN_ONLY alone enables the whole path. This proves the single
// kill-switch actually re-routes normal models, not just the special-agent
// catalog. (It does NOT prove Devin serves claude as claude — the model name
// only reaches the prompt hint; true model selection is gated on a live probe.)
describe('ACP integration — DEVIN_ONLY routes a normal (Cascade) model into Devin', () => {
  it('forces claude-sonnet-4.6 through the real ACP runner under DEVIN_ONLY=1', async () => {
    process.env.DEVIN_ONLY = '1';
    // Deliberately do NOT set WINDSURFAPI_SPECIAL_AGENT_BACKEND — DEVIN_ONLY
    // must enable the backend on its own.
    delete process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
    delete process.env.DEVIN_CLI_ENABLED;
    installAcpBackend(ECHO_FAKE);

    const result = await handleChatCompletions(
      { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'devin-only ping' }] },
      poolContext({ id: 'a', apiKey: 'pool-key-claude', apiServerUrl: 'https://srv.example' }),
    );

    assert.equal(result.status, 200, 'claude routed into Devin returns 200');
    const content = result.body.choices[0].message.content;
    // The ECHO fake proves the request reached the ACP authenticate + prompt
    // frames — i.e. it went through Devin, not Cascade.
    assert.match(content, /KEY=pool-key-claude/);
    assert.match(content, /PROMPT<[\s\S]*Model requested by caller: claude-sonnet-4\.6[\s\S]*devin-only ping[\s\S]*>/);
    assert.equal(result.body.model, 'claude-sonnet-4.6', 'response echoes the requested model id');
  });
});

