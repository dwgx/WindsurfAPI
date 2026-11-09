/**
 * Four-family transport matrix: OpenAI chat, Anthropic Messages, OpenAI
 * Responses and Gemini, each in stream and non-stream form, with tool-call and
 * image cases where the translators support them.
 *
 * Everything runs through the REAL `startServer` router and the real protocol
 * translators; only the connect network hop is scripted via `__setConnectDeps`
 * (the same seam `test/startserver-harness-shapes.test.js` uses). No socket
 * leaves the process.
 *
 * The suite prints two tables when it finishes:
 *   - every flow with status / content-type / frame count / terminal frame
 *   - p50/p95 wall time and request/response bytes for 1 KB, 64 KB, 1 MB
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';
import {
  PNG_DATA_URL,
  TOOL_CALL,
  TRANSPORT_MODEL,
  TRANSPORT_SECRETS,
  byteLength,
  createScriptedUpstream,
  formatTable,
  jsonFrames,
  sseFrames,
  summarize,
} from './transport-matrix.helpers.mjs';

const CLIENT_KEY = TRANSPORT_SECRETS[0].value;
const CONNECT_TOKEN = TRANSPORT_SECRETS[1].value;
const ANTHROPIC_HEADERS = { 'anthropic-version': '2023-06-01' };

const SAVED_ENV = {};
for (const key of ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY']) SAVED_ENV[key] = process.env[key];

const upstream = createScriptedUpstream();
const FLOWS = [];
const BODIES = [];
const METRICS = [];
let server;
let port;

before(async () => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  config.apiKey = CLIENT_KEY;
  config.host = '127.0.0.1';
  config.port = 0;
  __setConnectDeps(upstream.deps);
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
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Print first so a leak still leaves the diagnostic tables in the log.
  printTables();
  // Secret scan across every body this suite received. Both values are
  // synthetic, so a hit is always a real egress leak, never fixture noise.
  for (const { label, value } of TRANSPORT_SECRETS) {
    for (const body of BODIES) {
      assert.ok(!body.includes(value), `response body leaked ${label}: ${body.slice(0, 200)}`);
    }
  }
});

beforeEach(() => {
  upstream.state.scenario = 'text';
});

// ── request + recording ──────────────────────────────────────────────

async function call(path, body, headers = {}) {
  const raw = JSON.stringify(body);
  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CLIENT_KEY}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: raw,
  });
  const text = await res.text();
  const ms = performance.now() - started;
  BODIES.push(text);
  return {
    res,
    text,
    ms,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    reqBytes: byteLength(raw),
    respBytes: byteLength(text),
  };
}

function recordFlow(family, mode, testCase, result, { frames = 1, terminal = '-' } = {}) {
  FLOWS.push({
    family,
    mode,
    case: testCase,
    status: result.status,
    contentType: result.contentType.split(';')[0],
    frames,
    terminal,
    bytes: result.respBytes,
    ms: result.ms.toFixed(1),
  });
}

function assertJson(result) {
  assert.equal(result.status, 200, result.text);
  assert.match(result.contentType, /^application\/json\b/, result.contentType);
  return JSON.parse(result.text);
}

function assertSse(result) {
  assert.equal(result.status, 200, result.text);
  assert.match(result.contentType, /^text\/event-stream\b/, result.contentType);
}

function assertSingleDone(frames) {
  assert.equal(frames.filter((frame) => frame.data === '[DONE]').length, 1, 'exactly one [DONE]');
  assert.equal(frames.at(-1).data, '[DONE]', '[DONE] must be the final frame');
}

/** Match every content_block_start with exactly one stop of the same index. */
function assertBlockPairs(frames) {
  const starts = frames.filter((frame) => frame.event === 'content_block_start');
  const stops = frames.filter((frame) => frame.event === 'content_block_stop');
  assert.equal(starts.length, stops.length, 'every content block must be closed');
  const startIndexes = starts.map((frame) => frame.json.index);
  assert.equal(new Set(startIndexes).size, startIndexes.length, 'duplicate content_block_start index');
  for (const frame of starts) {
    assert.equal(
      stops.filter((stop) => stop.json.index === frame.json.index).length,
      1,
      `content_block ${frame.json.index} must stop exactly once`,
    );
  }
}

