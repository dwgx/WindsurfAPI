// P2b (external Devin audit, SWE-2 Flash) — ROUTE-LEVEL matrix for the
// "explicit upstream ERROR + decodable tool call" turn.
//
// The adapter-level guard is pinned in test/connect-stop-reason-truncation.test.js
// (`terminalError` snapshot → 'error' re-asserted after the tool-call arms). That
// guard only matters if each protocol route actually STOPS presenting the turn as
// a clean, executable tool call — and this repo has a documented history of fixes
// that covered one route and silently missed the other three
// (docs/HANDOFF-2026-07-27.md §v3.9.2-v3.9.3, "修复只覆盖部分路径" ×4).
//
// So every route is driven end-to-end through the REAL connect adapter over a
// mocked transport (no network: setup-env installs the fail-closed guard and
// `__setRequestImpl` replaces the transport). The upstream sends a valid #6
// ChatToolCall followed by stop reason 13 (ERROR).
//
// The invariant, identical on all four: the turn must NOT come back as a
// successful, tool-call-shaped answer. Exact error codes are deliberately not
// pinned — the routes own their shapes (529 / 503 / response.failed); what must
// never regress is "clean tool_use with finish STOP".
//
// Note on the negative direction: a route that returns 200 is checked too, so a
// future change that "fixes" the status but re-labels the turn as a normal
// tool call still fails here.

process.env.DEVIN_CONNECT = '1';
process.env.DEVIN_CONNECT_TOKEN = 'devin-session-token$errmatrix.jwt.sig';
process.env.DEVIN_CONNECT_TOOL_CALL_TAGS = 'outer=6,id=1,name=2,arguments_json=3';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleGemini } from '../src/handlers/gemini.js';
import { __setRequestImpl } from '../src/devin-connect.js';
import { writeStringField, writeVarintField, writeMessageField } from '../src/proto.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../src/connect.js';

const MODEL = 'swe-1-6-slow';
const CONTEXT = { callerKey: 'errmatrix:caller' };

// #6 ChatToolCall { id=1, name=2, arguments_json=3 } — a call the proxy can decode.
const toolCallFrame = () => writeMessageField(6, Buffer.concat([
  writeStringField(1, 'call_1'),
  writeStringField(2, 'Read'),
  writeStringField(3, '{}'),
]));

// A complete, well-formed stream: one decodable call, then the upstream's ERROR
// stop reason, then the mandatory end-of-stream trailer.
function errorTurnTransport() {
  return (_opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        res.emit('data', wrapEnvelope(toolCallFrame(), { compress: false }));
        res.emit('data', wrapEnvelope(writeVarintField(5, 13), { compress: false }));
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      });
      cb(res);
    };
    return req;
  };
}

const openaiTools = [{ type: 'function', function: { name: 'Read', description: 'read', parameters: { type: 'object' } } }];
const anthropicTools = [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }];

afterEach(() => __setRequestImpl(null));

describe('P2b matrix: an ERROR turn with a tool call is never a clean tool_use', () => {
  it('/v1/chat/completions reports finish_reason "error"', async () => {
    __setRequestImpl(errorTurnTransport());
    const r = await handleChatCompletions({
      model: MODEL,
      stream: false,
      tools: openaiTools,
      messages: [{ role: 'user', content: 'read a.txt' }],
    }, CONTEXT);
    const choice = r.body?.choices?.[0];
    assert.notEqual(choice?.finish_reason, 'tool_calls',
      'a failed turn must not advertise executable arguments');
    assert.equal(choice?.finish_reason, 'error');
  });

  it('/v1/messages does not hand Claude Code a tool_use block', async () => {
    __setRequestImpl(errorTurnTransport());
    const r = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 64,
      tools: anthropicTools,
      messages: [{ role: 'user', content: 'read a.txt' }],
    }, CONTEXT);
    if (r.status === 200) {
      const blocks = (r.body?.content || []).map((b) => b?.type);
      assert.equal(blocks.includes('tool_use'), false,
        `a failed turn must not deliver a tool_use block (got ${blocks.join(',')})`);
    } else {
      assert.ok(r.status >= 400, `unexpected status ${r.status}`);
    }
  });

  it('/v1/responses does not close the turn as completed', async () => {
    __setRequestImpl(errorTurnTransport());
    const r = await handleResponses({
      model: MODEL,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'read a.txt' }] }],
      tools: [{ type: 'function', name: 'Read', description: 'read', parameters: { type: 'object' } }],
    }, CONTEXT);
    if (r.status === 200) {
      assert.notEqual(r.body?.status, 'completed',
        'a failed turn must not be reported as a completed response');
    } else {
      assert.ok(r.status >= 400, `unexpected status ${r.status}`);
    }
  });

  it('/v1beta gemini does not report STOP with a functionCall', async () => {
    __setRequestImpl(errorTurnTransport());
    const r = await handleGemini(MODEL, {
      contents: [{ role: 'user', parts: [{ text: 'read a.txt' }] }],
      tools: [{ functionDeclarations: [{ name: 'Read', description: 'read', parameters: { type: 'object' } }] }],
    }, CONTEXT);
    if (r.status === 200) {
      const cand = r.body?.candidates?.[0];
      assert.notEqual(cand?.finishReason, 'STOP',
        'a failed turn must not report a clean STOP');
    } else {
      assert.ok(r.status >= 400, `unexpected status ${r.status}`);
    }
  });
});
