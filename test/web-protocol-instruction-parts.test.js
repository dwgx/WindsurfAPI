// REGRESSION (2026-11-21): direct Connect instruction channel.
//
// Basis: the frozen 507f4fca protocol probe
// (protocol-probe/test/web-protocol-shapes-system.test.js, sha256
// 9469701bee2b25d608ce8fa83c679006a7de1fdd1704fb490e8ebd429613ba21).
// That probe measured, through the REAL public handlers and the REAL protobuf
// builder, two defects in the non-stream direct Connect branch:
//
//   1. a Chat `developer` message (string or text parts) reached the wire as a
//      USER frame with an empty #2, losing the declared instruction priority;
//   2. per-PART identity neutralization could not see a trigger phrase split
//      across text-part boundaries, so the Claude Code self-ID escaped.
//
// This suite is the formal regression for the approved contract: pure-text
// `developer` turns are promoted to the instruction channel BEFORE prompt
// composition, and each single pure-text system turn is folded to its exact
// wire text (`messageText()` boundary `\n`) before one neutralization pass.
//
// The assertions stay on bytes the product would send: each case drives the
// real handler (handleChatCompletions / handleResponses / handleMessages /
// handleGemini), fakes ONLY the transport seam, and feeds the captured
// parameters to the real buildGetChatMessageRequest. No listener, socket,
// provider, model or account call.
//
// Deliberately NOT covered: the deliberately-failing F-PREFIX tool-name probe
// (separate seam, currently unreachable from production producers), Cascade
// request shapes, and real upstream/ACP/SSE-client frames.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  handleChatCompletions, __setConnectDeps, __resetConnectDeps,
} from '../src/handlers/chat.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleGemini } from '../src/handlers/gemini.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const MODEL = 'swe-1-6-slow';
const TOKEN = 'devin-session-token$instruction.parts.jwt.sig';

// Two parts that must survive as one ordered string. The second part carries an
// embedded newline and a non-ASCII character so trimming / replacement / first-
// or last-part-only loss is observable.
const PART_A = 'A ';
const PART_B = 'β\nB';
const JOINED = `${PART_A}\n${PART_B}`;

// The project's own CC self-ID trigger. The full sentence is replaced by
// "You are an AI coding assistant."; the split halves individually are not.
const CC_HEAD = 'PRE You are Claude Code, ';
const CC_TAIL = "Anthropic's official CLI for Claude. POST";
const CC_NEUTRALIZED = 'PRE You are an AI coding assistant. POST';

let captured = null;

