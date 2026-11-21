import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';

// Drive the real ACP transport and HTTP format adapters through a synthetic
// peer. The fixture reports an imaginary operation with no implementation.
const TOOL_NAME = 'fixture_counter';
const TOOL_DESCRIPTION = 'fixture-client-definition';
const TOOL_INPUT = 'fixture-agent-input';
const TOOL_OUTPUT = 'fixture-agent-output';
const ANSWER = 'The fixture turn finished.';
const REASONING = 'The fixture thought.';
const USER_MESSAGE = 'Respond using the fixture.';
const TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: { type: 'object', properties: { marker: { type: 'string' } } },
  },
};
const ENV_KEYS = [
  'WINDSURFAPI_SPECIAL_AGENT_BACKEND',
  'DEVIN_CLI_PATH',
  'DEVIN_CLI_ACP_ARGS_JSON',
  'DEVIN_CLI_USE_ACCOUNT_POOL',
  'DEVIN_CLI_MODE',
  'DEVIN_CLI_ALLOW_CLIENT_TOOLS',
  'DEVIN_ACP_EXPOSE_REASONING',
  'DEVIN_ACP_PROBE',
  'DEVIN_TIMEOUT_MS',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const tmpDirs = [];

beforeEach(() => {
  process.env.DEVIN_ACP_PROBE = '0';
  process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
  process.env.DEVIN_CLI_MODE = 'acp';
  process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '1';
  delete process.env.DEVIN_CLI_ALLOW_CLIENT_TOOLS;
  process.env.DEVIN_ACP_EXPOSE_REASONING = '1';
  process.env.DEVIN_TIMEOUT_MS = '5000';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const TOOL_UPDATES = [
  ...['pending', undefined, 'in_progress', 'completed', 'failed'].map((status, index) => ({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-' + index,
    title: TOOL_NAME,
    name: TOOL_NAME,
    kind: 'other',
    status,
    rawInput: { marker: TOOL_INPUT },
  })),
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-3',
    title: TOOL_NAME,
    name: TOOL_NAME,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: TOOL_OUTPUT } }],
    rawOutput: TOOL_OUTPUT,
  },
];

