// Stage E: WINDSURFAPI_LEAK_TRACE — structured reasoning/content boundary logs.
//
// The gate is read per call (leakTraceEnabled()), so a single file toggles
// process.env.WINDSURFAPI_LEAK_TRACE between tests. Logger stub style follows
// test/retry-rescue-budget-split.test.js (message-first variadic log), except
// the fields object is JSON-stringified so field-level assertions work (the
// repo sample flattens objects to '[object Object]').
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { log } from '../src/config.js';
import { handleChatCompletions, __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { toChatCompletion, __setStreamChatForTest } from '../src/devin-connect-openai.js';

let captured = [];
const originalInfo = log.info;
const originalWarn = log.warn;

function captureLogs() {
  captured = [];
  log.info = (...args) => captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  log.warn = (...args) => captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
}
const leakLines = () => captured.filter((l) => l.includes('LEAK_TRACE'));
const sseFrame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function fakeStreamRes() {
  const listeners = new Map();
  return {
    body: '', writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

beforeEach(() => {
  __resetConnectDeps();
  __setStreamChatForTest(null);
  captureLogs();
});

afterEach(() => {
  log.info = originalInfo;
  log.warn = originalWarn;
  __resetConnectDeps();
  __setStreamChatForTest(null);
  delete process.env.WINDSURFAPI_LEAK_TRACE;
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS;
});

// --- devin-connect-openai.js: raw stream events at the channel boundary ---

it('gate ON: raw stream events logged with channel/think/sample/reqId/account', async () => {
  process.env.WINDSURFAPI_LEAK_TRACE = '1';
  process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
  __setStreamChatForTest(async function* () {
    yield { type: 'reasoning', text: 'let me think </thinking>' };
    yield { type: 'content', text: 'x'.repeat(500) };
    yield { type: 'finish', reason: 'stop' };
  });
  const out = await toChatCompletion({ model: 'm' }, { reqId: 'r1', account: 'acc-1' });
  assert.equal(out.body.choices[0].message.content, 'x'.repeat(500));
  const lines = leakLines();
  assert.equal(lines.length, 2, 'one stream-event line per text-bearing event');
  const reasoning = lines.find((l) => l.includes('"channel":"reasoning"'));
  const content = lines.find((l) => l.includes('"channel":"content"'));
  assert.ok(reasoning, 'reasoning event logged');
  assert.ok(content, 'content event logged');
  assert.ok(reasoning.includes('LEAK_TRACE stream-event'), 'message prefix');
  assert.ok(reasoning.includes('"think":["</thinking>"]'), 'think marker detected');
  assert.ok(content.includes('"len":500'), 'len field');
  assert.ok(content.includes('"sample":"') && content.includes('…'), 'sample truncated');
  assert.ok(content.includes('"reqId":"r1"') && content.includes('"account":"acc-1"'), 'reqId/account threaded via opts');
});

it('gate OFF: zero LEAK_TRACE lines on the same hot path', async () => {
  delete process.env.WINDSURFAPI_LEAK_TRACE;
  process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
  __setStreamChatForTest(async function* () {
    yield { type: 'reasoning', text: 'think hard' };
    yield { type: 'content', text: 'answer' };
    yield { type: 'finish', reason: 'stop' };
  });
  await toChatCompletion({ model: 'm' }, { reqId: 'r1', account: 'acc-1' });
  assert.equal(leakLines().length, 0, 'no leak-trace lines when WINDSURFAPI_LEAK_TRACE is off');
});

// --- messages.js: block classification / rerouting decisions ---

it('gate ON: messages.js classify + block-start logs with channel/reqId fields', async () => {
  process.env.WINDSURFAPI_LEAK_TRACE = '1';
  const fakeUpstream = async (body, ctx) => ({
    status: 200,
    stream: true,
    handler: async (captureRes) => {
      captureRes.write(sseFrame({ choices: [{ delta: { role: 'assistant' } }] }));
      captureRes.write(sseFrame({ choices: [{ delta: { reasoning_content: 'deep think </thinking>' } }] }));
      captureRes.write(sseFrame({ choices: [{ delta: { content: 'hi there' } }] }));
      captureRes.write(sseFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      captureRes.write('data: [DONE]\n\n');
    },
  });
  const result = await handleMessages(
    { model: 'm', stream: true, messages: [{ role: 'user', content: 'q' }], max_tokens: 10 },
    { handleChatCompletions: fakeUpstream, reqId: 'r1', conversation_id: 'c1' },
  );
  const res = fakeStreamRes();
  await result.handler(res);
  const lines = leakLines();
  assert.ok(lines.some((l) => l.includes('LEAK_TRACE classify') && l.includes('"channel":"reasoning"')), 'reasoning classification logged');
  assert.ok(lines.some((l) => l.includes('LEAK_TRACE classify') && l.includes('"channel":"content"')), 'content classification logged');
  assert.ok(lines.some((l) => l.includes('LEAK_TRACE block-start')), 'block-start logged');
  assert.ok(lines.some((l) => l.includes('"reqId":"r1"')), 'reqId threaded into translator');
  assert.ok(lines.some((l) => l.includes('"think":["</thinking>"]')), 'think marker in reasoning sample');
});

// --- chat.js: settle summary (what went to content vs reasoning) ---

it('gate ON: chat.js streamResponse settle log with content/reasoning sizes', async () => {
  process.env.WINDSURFAPI_LEAK_TRACE = '1';
  process.env.DEVIN_CONNECT = '1';
  const key = `leak-trace-token-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, 'leak-trace');
  try {
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: params.model, choices: [{ index: 0, delta: { reasoning_content: 'deep reasoning' }, finish_reason: null }] });
        send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: params.model, choices: [{ index: 0, delta: { content: 'hello world' }, finish_reason: null }] });
        return { id: 'c1', object: 'chat.completion.chunk', created: 1, model: params.model, content: 'hello world', reasoning: 'deep reasoning', finish_reason: 'stop', usage: { total_tokens: 9 }, billing: {} };
      },
    });
    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeStreamRes();
    await result.handler(res);
    const settle = leakLines().find((l) => l.includes('LEAK_TRACE settle'));
    assert.ok(settle, 'settle log present');
    assert.ok(settle.includes('"contentChars":11'), `content size 11 (hello world), got: ${settle}`);
    assert.ok(settle.includes('"reasoningChars":14'), `reasoning size 14 (deep reasoning), got: ${settle}`);
    assert.ok(settle.includes('"rerouted":false'), 'reroute flag false');
    assert.ok(settle.includes('"reqId":'), 'reqId in settle fields');
  } finally {
    removeAccount(acct.id);
  }
});
