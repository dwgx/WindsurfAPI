import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { getModelInfo, listModels, resolveModel } from '../src/models.js';
import {
  getModelAccessConfig,
  setModelAccessList,
  setModelAccessMode,
} from '../src/dashboard/model-access.js';
import {
  buildSpecialAgentPrompt,
  getSpecialAgentStatus,
  isSpecialAgentModelInfo,
  runDevinAcp,
} from '../src/special-agent.js';

const ENV_KEYS = [
  'WINDSURFAPI_SPECIAL_AGENT_BACKEND',
  'DEVIN_CLI_ENABLED',
  'DEVIN_CLI_PATH',
  'DEVIN_CLI_ARGS_JSON',
  'DEVIN_CLI_ACP_ARGS_JSON',
  'DEVIN_CLI_USE_ACCOUNT_POOL',
  'DEVIN_CLI_ALLOW_CLIENT_TOOLS',
  'DEVIN_CLI_ALLOW_MEDIA',
  'DEVIN_CLI_MODE',
  'DEVIN_ACP_EXPOSE_REASONING',
  'WINDSURFAPI_SHOW_DISABLED_SPECIAL_AGENT_MODELS',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const originalModelAccess = getModelAccessConfig();

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  setModelAccessMode(originalModelAccess.mode || 'all');
  setModelAccessList(originalModelAccess.list || []);
});

function user(content) {
  return { role: 'user', content };
}

function fnTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
    },
  };
}