/** Every content_block_delta must land inside an open block, in order. */
function assertDeltaContainment(frames) {
  const ranges = new Map();
  frames.forEach((frame, index) => {
    if (frame.event === 'content_block_start') ranges.set(frame.json.index, { start: index, stop: Infinity });
    if (frame.event === 'content_block_stop') {
      const range = ranges.get(frame.json.index);
      assert.ok(range, `content_block_stop without a start: ${frame.json.index}`);
      range.stop = index;
    }
  });
  frames.forEach((frame, index) => {
    if (frame.event !== 'content_block_delta') return;
    const range = ranges.get(frame.json.index);
    assert.ok(range, `delta for an unopened block: ${frame.json.index}`);
    assert.ok(index > range.start && index < range.stop, `delta outside block ${frame.json.index}`);
  });
}

function parseChatToolCalls(chunks) {
  const calls = [];
  for (const chunk of chunks) {
    for (const delta of chunk.choices?.[0]?.delta?.tool_calls || []) {
      const slot = delta.index ?? 0;
      calls[slot] ||= { id: '', name: '', arguments: '' };
      if (delta.id) calls[slot].id += delta.id;
      if (delta.function?.name) calls[slot].name += delta.function.name;
      if (delta.function?.arguments) calls[slot].arguments += delta.function.arguments;
    }
  }
  return calls;
}

function chatText(chunks) {
  return chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || '').join('');
}

function printTables() {
  console.log('\nTRANSPORT MATRIX — FLOWS');
  console.log(formatTable(FLOWS, [
    { key: 'family', label: 'family' },
    { key: 'mode', label: 'mode' },
    { key: 'case', label: 'case' },
    { key: 'status', label: 'status' },
    { key: 'contentType', label: 'content-type' },
    { key: 'frames', label: 'frames' },
    { key: 'terminal', label: 'terminal' },
    { key: 'bytes', label: 'resp bytes' },
    { key: 'ms', label: 'wall ms' },
  ]));
  console.log('\nTRANSPORT MATRIX — LATENCY / BYTES (stream)');
  console.log(formatTable(METRICS, [
    { key: 'size', label: 'prompt' },
    { key: 'family', label: 'family' },
    { key: 'n', label: 'n' },
    { key: 'p50', label: 'p50 ms' },
    { key: 'p95', label: 'p95 ms' },
    { key: 'reqBytes', label: 'req bytes' },
    { key: 'respBytes', label: 'resp bytes' },
  ]));
}

// ── OpenAI chat ──────────────────────────────────────────────────────

describe('OpenAI chat /v1/chat/completions', () => {
  it('non-stream text', async () => {
    const result = await call('/v1/chat/completions', {
      model: TRANSPORT_MODEL,
      stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    const body = assertJson(result);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].message.content, 'PONG');
    assert.equal(body.choices[0].finish_reason, 'stop');
    recordFlow('openai-chat', 'non-stream', 'text', result, { terminal: 'finish_reason:stop' });
  });

  it('stream text', async () => {
    const result = await call('/v1/chat/completions', {
      model: TRANSPORT_MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    assertSse(result);
    const frames = sseFrames(result.text);
    assertSingleDone(frames);
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame.data));
    assert.ok(chunks.length >= 2, result.text);
    for (const chunk of chunks) {
      assert.equal(chunk.object, 'chat.completion.chunk', result.text);
      assert.equal(chunk.choices.length, 1, result.text);
    }
    const terminals = chunks.filter((chunk) => chunk.choices[0].finish_reason != null);
    assert.equal(terminals.length, 1, 'exactly one terminal chunk');
    assert.equal(chunks.at(-1), terminals[0], 'terminal chunk must be last before [DONE]');
    assert.equal(terminals[0].choices[0].finish_reason, 'stop');
    assert.equal(chatText(chunks), 'PONG', 'assembled text must be exact');
    recordFlow('openai-chat', 'stream', 'text', result, { frames: frames.length, terminal: '[DONE]' });
  });

  it('non-stream tool call JSON is parseable', async () => {
    upstream.state.scenario = 'tool';
    const result = await call('/v1/chat/completions', {
      model: TRANSPORT_MODEL,
      stream: false,
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });
    const body = assertJson(result);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    const calls = body.choices[0].message.tool_calls;
    assert.equal(calls.length, 1, result.text);
    assert.equal(calls[0].function.name, TOOL_CALL.name);
    assert.ok(calls[0].id, 'tool call id must survive');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: 'Tokyo', unit: 'c' });
    recordFlow('openai-chat', 'non-stream', 'tool-call', result, { terminal: 'finish_reason:tool_calls' });
  });

  it('stream tool call reassembles split name and arguments', async () => {
    upstream.state.scenario = 'tool';
    const result = await call('/v1/chat/completions', {
      model: TRANSPORT_MODEL,
      stream: true,
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });
    assertSse(result);
    const frames = sseFrames(result.text);
    assertSingleDone(frames);
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame.data));
    const calls = parseChatToolCalls(chunks);
    assert.equal(calls.length, 1, result.text);
    assert.equal(calls[0].name, TOOL_CALL.name);
    assert.ok(calls[0].id, 'streamed tool call id must survive');
    assert.deepEqual(JSON.parse(calls[0].arguments), { city: 'Tokyo', unit: 'c' });
    const terminal = chunks.at(-1).choices[0];
    assert.equal(terminal.finish_reason, 'tool_calls');
    recordFlow('openai-chat', 'stream', 'tool-call', result, { frames: frames.length, terminal: 'tool_calls+[DONE]' });
  });

  it('preserves a user image part through the router', async () => {
    const result = await call('/v1/chat/completions', {
      model: TRANSPORT_MODEL,
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', image_url: { url: PNG_DATA_URL } },
        ],
      }],
    });
    const body = assertJson(result);
    assert.equal(body.choices[0].message.content, 'PONG');
    assert.ok(upstream.state.calls.at(-1).imageUrls.includes(PNG_DATA_URL), 'image part must reach the upstream');
    recordFlow('openai-chat', 'non-stream', 'image', result, { terminal: 'finish_reason:stop' });
  });
});

