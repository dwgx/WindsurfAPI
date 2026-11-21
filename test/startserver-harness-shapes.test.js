import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __setStreamChatForTest, streamChatCompletion } from '../src/devin-connect-openai.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';
import { __resetRequestRingForTest, listRequests } from '../src/dashboard/request-ring.js';

// Q2 gap: protocol translation had unit coverage, but no startServer HTTP
// success test for Messages, Gemini, or Responses, and no full tool loop.
// These are harness-shaped requests, not one-word probes.
const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
for (const key of ENV_KEYS) SAVED[key] = process.env[key];

let server;
let port;
let lastParams = null;
let lastStreamParams = null;
let streamBehavior = 'text';
let nonStreamBehavior = 'tool';

// Deterministic nonce carried in the tool call arguments and echoed back only
// after the fake upstream sees it inside a forwarded tool result.
const STREAM_NONCE = 'NONCE_5f3a91c2';

function nonceFromToolResult(params) {
  for (const message of params?.messages || []) {
    if (message?.role !== 'tool') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content ?? '');
    const match = text.match(/NONCE_[0-9a-f]{8}/);
    if (match) return match[0];
  }
  return null;
}

function sseFrames(body) {
  return body.split(/\r?\n\r?\n/).filter((frame) => frame.trim()).map((frame) => {
    const lines = frame.split(/\r?\n/);
    return {
      event: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? null,
      data: lines.find((line) => line.startsWith('data: '))?.slice(6) ?? null,
    };
  });
}

function protocolFrames(body) {
  return sseFrames(body)
    .filter((frame) => frame.data && frame.data.trim() !== '[DONE]')
    .map((frame) => ({ ...frame, json: JSON.parse(frame.data) }));
}

function chatStreamChunks(body) {
  const frames = sseFrames(body);
  const doneAt = frames.findIndex((frame) => frame.data === '[DONE]');
  assert.ok(doneAt > 0, `chat stream must end with [DONE]: ${body}`);
  assert.equal(doneAt, frames.length - 1, `chat stream has frames after [DONE]: ${body}`);
  return frames.slice(0, doneAt).map((frame) => JSON.parse(frame.data));
}

function assertUpstreamSawToolResult(nonce) {
  assert.ok(lastStreamParams, 'streaming upstream was never called');
  assert.match(JSON.stringify(lastStreamParams.messages), new RegExp(nonce), 'upstream never received the tool result');
}

function completion(message, finish = 'stop') {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-harness',
      object: 'chat.completion',
      created: 0,
      model: 'claude-haiku-5-5-low',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  };
}