describe('special-agent model routing', () => {
  it('marks SWE/adaptive special-route models explicitly in the catalog', () => {
    assert.equal(resolveModel('swe-1-6'), 'swe-1.6');
    assert.equal(resolveModel('swe-1-6-fast'), 'swe-1.6-fast');

    for (const key of ['swe-1.6', 'swe-1.6-fast', 'adaptive', 'arena-fast', 'arena-smart']) {
      const info = getModelInfo(key);
      assert.ok(info, `${key} missing`);
      assert.equal(info.backend, 'special_agent');
      assert.equal(isSpecialAgentModelInfo(info), true);
    }
  });

  it('returns backend_unavailable instead of falling into Cascade when disabled', async () => {
    delete process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
    delete process.env.DEVIN_CLI_ENABLED;

    let checkoutCalls = 0;
    let runnerCalls = 0;
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user('hello')],
    }, {
      specialAgent: {
        checkoutAccount: () => { checkoutCalls++; },
        runDevinPrint: () => { runnerCalls++; },
      },
    });

    assert.equal(result.status, 503);
    assert.equal(result.body.error.type, 'backend_unavailable');
    assert.equal(checkoutCalls, 0);
    assert.equal(runnerCalls, 0);
  });

  it('routes enabled SWE calls to the special-agent runner before LSP/Cascade work', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    let seenPrompt = '';
    const result = await handleChatCompletions({
      model: 'swe-1.6-fast',
      messages: [
        { role: 'system', content: 'be direct' },
        user('ship the smallest PoC'),
      ],
    }, {
      specialAgent: {
        checkoutAccount: () => { throw new Error('account checkout must not run when pool use is off'); },
        runDevinPrint: async (prompt, opts) => {
          seenPrompt = prompt;
          assert.equal(opts.modelKey, 'swe-1.6-fast');
          assert.equal(opts.apiKey, '');
          return { text: 'SPECIAL_OK' };
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.model, 'swe-1.6-fast');
    assert.equal(result.body.choices[0].message.content, 'SPECIAL_OK');
    assert.match(seenPrompt, /System:\nbe direct/);
    assert.match(seenPrompt, /User:\nship the smallest PoC/);
  });

  it('routes acp mode through the ACP runner with account-pool credentials', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';

    let seenPrompt = '';
    let released = false;
    const result = await handleChatCompletions({
      model: 'swe-1.6-fast',
      messages: [user('use ACP')],
    }, {
      specialAgent: {
        checkoutAccount: () => ({
          id: 'acct-1',
          apiKey: 'windsurf-upstream-key',
          apiServerUrl: 'https://server.self-serve.windsurf.com',
        }),
        runDevinAcp: async (prompt, opts) => {
          seenPrompt = prompt;
          assert.equal(opts.modelKey, 'swe-1.6-fast');
          assert.equal(opts.apiKey, 'windsurf-upstream-key');
          assert.equal(opts.apiServerUrl, 'https://server.self-serve.windsurf.com');
          return { text: 'ACP_OK' };
        },
        releaseAccount: () => { released = true; },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'ACP_OK');
    assert.match(seenPrompt, /User:\nuse ACP/);
    assert.equal(released, true);
  });

  it('rejects caller-local tools on print backend by default', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    let runnerCalls = 0;
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user('read package.json')],
      tools: [fnTool('Read')],
    }, {
      specialAgent: {
        runDevinPrint: async () => { runnerCalls++; return { text: 'bad' }; },
      },
    });

    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'unsupported_tool_boundary');
    assert.equal(runnerCalls, 0);
  });

  it('rejects media content on print backend by default', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';
    delete process.env.DEVIN_CLI_ALLOW_MEDIA;

    let runnerCalls = 0;
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user([{ type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }])],
    }, {
      specialAgent: {
        runDevinPrint: async () => { runnerCalls++; return { text: 'bad' }; },
      },
    });

    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'unsupported_media');
    assert.equal(runnerCalls, 0);
  });

  it('routes hidden adaptive/arena models before the deprecated-model 410 guard', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      model: 'adaptive',
      messages: [user('use the special route')],
    }, {
      specialAgent: {
        runDevinPrint: async (_prompt, opts) => {
          assert.equal(opts.modelKey, 'adaptive');
          return { text: 'ADAPTIVE_OK' };
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'ADAPTIVE_OK');
  });

  it('honors dashboard blocklist before special-agent routing', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';
    setModelAccessMode('blocklist');
    setModelAccessList(['swe-1.6']);

    let runnerCalls = 0;
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user('blocked')],
    }, {
      specialAgent: {
        runDevinPrint: async () => { runnerCalls++; return { text: 'bad' }; },
      },
    });

    assert.equal(result.status, 403);
    assert.equal(result.body.error.type, 'model_blocked');
    assert.equal(runnerCalls, 0);
  });

  it('honors dashboard allowlist before special-agent routing', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-sonnet-4.6']);

    let runnerCalls = 0;
    const result = await handleChatCompletions({
      model: 'swe-1.6-fast',
      messages: [user('not allowlisted')],
    }, {
      specialAgent: {
        runDevinPrint: async () => { runnerCalls++; return { text: 'bad' }; },
      },
    });

    assert.equal(result.status, 403);
    assert.equal(result.body.error.type, 'model_blocked');
    assert.equal(runnerCalls, 0);
  });

  it('returns a buffered SSE stream for special-agent stream requests', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      model: 'swe-1.6',
      stream: true,
      messages: [user('stream it')],
    }, {
      specialAgent: {
        runDevinPrint: async () => ({ text: 'STREAM_OK' }),
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.stream, true);
    const writes = [];
    const res = {
      writableEnded: false,
      write(chunk) { writes.push(String(chunk)); },
      end() { this.writableEnded = true; },
    };
    await result.handler(res);
    const joined = writes.join('');
    assert.match(joined, /STREAM_OK/);
    assert.match(joined, /finish_reason":"stop"/);
    assert.match(joined, /data: \[DONE\]/);
  });

  it('drops ACP reasoning by default (DEVIN_ACP_EXPOSE_REASONING unset)', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';
    delete process.env.DEVIN_ACP_EXPOSE_REASONING;

    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user('hi')],
    }, {
      specialAgent: {
        runDevinAcp: async () => ({ text: 'VISIBLE', reasoning: 'secret-thought' }),
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'VISIBLE');
    assert.equal(result.body.choices[0].message.reasoning_content, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /secret-thought/);
  });

  it('exposes ACP reasoning as reasoning_content when DEVIN_ACP_EXPOSE_REASONING=1', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';
    process.env.DEVIN_ACP_EXPOSE_REASONING = '1';

    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user('hi')],
    }, {
      specialAgent: {
        runDevinAcp: async () => ({ text: 'VISIBLE', reasoning: 'thinking-here' }),
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'VISIBLE');
    assert.equal(result.body.choices[0].message.reasoning_content, 'thinking-here');
    // The reply text must not leak the reasoning buffer.
    assert.doesNotMatch(result.body.choices[0].message.content, /thinking-here/);
  });

  it('streams reasoning_content before content when exposed', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';
    process.env.DEVIN_ACP_EXPOSE_REASONING = '1';

    const result = await handleChatCompletions({
      model: 'swe-1.6',
      stream: true,
      messages: [user('stream it')],
    }, {
      specialAgent: {
        runDevinAcp: async () => ({ text: 'STREAM_OK', reasoning: 'stream-thought' }),
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.stream, true);
    const writes = [];
    const res = {
      writableEnded: false,
      write(chunk) { writes.push(String(chunk)); },
      end() { this.writableEnded = true; },
    };
    await result.handler(res);
    const joined = writes.join('');
    assert.match(joined, /reasoning_content":"stream-thought"/);
    assert.match(joined, /"content":"STREAM_OK"/);
    // reasoning_content chunk must arrive before the content chunk.
    assert.ok(joined.indexOf('stream-thought') < joined.indexOf('STREAM_OK'));
  });

  it('does not stream reasoning_content by default', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';
    delete process.env.DEVIN_ACP_EXPOSE_REASONING;

    const result = await handleChatCompletions({
      model: 'swe-1.6',
      stream: true,
      messages: [user('stream it')],
    }, {
      specialAgent: {
        runDevinAcp: async () => ({ text: 'STREAM_OK', reasoning: 'hidden-thought' }),
      },
    });

    const writes = [];
    const res = {
      writableEnded: false,
      write(chunk) { writes.push(String(chunk)); },
      end() { this.writableEnded = true; },
    };
    await result.handler(res);
    const joined = writes.join('');
    assert.match(joined, /STREAM_OK/);
    assert.doesNotMatch(joined, /reasoning_content/);
    assert.doesNotMatch(joined, /hidden-thought/);
  });
});

