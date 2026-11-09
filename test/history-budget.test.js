// #136 / #191 — outbound conversation-history budget.
//
// The measured failure: a 113-turn, ~128 KB transcript is accepted and
// forwarded, then the upstream abandons it MID-STREAM with `context deadline
// exceeded`. The caller has partial bytes and no clean retry. Nothing bounded
// the transcript: `CASCADE_MAX_HISTORY_BYTES` trims the Cascade history suffix
// (a prompt-assembly budget), the DEVIN_CONNECT path has no equivalent, and
// neither is an admission check.
//
// The contract pinned here:
//   * the budget has two independent dimensions (turns, payload bytes) and both
//     are configurable; `0` disables a dimension;
//   * exceeding EITHER refuses the request with one local 413 BEFORE backend
//     selection / account acquisition / any upstream call — not mid-stream;
//   * the refusal logs a warning carrying the measured numbers, and the error
//     names the measured value, the budget and the knob.
//
// The handler-level cases drive the REAL handleChatCompletions with the connect
// upstream mocked, so "before the upstream call" is observed (call counter = 0),
// not inferred from the response shape.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { cacheClear } from '../src/cache.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import {
  checkOutboundHistory,
  dominantContributor,
  historyBudgetErrorMessage,
  measureOutboundHistory,
  resolveHistoryBudget,
  DEFAULT_HISTORY_BUDGET_BYTES,
  DEFAULT_HISTORY_BUDGET_TURNS,
  HISTORY_BUDGET_BYTES_ENV,
  HISTORY_BUDGET_ERROR_CODE,
  HISTORY_BUDGET_TURNS_ENV,
} from '../src/history-budget.js';

const CALLER = 'api:test:user:history-budget';
const MODEL = 'swe-1-6-slow';
const ENV_KEYS = [HISTORY_BUDGET_TURNS_ENV, HISTORY_BUDGET_BYTES_ENV];

function savedEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}
function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

// A transcript that ends on a user turn (the answerability guard rejects
// anything else before the budget check could run).
function transcript(turns, contentFor = (i) => `turn ${i}`) {
  return Array.from({ length: turns }, (_, i) => ({
    role: i === turns - 1 || i % 2 === 0 ? 'user' : 'assistant',
    content: contentFor(i),
  }));
}

function nonStream(content = 'ok') {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-history-budget', object: 'chat.completion', created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  };
}

const chatBody = (messages, extra = {}) => ({ model: MODEL, messages, __callerKey: CALLER, ...extra });

describe('measureOutboundHistory', () => {
  it('counts every message as a turn and sums UTF-8 content bytes', () => {
    const measured = measureOutboundHistory([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '中' }, // 3 UTF-8 bytes, 1 UTF-16 code unit
    ]);
    assert.equal(measured.turns, 2, 'system turns ride the wire and count');
    assert.equal(measured.bytes, 6, '3 ASCII + 3 CJK bytes');
  });

  it('counts array text parts, image payloads and tool-call fields', () => {
    const measured = measureOutboundHistory([
      { role: 'user', content: [{ type: 'text', text: 'abc' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ]);
    // 3 + len(data URI) + (6 + 4 + 12) + (6 + 2)
    assert.equal(measured.turns, 3);
    assert.equal(measured.bytes, 3 + 'data:image/png;base64,AAAA'.length + 6 + 4 + 12 + 6 + 2);
  });

  it('counts signed reasoning payload bytes', () => {
    const message = { role: 'assistant', content: null, reasoning_content: 'think', reasoning_signature: 'E'.repeat(4096) };
    assert.equal(measureOutboundHistory([message]).bytes, 5 + 4096);
  });

  it('is total on malformed input (never throws, never counts a missing transcript)', () => {
    const missing = measureOutboundHistory(null);
    assert.equal(missing.turns, 0);
    assert.equal(missing.bytes, 0);
    const malformed = measureOutboundHistory([null, {}, { content: 42 }]);
    assert.equal(malformed.turns, 3);
    assert.equal(malformed.bytes, 0);
  });

  it('counts the tool schemas, not just messages', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
    const toolBytes = JSON.stringify(tools[0]).length;
    const measured = measureOutboundHistory(messages, { tools });
    assert.equal(measured.turns, 1);
    assert.equal(measured.breakdown.messages, 2);
    assert.equal(measured.breakdown.tools, toolBytes);
    assert.equal(measured.bytes, 2 + toolBytes);
  });

  it('an 8.7MB request is measured as 8.7MB, not as its 0.2MB messages slice', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i === 9 ? 'user' : (i % 2 === 0 ? 'user' : 'assistant'),
      content: 'x'.repeat(20 * 1024),
    }));
    const tools = [{ type: 'function', function: { name: 'big', description: 'y'.repeat(8_500_000), parameters: { type: 'object' } } }];
    const measured = measureOutboundHistory(messages, { tools });
    assert.ok(measured.breakdown.messages < 250_000, 'messages are a small slice');
    assert.ok(measured.bytes > DEFAULT_HISTORY_BUDGET_BYTES, `total ${measured.bytes} must exceed the 8MB budget`);
    assert.equal(dominantContributor(measured.breakdown).name, 'tools');
  });
});