function installFakeAcp({ stopReason = 'end_turn', updates = TOOL_UPDATES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-tools-'));
  tmpDirs.push(dir);
  const script = join(dir, 'fake-acp.mjs');
  const prompts = join(dir, 'prompts.jsonl');
  writeFileSync(prompts, '', 'utf8');
  writeFileSync(script, String.raw`
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } }); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    appendFileSync(new URL('./prompts.jsonl', import.meta.url), JSON.stringify(msg.params) + '\n');
    for (const entry of ${JSON.stringify(updates)}) update(entry);
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ${JSON.stringify(REASONING)} } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(ANSWER)} } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: ${JSON.stringify(stopReason)}, usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 } } });
  }
});
`, 'utf8');
  process.env.DEVIN_CLI_PATH = process.execPath;
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
  return () => readFileSync(prompts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function acpDeps() {
  return {
    specialAgent: {
      checkoutAccount: async () => ({ apiKey: 'test-key', id: 'acct-1', apiServerUrl: '' }),
      releaseAccount: () => {},
      reportSuccess: () => {},
      refundReservation: () => {},
      reportError: () => {},
      reportInternalError: () => {},
      reportBanSignal: () => {},
      markRateLimited: () => {},
    },
  };
}

async function collectStream(result) {
  let wire = '';
  const res = {
    writableEnded: false,
    write(chunk) { wire += String(chunk); return true; },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  assert.equal(result.status, 200);
  assert.equal(result.stream, true);
  await result.handler(res);
  assert.equal(res.writableEnded, true);
  const data = Array.from(wire.matchAll(/^data: (.+)$/gm), ([, value]) => value);
  return { wire, frames: data.filter(value => value !== '[DONE]').map(value => JSON.parse(value)) };
}

function assertNoToolPayload(wire) {
  assert.doesNotMatch(wire, /fixture_counter|fixture-agent-input|fixture-agent-output/);
}

const chatBody = { model: 'swe-1.6', messages: [{ role: 'user', content: USER_MESSAGE }] };

describe('ACP agent tool activity', () => {
  for (const allowTools of [false, true]) {
    for (const stream of [false, true]) {
      it('preserves a Chat ' + (stream ? 'stream' : 'buffered turn') + (allowTools ? ' with a matching admitted tool' : ' without declared tools'), async () => {
        const readPrompts = installFakeAcp();
        if (allowTools) process.env.DEVIN_CLI_ALLOW_CLIENT_TOOLS = '1';
        const result = await handleChatCompletions({
          ...chatBody,
          ...(allowTools ? { tools: [TOOL] } : {}),
          stream,
          stream_options: { include_usage: true },
        }, acpDeps());

        if (stream) {
          const { frames, wire } = await collectStream(result);
          const choices = frames.flatMap(frame => frame.choices || []);
          assert.equal(choices.map(choice => choice.delta.content || '').join(''), ANSWER);
          assert.equal(choices.map(choice => choice.delta.reasoning_content || '').join(''), REASONING);
          assert.deepEqual(choices.map(choice => choice.finish_reason).filter(Boolean), ['stop']);
          assert.equal(frames.at(-1).usage.total_tokens, 38);
          assert.match(wire, /data: \[DONE\]\n\n$/);
          assert.doesNotMatch(wire, /"tool_calls"|"role":"tool"/);
          assertNoToolPayload(wire);
        } else {
          assert.equal(result.status, 200);
          const choice = result.body.choices[0];
          assert.equal(choice.message.content, ANSWER);
          assert.equal(choice.message.reasoning_content, REASONING);
          assert.equal(choice.finish_reason, 'stop');
          assert.equal(result.body.usage.total_tokens, 38);
          assert.equal('tool_calls' in choice.message, false);
          assertNoToolPayload(JSON.stringify(result.body));
        }

        // Verify the prompt that reaches the CLI even with admission enabled.
        const prompts = readPrompts();
        assert.equal(prompts.length, 1);
        const [params] = prompts;
        assert.equal('tools' in params, false);
        assert.doesNotMatch(JSON.stringify(params), /fixture_counter|fixture-client-definition/);
        assert.ok(params.prompt.some(block => block.type === 'text' && block.text.includes(USER_MESSAGE)));
      });
    }
  }

  it('refuses caller tool declarations by default before sending an ACP prompt', async () => {
    const readPrompts = installFakeAcp();
    const result = await handleChatCompletions({ ...chatBody, tools: [TOOL] }, acpDeps());
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'unsupported_tool_boundary');
    assert.deepEqual(readPrompts(), []);
  });

  for (const stream of [false, true]) {
    it('preserves the ' + (stream ? 'streaming' : 'buffered') + ' Anthropic end_turn', async () => {
      installFakeAcp();
      const result = await handleMessages({ ...chatBody, max_tokens: 128, stream }, acpDeps());
      if (stream) {
        const { frames, wire } = await collectStream(result);
        const deltas = frames.filter(frame => frame.type === 'content_block_delta').map(frame => frame.delta);
        assert.equal(deltas.map(delta => delta.text || '').join(''), ANSWER);
        assert.equal(deltas.map(delta => delta.thinking || '').join(''), REASONING);
        const terminal = frames.find(frame => frame.type === 'message_delta');
        assert.equal(terminal.delta.stop_reason, 'end_turn');
        assert.equal(terminal.usage.output_tokens, 7);
        assert.equal(frames.at(-1).type, 'message_stop');
        assert.doesNotMatch(wire, /"tool_use"|"tool_result"/);
        assertNoToolPayload(wire);
      } else {
        assert.equal(result.status, 200);
        assert.equal(result.body.stop_reason, 'end_turn');
        assert.deepEqual(result.body.content.map(block => block.type), ['thinking', 'text']);
        assert.equal(result.body.content[0].thinking, REASONING);
        assert.equal(result.body.content[1].text, ANSWER);
        assert.equal(result.body.usage.output_tokens, 7);
        assertNoToolPayload(JSON.stringify(result.body));
      }
    });

    it('preserves the ' + (stream ? 'streaming' : 'buffered') + ' Responses completion', async () => {
      installFakeAcp();
      const result = await handleResponses({ model: chatBody.model, input: USER_MESSAGE, store: false, stream }, { context: acpDeps() });
      assert.equal(result.status, 200);
      const { frames, wire } = stream ? await collectStream(result) : { frames: [], wire: JSON.stringify(result.body) };
      const response = stream ? frames.find(frame => frame.type === 'response.completed')?.response : result.body;
      assert.equal(response?.status, 'completed');
      assert.deepEqual(response.output.map(item => item.type), ['reasoning', 'message']);
      assert.equal(response.output[0].summary[0].text, REASONING);
      assert.equal(response.output[1].content[0].text, ANSWER);
      assert.equal(response.usage.output_tokens, 7);
      assert.doesNotMatch(wire, /"function_call"|"function_call_output"|"custom_tool_call"|response\.function_call_arguments/);
      assertNoToolPayload(wire);
    });
  }
});

describe('ACP tool stops', () => {
  for (const updates of [[], TOOL_UPDATES]) {
    const withUpdates = updates.length > 0;
    it('rejects a tool_use stop ' + (withUpdates ? 'after agent tool activity' : 'without tool activity'), async () => {
      const readPrompts = installFakeAcp({ stopReason: 'tool_use', updates });
      const result = await handleChatCompletions(chatBody, acpDeps());
      assert.equal(result.status, 502);
      assert.equal(result.body.error.type, 'backend_tool_call_unmapped');
      assert.match(result.body.error.message, /tool_use/);
      assert.equal(readPrompts().length, 1);
    });

    it('ends a stream with an error for tool_use ' + (withUpdates ? 'after agent tool activity' : 'without tool activity'), async () => {
      const readPrompts = installFakeAcp({ stopReason: 'tool_use', updates });
      const result = await handleChatCompletions({ ...chatBody, stream: true }, acpDeps());
      const { frames, wire } = await collectStream(result);
      assert.equal(frames.find(frame => frame.error)?.error.type, 'backend_tool_call_unmapped');
      assert.equal(frames.at(-1).choices[0].finish_reason, 'error');
      assert.match(wire, /data: \[DONE\]\n\n$/);
      assert.doesNotMatch(wire, /"tool_calls"/);
      assertNoToolPayload(wire);
      assert.equal(readPrompts().length, 1);
    });
  }

  it('converts an unmappable ACP stop into the existing Anthropic error', async () => {
    installFakeAcp({ stopReason: 'tool_use' });
    const result = await handleMessages({ ...chatBody, max_tokens: 128 }, acpDeps());
    assert.equal(result.status, 529);
    assert.equal(result.body.error.type, 'overloaded_error');
    assert.match(result.body.error.message, /tool_use/);
  });
});

it('still forwards caller-owned tool calls from a custom runner', async () => {
  process.env.DEVIN_CLI_ALLOW_CLIENT_TOOLS = '1';
  const deps = acpDeps();
  deps.specialAgent.runDevinAcp = async () => ({
    stopReason: 'tool_use',
    toolCalls: [{ id: 'call_fixture', name: TOOL_NAME, input: { marker: 'caller-action' } }],
  });
  const result = await handleChatCompletions({ ...chatBody, tools: [TOOL] }, deps);
  assert.equal(result.status, 200);
  const choice = result.body.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.deepEqual(choice.message.tool_calls, [{
    id: 'call_fixture',
    type: 'function',
    function: { name: TOOL_NAME, arguments: '{"marker":"caller-action"}' },
  }]);
});
