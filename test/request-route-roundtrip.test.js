// Public HTTP round trip through the real gateway and Connect adapter, ending at
// the fake stream transport. Only loopback and synthetic files are involved.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DEVIN_CONNECT = '1';
process.env.DEVIN_CONNECT_FAILOVER_MAX = '0';
process.env.DEVIN_CONNECT_SESSION_REUSE = '0';
process.env.RESPONSE_CACHE_ENABLED = '0';

const { startServer } = await import('../src/server.js');
const { config, log } = await import('../src/config.js');
const { _resetRuntimeConfigForTests } = await import('../src/runtime-config.js');
const {
  addAccountByKey, removeAccount, getAccountInternal, __setModelCatalogDeps, __waitForModelCatalogSync,
} = await import('../src/auth.js');
const { __setStreamChatForTest } = await import('../src/devin-connect-openai.js');
const { exportStats, getRequestLog, importStats, resetStats } = await import('../src/dashboard/stats.js');

const API_KEY = 'local-route-fixture-authorization';
const MODEL = 'gpt-5.5';
const EFFORT = 'xhigh';
const SELECTOR = 'gpt-5-5-xhigh';
const TOOL_ID = 'call_route_fixture_read';
const FILE_NAME = 'input.txt';
const TOOL = {
  type: 'function',
  function: {
    name: 'read_fixture',
    parameters: {
      type: 'object', required: ['name'], additionalProperties: false,
      properties: { name: { type: 'string', enum: [FILE_NAME] } },
    },
  },
};
const USAGE = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function harness(t, upstream) {
  const previous = { host: config.host, port: config.port, apiKey: config.apiKey };
  const dispatches = [];
  const probes = [];
  config.host = '127.0.0.1';
  config.port = 0;
  config.apiKey = API_KEY;
  resetStats();
  _resetRuntimeConfigForTests({ experimental: { nativeToolCall: true } });
  __setModelCatalogDeps({
    disableConnectSync: true,
    getCascadeModelConfigs: async () => ({ configs: [] }),
  });
  const account = addAccountByKey('devin-session-token$offline-route-fixture', 'Route fixture');
  const liveAccount = getAccountInternal(account.id);
  liveAccount.tier = 'pro';
  liveAccount.credits = { dailyPercent: 80, weeklyPercent: 80 };
  t.after(async () => {
    await __waitForModelCatalogSync();
    removeAccount(account.id);
    __setModelCatalogDeps(null);
    __setStreamChatForTest(null);
    _resetRuntimeConfigForTests();
    resetStats();
    Object.assign(config, previous);
  });
  t.mock.method(log, 'info', (message) => {
    if (typeof message !== 'string' || !message.startsWith('Probe[')) return;
    const close = message.indexOf(']');
    const effort = /\breasoning=(\S+)/.exec(message)?.[1];
    if (effort) probes.push({ traceId: message.slice('Probe['.length, close), effort });
  });
  __setStreamChatForTest(async function* (params) {
    const observation = { selector: params.model, traceId: params.traceId, temperature: params.completion?.temperature };
    dispatches.push(observation);
    yield* upstream(params.messages, observation);
  });
  const server = startServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  if (!server.listening) await once(server, 'listening');
  async function post(path, body) {
    const response = await fetch(new URL(path, 'http://127.0.0.1:' + server.address().port), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await response.text()).split(/\r?\n/)
      .filter(line => line.startsWith('data: ')).map(line => line.slice('data: '.length));
    return {
      status: response.status, requestId: response.headers.get('x-request-id'),
      anthropicRequestId: response.headers.get('request-id'),
      publicModel: response.headers.get('openai-model'),
      done: data.filter(line => line === '[DONE]').length,
      frames: data.filter(line => line !== '[DONE]').map(line => JSON.parse(line)),
    };
  }
  return { dispatches, probes, post };
}