before(async () => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  config.apiKey = 'test-harness-key';
  config.host = '127.0.0.1';
  config.port = 0;
  __setConnectDeps({
    toChatCompletion: async (params) => {
      lastParams = params;
      if (nonStreamBehavior === 'text') return completion({ role: 'assistant', content: 'PONG' });
      if (Array.isArray(params.messages) && params.messages.some((m) => m?.role === 'tool')) {
        return completion({ role: 'assistant', content: '22' });
      }
      return completion({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_harness_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        }],
      }, 'tool_calls');
    },
    streamChatCompletion: async (params, send, opts) => {
      lastStreamParams = params;
      if (streamBehavior === 'connect-encoder') return streamChatCompletion(params, send, opts);
      if (streamBehavior === 'nonce') {
        const echoed = nonceFromToolResult(params);
        if (echoed) {
          send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { role: 'assistant', content: `final ${echoed}` }, finish_reason: null }] });
          send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          return { content: `final ${echoed}`, reasoning: '', toolCalls: [], finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
        }
        // Split both the function name and the argument JSON across deltas so
        // the streaming assembler, not a lucky single chunk, has to rebuild them.
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_stream_1', type: 'function', function: { name: 'get_', arguments: '{"city":"Tokyo","nonce":"' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'weather', arguments: `${STREAM_NONCE}"}` } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        return { content: '', reasoning: '', toolCalls: [{ id: 'call_stream_1', name: 'get_weather', arguments: `{"city":"Tokyo","nonce":"${STREAM_NONCE}"}` }], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
      }
      if (streamBehavior === 'parallel') {
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        return { content: '', reasoning: '', toolCalls: [
          { id: 'call_a', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          { id: 'call_b', name: 'get_time', arguments: '{"zone":"UTC"}' },
        ], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
      }
      if (streamBehavior === 'tool') {
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_harness_1', type: 'function', function: { name: 'get_', arguments: '{"city":' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'weather', arguments: '"Tokyo"}' } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        return { content: '', reasoning: '', toolCalls: [{ id: 'call_harness_1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
      }
      send({
        id: 'chatcmpl-harness',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'claude-haiku-5-5-low',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' }, finish_reason: null }],
      });
      send({
        id: 'chatcmpl-harness',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'claude-haiku-5-5-low',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      return { content: 'PONG', reasoning: '', toolCalls: [], finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    },
  });
  server = startServer();
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  port = server.address().port;
});

after(async () => {
  __resetConnectDeps();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

function post(path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-harness-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sseData(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean)
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data) => data && data.trim() !== '[DONE]')
    .map((data) => JSON.parse(data));
}

describe('startServer harness-shaped success paths', () => {
  it('runs a chat tool_call -> tool result -> final answer loop through the real router', async () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }];
    const first = await post('/v1/chat/completions', {
      model: 'claude-haiku-5-5-low',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      tools,
      tool_choice: 'auto',
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    assert.equal(firstBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, 'get_weather');
    assert.equal(firstBody.choices?.[0]?.finish_reason, 'tool_calls');

    const second = await post('/v1/chat/completions', {
      model: 'claude-haiku-5-5-low',
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        { role: 'assistant', content: null, tool_calls: firstBody.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: 'call_harness_1', content: '{"temperature":22,"city":"Tokyo"}' },
        { role: 'user', content: 'What is the temperature? Reply with just the number.' },
      ],
      tools,
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.equal(secondBody.choices?.[0]?.message?.content, '22');
    assert.ok(lastParams, 'upstream received the second turn');
    assert.match(JSON.stringify(lastParams.messages), /temperature/);
  });

  it('forwards a 600 KB harness history through the real router', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'claude-haiku-5-5-low',
      messages: [
        { role: 'system', content: 'You are a coding agent. '.repeat(100) },
        { role: 'user', content: 'x'.repeat(600000) },
      ],
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(lastParams, 'upstream received the long request');
    const size = JSON.stringify(lastParams.messages).length;
    assert.ok(size > 500000, `upstream history was unexpectedly small: ${size}`);
  });

  it('serves Anthropic Messages success through the real router', async () => {
    const res = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    assert.match(body, /message_start/);
    assert.match(body, /PONG/);
  });

  it('serves Responses success through the real router', async () => {
    const res = await post('/v1/responses', {
      model: 'claude-haiku-5-5-low',
      stream: true,
      store: false,
      input: 'Reply with exactly: PONG',
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    assert.match(body, /response\.output_text\.delta/);
    assert.match(body, /PONG/);
  });

  it('streams split tool-call deltas through Anthropic Messages', async () => {
    streamBehavior = 'tool';
    try {
      const res = await post('/v1/messages', {
        model: 'claude-haiku-5-5-low',
        max_tokens: 64,
        stream: true,
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      });
      const body = await res.text();
      assert.equal(res.status, 200, body);
      const starts = body.split('\n\n').filter((frame) => frame.includes('content_block_start'));
      const toolStart = starts.find((frame) => frame.includes('tool_use'));
      assert.ok(toolStart, body);
      assert.match(toolStart, /get_weather/);
      const deltas = body.split('\n\n').filter((frame) => frame.includes('input_json_delta'));
      const json = deltas.map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)).delta.partial_json).join('');
      assert.deepEqual(JSON.parse(json), { city: 'Tokyo' });
      assert.match(body, /"stop_reason":"tool_use"/);
    } finally {
      streamBehavior = 'text';
    }
  });

  it('records Messages and Gemini rows in the request ring with protocol', async () => {
    __resetRequestRingForTest();
    const messages = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    assert.equal(messages.status, 200);
    await messages.text();
    const gemini = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    });
    assert.equal(gemini.status, 200);
    await gemini.text();
    const rows = listRequests({ limit: 20 }).items;
    const protocols = rows.map((row) => row.protocol);
    assert.ok(protocols.includes('messages'), JSON.stringify(protocols));
    assert.ok(protocols.includes('gemini'), JSON.stringify(protocols));
  });

  it('serves Gemini SSE and default array success through the real router', async () => {
    const req = {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    };
    const sse = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', req);
    const sseBody = await sse.text();
    assert.equal(sse.status, 200, sseBody);
    assert.match(sseBody, /data:/);
    assert.match(sseBody, /PONG/);

    const array = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent', req);
    const arrayBody = await array.text();
    assert.equal(array.status, 200, arrayBody);
    const parsed = JSON.parse(arrayBody);
    assert.ok(Array.isArray(parsed), 'default Gemini stream is a JSON array');
    assert.match(arrayBody, /PONG/);
  });

  it('serves non-stream success for Messages, Responses, and Gemini', async () => {
    nonStreamBehavior = 'text';
    try {
    const messages = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low', max_tokens: 16, stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    const messagesBody = await messages.json();
    assert.equal(messages.status, 200, JSON.stringify(messagesBody));
    assert.equal(messagesBody.content?.[0]?.type, 'text');
    assert.match(messagesBody.content?.[0]?.text || '', /PONG/);

    const responses = await post('/v1/responses', {
      model: 'claude-haiku-5-5-low', stream: false, store: false,
      input: 'Reply with exactly: PONG',
    });
    const responsesBody = await responses.json();
    assert.equal(responses.status, 200, JSON.stringify(responsesBody));
    assert.match(JSON.stringify(responsesBody.output), /PONG/);

    const gemini = await post('/v1beta/models/claude-haiku-5-5-low:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    });
    const geminiBody = await gemini.json();
    assert.equal(gemini.status, 200, JSON.stringify(geminiBody));
    assert.match(JSON.stringify(geminiBody.candidates), /PONG/);
    } finally {
      nonStreamBehavior = 'tool';
    }
  });

  it('runs a Responses function_call -> function_call_output -> final answer loop', async () => {
    const tools = [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
    const first = await post('/v1/responses', {
      model: 'claude-haiku-5-5-low', stream: false, store: false,
      input: 'What is the weather in Tokyo?', tools,
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    const call = firstBody.output?.find((item) => item.type === 'function_call');
    assert.ok(call, JSON.stringify(firstBody));
    assert.equal(call.name, 'get_weather');

    const second = await post('/v1/responses', {
      model: 'claude-haiku-5-5-low', stream: false, store: false,
      input: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: '{"temperature":22}' },
        { role: 'user', content: 'Reply with just the number.' },
      ],
      tools,
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.match(JSON.stringify(secondBody.output), /22/);
    assert.match(JSON.stringify(lastParams.messages), /temperature/);
  });

  it('runs a Messages tool_use -> tool_result -> final answer loop', async () => {
    const tools = [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];
    const first = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low', max_tokens: 64, stream: false,
      tools, messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    const call = firstBody.content?.find((block) => block.type === 'tool_use');
    assert.ok(call, JSON.stringify(firstBody));
    assert.equal(call.name, 'get_weather');

    const second = await post('/v1/messages', {
      model: 'claude-haiku-5-5-low', max_tokens: 64, stream: false, tools,
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: '{"temperature":22}' }] },
        { role: 'user', content: 'Reply with just the number.' },
      ],
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.match(JSON.stringify(secondBody.content), /22/);
    assert.match(JSON.stringify(lastParams.messages), /temperature/);
  });

  it('runs a Gemini functionCall -> functionResponse -> final answer loop', async () => {
    const tools = [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }] }];
    const first = await post('/v1beta/models/claude-haiku-5-5-low:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] }], tools,
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    const call = firstBody.candidates?.[0]?.content?.parts?.find((part) => part.functionCall)?.functionCall;
    assert.ok(call, JSON.stringify(firstBody));
    assert.equal(call.name, 'get_weather');

    const second = await post('/v1beta/models/claude-haiku-5-5-low:generateContent', {
      contents: [
        { role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] },
        { role: 'model', parts: [{ functionCall: { name: call.name, args: call.args } }] },
        { role: 'user', parts: [{ functionResponse: { name: call.name, response: { temperature: 22 } } }] },
        { role: 'user', parts: [{ text: 'Reply with just the number.' }] },
      ], tools,
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.match(JSON.stringify(secondBody.candidates), /22/);
    assert.match(JSON.stringify(lastParams.messages), /temperature/);
  });

  it('settles split tool names in Responses and Gemini streams', async () => {
    streamBehavior = 'tool';
    try {
      const responses = await post('/v1/responses', {
        model: 'claude-haiku-5-5-low', stream: true, store: false,
        input: 'What is the weather in Tokyo?',
        tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      });
      const responsesBody = await responses.text();
      assert.equal(responses.status, 200, responsesBody);
      const added = sseData(responsesBody).find((e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      assert.equal(added?.item?.name, 'get_weather', responsesBody);

      const gemini = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
        contents: [{ role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] }],
        tools: [{ functionDeclarations: [{ name: 'get_weather' }] }],
      });
      const geminiBody = await gemini.text();
      assert.equal(gemini.status, 200, geminiBody);
      const call = sseData(geminiBody)
        .flatMap((frame) => frame.candidates?.[0]?.content?.parts || [])
        .find((part) => part.functionCall)?.functionCall;
      assert.equal(call?.name, 'get_weather', geminiBody);
    } finally {
      streamBehavior = 'text';
    }
  });

  it('keeps parallel tool calls distinct in Responses and Gemini streams', async () => {
    streamBehavior = 'parallel';
    try {
      const responses = await post('/v1/responses', {
        model: 'claude-haiku-5-5-low', stream: true, store: false, input: 'Use both tools',
        tools: [
          { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
          { type: 'function', name: 'get_time', parameters: { type: 'object' } },
        ],
      });
      const responsesBody = await responses.text();
      assert.equal(responses.status, 200, responsesBody);
      const responseCalls = sseData(responsesBody)
        .filter((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call')
        .map((e) => e.item.name);
      assert.deepEqual(responseCalls, ['get_weather', 'get_time'], responsesBody);

      const gemini = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
        contents: [{ role: 'user', parts: [{ text: 'Use both tools' }] }],
        tools: [{ functionDeclarations: [{ name: 'get_weather' }, { name: 'get_time' }] }],
      });
      const geminiBody = await gemini.text();
      assert.equal(gemini.status, 200, geminiBody);
      const geminiCalls = sseData(geminiBody)
        .flatMap((frame) => frame.candidates?.[0]?.content?.parts || [])
        .filter((part) => part.functionCall)
        .map((part) => part.functionCall.name);
      assert.deepEqual(geminiCalls, ['get_weather', 'get_time'], geminiBody);
    } finally {
      streamBehavior = 'text';
    }
  });

  // The four tool loops above run with stream:false, while real harness lanes
  // stream every turn. These lock the streaming two-turn path: turn 1 emits a
  // tool call carrying STREAM_NONCE, turn 2 sends the nonce back inside the
  // tool result, and the fake upstream only echoes a nonce it actually found
  // in a forwarded `role:"tool"` message — so the final answer proves causal
  // use of the result, not merely that the nonce appeared somewhere.
  it('runs a streaming chat tool_call -> tool result -> final answer loop', async () => {
    streamBehavior = 'nonce';
    try {
      const tools = [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' }, nonce: { type: 'string' } } },
        },
      }];
      const first = await post('/v1/chat/completions', {
        model: 'claude-haiku-5-5-low',
        stream: true,
        messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
        tools,
        tool_choice: 'auto',
      });
      const firstBody = await first.text();
      assert.equal(first.status, 200, firstBody);
      const chunks = chatStreamChunks(firstBody);
      assert.ok(chunks.length >= 2, firstBody);
      for (const chunk of chunks) {
        assert.equal(chunk.object, 'chat.completion.chunk', JSON.stringify(chunk));
        assert.equal(chunk.choices?.length, 1, JSON.stringify(chunk));
      }
      const calls = [];
      let terminalAt = -1;
      chunks.forEach((chunk, index) => {
        const choice = chunk.choices[0];
        if (choice.finish_reason != null) {
          assert.equal(terminalAt, -1, `chat stream has more than one terminal chunk: ${firstBody}`);
          terminalAt = index;
        }
        for (const delta of choice.delta?.tool_calls || []) {
          const slot = delta.index ?? 0;
          calls[slot] ||= { id: '', name: '', arguments: '' };
          if (delta.id) calls[slot].id += delta.id;
          if (delta.function?.name) calls[slot].name += delta.function.name;
          if (delta.function?.arguments) calls[slot].arguments += delta.function.arguments;
        }
      });
      assert.equal(terminalAt, chunks.length - 1, `finish_reason chunk must be last before [DONE]: ${firstBody}`);
      assert.equal(chunks[terminalAt].choices[0].finish_reason, 'tool_calls');
      assert.equal(calls.length, 1, firstBody);
      assert.equal(calls[0].id, 'call_stream_1');
      assert.equal(calls[0].name, 'get_weather');
      const args = JSON.parse(calls[0].arguments);
      assert.deepEqual(args, { city: 'Tokyo', nonce: STREAM_NONCE });

      const second = await post('/v1/chat/completions', {
        model: 'claude-haiku-5-5-low',
        stream: true,
        tools,
        messages: [
          { role: 'user', content: 'What is the weather in Tokyo?' },
          { role: 'assistant', content: null, tool_calls: [{ id: calls[0].id, type: 'function', function: { name: calls[0].name, arguments: calls[0].arguments } }] },
          { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ temperature: 22, nonce: args.nonce }) },
          { role: 'user', content: 'Use the tool result. Reply with the nonce.' },
        ],
      });
      const secondBody = await second.text();
      assert.equal(second.status, 200, secondBody);
      const secondChunks = chatStreamChunks(secondBody);
      const text = secondChunks.map((chunk) => chunk.choices[0].delta?.content || '').join('');
      assert.match(text, new RegExp(args.nonce), `final chat answer did not use the tool result: ${secondBody}`);
      assert.ok(!secondChunks.some((chunk) => chunk.choices[0].delta?.tool_calls), `final turn must be text, not another tool call: ${secondBody}`);
      assert.equal(secondChunks.at(-1).choices[0].finish_reason, 'stop');
      assertUpstreamSawToolResult(args.nonce);
    } finally {
      streamBehavior = 'text';
    }
  });

  it('runs a streaming Messages tool_use -> tool_result -> final answer loop', async () => {
    streamBehavior = 'nonce';
    try {
      const tools = [{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' }, nonce: { type: 'string' } } },
      }];
      const first = await post('/v1/messages', {
        model: 'claude-haiku-5-5-low', max_tokens: 64, stream: true, tools,
        messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      });
      const firstBody = await first.text();
      assert.equal(first.status, 200, firstBody);
      const rawFrames = sseFrames(firstBody);
      assert.equal(rawFrames.at(-1).event, 'message_stop', `message_stop must be the final frame: ${firstBody}`);
      assert.ok(!rawFrames.some((frame) => frame.data === '[DONE]'), `Messages streams must not carry an OpenAI [DONE]: ${firstBody}`);
      const frames = protocolFrames(firstBody);
      assert.ok(frames.length >= 6, firstBody);
      assert.equal(frames[0].event, 'message_start');
      assert.equal(frames.at(-1).event, 'message_stop');
      for (const frame of frames) {
        assert.ok(frame.event, `Messages frame is missing its event name: ${frame.data}`);
        assert.equal(frame.json.type, frame.event, `event/data type mismatch: ${frame.data}`);
      }
      const startAt = frames.findIndex((frame) => frame.event === 'content_block_start' && frame.json.content_block?.type === 'tool_use');
      assert.ok(startAt > 0, firstBody);
      const block = frames[startAt].json.content_block;
      const blockIndex = frames[startAt].json.index;
      assert.equal(block.name, 'get_weather');
      assert.ok(block.id, firstBody);
      const argDeltas = frames.filter((frame) => frame.event === 'content_block_delta' && frame.json.delta?.type === 'input_json_delta');
      assert.ok(argDeltas.length >= 1, firstBody);
      const inputJson = argDeltas.map((frame) => frame.json.delta.partial_json).join('');
      const input = JSON.parse(inputJson);
      assert.deepEqual(input, { city: 'Tokyo', nonce: STREAM_NONCE });
      const stopAt = frames.findIndex((frame) => frame.event === 'content_block_stop' && frame.json.index === blockIndex);
      const deltaAt = frames.findIndex((frame) => frame.event === 'message_delta');
      assert.ok(startAt < frames.indexOf(argDeltas[0]), `tool_use block must start before its input deltas: ${firstBody}`);
      assert.ok(frames.indexOf(argDeltas.at(-1)) < stopAt, `input deltas must precede content_block_stop: ${firstBody}`);
      assert.ok(stopAt < deltaAt, `content_block_stop must precede message_delta: ${firstBody}`);
      assert.equal(frames[deltaAt].json.delta.stop_reason, 'tool_use');
      assert.equal(deltaAt, frames.length - 2, `message_delta must directly precede message_stop: ${firstBody}`);

      const second = await post('/v1/messages', {
        model: 'claude-haiku-5-5-low', max_tokens: 64, stream: true, tools,
        messages: [
          { role: 'user', content: 'What is the weather in Tokyo?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: block.id, name: block.name, input }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ temperature: 22, nonce: input.nonce }) },
              { type: 'text', text: 'Use the tool result. Reply with the nonce.' },
            ],
          },
        ],
      });
      const secondBody = await second.text();
      assert.equal(second.status, 200, secondBody);
      const secondFrames = protocolFrames(secondBody);
      const secondRaw = sseFrames(secondBody);
      assert.equal(secondRaw.at(-1).event, 'message_stop', `message_stop must be the final frame: ${secondBody}`);
      assert.ok(!secondRaw.some((frame) => frame.data === '[DONE]'), `Messages streams must not carry an OpenAI [DONE]: ${secondBody}`);
      assert.equal(secondFrames[0].event, 'message_start');
      assert.equal(secondFrames.at(-1).event, 'message_stop');
      const text = secondFrames
        .filter((frame) => frame.event === 'content_block_delta' && frame.json.delta?.type === 'text_delta')
        .map((frame) => frame.json.delta.text)
        .join('');
      assert.match(text, new RegExp(input.nonce), `final Messages answer did not use the tool result: ${secondBody}`);
      assert.ok(!secondFrames.some((frame) => frame.json.content_block?.type === 'tool_use'), `final turn must be text, not another tool_use: ${secondBody}`);
      const secondDeltaAt = secondFrames.findIndex((frame) => frame.event === 'message_delta');
      assert.equal(secondFrames[secondDeltaAt].json.delta.stop_reason, 'end_turn');
      assert.equal(secondDeltaAt, secondFrames.length - 2);
      assertUpstreamSawToolResult(input.nonce);
    } finally {
      streamBehavior = 'text';
    }
  });

  it('runs a streaming Responses function_call -> function_call_output -> final answer loop', async () => {
    streamBehavior = 'nonce';
    try {
      const tools = [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' }, nonce: { type: 'string' } } } }];
      const first = await post('/v1/responses', {
        model: 'claude-haiku-5-5-low', stream: true, store: false,
        input: 'What is the weather in Tokyo?', tools,
      });
      const firstBody = await first.text();
      assert.equal(first.status, 200, firstBody);
      const frames = protocolFrames(firstBody);
      assert.equal(frames[0].event, 'response.created');
      for (const frame of frames) {
        assert.ok(frame.event?.startsWith('response.'), `Responses frame has a foreign event name: ${frame.data}`);
        assert.equal(frame.json.type, frame.event, `event/data type mismatch: ${frame.data}`);
      }
      const completed = frames.filter((frame) => frame.event === 'response.completed');
      assert.equal(completed.length, 1, firstBody);
      assert.equal(frames.at(-1).event, 'response.completed', `response.completed must be the terminal protocol event: ${firstBody}`);
      const seqs = frames.map((frame) => frame.json.sequence_number);
      for (let i = 1; i < seqs.length; i += 1) {
        assert.ok(seqs[i] > seqs[i - 1], `sequence_number must increase: ${seqs.join(',')}`);
      }
      const added = frames.find((frame) => frame.event === 'response.output_item.added' && frame.json.item?.type === 'function_call');
      assert.ok(added, firstBody);
      const callId = added.json.item.call_id;
      assert.ok(callId, firstBody);
      assert.equal(added.json.item.name, 'get_weather');
      const argDeltas = frames
        .filter((frame) => frame.event === 'response.function_call_arguments.delta')
        .map((frame) => frame.json.delta)
        .join('');
      const args = JSON.parse(argDeltas);
      assert.deepEqual(args, { city: 'Tokyo', nonce: STREAM_NONCE });
      const argDone = frames.find((frame) => frame.event === 'response.function_call_arguments.done');
      assert.equal(argDone.json.arguments, argDeltas);
      const itemDone = frames.find((frame) => frame.event === 'response.output_item.done' && frame.json.item?.type === 'function_call');
      assert.equal(itemDone.json.item.call_id, callId);
      assert.equal(itemDone.json.item.name, 'get_weather');
      assert.equal(itemDone.json.item.arguments, argDeltas);
      assert.equal(completed[0].json.response.output.find((item) => item.type === 'function_call')?.call_id, callId);
      assert.equal(sseFrames(firstBody).at(-1).data, '[DONE]', `[DONE] must follow response.completed: ${firstBody}`);

      const second = await post('/v1/responses', {
        model: 'claude-haiku-5-5-low', stream: true, store: false, tools,
        input: [
          { role: 'user', content: 'What is the weather in Tokyo?' },
          { type: 'function_call', call_id: callId, name: 'get_weather', arguments: argDeltas },
          { type: 'function_call_output', call_id: callId, output: JSON.stringify({ temperature: 22, nonce: args.nonce }) },
          { role: 'user', content: 'Use the tool result. Reply with the nonce.' },
        ],
      });
      const secondBody = await second.text();
      assert.equal(second.status, 200, secondBody);
      const secondFrames = protocolFrames(secondBody);
      assert.equal(secondFrames.at(-1).event, 'response.completed');
      const text = secondFrames
        .filter((frame) => frame.event === 'response.output_text.delta')
        .map((frame) => frame.json.delta)
        .join('');
      assert.match(text, new RegExp(args.nonce), `final Responses answer did not use the tool result: ${secondBody}`);
      assert.ok(!secondFrames.some((frame) => frame.json.item?.type === 'function_call'), `final turn must be text, not another function_call: ${secondBody}`);
      assert.equal(secondFrames.at(-1).json.response.status, 'completed');
      assertUpstreamSawToolResult(args.nonce);
    } finally {
      streamBehavior = 'text';
    }
  });

  it('replays a namespaced Responses call produced by the Connect encoder with its tool output', async () => {
    const namespace = 'mcp__fixture';
    const toolName = 'mcp__fixture__echo';
    const callId = 'call_fixture_echo';
    const args = { text: 'fixture query' };
    const callUsage = { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 };
    const answerUsage = { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 };
    const tools = [{
      type: 'namespace',
      name: namespace,
      tools: [{ type: 'function', name: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
    }];
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use the echo tool.' }] }];
    const body = { model: 'swe-1-6-slow', stream: true, store: false, tool_choice: 'auto', tools };
    const expectedOutput = 'fixture tool returned a value';
    const calls = [];

    streamBehavior = 'connect-encoder';
    __setStreamChatForTest(async function* (params) {
      calls.push(params);
      const result = params.messages.find((message) => message.role === 'tool');
      if (result) {
        yield { type: 'content', text: result.content };
        yield { type: 'finish', reason: 'stop', usage: answerUsage };
        return;
      }
      yield {
        type: 'finish',
        reason: 'stop',
        usage: callUsage,
        toolCalls: [{ id: callId, name: toolName, arguments: JSON.stringify(args) }],
      };
    });

    async function stream(inputItems, expectedUsage) {
      const response = await post('/v1/responses', { ...body, input: inputItems });
      const wire = await response.text();
      assert.equal(response.status, 200, wire);
      const events = protocolFrames(wire);
      const completed = events.at(-1);
      assert.equal(completed.event, 'response.completed', wire);
      assert.equal(completed.json.response.status, 'completed');
      assert.equal(sseFrames(wire).at(-1).data, '[DONE]');
      const { input_tokens, output_tokens, total_tokens } = completed.json.response.usage;
      assert.deepEqual([input_tokens, output_tokens, total_tokens],
        [expectedUsage.prompt_tokens, expectedUsage.completion_tokens, expectedUsage.total_tokens]);
      return events;
    }

    try {
      const first = await stream(input, callUsage);
      const adds = first.filter((frame) => frame.event === 'response.output_item.added');
      assert.deepEqual(adds.map(({ json: { item } }) => [item.type, item.name, item.namespace, item.call_id]),
        [['function_call', 'echo', namespace, callId]]);
      const call = first.find((frame) => frame.event === 'response.output_item.done').json.item;
      assert.equal(call.call_id, callId);
      assert.ok(call.id);
      assert.equal(call.status, 'completed');
      assert.deepEqual(JSON.parse(call.arguments), args);
      // Codex CLI 0.169.0 replays the completed call alongside its result with store:false.
      const second = await stream([
        ...input,
        call,
        { type: 'function_call_output', call_id: call.call_id, output: expectedOutput },
      ], answerUsage);
      const finalText = second.filter((frame) => frame.event === 'response.output_text.delta')
        .map((frame) => frame.json.delta).join('');
      assert.equal(finalText, expectedOutput);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].toolChoice, 'auto');
      assert.deepEqual(calls[0].tools.map((tool) => tool.function.name), [toolName]);
      const history = calls[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
      assert.deepEqual(history.tool_calls, [
        { id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } },
      ]);
      assert.equal(calls[1].messages.find((message) => message.role === 'tool').tool_call_id, callId);
    } finally {
      __setStreamChatForTest(null);
      streamBehavior = 'text';
    }
  });

  it('runs a streaming Gemini functionCall -> functionResponse -> final answer loop', async () => {
    streamBehavior = 'nonce';
    try {
      const tools = [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' }, nonce: { type: 'string' } } } }] }];
      const first = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
        contents: [{ role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] }],
        tools,
      });
      const firstBody = await first.text();
      assert.equal(first.status, 200, firstBody);
      assert.ok(!sseFrames(firstBody).some((frame) => frame.data === '[DONE]'), `Gemini SSE must not carry an OpenAI [DONE]: ${firstBody}`);
      const frames = protocolFrames(firstBody).map((frame) => frame.json);
      assert.ok(frames.length >= 1, firstBody);
      for (const frame of frames) {
        assert.ok(Array.isArray(frame.candidates) && frame.candidates.length === 1, `Gemini frame has no candidate: ${JSON.stringify(frame)}`);
      }
      const call = frames.flatMap((frame) => frame.candidates[0].content?.parts || []).find((part) => part.functionCall)?.functionCall;
      assert.ok(call, firstBody);
      assert.equal(call.name, 'get_weather');
      assert.ok(call.id, firstBody);
      assert.deepEqual(call.args, { city: 'Tokyo', nonce: STREAM_NONCE });
      assert.equal(frames.at(-1).candidates[0].finishReason, 'STOP');
      assert.ok(frames.slice(0, -1).every((frame) => frame.candidates[0].finishReason == null), `finishReason must be terminal: ${firstBody}`);

      const second = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
        contents: [
          { role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] },
          { role: 'model', parts: [{ functionCall: { name: call.name, args: call.args } }] },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: call.name, response: { temperature: 22, nonce: call.args.nonce } } },
              { text: 'Use the tool result. Reply with the nonce.' },
            ],
          },
        ],
        tools,
      });
      const secondBody = await second.text();
      assert.equal(second.status, 200, secondBody);
      assert.ok(!sseFrames(secondBody).some((frame) => frame.data === '[DONE]'), `Gemini SSE must not carry an OpenAI [DONE]: ${secondBody}`);
      const secondFrames = protocolFrames(secondBody).map((frame) => frame.json);
      const parts = secondFrames.flatMap((frame) => frame.candidates[0].content?.parts || []);
      const text = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('');
      assert.match(text, new RegExp(call.args.nonce), `final Gemini answer did not use the tool result: ${secondBody}`);
      assert.ok(!parts.some((part) => part.functionCall), `final turn must be text, not another functionCall: ${secondBody}`);
      assert.equal(secondFrames.at(-1).candidates[0].finishReason, 'STOP');
      assert.ok(secondFrames.slice(0, -1).every((frame) => frame.candidates[0].finishReason == null));
      assertUpstreamSawToolResult(call.args.nonce);
    } finally {
      streamBehavior = 'text';
    }
  });

  it('carries OpenAI and Anthropic user images through the real router', async () => {
    nonStreamBehavior = 'text';
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    try {
      const chat = await post('/v1/chat/completions', {
        model: 'claude-haiku-5-5-low', stream: false,
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        ] }],
      });
      const chatBody = await chat.json();
      assert.equal(chat.status, 200, JSON.stringify(chatBody));
      assert.match(JSON.stringify(lastParams.messages), /image_url/);

      const messages = await post('/v1/messages', {
        model: 'claude-haiku-5-5-low', max_tokens: 16, stream: false,
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ] }],
      });
      const messagesBody = await messages.json();
      assert.equal(messages.status, 200, JSON.stringify(messagesBody));
      assert.match(JSON.stringify(lastParams.messages), /image_url/);
    } finally {
      nonStreamBehavior = 'tool';
    }
  });

});
