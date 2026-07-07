import { afterEach, beforeEach, describe, it } from 'node:test';
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
  'DEVIN_ACP_VISION',
  'DEVIN_ACP_EXPOSE_REASONING',
  'WINDSURFAPI_SHOW_DISABLED_SPECIAL_AGENT_MODELS',
  'DEVIN_TIMEOUT_MS',
  'DEVIN_ACP_PING_MS',
  'DEVIN_ACP_PROBE',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const originalModelAccess = getModelAccessConfig();

beforeEach(() => {
  // These routing tests inject a mock ACP runner and never set a real CLI
  // binary, so the new proactive availability probe (default ON) would fork a
  // real `devin --version` that fails on CI. Disable it here so they exercise
  // the unchanged routing/runner path; the probe has dedicated coverage in
  // devin-acp-probe.test.js.
  process.env.DEVIN_ACP_PROBE = '0';
});

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
    assert.match(seenPrompt, /System instructions:\nbe direct/);
    assert.match(seenPrompt, /ship the smallest PoC/);
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
    assert.equal(seenPrompt, 'use ACP');
    assert.equal(released, true);
  });

  it('vision over ACP (DEVIN_ACP_VISION=1): forwards images as a structured prompt', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_ACP_VISION = '1';
    const RED_DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    let seenPrompt = null;
    const result = await handleChatCompletions({
      model: 'swe-1.6-fast',
      messages: [user([
        { type: 'text', text: 'what color?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT}` } },
      ])],
    }, {
      specialAgent: {
        checkoutAccount: () => ({ id: 'a1', apiKey: 'k', apiServerUrl: 'https://x' }),
        runDevinAcp: async (prompt) => { seenPrompt = prompt; return { text: 'red' }; },
        releaseAccount: () => {},
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'red');
    // The runner received a STRUCTURED prompt carrying the image, not a string.
    assert.equal(typeof seenPrompt, 'object', 'prompt is structured when vision is on');
    assert.match(seenPrompt.text, /what color/);
    assert.equal(seenPrompt.images.length, 1);
    assert.equal(seenPrompt.images[0].base64_data, RED_DOT);
    assert.equal(seenPrompt.images[0].mime_type, 'image/png');
  });

  it('vision gate OFF: an image request is still rejected as unsupported media', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    // DEVIN_ACP_VISION unset → images not allowed through
    const RED_DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let runnerCalled = false;
    const result = await handleChatCompletions({
      model: 'swe-1.6-fast',
      messages: [user([
        { type: 'text', text: 'what color?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT}` } },
      ])],
    }, {
      specialAgent: {
        checkoutAccount: () => ({ id: 'a1', apiKey: 'k', apiServerUrl: 'https://x' }),
        runDevinAcp: async () => { runnerCalled = true; return { text: 'x' }; },
        releaseAccount: () => {},
      },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'unsupported_media');
    assert.equal(runnerCalled, false, 'runner not reached when vision gate is off');
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

  it('streams real ACP chunks incrementally as they arrive (onChunk)', async () => {
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
        // A chunking runner: emits three message deltas via onChunk, like real ACP.
        runDevinAcp: async (prompt, opts) => {
          opts.onChunk({ kind: 'message', text: 'Hel' });
          opts.onChunk({ kind: 'message', text: 'lo ' });
          opts.onChunk({ kind: 'message', text: 'world' });
          return { text: 'Hello world' };
        },
      },
    });

    const writes = [];
    const res = { writableEnded: false, write(c) { writes.push(String(c)); }, end() { this.writableEnded = true; } };
    await result.handler(res);

    // Each delta is its own SSE chunk (real streaming, not one buffered blob).
    const contentDeltas = writes
      .filter(w => w.includes('"content"') && !w.includes('"role"'))
      .map(w => JSON.parse(w.replace(/^data: /, '')).choices[0].delta.content);
    assert.deepEqual(contentDeltas, ['Hel', 'lo ', 'world']);
    const joined = writes.join('');
    assert.match(joined, /finish_reason":"stop"/);
    assert.match(joined, /data: \[DONE\]/);
  });

  it('emits a terminal SSE error event when a live ACP stream fails mid-flight', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      model: 'swe-1.6',
      stream: true,
      messages: [user('stream it')],
    }, {
      specialAgent: {
        runDevinAcp: async (prompt, opts) => {
          opts.onChunk({ kind: 'message', text: 'partial' });
          throw Object.assign(new Error('high demand for this model'), { status: 502, type: 'backend_error' });
        },
      },
    });

    const writes = [];
    const res = { writableEnded: false, write(c) { writes.push(String(c)); }, end() { this.writableEnded = true; } };
    await result.handler(res);
    const joined = writes.join('');
    assert.match(joined, /"content":"partial"/); // what arrived before the error is preserved
    assert.match(joined, /"error"/);
    assert.match(joined, /high demand/);
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

  it('streams live ACP chunks through /v1/messages as Anthropic SSE', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleMessages({
      model: 'swe-1.6',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'stream via anthropic' }],
    }, {
      specialAgent: {
        runDevinAcp: async (prompt, opts) => {
          opts.onChunk({ kind: 'message', text: 'Hel' });
          opts.onChunk({ kind: 'message', text: 'lo' });
          return { text: 'Hello' };
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.stream, true);
    const writes = [];
    const res = { writableEnded: false, write(c) { writes.push(String(c)); }, end() { this.writableEnded = true; }, on() {} };
    await result.handler(res);
    const joined = writes.join('');

    // The ACP message chunks must arrive as Anthropic text deltas, framed by
    // the standard event sequence Claude Code expects.
    assert.match(joined, /event: message_start/);
    assert.match(joined, /event: content_block_delta/);
    assert.match(joined, /"text":"Hel"/);
    assert.match(joined, /"text":"lo"/);
    assert.match(joined, /event: message_stop/);
  });

  it('surfaces a mid-stream ACP failure as an Anthropic error event', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleMessages({
      model: 'swe-1.6',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'will fail' }],
    }, {
      specialAgent: {
        runDevinAcp: async (prompt, opts) => {
          opts.onChunk({ kind: 'message', text: 'partial' });
          throw Object.assign(new Error('high demand for this model'), { status: 502, type: 'backend_error' });
        },
      },
    });

    assert.equal(result.status, 200);
    const writes = [];
    const res = { writableEnded: false, write(c) { writes.push(String(c)); }, end() { this.writableEnded = true; }, on() {} };
    await result.handler(res);
    const joined = writes.join('');
    assert.match(joined, /"text":"partial"/); // delivered before the failure
    assert.match(joined, /event: error/);
    assert.match(joined, /high demand/);
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
  it('builds a multi-turn prompt with labeled history and a continuation cue', () => {
    const prompt = buildSpecialAgentPrompt([
      { role: 'system', content: 'system rules' },
      user([{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'x' } }]),
      { role: 'assistant', content: 'prior answer' },
      { role: 'tool', content: 'tool output' },
      user('latest question'),
    ]);
    assert.match(prompt, /System instructions:\nsystem rules/);
    assert.match(prompt, /Conversation so far:/);
    assert.match(prompt, /User:\nhello/);
    assert.match(prompt, /\[image omitted/);
    assert.match(prompt, /Assistant:\nprior answer/);
    assert.match(prompt, /Tool result:\ntool output/);
    // Latest turn is called out separately, and the agent is told to continue.
    assert.match(prompt, /Latest User message:\nlatest question/);
    assert.match(prompt, /Reply as the assistant to the latest message/);
  });

  it('sends a single-turn prompt as plain text (no role labels)', () => {
    const prompt = buildSpecialAgentPrompt([user('just one question')]);
    assert.equal(prompt, 'just one question');
    assert.doesNotMatch(prompt, /User:/);
    assert.doesNotMatch(prompt, /Conversation so far/);
  });

  it('prefixes a single-turn prompt with system instructions but no turn labels', () => {
    const prompt = buildSpecialAgentPrompt([
      { role: 'system', content: 'be terse' },
      user('the question'),
    ]);
    assert.match(prompt, /System instructions:\nbe terse/);
    assert.match(prompt, /the question/);
    assert.doesNotMatch(prompt, /Conversation so far/);
    assert.doesNotMatch(prompt, /Latest User message/);
  });

  it('merges multiple system messages and keeps them out of the turn flow', () => {
    const prompt = buildSpecialAgentPrompt([
      { role: 'system', content: 'rule one' },
      { role: 'system', content: 'rule two' },
      user('first'),
      { role: 'assistant', content: 'ack' },
      user('second'),
    ]);
    assert.match(prompt, /System instructions:\nrule one\n\nrule two/);
    assert.match(prompt, /Latest User message:\nsecond/);
  });

  it('returns an empty string when there are no usable messages', () => {
    assert.equal(buildSpecialAgentPrompt([]), '');
    assert.equal(buildSpecialAgentPrompt([{ role: 'user', content: '   ' }]), '');
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

// Survival trio: SURV-02 (abort wiring), AP-GAP-2 (pool health feedback),
// P0-3 (SSE ping). These are the post-Cascade "don't die" fixes.
describe('special-agent survival hardening', () => {
  // An http.ServerResponse-like mock that supports res.on('close') so abort
  // wiring can be exercised by emitting 'close'.
  function makeRes() {
    const writes = [];
    const listeners = {};
    return {
      writes,
      writableEnded: false,
      write(c) { writes.push(String(c)); return true; },
      end() { this.writableEnded = true; },
      on(ev, fn) { (listeners[ev] ||= []).push(fn); return this; },
      emit(ev) { (listeners[ev] || []).forEach(fn => fn()); },
      joined() { return writes.join(''); },
    };
  }

  it('SURV-02: client disconnect aborts the ACP runner signal', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    let seenSignal = null;
    let abortedDuringRun = false;
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      stream: true,
      messages: [user('long run')],
    }, {
      specialAgent: {
        runDevinAcp: async (_prompt, opts) => {
          seenSignal = opts.signal;
          // Simulate a long run: resolve only after the abort fires.
          await new Promise((resolve) => {
            if (opts.signal.aborted) { abortedDuringRun = true; return resolve(); }
            opts.signal.addEventListener('abort', () => { abortedDuringRun = true; resolve(); }, { once: true });
          });
          return { text: 'late' };
        },
      },
    });

    const res = makeRes();
    const handlerPromise = result.handler(res);
    // Let the handler start the runner, then simulate a client hangup.
    await new Promise(r => setImmediate(r));
    res.emit('close');
    await handlerPromise;

    assert.ok(seenSignal, 'runner received an AbortSignal');
    assert.equal(abortedDuringRun, true, 'client close aborted the runner');
  });

  it('AP-GAP-2: a 429 failure reports the account rate-limited', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'print';

    const calls = [];
    const acct = { apiKey: 'k-429', id: 'acct-1', apiServerUrl: '' };
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user('rate me')],
    }, {
      specialAgent: {
        checkoutAccount: async () => acct,
        releaseAccount: () => calls.push(['release']),
        runDevinPrint: async () => { throw Object.assign(new Error('rate limit exceeded'), { status: 429 }); },
        // Spy hooks injected via the same deps object the handler reads.
        markRateLimited: (key, ms) => calls.push(['markRateLimited', key, ms]),
        reportError: (key) => calls.push(['reportError', key]),
        reportSuccess: (key) => calls.push(['reportSuccess', key]),
      },
    });

    assert.equal(result.status, 429);
    // The handler must have classified the 429 onto the pool.
    assert.ok(calls.some(c => c[0] === 'markRateLimited' && c[1] === 'k-429'),
      `expected markRateLimited for k-429, got ${JSON.stringify(calls)}`);
    assert.ok(!calls.some(c => c[0] === 'reportError'), 'a 429 is not a generic error');
  });

  it('AP-GAP-2: a clean run reports the account healthy', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'print';

    const calls = [];
    const acct = { apiKey: 'k-ok', id: 'acct-2', apiServerUrl: '' };
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user('hi')],
    }, {
      specialAgent: {
        checkoutAccount: async () => acct,
        releaseAccount: () => {},
        runDevinPrint: async () => ({ text: 'OK' }),
        reportSuccess: (key) => calls.push(['reportSuccess', key]),
        reportError: (key) => calls.push(['reportError', key]),
      },
    });

    assert.equal(result.status, 200);
    assert.ok(calls.some(c => c[0] === 'reportSuccess' && c[1] === 'k-ok'),
      `expected reportSuccess for k-ok, got ${JSON.stringify(calls)}`);
  });

  it('AP-GAP-2: a ban-shaped failure reports a ban signal', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'print';

    const calls = [];
    const acct = { apiKey: 'k-ban', id: 'acct-3', apiServerUrl: '' };
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [user('ban me')],
    }, {
      specialAgent: {
        checkoutAccount: async () => acct,
        releaseAccount: () => {},
        runDevinPrint: async () => { throw Object.assign(new Error('Your account has been suspended'), { status: 403 }); },
        reportBanSignal: (key, msg) => calls.push(['reportBanSignal', key, msg]),
        reportError: (key) => calls.push(['reportError', key]),
      },
    });

    assert.equal(result.status, 403);
    assert.ok(calls.some(c => c[0] === 'reportBanSignal' && c[1] === 'k-ban'),
      `expected reportBanSignal for k-ban, got ${JSON.stringify(calls)}`);
  });

  it('P0-3: streamLiveAcp emits an SSE ping comment during a silent run', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';
    process.env.DEVIN_ACP_PING_MS = '10'; // fire fast for the test

    const result = await handleChatCompletions({
      model: 'swe-1.6',
      stream: true,
      messages: [user('think silently')],
    }, {
      specialAgent: {
        runDevinAcp: async () => {
          // Silent for long enough that at least one ping fires.
          await new Promise(r => setTimeout(r, 40));
          return { text: 'done' };
        },
      },
    });

    const res = makeRes();
    await result.handler(res);
    assert.match(res.joined(), /: ping/, 'expected at least one SSE ping comment');
    assert.match(res.joined(), /"content":"done"/);
  });
});