// ── Anthropic Messages ───────────────────────────────────────────────

describe('Anthropic Messages /v1/messages', () => {
  it('non-stream text', async () => {
    const result = await call('/v1/messages', {
      model: TRANSPORT_MODEL,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    }, ANTHROPIC_HEADERS);
    const body = assertJson(result);
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.content.find((block) => block.type === 'text')?.text, 'PONG');
    assert.equal(body.stop_reason, 'end_turn');
    recordFlow('anthropic-messages', 'non-stream', 'text', result, { terminal: 'stop_reason:end_turn' });
  });

  it('stream text has canonical event order', async () => {
    const result = await call('/v1/messages', {
      model: TRANSPORT_MODEL,
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    }, ANTHROPIC_HEADERS);
    assertSse(result);
    const raw = sseFrames(result.text);
    assert.equal(raw.at(-1).event, 'message_stop', 'message_stop must be the final frame');
    assert.ok(!raw.some((frame) => frame.data === '[DONE]'), 'Messages must not carry an OpenAI [DONE]');
    const frames = jsonFrames(result.text);
    for (const frame of frames) {
      assert.ok(frame.event, `frame missing event name: ${frame.data}`);
      assert.equal(frame.json.type, frame.event, `event/data type mismatch: ${frame.data}`);
    }
    assert.equal(frames[0].event, 'message_start');
    assert.equal(frames[1].event, 'ping', 'official streams follow message_start with a ping');
    assert.equal(frames.filter((frame) => frame.event === 'message_start').length, 1);
    assert.equal(frames.filter((frame) => frame.event === 'message_stop').length, 1);
    const deltaAt = frames.findIndex((frame) => frame.event === 'message_delta');
    assert.equal(deltaAt, frames.length - 2, 'message_delta must directly precede message_stop');
    assert.equal(frames[deltaAt].json.delta.stop_reason, 'end_turn');
    assertBlockPairs(frames);
    assertDeltaContainment(frames);
    assert.equal(frames.filter((frame) => frame.event === 'content_block_start').length, 1, 'text flow has exactly one block');
    const text = frames
      .filter((frame) => frame.event === 'content_block_delta' && frame.json.delta?.type === 'text_delta')
      .map((frame) => frame.json.delta.text)
      .join('');
    assert.equal(text, 'PONG', 'assembled text must be exact');
    recordFlow('anthropic-messages', 'stream', 'text', result, { frames: raw.length, terminal: 'message_stop' });
  });

  it('non-stream tool_use input is an object', async () => {
    upstream.state.scenario = 'tool';
    const result = await call('/v1/messages', {
      model: TRANSPORT_MODEL,
      max_tokens: 64,
      stream: false,
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    }, ANTHROPIC_HEADERS);
    const body = assertJson(result);
    const toolUse = body.content.find((block) => block.type === 'tool_use');
    assert.ok(toolUse, result.text);
    assert.equal(toolUse.name, TOOL_CALL.name);
    assert.deepEqual(toolUse.input, { city: 'Tokyo', unit: 'c' });
    assert.equal(body.stop_reason, 'tool_use');
    recordFlow('anthropic-messages', 'non-stream', 'tool-call', result, { terminal: 'stop_reason:tool_use' });
  });

  it('stream tool_use reassembles input_json_delta', async () => {
    upstream.state.scenario = 'tool';
    const result = await call('/v1/messages', {
      model: TRANSPORT_MODEL,
      max_tokens: 64,
      stream: true,
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    }, ANTHROPIC_HEADERS);
    assertSse(result);
    const raw = sseFrames(result.text);
    assert.equal(raw.at(-1).event, 'message_stop');
    assert.ok(!raw.some((frame) => frame.data === '[DONE]'));
    const frames = jsonFrames(result.text);
    const startAt = frames.findIndex((frame) => frame.event === 'content_block_start' && frame.json.content_block?.type === 'tool_use');
    assert.ok(startAt > 0, result.text);
    const block = frames[startAt].json.content_block;
    assert.equal(block.name, TOOL_CALL.name);
    const argDeltas = frames.filter((frame) => frame.event === 'content_block_delta' && frame.json.delta?.type === 'input_json_delta');
    assert.ok(argDeltas.length >= 1, result.text);
    assert.ok(frames.indexOf(argDeltas[0]) > startAt, 'input deltas must follow the block start');
    const input = JSON.parse(argDeltas.map((frame) => frame.json.delta.partial_json).join(''));
    assert.deepEqual(input, { city: 'Tokyo', unit: 'c' });
    const stopAt = frames.findIndex((frame) => frame.event === 'content_block_stop' && frame.json.index === frames[startAt].json.index);
    const deltaAt = frames.findIndex((frame) => frame.event === 'message_delta');
    assert.ok(frames.indexOf(argDeltas.at(-1)) < stopAt, 'input deltas must precede content_block_stop');
    assert.ok(stopAt < deltaAt, 'content_block_stop must precede message_delta');
    assert.equal(frames[deltaAt].json.delta.stop_reason, 'tool_use');
    assert.equal(deltaAt, frames.length - 2);
    assertBlockPairs(frames);
    assertDeltaContainment(frames);
    assert.equal(frames.filter((frame) => frame.event === 'content_block_start').length, 1, 'tool flow has exactly one block');
    recordFlow('anthropic-messages', 'stream', 'tool-call', result, { frames: raw.length, terminal: 'message_stop' });
  });

  it('preserves a base64 image block', async () => {
    const result = await call('/v1/messages', {
      model: TRANSPORT_MODEL,
      max_tokens: 16,
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_DATA_URL.split(',')[1] } },
        ],
      }],
    }, ANTHROPIC_HEADERS);
    const body = assertJson(result);
    assert.equal(body.content.find((block) => block.type === 'text')?.text, 'PONG');
    assert.ok(upstream.state.calls.at(-1).imageUrls.includes(PNG_DATA_URL), 'image block must reach the upstream as a data URL');
    recordFlow('anthropic-messages', 'non-stream', 'image', result, { terminal: 'stop_reason:end_turn' });
  });
});