function chatRequest(messages, extra = {}) {
  return { model: MODEL, reasoning_effort: EFFORT, messages, temperature: 0.73, stream: true, ...extra };
}

function chatParts(response) {
  const calls = new Map();
  const choices = response.frames.flatMap(frame => frame.choices || []);
  for (const choice of choices) {
    for (const chunk of choice.delta?.tool_calls || []) {
      const call = calls.get(chunk.index) || { id: '', name: '', arguments: '' };
      if (chunk.id) call.id = chunk.id;
      call.name += chunk.function?.name || '';
      call.arguments += chunk.function?.arguments || '';
      calls.set(chunk.index, call);
    }
  }
  return {
    text: choices.map(choice => choice.delta?.content || '').join(''),
    terminals: choices.map(choice => choice.finish_reason).filter(reason => reason != null),
    calls: [...calls.values()],
    errors: response.frames.filter(frame => frame.error).map(frame => frame.error),
  };
}

function requireRoute(response, dispatch, probes, selector = SELECTOR) {
  assert.equal(dispatch.selector, selector, 'unexpected dispatched selector');
  assert.match(response.requestId, /^req_[a-f0-9-]{36}$/);
  assert.equal(dispatch.traceId, response.requestId, 'public request ID and dispatch trace do not match');
  const probe = probes.find(item => item.traceId === response.requestId);
  assert.equal(probe?.effort, EFFORT, 'request ID must identify the matching effort probe');
}

function requireChatTerminal(response, parts, terminal) {
  assert.equal(response.status, 200);
  assert.deepEqual(parts.errors, [], 'HTTP 200 carried a stream error');
  assert.deepEqual(parts.terminals, [terminal]);
  assert.equal(response.done, 1);
}

async function requireArtifact(path, expectedDigest) {
  const bytes = await readFile(path);
  assert.equal(digest(bytes), expectedDigest, 'final artifact digest differs');
}

