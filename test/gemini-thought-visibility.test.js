import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { config } from '../src/config.js';
import { __setStreamChatForTest } from '../src/devin-connect-openai.js';
import { geminiToOpenAI } from '../src/handlers/gemini.js';
import { startServer } from '../src/server.js';
import { jsonFrames, TOOL_CALL, TRANSPORT_MODEL } from './transport-matrix.helpers.mjs';

const clientKey = 'gemini-visibility-fixture-client';
const summary = 'Fixture summary about the weather';
const answer = 'Fixture final answer';
const contents = [{ role: 'user', parts: [{ text: 'Fixture request' }] }];
const generation = { maxOutputTokens: 128, temperature: 0.25, topK: 24 };
const expectedCall = {
  functionCall: { id: TOOL_CALL.id, name: TOOL_CALL.name, args: JSON.parse(TOOL_CALL.arguments) },
};
const secondCall = { ...TOOL_CALL, id: 'call_gemini_second', arguments: '{"city":"Osaka","unit":"c"}' };
const expectedCalls = [
  expectedCall,
  { functionCall: { id: secondCall.id, name: secondCall.name, args: JSON.parse(secondCall.arguments) } },
];
const tools = [{
  functionDeclarations: [{ name: TOOL_CALL.name, parameters: { type: 'OBJECT' } }],
}];

const savedConfig = { apiKey: config.apiKey, host: config.host, port: config.port };
const fakeEnv = {
  DEVIN_CONNECT: '1',
  DEVIN_CONNECT_TOKEN: 'gemini-visibility-fixture-connect',
  DEVIN_CONNECT_RESCUE_MAX: '0',
  WINDSURF_API_KEY: undefined,
  RESPONSE_CACHE_ENABLED: '1',
};
const savedEnv = Object.fromEntries(Object.keys(fakeEnv).map(key => [key, process.env[key]]));

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let server;
let turns = 0;
let script = 'mixed';

before(async () => {
  setEnv(fakeEnv);
  Object.assign(config, { apiKey: clientKey, host: '127.0.0.1', port: 0 });
  // Exercise the real HTTP handler and both Connect adapters. Only the
  // upstream event source is replaced, with explicitly marked fixture parts.
  __setStreamChatForTest(async function* (params) {
    turns++;
    assert.deepEqual(params.completion, { maxTokens: 128, temperature: 0.25, topK: 24 });
    if (script === 'final-only') {
      yield { type: 'content', text: summary }; // Identical text with a final-content mark.
    } else if (script === 'emulated-tool') {
      yield { type: 'reasoning', text: `${summary} <tool_call>{"name":"${TOOL_CALL.name}","arguments":${TOOL_CALL.arguments}}</tool_call>` };
    } else {
      yield { type: 'reasoning', text: summary };
      if (script === 'mixed' || script === 'native-mixed') yield { type: 'content', text: answer };
    }
    const usage = {
      prompt_tokens: 10,
      completion_tokens: script === 'summary-only' ? 3 : 4,
      total_tokens: script === 'summary-only' ? 13 : 14,
      completion_tokens_details: { reasoning_tokens: script === 'final-only' ? 0 : 3 },
    };
    yield {
      type: 'finish', reason: 'stop', usage,
      ...(script === 'tool' ? { toolCalls: [TOOL_CALL] } : {}),
      ...(script === 'native-mixed' ? { toolCalls: [TOOL_CALL, secondCall] } : {}),
    };
  });
  server = startServer();
  await once(server, 'listening');
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  __setStreamChatForTest(null);
  Object.assign(config, savedConfig);
  setEnv(savedEnv);
});

const paths = {
  buffered: 'generateContent',
  sse: 'streamGenerateContent?alt=sse',
  array: 'streamGenerateContent',
};