function okBody(model = MODEL) {
  return {
    id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function okStreamResult() {
  return {
    content: 'ok', delivered: 'ok', reasoning: '', toolCalls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    billing: null,
  };
}

function fakeRes() {
  const listeners = new Map();
  const state = { body: '', writableEnded: false };
  const res = {
    get writableEnded() { return state.writableEnded; },
    get body() { return state.body; },
    write(chunk) { state.body += String(chunk); return true; },
    end(chunk) { if (chunk) res.write(chunk); state.writableEnded = true; },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return res; },
    once(event, cb) {
      const wrap = (...args) => { res.removeListener(event, wrap); cb(...args); };
      res.on(event, wrap);
    },
    removeListener(event, cb) {
      const list = listeners.get(event) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
  };
  return res;
}

function capture() {
  captured = [];
  __setConnectDeps({
    toChatCompletion: async (params) => { captured.push(params); return { status: 200, body: okBody(params.model) }; },
  });
}

function wire(params) {
  const proto = buildGetChatMessageRequest({ ...params, token: TOKEN, env: process.env });
  const fields = parseFields(proto);
  return {
    system: getField(fields, 2, 2)?.value?.toString('utf8') ?? '',
    turns: getAllFields(fields, 3).filter(f => f.wireType === 2).map((f) => {
      const inner = parseFields(f.value);
      return {
        source: Number(getField(inner, 2, 0)?.value ?? 0),
        text: getField(inner, 3, 2)?.value?.toString('utf8') ?? '',
      };
    }),
  };
}

async function viaChat(messages, extra = {}) {
  const r = await handleChatCompletions({ model: MODEL, stream: false, messages, ...extra }, { reqId: 'regress-chat', callerKey: 'regress' });
  assert.equal(r.status, 200, `chat surface rejected the request: ${JSON.stringify(r.body)}`);
  assert.equal(captured.length, 1, 'request must reach the Connect seam');
  return wire(captured[0]);
}

// Real streaming entry (handleChatCompletions stream:true -> result.handler),
// with an inert adapter seam: it records the outgoing params and emits one
// trivial delta. Proves the same handler-side projection the adapter would
// encode; it does NOT claim anything about real upstream frames.
async function viaChatStream(messages, extra = {}) {
  captured = [];
  __setConnectDeps({
    toChatCompletion: async () => { throw new Error('non-stream seam must not be called for stream:true'); },
    streamChatCompletion: async (params, send) => {
      captured.push(params);
      send({ id: 'x', object: 'chat.completion.chunk', created: 1, model: MODEL,
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] });
      return okStreamResult();
    },
  });
  const r = await handleChatCompletions({ model: MODEL, stream: true, messages, ...extra }, { reqId: 'regress-stream', callerKey: 'regress' });
  assert.equal(r.status, 200, `stream surface rejected the request: ${JSON.stringify(r.body)}`);
  await r.handler(fakeRes());
  assert.equal(captured.length, 1, 'request must reach the streaming Connect seam');
  return wire(captured[0]);
}

async function viaMessages(body) {
  const r = await handleMessages({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }], ...body }, { reqId: 'regress-messages', callerKey: 'regress' });
  assert.equal(r.status, 200, `messages surface rejected the request: ${JSON.stringify(r.body)}`);
  assert.equal(captured.length, 1, 'request must reach the Connect seam');
  return wire(captured[0]);
}

async function viaGemini(body) {
  const r = await handleGemini(MODEL, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], ...body }, { reqId: 'regress-gemini', callerKey: 'regress' }, { stream: false });
  assert.equal(r.status, 200, `gemini surface rejected the request: ${JSON.stringify(r.body)}`);
  assert.equal(captured.length, 1, 'request must reach the Connect seam');
  return wire(captured[0]);
}

async function viaResponses(body) {
  const r = await handleResponses({ model: MODEL, stream: false, input: 'hi', ...body }, { reqId: 'regress-responses', callerKey: 'regress' });
  assert.equal(r.status, 200, `responses surface rejected the request: ${JSON.stringify(r.body)}`);
  assert.equal(captured.length, 1, 'request must reach the Connect seam');
  return wire(captured[0]);
}

const SAVED = {};
for (const k of [
  'DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'WINDSURFAPI_TOOL_HYGIENE',
  'DEVIN_CONNECT_COLLAPSE_SYSTEM', 'WINDSURFAPI_NEUTRALIZE_CLIENT_ID',
]) SAVED[k] = process.env[k];

beforeEach(() => {
  __resetConnectDeps();
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'probe-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  delete process.env.DEVIN_CONNECT_COLLAPSE_SYSTEM;
  delete process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID;
  capture();
});