describe('resolveHistoryBudget', () => {
  it('defaults to the measured-failure ceiling for turns and the ingress-cap safety net for bytes', () => {
    const budget = resolveHistoryBudget({ env: {} });
    assert.equal(budget.maxTurns, DEFAULT_HISTORY_BUDGET_TURNS);
    assert.equal(budget.maxBytes, DEFAULT_HISTORY_BUDGET_BYTES);
    assert.ok(DEFAULT_HISTORY_BUDGET_TURNS < 113,
      'the default turn ceiling must sit below the measured 113-turn mid-stream death');
  });

  it('reads both dimensions from the environment', () => {
    const budget = resolveHistoryBudget({ env: { [HISTORY_BUDGET_TURNS_ENV]: '7', [HISTORY_BUDGET_BYTES_ENV]: '1234' } });
    assert.deepEqual(budget, { maxTurns: 7, maxBytes: 1234 });
  });

  it('treats 0 as "disabled" and a malformed value as "use the default"', () => {
    assert.deepEqual(
      resolveHistoryBudget({ env: { [HISTORY_BUDGET_TURNS_ENV]: '0', [HISTORY_BUDGET_BYTES_ENV]: '0' } }),
      { maxTurns: 0, maxBytes: 0 },
    );
    assert.deepEqual(
      resolveHistoryBudget({ env: { [HISTORY_BUDGET_TURNS_ENV]: 'lots', [HISTORY_BUDGET_BYTES_ENV]: '-5' } }),
      { maxTurns: DEFAULT_HISTORY_BUDGET_TURNS, maxBytes: DEFAULT_HISTORY_BUDGET_BYTES },
      'a typo must not silently disable the guard',
    );
  });
});

describe('checkOutboundHistory', () => {
  const env = { [HISTORY_BUDGET_TURNS_ENV]: '3', [HISTORY_BUDGET_BYTES_ENV]: '100' };

  it('passes at the boundary and fails one turn past it', () => {
    assert.equal(checkOutboundHistory(transcript(3), { env }).ok, true);
    const over = checkOutboundHistory(transcript(4), { env });
    assert.equal(over.ok, false);
    assert.equal(over.overTurns, true);
    assert.equal(over.overBytes, false);
  });

  it('fails on bytes alone', () => {
    const over = checkOutboundHistory([{ role: 'user', content: 'x'.repeat(101) }], { env });
    assert.equal(over.ok, false);
    assert.equal(over.overTurns, false);
    assert.equal(over.overBytes, true);
  });

  it('counts tools toward the byte budget even when messages are small', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const tools = [{ type: 'function', function: { name: 'f', parameters: { description: 'x'.repeat(200) } } }];
    const over = checkOutboundHistory(messages, { env, tools });
    assert.equal(over.ok, false);
    assert.equal(over.overBytes, true);
    assert.equal(over.measured.breakdown.tools > 100, true);
  });

  it('names the dominant contributor in the refusal', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const tools = [{ type: 'function', function: { name: 'f', parameters: { description: 'x'.repeat(200) } } }];
    const over = checkOutboundHistory(messages, { env, tools });
    const message = historyBudgetErrorMessage(over);
    assert.match(message, /Largest contributor: tool schemas/);
    assert.match(message, /of history \(budget/);
    assert.match(message, /WINDSURFAPI_HISTORY_BUDGET_BYTES/);
  });

  it('reports both dimensions when both are exceeded', () => {
    const over = checkOutboundHistory(transcript(4, () => 'x'.repeat(60)), { env });
    assert.equal(over.overTurns, true);
    assert.equal(over.overBytes, true);
  });

  it('a disabled dimension is never exceeded', () => {
    const disabled = { [HISTORY_BUDGET_TURNS_ENV]: '0', [HISTORY_BUDGET_BYTES_ENV]: '0' };
    assert.equal(checkOutboundHistory(transcript(500), { env: disabled }).ok, true);
  });

  it('the error names the measured value, the budget and the knob', () => {
    const over = checkOutboundHistory(transcript(4), { env });
    const message = historyBudgetErrorMessage(over);
    assert.match(message, /4 messages \(budget 3, WINDSURFAPI_HISTORY_BUDGET_TURNS\)/);
    assert.match(message, /refused before it was sent/);
  });
});