describe('special-agent wrapper routes', () => {
  it('Anthropic messages route forwards special-agent context through chat', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleMessages({
      model: 'swe-1.6',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'messages wrapper' }],
    }, {
      specialAgent: {
        runDevinPrint: async (prompt, opts) => {
          assert.match(prompt, /messages wrapper/);
          assert.equal(opts.modelKey, 'swe-1.6');
          return { text: 'MESSAGES_OK' };
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.type, 'message');
    const text = result.body.content.find(p => p.type === 'text')?.text || '';
    assert.equal(text, 'MESSAGES_OK');
  });

  it('Responses route forwards special-agent context through chat', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleResponses({
      model: 'swe-1.6-fast',
      input: 'responses wrapper',
    }, {
      context: {
        specialAgent: {
          runDevinPrint: async (prompt, opts) => {
            assert.match(prompt, /responses wrapper/);
            assert.equal(opts.modelKey, 'swe-1.6-fast');
            return { text: 'RESPONSES_OK' };
          },
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'completed');
    const text = result.body.output
      .flatMap(item => item.content || [])
      .find(part => part.type === 'output_text')?.text || '';
    assert.equal(text, 'RESPONSES_OK');
  });
});

describe('special-agent prompt/status helpers', () => {
  it('builds a compact text prompt from chat messages', () => {
    const prompt = buildSpecialAgentPrompt([
      { role: 'system', content: 'system rules' },
      user([{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'x' } }]),
      { role: 'assistant', content: 'prior answer' },
      { role: 'tool', content: 'tool output' },
    ]);
    assert.match(prompt, /System:\nsystem rules/);
    assert.match(prompt, /User:\nhello/);
    assert.match(prompt, /\[image omitted/);
    assert.match(prompt, /Assistant:\nprior answer/);
    assert.match(prompt, /Tool result:\ntool output/);
  });

  it('reports disabled status by default', () => {
    delete process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
    delete process.env.DEVIN_CLI_ENABLED;
    const status = getSpecialAgentStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.backend, 'disabled');
  });

  it('hides special-agent models from /v1/models while backend is disabled', () => {
    delete process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
    delete process.env.DEVIN_CLI_ENABLED;
    delete process.env.WINDSURFAPI_SHOW_DISABLED_SPECIAL_AGENT_MODELS;
    const ids = listModels().map(m => m.id);
    assert.equal(ids.includes('swe-1.6'), false);
    assert.equal(ids.includes('swe-1.6-fast'), false);
  });

  it('can expose disabled special-agent models with unavailable metadata for operators', () => {
    delete process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
    delete process.env.DEVIN_CLI_ENABLED;
    process.env.WINDSURFAPI_SHOW_DISABLED_SPECIAL_AGENT_MODELS = '1';
    const model = listModels().find(m => m.id === 'swe-1.6');
    assert.equal(model?._backend, 'special_agent');
    assert.equal(model?._available, false);
    assert.equal(model?._unavailable_reason, 'special-agent backend disabled');
  });

  it('shows special-agent models as available when backend is enabled', () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    delete process.env.DEVIN_CLI_ENABLED;
    const model = listModels().find(m => m.id === 'swe-1.6');
    assert.equal(model?._backend, 'special_agent');
    assert.equal(model?._available, true);
  });
});