afterEach(() => {
  __resetConnectDeps();
  captured = null;
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('system shape reachability: string vs multi-part text', () => {
  it('Chat: system string reaches protobuf #2 unchanged', async () => {
    const w = await viaChat([{ role: 'system', content: JOINED }, { role: 'user', content: 'hi' }]);
    assert.equal(w.system, JOINED);
  });

  it('Chat: system text-part array keeps order and part boundary on protobuf #2', async () => {
    const w = await viaChat([
      { role: 'system', content: [{ type: 'text', text: PART_A }, { type: 'text', text: PART_B }] },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, JOINED, 'parts must join in order with one boundary newline, untrimmed');
  });

  it('Messages: top-level system string reaches protobuf #2 unchanged', async () => {
    const w = await viaMessages({ system: JOINED });
    assert.equal(w.system, JOINED);
  });

  it('Messages: system text-block array keeps order and part boundary on protobuf #2', async () => {
    const w = await viaMessages({ system: [{ type: 'text', text: PART_A }, { type: 'text', text: PART_B }] });
    assert.equal(w.system, JOINED);
  });

  it('Gemini: systemInstruction string reaches protobuf #2 unchanged', async () => {
    const w = await viaGemini({ systemInstruction: JOINED });
    assert.equal(w.system, JOINED);
  });

  it('Gemini: systemInstruction.parts keeps order and part boundary on protobuf #2', async () => {
    const w = await viaGemini({ systemInstruction: { parts: [{ text: PART_A }, { text: PART_B }] } });
    assert.equal(w.system, JOINED);
  });

  it('Responses: instructions string reaches protobuf #2 unchanged', async () => {
    const w = await viaResponses({ instructions: JOINED });
    assert.equal(w.system, JOINED);
  });

  it('Responses: developer input_text array keeps order and part boundary on protobuf #2', async () => {
    const w = await viaResponses({
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: PART_A }, { type: 'input_text', text: PART_B }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    });
    assert.equal(w.system, JOINED);
  });
});

describe('Chat developer role: instruction channel, not a USER frame', () => {
  it('Chat: developer string hoists to protobuf #2 and is absent from the USER frames', async () => {
    const w = await viaChat([{ role: 'developer', content: 'D1' }, { role: 'user', content: 'hi' }]);
    assert.equal(w.system, 'D1', 'developer text must ride the instruction channel');
    assert.ok(!w.turns.some(t => t.text === 'D1'), 'developer text must not also appear as a USER frame');
    assert.deepEqual(w.turns.map(t => t.source), [1]);
    assert.equal(w.turns[0].text, 'hi');
  });

  it('Chat: developer text-part array joins with the wire newline on protobuf #2', async () => {
    const w = await viaChat([
      { role: 'developer', content: [{ type: 'text', text: 'D1 ' }, { type: 'text', text: 'D2' }] },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, 'D1 \nD2');
    assert.deepEqual(w.turns.map(t => t.source), [1]);
  });

  it('Chat: instruction order is preserved across system/developer/system', async () => {
    const w = await viaChat([
      { role: 'system', content: 'S1' },
      { role: 'developer', content: 'D1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, 'S1\nD1\nS2');
  });

  it('Chat: disabled neutralization keeps the developer text but still promotes it', async () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    const w = await viaChat([{ role: 'developer', content: CC_HEAD + CC_TAIL }, { role: 'user', content: 'hi' }]);
    assert.equal(w.system, CC_HEAD + CC_TAIL, 'off switch must preserve the original text');
    assert.deepEqual(w.turns.map(t => t.source), [1]);
  });

  it('Chat: mixed/non-text developer content is NOT promoted (no silent stringify)', async () => {
    const w = await viaChat([
      { role: 'developer', content: [{ type: 'text', text: 'D1' }, { type: 'unknown_part', value: 1 }] },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, '', 'only an all-text developer content is promotable');
    assert.equal(w.turns[0].source, 1, 'unpromotable developer content keeps the historical USER frame');
    assert.equal(w.turns[0].text, 'D1');
  });

  it('Responses: developer maps to system, matching the declared compatibility', async () => {
    const w = await viaResponses({
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'D1' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    });
    assert.equal(w.system, 'D1');
  });

  it('Responses: developer message string also hoists to protobuf #2', async () => {
    const w = await viaResponses({
      input: [
        { type: 'message', role: 'developer', content: 'D1' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    assert.equal(w.system, 'D1');
  });
});

describe('identity neutralization across the part boundary', () => {
  it('CONTROL: Chat system string containing the CC self-ID is neutralized', async () => {
    const w = await viaChat([{ role: 'system', content: CC_HEAD + CC_TAIL }, { role: 'user', content: 'hi' }]);
    assert.equal(w.system, CC_NEUTRALIZED);
  });

  it('CONTROL: Messages system string containing the CC self-ID is neutralized', async () => {
    const w = await viaMessages({ system: CC_HEAD + CC_TAIL });
    assert.equal(w.system, CC_NEUTRALIZED);
  });

  it('CONTROL: Gemini systemInstruction string containing the CC self-ID is neutralized', async () => {
    const w = await viaGemini({ systemInstruction: CC_HEAD + CC_TAIL });
    assert.equal(w.system, CC_NEUTRALIZED);
  });

  it('CONTROL: Responses instructions string containing the CC self-ID is neutralized', async () => {
    const w = await viaResponses({ instructions: CC_HEAD + CC_TAIL });
    assert.equal(w.system, CC_NEUTRALIZED);
  });

  it('CONTROL: Responses developer message string containing the CC self-ID is neutralized', async () => {
    const w = await viaResponses({
      input: [
        { type: 'message', role: 'developer', content: CC_HEAD + CC_TAIL },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    assert.equal(w.system, CC_NEUTRALIZED);
  });

  it('REGRESSION: Chat system trigger split across two text parts is neutralized', async () => {
    const w = await viaChat([
      { role: 'system', content: [{ type: 'text', text: CC_HEAD }, { type: 'text', text: CC_TAIL }] },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, CC_NEUTRALIZED,
      `a pure-text system turn must be folded to wire text before neutralization; wire kept ${JSON.stringify(w.system)}`);
  });

  it('REGRESSION: Responses developer trigger split across two input_text parts is neutralized', async () => {
    const w = await viaResponses({
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: CC_HEAD }, { type: 'input_text', text: CC_TAIL }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    });
    assert.equal(w.system, CC_NEUTRALIZED,
      `a pure-text system turn must be folded to wire text before neutralization; wire kept ${JSON.stringify(w.system)}`);
  });

  it('CONTROL: Messages joins the system blocks before neutralizing (boundary is transparent)', async () => {
    const w = await viaMessages({ system: [{ type: 'text', text: CC_HEAD }, { type: 'text', text: CC_TAIL }] });
    assert.equal(w.system, CC_NEUTRALIZED);
  });

  it('CONTROL: Gemini joins systemInstruction.parts before neutralizing (boundary is transparent)', async () => {
    const w = await viaGemini({ systemInstruction: { parts: [{ text: CC_HEAD }, { text: CC_TAIL }] } });
    assert.equal(w.system, CC_NEUTRALIZED);
  });
});

describe('instruction-fold controls', () => {
  it('does not mutate body.messages or the caller message objects', async () => {
    const sysParts = [{ type: 'text', text: CC_HEAD }, { type: 'text', text: CC_TAIL }];
    const sys = { role: 'system', content: sysParts };
    const devParts = [{ type: 'text', text: 'D1' }];
    const dev = { role: 'developer', content: devParts };
    const user = { role: 'user', content: 'hi' };
    const messages = [sys, dev, user];
    const snapshot = structuredClone(messages);

    await viaChat(messages);

    assert.deepEqual(messages, snapshot, 'the request body must be byte-identical after the call');
    assert.equal(messages[0], sys);
    assert.equal(messages[1], dev);
    assert.equal(messages[1].role, 'developer');
    assert.equal(sys.content, sysParts, 'the neutralization copy must not replace the caller array');
    assert.equal(dev.content, devParts);
  });

  it('unchanged pure-text system content preserves the original message and array reference', async () => {
    const parts = [{ type: 'text', text: PART_A }, { type: 'text', text: PART_B }];
    const sys = { role: 'system', content: parts };
    await viaChat([sys, { role: 'user', content: 'hi' }]);
    assert.equal(captured[0].messages[0], sys, 'no rewrite => same message object');
    assert.equal(captured[0].messages[0].content, parts, 'no rewrite => same content array');
  });

  it('empty text parts fold to the wire boundary without a rewrite', async () => {
    const parts = [{ type: 'text', text: '' }, { type: 'text', text: '' }];
    const sys = { role: 'system', content: parts };
    const w = await viaChat([sys, { role: 'user', content: 'hi' }]);
    assert.equal(w.system, '\n');
    assert.equal(captured[0].messages[0], sys);
  });

  it('mixed system content keeps the per-part contract (not folded, not stringified)', async () => {
    const w = await viaChat([
      { role: 'system', content: [{ type: 'text', text: CC_HEAD + CC_TAIL }, { type: 'unknown_part', value: 1 }] },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, CC_NEUTRALIZED);
    const sent = captured[0].messages[0].content;
    assert.ok(Array.isArray(sent), 'mixed content must stay an array for the existing helpers');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, CC_NEUTRALIZED);
    assert.deepEqual(sent[1], { type: 'unknown_part', value: 1 });
  });

  it('two independent system messages are neutralized per message, never joined', async () => {
    const w = await viaChat([
      { role: 'system', content: CC_HEAD },
      { role: 'system', content: CC_TAIL },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, `${CC_HEAD}\n${CC_TAIL}`,
      'the builder join is a wire boundary; neutralization must not rewrite across two messages');
    assert.match(w.system, /Claude Code/);
  });

  it('off switch leaves split parts raw but preserves the role mapping', async () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    const w = await viaChat([
      { role: 'system', content: [{ type: 'text', text: CC_HEAD }, { type: 'text', text: CC_TAIL }] },
      { role: 'developer', content: [{ type: 'text', text: CC_HEAD }, { type: 'text', text: CC_TAIL }] },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, `${CC_HEAD}\n${CC_TAIL}\n${CC_HEAD}\n${CC_TAIL}`);
    assert.deepEqual(w.turns.map(t => t.source), [1]);
  });

  it('existing builder collapse option still controls the promoted instruction', async () => {
    process.env.DEVIN_CONNECT_COLLAPSE_SYSTEM = '1';
    const w = await viaChat([{ role: 'developer', content: 'D1' }, { role: 'user', content: 'hi' }]);
    assert.equal(w.system, '');
    assert.equal(w.turns.length, 1);
    assert.equal(w.turns[0].source, 1);
    assert.equal(w.turns[0].text, '<system>\nD1\n</system>\nhi');
  });

  it('promotion happens before prompt composition: the tool preamble precedes it on #2', async () => {
    // runtime-config's default nativeToolCall=true takes the native description-
    // preamble path, which injects into the first system message and then the
    // builder joins the remaining system turns in array order. The promoted
    // developer turn must therefore be AFTER the preamble and still in order.
    const w = await viaChat([
      { role: 'system', content: 'S1' },
      { role: 'developer', content: 'D1' },
      { role: 'user', content: 'hi' },
    ], {
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
    });
    assert.ok(w.system.endsWith('S1\nD1'), `the promoted instruction stays on #2 in order: ${JSON.stringify(w.system)}`);
    assert.ok(w.system.indexOf('### read') >= 0, 'the native tool description preamble was composed');
    assert.ok(w.system.indexOf('### read') < w.system.indexOf('S1\nD1'), 'the preamble precedes the caller instructions');
    assert.equal(w.turns.length, 1);
    assert.equal(w.turns[0].source, 1);
    assert.equal(w.turns[0].text, 'hi');
  });

  it('streaming entry projects the same promoted, folded instruction message', async () => {
    const w = await viaChatStream([
      { role: 'developer', content: [{ type: 'text', text: CC_HEAD }, { type: 'text', text: CC_TAIL }] },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(w.system, CC_NEUTRALIZED);
    assert.deepEqual(w.turns.map(t => t.source), [1]);
    assert.equal(captured[0].messages[0].role, 'system');
  });
});