test('Chat carries alias, effort, request identity, tool result and final artifact together', async t => {
  const tmp = await mkdtemp(join(process.env.DATA_DIR, 'route-proof-'));
  const fixture = join(tmp, FILE_NAME);
  const final = join(tmp, 'final.txt');
  const marker = 'offline-marker-' + randomUUID();
  await writeFile(fixture, marker, 'utf8');
  const expected = digest('verified=' + marker + '\n');
  const user = { role: 'user', content: 'Read the fixture and form the verified result.' };
  let round = 0;
  let toolReads = 0;
  const route = await harness(t, async function* (messages, observation) {
    round++;
    if (round === 1) {
      assert.ok(!JSON.stringify(messages).includes(marker));
      yield { type: 'finish', reason: 'tool_calls', usage: USAGE, toolCalls: [
        { id: TOOL_ID, name: TOOL.function.name, arguments: JSON.stringify({ name: FILE_NAME }) },
      ] };
      return;
    }
    assert.equal(round, 2, 'one upstream dispatch per request');
    const tool = messages.find(message => message.role === 'tool');
    assert.ok(tool, 'the resolved upstream request is missing the tool result');
    observation.toolCallId = tool.tool_call_id;
    observation.toolDigest = digest(tool.content);
    yield { type: 'content', text: 'verified=' + tool.content + '\n' };
    yield { type: 'finish', reason: 'stop', usage: USAGE };
  });
  const first = await route.post('/v1/chat/completions', chatRequest([user], { tools: [TOOL] }));
  const firstParts = chatParts(first);
  requireChatTerminal(first, firstParts, 'tool_calls');
  assert.equal(firstParts.calls.length, 1);
  const call = firstParts.calls[0];
  assert.equal(call.name, TOOL.function.name);
  assert.equal(call.id, TOOL_ID);
  assert.deepEqual(JSON.parse(call.arguments), { name: FILE_NAME });
  const toolOutput = await readFile(fixture, 'utf8');
  toolReads++;
  const second = await route.post('/v1/chat/completions', chatRequest([
    user,
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function',
      function: { name: call.name, arguments: call.arguments } }] },
    { role: 'tool', tool_call_id: call.id, content: toolOutput },
  ], { tools: [TOOL] }));
  const secondParts = chatParts(second);
  requireChatTerminal(second, secondParts, 'stop');
  assert.deepEqual([first.publicModel, second.publicModel], [MODEL, MODEL]);
  assert.deepEqual(secondParts.calls, []);
  assert.equal(route.dispatches.length, 2);
  requireRoute(first, route.dispatches[0], route.probes);
  requireRoute(second, route.dispatches[1], route.probes);
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual(route.dispatches.map(call => call.temperature), [0.73, 0.73]);
  assert.equal(route.dispatches[1].toolCallId, call.id);
  assert.equal(route.dispatches[1].toolDigest, digest(toolOutput));
  assert.equal(toolReads, 1);
  for (const reply of [first, second]) {
    const rows = getRequestLog({ requestId: reply.requestId });
    assert.equal(rows.total, 1, 'lookup must isolate this HTTP root');
    const [row] = rows.items;
    assert.equal(row.requestId, reply.requestId);
    assert.equal(row.requestedModel, MODEL);
    assert.equal(row.requestHttpStatus, 200);
    assert.deepEqual(row.requestDispatches, [SELECTOR]);
    assert.equal(row.requestDispatchCount, 1);
    assert.equal(row.requestFailureCode, null);
  }
  const saved = exportStats().recentRequests;
  assert.equal(new Set(saved.map(row => row.statsRowId)).size, 2);
  assert.ok(saved.every(row => row.requestId && row.requestId !== row.statsRowId));
  assert.equal(importStats(exportStats()).ok, true);
  assert.equal(getRequestLog({ requestId: first.requestId }).total, 1);
  assert.equal(getRequestLog({ requestId: second.requestId }).total, 1);
  await assert.rejects(requireArtifact(final, expected), err => err.code === 'ENOENT');
  await writeFile(final, secondParts.text, { encoding: 'utf8', flag: 'wx' });
  await requireArtifact(final, expected);
  t.diagnostic(JSON.stringify({
    model: MODEL, selector: SELECTOR, effort: EFFORT, requestIds: [first.requestId, second.requestId],
    toolCallId: call.id, toolReads, terminals: ['tool_calls', 'stop'], finalSha256: expected,
  }));
});

test('acceptance rejects a real different selector and a post-commit deadline despite HTTP 200', async t => {
  const user = { role: 'user', content: 'Synthetic post-commit deadline control' };
  const route = await harness(t, async function* () {
    yield { type: 'content', text: 'partial synthetic output' };
    throw Object.assign(new Error('synthetic deadline after response content'), { code: 'DEADLINE_EXCEEDED' });
  });
  const response = await route.post('/v1/chat/completions', chatRequest([user], { model: 'gpt-5.5-high' }));
  const parts = chatParts(response);
  assert.equal(response.status, 200);
  assert.equal(parts.text, 'partial synthetic output');
  assert.equal(route.dispatches.length, 1);
  assert.throws(() => requireRoute(response, route.dispatches[0], route.probes), /unexpected dispatched selector/);
  requireRoute(response, route.dispatches[0], route.probes, 'gpt-5-5-high');
  assert.equal(parts.errors.length, 1);
  assert.equal(parts.errors[0].code, 'DEADLINE_EXCEEDED');
  assert.deepEqual(parts.terminals, []);
  assert.throws(() => requireChatTerminal(response, parts, 'stop'), /HTTP 200 carried a stream error/);
  const stats = getRequestLog({ requestId: response.requestId }).items[0];
  assert.equal(stats.requestId, response.requestId);
  assert.equal(stats.requestedModel, 'gpt-5.5-high');
  assert.equal(stats.requestHttpStatus, 200);
  assert.equal(stats.success, false);
  assert.equal(stats.requestFailureCode, 'DEADLINE_EXCEEDED');
  assert.deepEqual(stats.requestDispatches, ['gpt-5-5-high']);
  t.diagnostic(JSON.stringify({
    requestedModel: 'gpt-5.5-high', selector: route.dispatches[0].selector, http: response.status,
    requestId: response.requestId, terminal: null, streamError: parts.errors[0].code ?? parts.errors[0].type,
    attemptSucceeded: stats.success,
  }));
});

