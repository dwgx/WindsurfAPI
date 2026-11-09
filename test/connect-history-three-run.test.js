// G5 (Q1 audit §7/§8.4) — a run of consecutive same-source turns.
//
// Clients that persist streamed output per part (an agent splitting one turn into
// several stored entries) emit runs like [assistant, assistant, assistant]. The
// upstream request validator rejects a same-source run of length >= 3 with a
// misleading `invalid_argument` ("an internal error occurred"); a run of 2 is
// tolerated (verified by wire-shape comparison in the PR #267 review).
//
// `buildGetChatMessageRequest` therefore coalesces consecutive same-source
// text-only turns before wire encoding (devin-connect.js, "Coalesce consecutive
// same-source text-only turns"). Nothing pinned it against the audit's exact
// shape, so this suite drives the real handler, captures what it hands the connect
// layer, encodes the REAL wire request from those params, and counts the encoded
// assistant frames.
//
// The coalescing must be text-preserving and must never merge a turn that carries
// tool_calls / a tool_call_id / reasoning / images — those encode to distinct wire
// types. Both halves are asserted below.

process.env.DEVIN_CONNECT = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const MODEL = 'swe-1-6-slow';
const TOKEN = 'devin-session-token$three-run.test.jwt.sig';
const SOURCE_ASSISTANT = 2; // SOURCE.ASSISTANT in devin-connect.js

function captureParams() {
  const seen = [];
  __setConnectDeps({
    toChatCompletion: async (params) => {
      seen.push(params);
      return {
        status: 200,
        body: {
          id: 'chatcmpl-three-run',
          object: 'chat.completion',
          created: 1,
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      };
    },
  });
  return seen;
}

// The encoded chat sequence: every #3 ChatMessage with its source + text.
function wireTurns(params) {
  const proto = buildGetChatMessageRequest({ ...params, token: TOKEN, env: process.env });
  return getAllFields(parseFields(proto), 3)
    .filter((f) => f.wireType === 2)
    .map((f) => {
      const inner = parseFields(f.value);
      return {
        source: Number(getField(inner, 2, 0)?.value ?? 0),
        text: getField(inner, 3, 2)?.value?.toString('utf8') ?? '',
      };
    });
}

const threeAssistantRun = () => ([
  { role: 'user', content: 'start' },
  { role: 'assistant', content: 'part one' },
  { role: 'assistant', content: 'part two' },
  { role: 'assistant', content: 'part three' },
  { role: 'user', content: 'continue' },
]);

beforeEach(() => {
  __resetConnectDeps();
  process.env.DEVIN_CONNECT = '1';
});

afterEach(() => {
  __resetConnectDeps();
  delete process.env.DEVIN_CONNECT;
});

describe('G5: three consecutive assistant text-only turns', () => {
  it('the request is accepted and reaches the connect layer', async () => {
    const seen = captureParams();
    const r = await handleChatCompletions({ model: MODEL, stream: false, messages: threeAssistantRun() });
    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen.length, 1, 'the request must reach the model, not stop at a request-shape gate');
  });

  it('the outbound body coalesces the run to ONE assistant frame', async () => {
    const seen = captureParams();
    await handleChatCompletions({ model: MODEL, stream: false, messages: threeAssistantRun() });
    const turns = wireTurns(seen[0]);
    const assistants = turns.filter((t) => t.source === SOURCE_ASSISTANT);
    assert.ok(assistants.length <= 2,
      `a same-source run of ${assistants.length} would be rejected by the upstream validator`);
    assert.equal(assistants.length, 1, 'all three parts are text-only, so they merge into one turn');
  });

  it('coalescing preserves the text, in order', async () => {
    const seen = captureParams();
    await handleChatCompletions({ model: MODEL, stream: false, messages: threeAssistantRun() });
    const text = wireTurns(seen[0]).filter((t) => t.source === SOURCE_ASSISTANT).map((t) => t.text).join('\n');
    assert.match(text, /part one/);
    assert.match(text, /part two/);
    assert.match(text, /part three/);
    assert.ok(text.indexOf('part one') < text.indexOf('part two'), 'the merged text keeps its order');
    assert.ok(text.indexOf('part two') < text.indexOf('part three'));
  });

  it('a run of exactly two is also collapsed (below the threshold is still safe)', async () => {
    const seen = captureParams();
    await handleChatCompletions({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'continue' },
      ],
    });
    assert.equal(wireTurns(seen[0]).filter((t) => t.source === SOURCE_ASSISTANT).length, 1);
  });

  it('a turn carrying tool_calls is never merged into its neighbour', async () => {
    // The text-only guard: a tool-carrying assistant turn encodes as structured #6
    // ChatToolCall frames, so merging it into a text turn would delete the call.
    const seen = captureParams();
    await handleChatCompletions({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: 'text before the call' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
        { role: 'user', content: 'continue' },
      ],
    });
    const assistants = wireTurns(seen[0]).filter((t) => t.source === SOURCE_ASSISTANT);
    assert.equal(assistants.length, 2,
      'the tool-carrying turn must stay a separate frame — merging would drop its call');
  });
});
