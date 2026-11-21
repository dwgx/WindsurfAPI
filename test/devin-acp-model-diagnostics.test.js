import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { getLogs } from '../src/dashboard/logger.js';
import { __setDevinAcpSpawnForTest } from '../src/devin-acp.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

const envKeys = [
  'WINDSURFAPI_SPECIAL_AGENT_BACKEND',
  'DEVIN_CLI_MODE',
  'DEVIN_CLI_ACP_ARGS_JSON',
  'DEVIN_CLI_USE_ACCOUNT_POOL',
  'DEVIN_ACP_CONFIG_OPTIONS',
  'DEVIN_ACP_PROBE',
];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const privateArgument = 'PrivateArgFixture9845';
const privateError = 'PrivateRpcErrorFixture9845';
const privatePrompt = 'PrivatePromptFixture9845';
const privateModel = 'PrivateModelFixture9845';
const fixtureKey = 'test-account-fixture';

afterEach(() => {
  __setDevinAcpSpawnForTest(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function modelOption(currentValue, { id = 'model', values = ['swe-1.6', 'arena-smart'], grouped = false } = {}) {
  const choices = values.map(value => ({ name: value, value }));
  return {
    id,
    name: 'Session model',
    type: 'select',
    currentValue,
    options: grouped ? [{ group: 'available', name: 'Available', options: choices }] : choices,
  };
}

const successfulConfig = { result: { configOptions: [modelOption('swe-1.6')] } };
const rejectedConfig = { error: { code: -32602, message: privateError } };

function installPeer({ config }) {
  const wire = { args: null, requests: [] };
  __setDevinAcpSpawnForTest((_command, args) => {
    wire.args = [...args];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.kill = () => true;
    const send = data => child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
    child.stdin.write = line => {
      const message = JSON.parse(line);
      wire.requests.push(message);
      queueMicrotask(() => {
        const { id, method } = message;
        if (method === 'initialize') {
          send({ id, result: { protocolVersion: 1 } });
        } else if (method === 'authenticate') {
          send({ id, result: {} });
        } else if (method === 'session/new') {
          send({ id, result: {
            sessionId: 'diagnostic-session',
            configOptions: config ? [modelOption('swe-1.6')] : [],
          } });
        } else if (method === 'session/set_config_option') {
          send({ id, ...config });
        } else if (method === 'session/prompt') {
          send({ method: 'session/update', params: { update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' },
          } } });
          send({ id, result: { stopReason: 'end_turn', model: 'arena-smart' } });
        }
      });
      return true;
    };
    return child;
  });
  return wire;
}

async function runCase(name, { args = ['acp'], config, configEnabled = Boolean(config), stream = false } = {}) {
  process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
  process.env.DEVIN_CLI_MODE = 'acp';
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify(args);
  process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '1';
  process.env.DEVIN_ACP_PROBE = '0';
  process.env.DEVIN_ACP_CONFIG_OPTIONS = configEnabled ? '1' : '0';

  const requestId = 'acp-diagnostic-' + name;
  const wire = installPeer({ config });
  const result = await handleChatCompletions({
    model: 'swe-1-6',
    messages: [{ role: 'user', content: privatePrompt }],
    stream,
  }, {
    traceId: requestId,
    specialAgent: {
      checkoutAccount: async () => ({ id: 'fixture', apiKey: fixtureKey, apiServerUrl: '' }),
      releaseAccount: () => {},
      reportSuccess: () => {},
    },
  });

  assert.equal(result.status, 200);
  if (stream) {
    const chunks = [];
    await result.handler({
      writableEnded: false,
      write(chunk) { chunks.push(chunk); },
      end() { this.writableEnded = true; },
      on() {},
    });
    const body = chunks.join('');
    assert.match(body, /"model":"swe-1-6"/);
    assert.match(body, /"content":"ready"/);
    assert.doesNotMatch(body, /backend_confirmed_model|effective_model|selection_source/);
  } else {
    assert.equal(result.body.model, 'swe-1-6');
    assert.equal(result.body.choices[0].message.content, 'ready');
    assert.equal(result.body.effective_model, undefined);
  }
  const prompt = wire.requests.find(row => row.method === 'session/prompt');
  assert.match(prompt.params.prompt[0].text, /^Model requested by caller: swe-1\.6\n/);

  const rows = getLogs().filter(row => row.msg === 'Devin ACP model selection' && row.ctx?.requestId === requestId);
  assert.equal(rows.length, 1, 'one operator log record should correlate with this request');
  assert.equal(rows[0].ctx.requested_model, 'swe-1-6');
  assert.equal(rows[0].ctx.backend_confirmed_model, null);
  assert.equal(rows[0].ctx.tool_owner, 'agent');
  const logText = JSON.stringify(rows);
  for (const value of [privateArgument, privateError, privatePrompt, privateModel, fixtureKey, 'diagnostic-session']) {
    assert.ok(!logText.includes(value), 'ACP model selection log included non-model input');
  }
  return { wire, log: rows[0] };
}

describe('ACP model selection operator diagnostics', () => {
  it('reports caller argv and an idle session setting on a normal streaming request', async () => {
    const { wire, log } = await runCase('stream', { stream: true });
    assert.deepEqual(wire.args, ['acp', '--model', 'swe-1.6']);
    assert.equal(log.ctx.launch_model, 'swe-1.6');
    assert.equal(log.ctx.session_config_status, 'disabled');
    assert.equal(log.ctx.session_attempted_model, null);
    assert.equal(log.ctx.session_model, null);
    assert.equal(log.ctx.effective_model, 'swe-1.6');
    assert.equal(log.ctx.selection_source, 'request_argv');
  });

  it('exposes a conflict between an operator launch pin and the acknowledged option', async () => {
    const { wire, log } = await runCase('pin', { args: ['acp', '--model', 'arena-fast'], config: successfulConfig });
    assert.deepEqual(wire.args, ['acp', '--model', 'arena-fast']);
    assert.equal(wire.requests.find(row => row.method === 'session/set_config_option').params.value, 'swe-1.6');
    assert.equal(log.ctx.launch_model, 'arena-fast');
    assert.equal(log.ctx.launch_source, 'operator_argv');
    assert.equal(log.ctx.session_config_status, 'acknowledged');
    assert.equal(log.ctx.session_attempted_model, 'swe-1.6');
    assert.equal(log.ctx.session_model, 'swe-1.6');
    assert.equal(log.ctx.effective_model, null);
    assert.equal(log.ctx.selection_source, 'conflict');
  });

  it('keeps the launch selection when an advertised session setting rejects the request', async () => {
    const { wire, log } = await runCase('rejected', { config: rejectedConfig });
    assert.deepEqual(wire.args, ['acp', '--model', 'swe-1.6']);
    assert.equal(log.level, 'warn');
    assert.equal(log.ctx.session_config_status, 'rejected');
    assert.equal(log.ctx.session_attempted_model, 'swe-1.6');
    assert.equal(log.ctx.session_model, null);
    assert.equal(log.ctx.effective_model, 'swe-1.6');
    assert.equal(log.ctx.selection_source, 'request_argv');
    assert.ok(!JSON.stringify(getLogs()).includes(privateError), 'config rejection leaked raw RPC error');
  });

  it('reports the acknowledged session model when it agrees with argv', async () => {
    const { log } = await runCase('acknowledged', { config: successfulConfig });
    assert.equal(log.ctx.session_config_status, 'acknowledged');
    assert.equal(log.ctx.session_attempted_model, 'swe-1.6');
    assert.equal(log.ctx.session_model, 'swe-1.6');
    assert.equal(log.ctx.effective_model, 'swe-1.6');
    assert.equal(log.ctx.selection_source, 'session_config');
  });

  it('reports a returned currentValue that differs from the attempted and launch model', async () => {
    const config = { result: { configOptions: [modelOption('arena-smart', { grouped: true })] } };
    const { log } = await runCase('different-current-value', { config });
    assert.equal(log.ctx.session_config_status, 'acknowledged');
    assert.equal(log.ctx.session_attempted_model, 'swe-1.6');
    assert.equal(log.ctx.session_model, 'arena-smart');
    assert.equal(log.ctx.effective_model, null);
    assert.equal(log.ctx.selection_source, 'conflict');
  });

  it('keeps unknown values out of the logs even when the option readback is valid', async () => {
    const config = { result: { configOptions: [modelOption(privateModel, { values: [privateModel] })] } };
    const { log } = await runCase('private-current-value', { config });
    assert.equal(log.ctx.session_config_status, 'acknowledged');
    assert.equal(log.ctx.session_attempted_model, 'swe-1.6');
    assert.equal(log.ctx.session_model, null);
    assert.equal(log.ctx.effective_model, null);
  });

  const invalidReadbacks = {
    missing: {},
    null: { result: null },
    empty: { result: {} },
    'wrong-id': { result: { configOptions: [modelOption('swe-1.6', { id: 'unrelated' })] } },
    'unlisted-value': { result: { configOptions: [modelOption('swe-1.6', { values: ['arena-smart'] })] } },
    'duplicate-id': { result: { configOptions: [modelOption('swe-1.6'), modelOption('arena-smart')] } },
  };
  for (const [name, config] of Object.entries(invalidReadbacks)) {
    it(`leaves the session model unconfirmed when the configuration readback is ${name}`, async () => {
      const { log } = await runCase('unresolved-' + name, { config });
      assert.equal(log.ctx.session_config_status, 'unresolved');
      assert.equal(log.ctx.session_attempted_model, 'swe-1.6');
      assert.equal(log.ctx.session_model, null);
      assert.equal(log.ctx.effective_model, null);
      assert.equal(log.ctx.selection_source, 'unknown');
    });
  }

  it('reports a prompt hint alone when the argv cannot set a model before the option terminator', async () => {
    const { wire, log } = await runCase('prompt-only', { args: ['acp', '--'], configEnabled: true });
    assert.deepEqual(wire.args, ['acp', '--', '--model', 'swe-1.6']);
    assert.equal(log.ctx.launch_model, null);
    assert.equal(log.ctx.session_config_status, 'not_advertised');
    assert.equal(log.ctx.effective_model, null);
    assert.equal(log.ctx.selection_source, 'prompt_hint');
  });

  it('does not expose a non-catalog value supplied as an operator model argument', async () => {
    const { wire, log } = await runCase('private-argument', { args: ['acp', '--model', privateArgument] });
    assert.deepEqual(wire.args, ['acp', '--model', privateArgument]);
    assert.equal(log.ctx.launch_model, null);
    assert.equal(log.ctx.launch_source, 'operator_argv');
    assert.equal(log.ctx.effective_model, null);
    assert.equal(log.ctx.selection_source, 'unknown');
  });

  it('reports ambiguous argv without changing how the adapter appends a request model', async () => {
    const { wire, log } = await runCase('ambiguous', { args: ['acp', '--model=arena-fast'] });
    assert.deepEqual(wire.args, ['acp', '--model=arena-fast', '--model', 'swe-1.6']);
    assert.equal(log.ctx.launch_model, null);
    assert.equal(log.ctx.launch_source, 'ambiguous');
    assert.equal(log.ctx.effective_model, null);
    assert.equal(log.ctx.selection_source, 'unknown');
  });
});