test('concurrent HTTP roots retain the selectors and retries actually dispatched for each', async t => {
  let xhighCalls = 0;
  const route = await harness(t, async function* (_messages, observation) {
    if (observation.selector === SELECTOR && ++xhighCalls === 1) {
      throw Object.assign(new Error('synthetic reset before delivery'), { code: 'ECONNRESET' });
    }
    yield { type: 'content', text: 'synthetic result' };
    yield { type: 'finish', reason: 'stop', usage: USAGE };
  });
  const user = { role: 'user', content: 'Synthetic independent request' };
  const [retried, distinct] = await Promise.all([
    route.post('/v1/chat/completions', chatRequest([user])),
    route.post('/v1/chat/completions', chatRequest([user], { model: 'gpt-5.5-high' })),
  ]);
  assert.notEqual(retried.requestId, distinct.requestId);
  for (const [reply, expected] of [[retried, [SELECTOR, SELECTOR]], [distinct, ['gpt-5-5-high']]]) {
    requireChatTerminal(reply, chatParts(reply), 'stop');
    const { items } = getRequestLog({ requestId: reply.requestId });
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].requestDispatches, expected);
    assert.equal(items[0].requestDispatchCount, expected.length);
    assert.deepEqual(route.dispatches.filter(call => call.traceId === reply.requestId).map(call => call.selector), expected);
  }
  assert.equal(getRequestLog({ requestId: retried.requestId.slice(0, -1) }).total, 0);
});

const responsesBody = { model: MODEL, reasoning: { effort: EFFORT }, input: 'synthetic', stream: true, store: false };
for (const [name, path, body, finish, terminal] of [
  ['Responses', '/v1/responses', responsesBody, 'stop', 'response.completed'],
  ['Capped Responses', '/v1/responses', responsesBody, 'length', 'response.incomplete'],
  ['Messages', '/v1/messages', { model: MODEL + '-xhigh', max_tokens: 128, messages: [{ role: 'user', content: 'synthetic' }], stream: true }, 'stop', 'message_stop'],
]) {
  test(name + ' carries its public request identity through the translated Connect dispatch', async t => {
    const route = await harness(t, async function* () {
      yield { type: 'content', text: 'synthetic result' };
      yield { type: 'finish', reason: finish, usage: USAGE };
    });
    const response = await route.post(path, body);
    assert.equal(response.status, 200);
    assert.equal(route.dispatches.length, 1);
    assert.equal(route.dispatches[0].selector, SELECTOR);
    assert.match(response.requestId, /^req_[a-f0-9-]{36}$/);
    assert.equal(route.dispatches[0].traceId, response.requestId);
    if (name === 'Messages') assert.equal(response.anthropicRequestId, response.requestId);
    assert.equal(response.frames.filter(frame => frame.type === terminal).length, 1);
    if (path === '/v1/responses') {
      const { items } = getRequestLog({ requestId: response.requestId });
      assert.equal(items.length, 1);
      assert.equal(items[0].requestSurface, 'responses');
      assert.deepEqual(items[0].requestDispatches, [SELECTOR]);
      assert.equal(items[0].requestDispatchCount, 1);
      assert.deepEqual(items[0].requestResponses, {
        inputToolResults: 0, outputToolCalls: 0, outputText: true, terminal: terminal.slice('response.'.length),
      });
    }
  });
}