async function post(path, body) {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

async function gemini(mode, kind, thinkingConfig, request = {}) {
  script = kind;
  const res = await post(`/v1beta/models/${TRANSPORT_MODEL}:${paths[mode]}`, {
    contents,
    ...(['tool', 'emulated-tool', 'native-mixed'].includes(kind) ? { tools } : {}),
    generationConfig: { ...generation, thinkingConfig },
    ...request,
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  assert.match(res.headers.get('content-type'), mode === 'sse' ? /^text\/event-stream\b/ : /^application\/json\b/);
  if (mode === 'sse') {
    assert.ok(!raw.includes('[DONE]'), 'Gemini SSE terminates with a Gemini candidate');
    return jsonFrames(raw).map(frame => frame.json);
  }
  const data = JSON.parse(raw);
  return mode === 'buffered' ? [data] : data;
}

function assertOutput(frames, parts, usage) {
  const candidates = frames.flatMap(frame => frame.candidates);
  assert.deepEqual(candidates.flatMap(c => c.content.parts).filter(part => part.text || part.functionCall), parts);
  assert.deepEqual(candidates.map(c => c.finishReason).filter(Boolean), ['STOP']);
  assert.equal(candidates.at(-1).finishReason, 'STOP');
  assert.deepEqual(frames.map(frame => frame.usageMetadata).filter(Boolean), [usage]);
}

const optedIn = { thinkingBudget: 128, includeThoughts: true };
const optedOut = { thinkingBudget: 128, includeThoughts: false };
const mixedUsage = { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 3, totalTokenCount: 14 };
const summaryPart = { text: summary, thought: true };

for (const mode of Object.keys(paths)) {
  for (const [label, thinkingConfig] of [
    ['true', optedIn], ['false', optedOut], ['omitted flag', { thinkingBudget: 128 }], ['omitted config', undefined],
  ]) {
    test(`${mode}: includeThoughts ${label} preserves final text and usage`, async () => {
      const frames = await gemini(mode, 'mixed', thinkingConfig);
      assertOutput(frames, [...(thinkingConfig === optedIn ? [summaryPart] : []), { text: answer }], mixedUsage);
    });
  }

  test(`${mode}: suppressing summaries keeps structured tool calls`, async () => {
    assertOutput(await gemini(mode, 'tool', optedOut), [expectedCall], mixedUsage);
  });

  for (const thinkingConfig of [optedIn, optedOut]) {
    test(`${mode}: includeThoughts ${thinkingConfig.includeThoughts} preserves final text and ordered native calls`, async () => {
      const frames = await gemini(mode, 'native-mixed', thinkingConfig);
      assertOutput(frames, [...(thinkingConfig.includeThoughts ? [summaryPart] : []), { text: answer }, ...expectedCalls], mixedUsage);
    });
  }

  test(`${mode}: suppressing marked prose keeps an existing emulated tool call`, async () => {
    const frames = await gemini(mode, 'emulated-tool', optedOut);
    const callPart = frames.flatMap(frame => frame.candidates[0].content.parts).find(part => part.functionCall);
    assert.ok(callPart);
    assertOutput(frames, [{ functionCall: { ...expectedCall.functionCall, id: callPart.functionCall.id } }], mixedUsage);
  });

  test(`${mode}: a suppressed summary-only turn still terminates with usage`, async () => {
    const frames = await gemini(mode, 'summary-only', optedOut);
    assertOutput(frames, [], { ...mixedUsage, candidatesTokenCount: 0, totalTokenCount: 13 });
    assert.deepEqual(frames.map(frame => frame.candidates[0].content.parts), [[{ text: '' }]]);
  });

  test(`${mode}: an opted-in summary-only turn keeps the summary marked`, async () => {
    const frames = await gemini(mode, 'summary-only', optedIn);
    assertOutput(frames, [summaryPart], { ...mixedUsage, candidatesTokenCount: 0, totalTokenCount: 13 });
  });

  test(`${mode}: the same text explicitly delivered as the final answer stays visible`, async () => {
    const frames = await gemini(mode, 'final-only', optedOut);
    assertOutput(frames, [{ text: summary }], { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 });
  });
}

test('the visibility bit does not change the internal generation hint', () => {
  const translate = thinkingConfig => geminiToOpenAI({ contents, generationConfig: { thinkingConfig } });
  assert.deepEqual(translate(optedOut), translate(optedIn));
  assert.deepEqual(translate(optedOut).thinking, { type: 'enabled', budget_tokens: 128 });
  assert.deepEqual(translate({ ...optedIn, thinkingBudget: 0 }).thinking, { type: 'disabled' });
});

test('buffered OpenAI retains null content on a native tool turn', async () => {
  script = 'native-mixed';
  const res = await post('/v1/chat/completions', {
    model: TRANSPORT_MODEL, max_tokens: 128, temperature: 0.25, top_k: 24,
    messages: [{ role: 'user', content: contents[0].parts[0].text }],
    tools: [{ type: 'function', function: { name: TOOL_CALL.name, parameters: { type: 'object' } } }],
  });
  assert.equal(res.status, 200);
  const { message } = (await res.json()).choices[0];
  assert.equal(message.content, null);
  assert.equal(message.tool_calls.length, expectedCalls.length);
});

test('OpenAI fallback and cache replay cannot promote a Gemini summary', async () => {
  script = 'summary-only';
  const before = turns;
  const user = 'fixture-caller';
  const openAIRequest = {
    model: TRANSPORT_MODEL, user, max_tokens: 128, temperature: 0.25, top_k: 24,
    messages: [{ role: 'user', content: contents[0].parts[0].text }],
  };
  for (let i = 0; i < 2; i++) {
    const res = await post('/v1/chat/completions', openAIRequest);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, summary);
  }
  assert.equal(turns - before, 1, 'the OpenAI fallback is present in the response cache');
  const frames = await gemini('buffered', 'summary-only', undefined, { user });
  assertOutput(frames, [], { ...mixedUsage, candidatesTokenCount: 0, totalTokenCount: 13 });
  assert.equal(turns - before, 2, 'Gemini must not use the OpenAI fallback answer');
});
