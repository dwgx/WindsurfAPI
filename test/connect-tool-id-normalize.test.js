// G6 (Q1 audit §7/§8.3) — a non-Anthropic upstream tool-call id must survive a
// Claude Code round-trip.
//
// The Anthropic Messages API accepts only `^[A-Za-z0-9_-]+$` tool ids, while the
// Connect upstream issues its own dialect (`get_weather:0#<uuid>` on swe-2; the
// audit's example is `call.a:b`). S09 documents the sanitizer this class needs
// (cognition-claude-proxy:44-54). Two things have to hold at once:
//
//   1. the id the CLIENT sees is legal for Anthropic, and
//   2. the tool_result that client sends back maps to the SAME upstream id, or
//      the follow-up turn's native #7 tool_result points at a call the upstream
//      never issued.
//
// The mapping in src/tool-ids.js is reversible and stateless (`call_e1_<base64url>`),
// applied at the egress boundary in devin-connect-openai.js and undone by
// restoreUpstreamToolIds() right before the wire encode. This suite drives the
// REAL chain (handleMessages → handleChatCompletions → devin-connect) with a
// mocked transport, so it fails if any hop drops either half.

process.env.DEVIN_CONNECT = '1';
process.env.DEVIN_CONNECT_TOKEN = 'devin-session-token$toolid.test.jwt.sig';
// Calibrated native tool-call decode tags (VERIFIED constants): the upstream id
// only exists on the native #6 ChatToolCall path.
process.env.DEVIN_CONNECT_TOOL_CALL_TAGS = 'outer=6,id=1,name=2,arguments_json=3';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleMessages } from '../src/handlers/messages.js';
import { __setRequestImpl } from '../src/devin-connect.js';
import { fromClientToolCallId } from '../src/tool-ids.js';
import { writeStringField, writeVarintField, writeMessageField } from '../src/proto.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../src/connect.js';

const MODEL = 'claude-sonnet-4.6';
const UPSTREAM_ID = 'call.a:b';
const ANTHROPIC_ID_RE = /^[A-Za-z0-9_-]+$/;

const TOOLS = [{
  name: 'Read',
  description: 'read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
}];

// #6 ChatToolCall { id=1, name=2, arguments_json=3 } — the descriptor-verified layout.
function toolCallFrame({ id, name, args = '{}' }) {
  return writeMessageField(6, Buffer.concat([
    writeStringField(1, id),
    writeStringField(2, name),
    writeStringField(3, args),
  ]));
}

// One complete upstream turn: the tool call, the FUNCTION_CALL stop reason (10),
// and the mandatory end-of-stream trailer.
const toolCallTurn = () => [
  toolCallFrame({ id: UPSTREAM_ID, name: 'Read', args: '{"path":"a.txt"}' }),
  writeVarintField(5, 10),
];

const textTurn = () => [
  Buffer.concat([writeStringField(3, 'ok'), writeVarintField(5, 2)]),
];

// Captures the framed protobuf this proxy WRITES upstream, so the round-trip is
// asserted on real bytes rather than on a re-derivation of the mapping.
function transport(payloads, captured) {
  return (_opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.write = (buf) => { if (captured) captured.push(Buffer.from(buf)); return true; };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        for (const p of payloads) res.emit('data', wrapEnvelope(p, { compress: false }));
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      });
      cb(res);
    };
    return req;
  };
}

const anthropicRequest = (messages, extra = {}) => ({
  model: MODEL,
  max_tokens: 64,
  stream: false,
  tools: TOOLS,
  messages,
  ...extra,
});

beforeEach(() => {
  __setRequestImpl(null);
});

afterEach(() => {
  __setRequestImpl(null);
});

describe('G6: an upstream tool-call id is normalized for the Anthropic client', () => {
  it('the tool_use id the client sees is legal and reversible', async () => {
    __setRequestImpl(transport(toolCallTurn(), null));
    const r = await handleMessages(anthropicRequest([{ role: 'user', content: 'read a.txt' }]));
    assert.equal(r.status, 200, JSON.stringify(r?.body));

    const use = (r.body?.content || []).find((b) => b?.type === 'tool_use');
    assert.ok(use, `the native #6 call must reach the client: ${JSON.stringify(r.body?.content)}`);
    assert.equal(use.name, 'Read', 'the tool name still round-trips');
    assert.match(use.id, ANTHROPIC_ID_RE,
      `"${use.id}" would be rejected by an Anthropic client (charset ^[A-Za-z0-9_-]+$)`);
    assert.equal(fromClientToolCallId(use.id), UPSTREAM_ID,
      'the client-visible id must decode back to the upstream id (stateless, no process map)');
  });

  it('the follow-up tool_result is encoded with the SAME upstream id', async () => {
    // Turn 1: learn the client-visible id.
    __setRequestImpl(transport(toolCallTurn(), null));
    const first = await handleMessages(anthropicRequest([{ role: 'user', content: 'read a.txt' }]));
    const use = (first.body?.content || []).find((b) => b?.type === 'tool_use');
    assert.ok(use, 'precondition: turn 1 produced a tool_use');
    const clientId = use.id;

    // Turn 2: the client echoes it back in a tool_result. Capture the wire bytes.
    const captured = [];
    __setRequestImpl(transport(textTurn(), captured));
    const second = await handleMessages(anthropicRequest([
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', content: [{ type: 'tool_use', id: clientId, name: 'Read', input: { path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: clientId, content: 'file contents' }] },
    ]));
    assert.equal(second.status, 200, JSON.stringify(second?.body));

    const wire = Buffer.concat(captured);
    assert.ok(wire.length > 0, 'the follow-up turn reached the upstream');
    assert.ok(wire.includes(Buffer.from(UPSTREAM_ID, 'utf8')),
      `the upstream id "${UPSTREAM_ID}" must be restored before the wire encode — a tool_result naming an id the upstream never issued is a protocol error`);
    assert.equal(wire.includes(Buffer.from(clientId, 'utf8')), false,
      'the client-visible id must never reach the upstream');
  });

  it('control: an id that is ALREADY legal passes through byte-identically', async () => {
    const plain = 'call_abc123';
    __setRequestImpl(transport([toolCallFrame({ id: plain, name: 'Read' }), writeVarintField(5, 10)], null));
    const r = await handleMessages(anthropicRequest([{ role: 'user', content: 'read a.txt' }]));
    const use = (r.body?.content || []).find((b) => b?.type === 'tool_use');
    assert.equal(use?.id, plain, 'valid ids are identity — no rewrite on the client-visible leg');
  });
});