describe('handleChatCompletions refuses an over-budget transcript before the upstream call', () => {
  let saved;
  let savedConnect;
  let accountId = null;
  let calls = 0;

  beforeEach(() => {
    saved = savedEnv();
    savedConnect = process.env.DEVIN_CONNECT;
    process.env.DEVIN_CONNECT = '1';
    cacheClear();
    calls = 0;
    accountId = addAccountByKey(`devin-session-token$history-budget-${Math.random().toString(36).slice(2)}`, 'history-budget-test').id;
    __setConnectDeps({
      toChatCompletion: async () => { calls += 1; return nonStream(); },
    });
  });

  afterEach(() => {
    __resetConnectDeps();
    cacheClear();
    if (accountId) removeAccount(accountId);
    accountId = null;
    if (savedConnect === undefined) delete process.env.DEVIN_CONNECT;
    else process.env.DEVIN_CONNECT = savedConnect;
    restoreEnv(saved);
  });

  it('refuses 101 turns with 413 and never calls the upstream', async () => {
    const res = await handleChatCompletions(chatBody(transcript(101)), { callerKey: CALLER });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.type, 'payload_too_large');
    assert.equal(res.body.error.param, 'messages');
    assert.equal(res.body.error.code, HISTORY_BUDGET_ERROR_CODE);
    assert.match(res.body.error.message, /101 messages/);
    assert.match(res.body.error.message, new RegExp(HISTORY_BUDGET_TURNS_ENV));
    assert.equal(calls, 0, 'the refusal must land before any upstream call');
  });

  it('serves a transcript at the default turn ceiling (no off-by-one)', async () => {
    const res = await handleChatCompletions(chatBody(transcript(DEFAULT_HISTORY_BUDGET_TURNS)), { callerKey: CALLER });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls, 1);
  });

  it('logs a warning carrying the measured numbers when it refuses', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      const res = await handleChatCompletions(chatBody(transcript(101)), { callerKey: CALLER });
      assert.equal(res.status, 413);
    } finally {
      console.warn = originalWarn;
    }
    const line = warnings.find((w) => w.includes('outbound history over budget'));
    assert.ok(line, `the refusal must be visible in the log, saw: ${warnings.join(' | ')}`);
    assert.match(line, /turns=101\/100/);
    assert.match(line, /rejecting before the upstream call/);
  });

  it('refuses a streaming request before the stream starts (not mid-stream)', async () => {
    // The reported failure is a stream that dies after partial bytes. A refusal
    // must be a plain JSON error with no stream handler attached.
    const res = await handleChatCompletions(chatBody(transcript(101), { stream: true }), { callerKey: CALLER });
    assert.equal(res.status, 413);
    assert.equal(res.stream, undefined, 'a refusal must not open an SSE stream');
    assert.equal(calls, 0);
  });

  it('counts tools: an 8.7MB request is refused naming the tool schemas, not "0.2 MB"', async () => {
    const messages = transcript(10, () => 'x'.repeat(20 * 1024));
    const tools = [{
      type: 'function',
      function: {
        name: 'big_schema',
        description: 'y'.repeat(8_500_000),
        parameters: { type: 'object', properties: { blob: { type: 'string' } } },
      },
    }];
    const res = await handleChatCompletions(chatBody(messages, { tools }), { callerKey: CALLER });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, HISTORY_BUDGET_ERROR_CODE);
    assert.match(res.body.error.message, /Largest contributor: tool schemas/);
    assert.doesNotMatch(res.body.error.message, /0\.2 MB of history/);
    assert.equal(calls, 0, 'the refusal must land before any upstream call');
  });

  it('refuses before account acquisition: an empty pool gets the 413, not a pool 429', async () => {
    // The check must sit above account selection, otherwise the caller would
    // get a pool-exhausted 429 for a request that can never be forwarded.
    removeAccount(accountId);
    accountId = null;
    const res = await handleChatCompletions(chatBody(transcript(101)), { callerKey: CALLER });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, HISTORY_BUDGET_ERROR_CODE);
    assert.equal(calls, 0);
  });

  it('honours a raised byte budget and refuses the same transcript at a lower one', async () => {
    const messages = transcript(2, (i) => (i === 1 ? 'y'.repeat(2048) : 'hi'));
    process.env[HISTORY_BUDGET_BYTES_ENV] = '1024';
    const refused = await handleChatCompletions(chatBody(messages), { callerKey: CALLER });
    assert.equal(refused.status, 413);
    assert.equal(refused.body.error.code, HISTORY_BUDGET_ERROR_CODE);
    assert.match(refused.body.error.message, new RegExp(HISTORY_BUDGET_BYTES_ENV));
    assert.equal(calls, 0);

    process.env[HISTORY_BUDGET_BYTES_ENV] = '4096';
    const served = await handleChatCompletions(chatBody(messages), { callerKey: CALLER });
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.equal(calls, 1);
  });

  it('a lowered turn budget refuses at once; 0 disables the guard', async () => {
    process.env[HISTORY_BUDGET_TURNS_ENV] = '4';
    const refused = await handleChatCompletions(chatBody(transcript(5)), { callerKey: CALLER });
    assert.equal(refused.status, 413);
    assert.equal(calls, 0);

    process.env[HISTORY_BUDGET_TURNS_ENV] = '0';
    process.env[HISTORY_BUDGET_BYTES_ENV] = '0';
    const served = await handleChatCompletions(chatBody(transcript(101)), { callerKey: CALLER });
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.equal(calls, 1);
  });
});