// ── OpenAI Responses ─────────────────────────────────────────────────

describe('OpenAI Responses /v1/responses', () => {
  it('non-stream text', async () => {
    const result = await call('/v1/responses', {
      model: TRANSPORT_MODEL,
      stream: false,
      store: false,
      input: 'Reply with exactly: PONG',
    });
    const body = assertJson(result);
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.ok(body.id.startsWith('resp_'), result.text);
    const message = body.output.find((item) => item.type === 'message');
    assert.ok(message, result.text);
    assert.equal(message.content[0].type, 'output_text');
    assert.equal(message.content[0].text, 'PONG');
    recordFlow('openai-responses', 'non-stream', 'text', result, { terminal: 'status:completed' });
  });

  it('stream text has contiguous sequence numbers and one completion', async () => {
    const result = await call('/v1/responses', {
      model: TRANSPORT_MODEL,
      stream: true,
      store: false,
      input: 'Reply with exactly: PONG',
    });
    assertSse(result);
    const raw = sseFrames(result.text);
    assertSingleDone(raw);
    const frames = jsonFrames(result.text);
    assert.equal(frames[0].event, 'response.created');
    assert.equal(frames[1].event, 'response.in_progress');
    for (const frame of frames) {
      assert.ok(frame.event.startsWith('response.'), `foreign event: ${frame.event}`);
      assert.equal(frame.json.type, frame.event, `event/data type mismatch: ${frame.data}`);
    }
    const seqs = frames.map((frame) => frame.json.sequence_number);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal(seqs[i], seqs[i - 1] + 1, `sequence_number gap: ${seqs.join(',')}`);
    }
    const completed = frames.filter((frame) => frame.event === 'response.completed');
    assert.equal(completed.length, 1, 'exactly one response.completed');
    assert.equal(frames.at(-1).event, 'response.completed', 'response.completed must be the terminal protocol event');
    const text = frames
      .filter((frame) => frame.event === 'response.output_text.delta')
      .map((frame) => frame.json.delta)
      .join('');
    assert.equal(text, 'PONG');
    const done = frames.filter((frame) => frame.event === 'response.output_text.done');
    assert.equal(done.length, 1);
    assert.equal(done[0].json.text, 'PONG');
    // Every added output item is closed exactly once.
    const added = frames.filter((frame) => frame.event === 'response.output_item.added').map((frame) => frame.json.item.id);
    const closed = frames.filter((frame) => frame.event === 'response.output_item.done').map((frame) => frame.json.item.id);
    assert.deepEqual(closed.sort(), added.sort(), 'output items must pair added/done');
    recordFlow('openai-responses', 'stream', 'text', result, { frames: raw.length, terminal: 'response.completed+[DONE]' });
  });

  it('non-stream function_call arguments are parseable', async () => {
    upstream.state.scenario = 'tool';
    const result = await call('/v1/responses', {
      model: TRANSPORT_MODEL,
      stream: false,
      store: false,
      input: 'What is the weather in Tokyo?',
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    });
    const body = assertJson(result);
    const functionCall = body.output.find((item) => item.type === 'function_call');
    assert.ok(functionCall, result.text);
    assert.equal(functionCall.name, TOOL_CALL.name);
    assert.ok(functionCall.call_id, 'call_id must be present');
    assert.deepEqual(JSON.parse(functionCall.arguments), { city: 'Tokyo', unit: 'c' });
    assert.equal(body.status, 'completed');
    recordFlow('openai-responses', 'non-stream', 'tool-call', result, { terminal: 'status:completed' });
  });

  it('stream function_call deltas reassemble and close', async () => {
    upstream.state.scenario = 'tool';
    const result = await call('/v1/responses', {
      model: TRANSPORT_MODEL,
      stream: true,
      store: false,
      input: 'What is the weather in Tokyo?',
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    });
    assertSse(result);
    const raw = sseFrames(result.text);
    assertSingleDone(raw);
    const frames = jsonFrames(result.text);
    const added = frames.find((frame) => frame.event === 'response.output_item.added' && frame.json.item?.type === 'function_call');
    assert.ok(added, result.text);
    assert.equal(added.json.item.name, TOOL_CALL.name);
    const args = frames
      .filter((frame) => frame.event === 'response.function_call_arguments.delta')
      .map((frame) => frame.json.delta)
      .join('');
    assert.deepEqual(JSON.parse(args), { city: 'Tokyo', unit: 'c' });
    const argsDone = frames.find((frame) => frame.event === 'response.function_call_arguments.done');
    assert.equal(argsDone.json.arguments, args);
    const itemDone = frames.find((frame) => frame.event === 'response.output_item.done' && frame.json.item?.type === 'function_call');
    assert.equal(itemDone.json.item.call_id, added.json.item.call_id);
    assert.equal(itemDone.json.item.arguments, args);
    const completed = frames.filter((frame) => frame.event === 'response.completed');
    assert.equal(completed.length, 1);
    assert.equal(frames.at(-1).event, 'response.completed');
    recordFlow('openai-responses', 'stream', 'tool-call', result, { frames: raw.length, terminal: 'response.completed+[DONE]' });
  });

  it('preserves an input_image part', async () => {
    const result = await call('/v1/responses', {
      model: TRANSPORT_MODEL,
      stream: false,
      store: false,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is in this image?' },
          { type: 'input_image', image_url: PNG_DATA_URL },
        ],
      }],
    });
    const body = assertJson(result);
    assert.equal(body.status, 'completed');
    assert.ok(upstream.state.calls.at(-1).imageUrls.includes(PNG_DATA_URL), 'input_image must reach the upstream as a data URL');
    recordFlow('openai-responses', 'non-stream', 'image', result, { terminal: 'status:completed' });
  });
});

