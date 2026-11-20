import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { config } from '../src/config.js';
import { __setStreamChatForTest } from '../src/devin-connect-openai.js';
import { geminiToOpenAI } from '../src/handlers/gemini.js';
import { validateJsonSchema, __jsonSchemaLimits } from '../src/json-schema.js';
import { startServer } from '../src/server.js';
import { jsonFrames, TRANSPORT_MODEL } from './transport-matrix.helpers.mjs';

const clientKey = 'schema-fixture-client';
const savedConfig = { host: config.host, port: config.port, apiKey: config.apiKey };
const fixtureEnv = {
  DEVIN_CONNECT: '1',
  DEVIN_CONNECT_TOKEN: 'schema-fixture-connect',
  DEVIN_CONNECT_RESCUE_MAX: '0',
  RESPONSE_CACHE_ENABLED: '0',
};
const savedEnv = Object.fromEntries(Object.keys(fixtureEnv).map(name => [name, process.env[name]]));
let server;
let output;

before(async () => {
  Object.assign(process.env, fixtureEnv);
  Object.assign(config, { host: '127.0.0.1', port: 0, apiKey: clientKey });
  __setStreamChatForTest(async function* () {
    yield { type: 'content', text: JSON.stringify(output) };
    yield { type: 'finish', reason: 'stop' };
  });
  server = startServer();
  await once(server, 'listening');
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  __setStreamChatForTest(null);
  Object.assign(config, savedConfig);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function post(path, body) {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
}

const nativeSchema = {
  type: 'OBJECT', properties: { rows: {
    type: 'ARRAY', items: { type: 'OBJECT', properties: { type: { type: 'INTEGER' } } },
  } },
};
const methods = ['generateContent', 'streamGenerateContent?alt=sse', 'streamGenerateContent'];
for (const method of methods) {
  const cases = [
    ['accepts an integer in a nested array', { rows: [{ type: 2 }] }, true],
    ['rejects a string in a nested array', { rows: [{ type: 'two' }] }, false],
  ];
  for (const [label, value, valid] of cases) {
    test(`${method} with Gemini responseSchema ${label}`, async () => {
      output = value;
      const res = await post(`/v1beta/models/${TRANSPORT_MODEL}:${method}`, {
        contents: [{ parts: [{ text: label }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: nativeSchema },
      });
      const frames = res.headers.get('content-type')?.startsWith('text/event-stream') ? jsonFrames(await res.text()).map(frame => frame.json)
        : [await res.json()].flat();
      if (valid) {
        assert.equal(res.status, 200);
        assert.deepEqual(frames.filter(frame => frame.error), []);
        const candidates = frames.flatMap(frame => frame.candidates || []);
        assert.deepEqual(candidates.map(c => c.finishReason).filter(Boolean), ['STOP']);
        const text = candidates.flatMap(c => c.content.parts).map(p => p.text || '').join('');
        assert.deepEqual(JSON.parse(text), value);
      } else {
        // The array stream opens before validation. Buffered and SSE requests
        // can still receive the error as an HTTP response.
        assert.equal(res.status, method === 'streamGenerateContent' ? 200 : 503);
        const errors = frames.filter(frame => frame.error);
        assert.equal(errors.length, 1);
        assert.match(errors[0].error.message, /\$\.rows\[0\]\.type.*expected integer/);
        assert.deepEqual(frames.flatMap(frame => frame.candidates || []), []);
      }
    });
  }
}

test('Gemini converts native subschemas at depth and preserves literal data and JSON Schema', () => {
  const literals = { type: 'STRING', units: ['OBJECT', 'ARRAY'] };
  const native = { type: 'STRING', enum: ['STRING', 'OBJECT'], default: literals, example: literals };
  let root = { anyOf: [native] };
  for (let i = 0; i < 8; i++) root = { type: 'OBJECT', properties: { next: root } };
  const convert = generation => geminiToOpenAI({
    generationConfig: { responseMimeType: 'application/json', ...generation },
  }).response_format.json_schema.schema;
  let converted = convert({ responseSchema: root });
  for (let i = 0; i < 8; i++) converted = converted.properties.next;
  assert.deepEqual(converted.anyOf[0], { ...native, type: 'string' });
  assert.equal(native.type, 'STRING');
  const jsonSchema = { type: 'object', enum: [literals] };
  assert.deepEqual(convert({ responseJsonSchema: jsonSchema }), jsonSchema);
});

const expected = { kind: 'fixture', values: [1, { a: 2, b: 3 }] };
const reordered = { values: [1, { b: 3, a: 2 }], kind: 'fixture' };
const changed = { values: [{ b: 3, a: 2 }, 1], kind: 'fixture' };

for (const [label, schema, value, valid] of [
  ['enum accepts reordered object members', { enum: [expected] }, reordered, true],
  ['enum distinguishes array order', { enum: [expected] }, changed, false],
  ['const accepts reordered object members', { const: expected }, reordered, true],
  ['const distinguishes array order', { const: expected }, changed, false],
  ['uniqueItems rejects an equal reordered object', { uniqueItems: true }, [expected, reordered], false],
  ['uniqueItems accepts different array order', { uniqueItems: true }, [expected, changed], true],
]) {
  for (const stream of [false, true]) {
    test(`Chat ${stream ? 'streamed' : 'buffered'}: ${label}`, async () => {
      output = { result: value };
      const res = await post('/v1/chat/completions', {
        model: TRANSPORT_MODEL, stream, messages: [{ role: 'user', content: label }],
        response_format: { type: 'json_schema', json_schema: {
          name: 'result', strict: true, schema: { type: 'object', properties: { result: schema }, required: ['result'] },
        } },
      });
      const frames = res.headers.get('content-type')?.startsWith('text/event-stream')
        ? jsonFrames(await res.text()).map(frame => frame.json) : [await res.json()];
      if (valid) {
        assert.equal(res.status, 200);
        const choices = frames.flatMap(frame => frame.choices || []);
        assert.deepEqual(choices.map(c => c.finish_reason).filter(Boolean), ['stop']);
        const text = choices.map(c => (c.message || c.delta)?.content || '').join('');
        assert.deepEqual(JSON.parse(text), output);
      } else {
        assert.equal(res.status, 502);
        assert.deepEqual(frames.filter(f => f.error).map(f => f.error.code), ['STRUCTURED_OUTPUT_NOT_CONFORMING']);
        const choices = frames.flatMap(frame => frame.choices || []);
        assert.ok(choices.every(c => !c.finish_reason && !c.delta?.content));
      }
    });
  }
}

test('checking nested JSON values draws from the shared validation budget', () => {
  // Spend the last available steps on an ordinary pair of small objects.
  const budget = { steps: __jsonSchemaLimits.MAX_SCHEMA_STEPS - 2, expiresAt: Infinity, exhausted: false };
  const result = validateJsonSchema(reordered, { const: expected }, { budget });
  assert.equal(result.code, 'SCHEMA_UNVALIDATED');
});