describe('Devin ACP runner', () => {
  it('authenticates with ACP _meta api_key and collects agent message chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-test-'));
    const script = join(dir, 'fake-devin-acp.mjs');
    writeFileSync(script, `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } });
    return;
  }
  if (msg.method === 'authenticate') {
    if (msg.params?._meta?.api_key !== 'upstream-key') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'bad key' } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'hidden thought' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ACP' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: '_OK' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { totalTokens: 12 } } });
    return;
  }
});
`, 'utf8');

    const savedPath = process.env.DEVIN_CLI_PATH;
    const savedArgs = process.env.DEVIN_CLI_ACP_ARGS_JSON;
    const savedTimeout = process.env.DEVIN_TIMEOUT_MS;
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
    process.env.DEVIN_TIMEOUT_MS = '5000';
    try {
      const result = await runDevinAcp('reply exactly OK', {
        modelKey: 'swe-1.6-fast',
        apiKey: 'upstream-key',
        apiServerUrl: 'https://server.self-serve.windsurf.com',
      });
      assert.equal(result.text, 'ACP_OK');
      assert.equal(result.reasoning, 'hidden thought');
      assert.deepEqual(result.usage, { totalTokens: 12 });
    } finally {
      if (savedPath === undefined) delete process.env.DEVIN_CLI_PATH;
      else process.env.DEVIN_CLI_PATH = savedPath;
      if (savedArgs === undefined) delete process.env.DEVIN_CLI_ACP_ARGS_JSON;
      else process.env.DEVIN_CLI_ACP_ARGS_JSON = savedArgs;
      if (savedTimeout === undefined) delete process.env.DEVIN_TIMEOUT_MS;
      else process.env.DEVIN_TIMEOUT_MS = savedTimeout;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps thought chunks out of the reply and drops unknown update kinds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-thought-'));
    const script = join(dir, 'fake-devin-acp-thought.mjs');
    writeFileSync(script, `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}
function update(u) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } });
}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } });
    return;
  }
  if (msg.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    update({ sessionUpdate: 'agent_thought_chunk', content: { text: 'think-' } });
    update({ sessionUpdate: 'agent_thought_delta', content: { text: 'more' } });
    update({ sessionUpdate: 'tool_call', content: { text: 'IGNORED_TOOL' } });
    update({ sessionUpdate: 'plan', content: { text: 'IGNORED_PLAN' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { text: 'VISIBLE' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
});
`, 'utf8');

    const savedPath = process.env.DEVIN_CLI_PATH;
    const savedArgs = process.env.DEVIN_CLI_ACP_ARGS_JSON;
    const savedTimeout = process.env.DEVIN_TIMEOUT_MS;
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
    process.env.DEVIN_TIMEOUT_MS = '5000';
    try {
      const result = await runDevinAcp('hi', {
        modelKey: 'swe-1.6',
        apiKey: 'upstream-key',
      });
      assert.equal(result.text, 'VISIBLE');
      assert.equal(result.reasoning, 'think-more');
      assert.doesNotMatch(result.text, /IGNORED|think/);
      assert.doesNotMatch(result.reasoning, /IGNORED|VISIBLE/);
    } finally {
      if (savedPath === undefined) delete process.env.DEVIN_CLI_PATH;
      else process.env.DEVIN_CLI_PATH = savedPath;
      if (savedArgs === undefined) delete process.env.DEVIN_CLI_ACP_ARGS_JSON;
      else process.env.DEVIN_CLI_ACP_ARGS_JSON = savedArgs;
      if (savedTimeout === undefined) delete process.env.DEVIN_TIMEOUT_MS;
      else process.env.DEVIN_TIMEOUT_MS = savedTimeout;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