// ── Gemini ───────────────────────────────────────────────────────────

const GEMINI_PATH = `/v1beta/models/${TRANSPORT_MODEL}`;

describe('Gemini /v1beta/models/*', () => {
  it('generateContent non-stream text', async () => {
    const result = await call(`${GEMINI_PATH}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    });
    const body = assertJson(result);
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].content.role, 'model');
    assert.equal(body.candidates[0].content.parts.find((part) => typeof part.text === 'string')?.text, 'PONG');
    assert.equal(body.candidates[0].finishReason, 'STOP');
    recordFlow('gemini', 'non-stream', 'text', result, { terminal: 'finishReason:STOP' });
  });

  it('streamGenerateContent alt=sse text', async () => {
    const result = await call(`${GEMINI_PATH}:streamGenerateContent?alt=sse`, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    });
    assertSse(result);
    const raw = sseFrames(result.text);
    assert.ok(!raw.some((frame) => frame.data === '[DONE]'), 'Gemini SSE must not carry an OpenAI [DONE]');
    assert.ok(raw.every((frame) => frame.event === null), 'Gemini SSE frames are data-only');
    const frames = jsonFrames(result.text);
    for (const frame of frames) {
      assert.equal(frame.json.candidates.length, 1, frame.data);
    }
    assert.equal(frames.at(-1).json.candidates[0].finishReason, 'STOP');
    assert.ok(frames.slice(0, -1).every((frame) => frame.json.candidates[0].finishReason == null), 'finishReason must be terminal');
    const text = frames
      .flatMap((frame) => frame.json.candidates[0].content?.parts || [])
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    assert.equal(text, 'PONG');
    recordFlow('gemini', 'stream', 'text', result, { frames: raw.length, terminal: 'finishReason:STOP' });
  });

  it('streamGenerateContent default array form', async () => {
    const result = await call(`${GEMINI_PATH}:streamGenerateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }],
    });
    const parsed = assertJson(result);
    assert.ok(Array.isArray(parsed), 'default Gemini stream is a JSON array');
    assert.ok(parsed.length >= 1, result.text);
    const text = parsed
      .flatMap((frame) => frame.candidates[0].content?.parts || [])
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    assert.equal(text, 'PONG');
    assert.equal(parsed.at(-1).candidates[0].finishReason, 'STOP');
    recordFlow('gemini', 'stream', 'array-form', result, { frames: parsed.length, terminal: 'finishReason:STOP' });
  });

  it('generateContent functionCall args are an object', async () => {
    upstream.state.scenario = 'tool';
    const result = await call(`${GEMINI_PATH}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] }],
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] }],
    });
    const body = assertJson(result);
    const functionCall = body.candidates[0].content.parts.find((part) => part.functionCall)?.functionCall;
    assert.ok(functionCall, result.text);
    assert.equal(functionCall.name, TOOL_CALL.name);
    assert.deepEqual(functionCall.args, { city: 'Tokyo', unit: 'c' });
    assert.equal(body.candidates[0].finishReason, 'STOP');
    recordFlow('gemini', 'non-stream', 'tool-call', result, { terminal: 'finishReason:STOP' });
  });

  it('streamGenerateContent functionCall args are an object', async () => {
    upstream.state.scenario = 'tool';
    const result = await call(`${GEMINI_PATH}:streamGenerateContent?alt=sse`, {
      contents: [{ role: 'user', parts: [{ text: 'What is the weather in Tokyo?' }] }],
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] }],
    });
    assertSse(result);
    const frames = jsonFrames(result.text);
    const functionCall = frames
      .flatMap((frame) => frame.json.candidates[0].content?.parts || [])
      .find((part) => part.functionCall)?.functionCall;
    assert.ok(functionCall, result.text);
    assert.equal(functionCall.name, TOOL_CALL.name);
    assert.deepEqual(functionCall.args, { city: 'Tokyo', unit: 'c' });
    assert.equal(frames.at(-1).json.candidates[0].finishReason, 'STOP');
    recordFlow('gemini', 'stream', 'tool-call', result, { frames: sseFrames(result.text).length, terminal: 'finishReason:STOP' });
  });

  it('preserves inlineData image parts', async () => {
    const result = await call(`${GEMINI_PATH}:generateContent`, {
      contents: [{
        role: 'user',
        parts: [
          { text: 'What is in this image?' },
          { inlineData: { mimeType: 'image/png', data: PNG_DATA_URL.split(',')[1] } },
        ],
      }],
    });
    const body = assertJson(result);
    assert.equal(body.candidates[0].finishReason, 'STOP');
    assert.ok(upstream.state.calls.at(-1).imageUrls.includes(PNG_DATA_URL), 'inlineData must reach the upstream as a data URL');
    recordFlow('gemini', 'non-stream', 'image', result, { terminal: 'finishReason:STOP' });
  });
});

// ── latency / byte matrix ────────────────────────────────────────────

const METRIC_SIZES = Object.freeze([
  { label: '1 KB', bytes: 1024, reps: 5 },
  { label: '64 KB', bytes: 64 * 1024, reps: 5 },
  { label: '1 MB', bytes: 1024 * 1024, reps: 3 },
]);

const METRIC_FLOWS = Object.freeze([
  {
    family: 'openai-chat',
    path: '/v1/chat/completions',
    headers: {},
    body: (prompt) => ({ model: TRANSPORT_MODEL, stream: true, messages: [{ role: 'user', content: prompt }] }),
    terminal: (text) => assert.equal(sseFrames(text).at(-1).data, '[DONE]'),
  },
  {
    family: 'anthropic-messages',
    path: '/v1/messages',
    headers: ANTHROPIC_HEADERS,
    body: (prompt) => ({ model: TRANSPORT_MODEL, max_tokens: 16, stream: true, messages: [{ role: 'user', content: prompt }] }),
    terminal: (text) => assert.equal(sseFrames(text).at(-1).event, 'message_stop'),
  },
  {
    family: 'openai-responses',
    path: '/v1/responses',
    headers: {},
    body: (prompt) => ({ model: TRANSPORT_MODEL, stream: true, store: false, input: prompt }),
    terminal: (text) => {
      assert.equal(sseFrames(text).at(-1).data, '[DONE]');
      assert.equal(jsonFrames(text).at(-1).event, 'response.completed');
    },
  },
  {
    family: 'gemini',
    path: `${GEMINI_PATH}:streamGenerateContent?alt=sse`,
    headers: {},
    body: (prompt) => ({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    terminal: (text) => assert.equal(jsonFrames(text).at(-1).json.candidates[0].finishReason, 'STOP'),
  },
]);

function sizedPrompt(bytes) {
  const prefix = 'Reply with exactly: PONG.\n';
  return prefix + 'a'.repeat(Math.max(0, bytes - prefix.length));
}

describe('latency / byte matrix', () => {
  it('records p50/p95 and bytes for 1 KB, 64 KB and 1 MB prompts', async () => {
    for (const size of METRIC_SIZES) {
      const prompt = sizedPrompt(size.bytes);
      assert.equal(byteLength(prompt), size.bytes, 'prompt must be exactly the target byte size');
      for (const flow of METRIC_FLOWS) {
        const latencies = [];
        let reqBytes = 0;
        let respBytes = 0;
        for (let rep = 0; rep < size.reps; rep += 1) {
          upstream.state.scenario = 'text';
          const result = await call(flow.path, flow.body(prompt), flow.headers);
          assert.equal(result.status, 200, `${flow.family} ${size.label}: ${result.text.slice(0, 300)}`);
          flow.terminal(result.text);
          latencies.push(result.ms);
          reqBytes = result.reqBytes;
          respBytes = result.respBytes;
        }
        assert.ok(reqBytes >= size.bytes, `${flow.family} ${size.label}: request was only ${reqBytes} bytes`);
        const summary = summarize(latencies);
        METRICS.push({
          size: size.label,
          family: flow.family,
          n: summary.n,
          p50: summary.p50.toFixed(1),
          p95: summary.p95.toFixed(1),
          reqBytes,
          respBytes,
        });
      }
    }
    // p95 is only meaningful if the measurements exist; nearest-rank keeps it
    // equal to max at n=3, which the report states explicitly.
    assert.equal(METRICS.length, METRIC_SIZES.length * METRIC_FLOWS.length);
    for (const row of METRICS) {
      assert.ok(Number(row.p50) >= 0);
      assert.ok(Number(row.p95) >= Number(row.p50));
    }
  });
});
