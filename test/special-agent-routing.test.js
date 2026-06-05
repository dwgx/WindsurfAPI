import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { getModelInfo, resolveModel } from '../src/models.js';
import {
  getModelAccessConfig,
  setModelAccessList,
  setModelAccessMode,
} from '../src/dashboard/model-access.js';
import {
  buildSpecialAgentPrompt,
  getSpecialAgentStatus,
  isSpecialAgentModelInfo,
} from '../src/special-agent.js';

const ENV_KEYS = [
  'WINDSURFAPI_SPECIAL_AGENT_BACKEND',
  'DEVIN_CLI_ENABLED',
  'DEVIN_CLI_PATH',
  'DEVIN_CLI_ARGS_JSON',
  'DEVIN_CLI_USE_ACCOUNT_POOL',
  'DEVIN_CLI_ALLOW_CLIENT_TOOLS',
  'DEVIN_CLI_ALLOW_MEDIA',
  'DEVIN_CLI_MODE',
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
});