// Batch 2 — streaming correctness: GAP-ACP-05 (onChunk reaches the runner),
// H3 (real ACP usage beats chars/4 estimate), H7 (stop_reason → finish_reason).
describe('special-agent streaming correctness', () => {
  function streamRes() {
    const writes = [];
    return {
      writes,
      writableEnded: false,
      write(c) { writes.push(String(c)); return true; },
      end() { this.writableEnded = true; },
      on() {},
      joined() { return writes.join(''); },
    };
  }

  it('GAP-ACP-05: the live streamer passes onChunk through to the runner', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    let sawOnChunk = false;
    const result = await handleChatCompletions({
      model: 'swe-1.6', stream: true, messages: [user('stream incrementally')],
    }, {
      specialAgent: {
        runDevinAcp: async (_prompt, opts) => {
          // The bug (GAP-ACP-05) was the wrapper dropping onChunk; assert it
          // arrives and that emitting through it lands as a content delta.
          assert.equal(typeof opts.onChunk, 'function', 'runner received onChunk');
          sawOnChunk = true;
          opts.onChunk({ kind: 'message', text: 'piece-1 ' });
          opts.onChunk({ kind: 'message', text: 'piece-2' });
          return { text: 'piece-1 piece-2' };
        },
      },
    });

    const res = streamRes();
    await result.handler(res);
    assert.equal(sawOnChunk, true);
    const joined = res.joined();
    // The two onChunk pieces stream as separate content deltas, before any
    // buffered fallback would have fired.
    assert.match(joined, /"content":"piece-1 "/);
    assert.match(joined, /"content":"piece-2"/);
  });

  it('H3: a live ACP stream bills the runner real usage, not chars/4', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      // O1: usage frame is opt-in; this test asserts its contents.
      model: 'swe-1.6', stream: true, stream_options: { include_usage: true }, messages: [user('hi')],
    }, {
      specialAgent: {
        runDevinAcp: async (_p, opts) => {
          opts.onChunk({ kind: 'message', text: 'ok' });
          return { text: 'ok', usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 } };
        },
      },
    });

    const res = streamRes();
    await result.handler(res);
    const usageFrame = res.writes
      .map(w => { try { return JSON.parse(w.replace(/^data: /, '')); } catch { return null; } })
      .find(o => o && o.usage);
    assert.ok(usageFrame, 'a usage frame was emitted');
    assert.equal(usageFrame.usage.prompt_tokens, 123, 'real input tokens, not chars/4');
    assert.equal(usageFrame.usage.completion_tokens, 456, 'real output tokens, not chars/4');
    assert.equal(usageFrame.usage.total_tokens, 579);
  });

  it('H3: usage falls back to estimation when the runner omits it', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      // O1: usage frame is opt-in; this test asserts its estimated contents.
      model: 'swe-1.6', stream: true, stream_options: { include_usage: true }, messages: [user('hi')],
    }, {
      specialAgent: { runDevinAcp: async (_p, opts) => { opts.onChunk({ kind: 'message', text: 'hello world' }); return { text: 'hello world' }; } },
    });
    const res = streamRes();
    await result.handler(res);
    const usageFrame = res.writes
      .map(w => { try { return JSON.parse(w.replace(/^data: /, '')); } catch { return null; } })
      .find(o => o && o.usage);
    assert.ok(usageFrame.usage.completion_tokens > 0, 'estimated completion tokens are non-zero');
  });

  it('O1: live ACP stream omits the usage frame without include_usage', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      model: 'swe-1.6', stream: true, messages: [user('hi')],
    }, {
      specialAgent: {
        runDevinAcp: async (_p, opts) => {
          opts.onChunk({ kind: 'message', text: 'ok' });
          return { text: 'ok', usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 } };
        },
      },
    });
    const res = streamRes();
    await result.handler(res);
    const usageFrame = res.writes
      .map(w => { try { return JSON.parse(w.replace(/^data: /, '')); } catch { return null; } })
      .find(o => o && o.usage);
    assert.equal(usageFrame, undefined, 'no usage frame emitted by default');
  });

  it('H7: stop_reason=max_tokens maps to finish_reason=length', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      model: 'swe-1.6', stream: true, messages: [user('truncate me')],
    }, {
      specialAgent: { runDevinAcp: async (_p, opts) => { opts.onChunk({ kind: 'message', text: 'cut' }); return { text: 'cut', stopReason: 'max_tokens' }; } },
    });
    const res = streamRes();
    await result.handler(res);
    assert.match(res.joined(), /"finish_reason":"length"/);
    assert.doesNotMatch(res.joined(), /"finish_reason":"stop"/);
  });

  it('H7: tool stop_reason maps to finish_reason=tool_calls', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      model: 'swe-1.6', stream: true, messages: [user('call a tool')],
    }, {
      specialAgent: { runDevinAcp: async (_p, opts) => { opts.onChunk({ kind: 'message', text: 'x' }); return { text: 'x', stopReason: 'tool_use' }; } },
    });
    const res = streamRes();
    await result.handler(res);
    assert.match(res.joined(), /"finish_reason":"tool_calls"/);
  });

  it('H3/H7: non-stream response carries real usage and mapped finish_reason', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    const result = await handleChatCompletions({
      model: 'swe-1.6', messages: [user('no stream')],
    }, {
      specialAgent: {
        runDevinAcp: async () => ({ text: 'done', usage: { input_tokens: 10, output_tokens: 20 }, stopReason: 'end_turn' }),
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.usage.prompt_tokens, 10);
    assert.equal(result.body.usage.completion_tokens, 20);
    assert.equal(result.body.choices[0].finish_reason, 'stop');
  });
});
