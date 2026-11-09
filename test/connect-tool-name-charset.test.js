// G1 (Q1 audit §7/§8.1) — the OpenAI Chat surface must sanitize tool names to
// the upstream charset BEFORE the wire.
//
// The upstream accepts only `^[A-Za-z0-9_-]{1,64}$` and answers anything else
// with a MISLEADING `invalid_argument` ("an internal error occurred") in the
// middle of the stream (S01 docs/upstream-protocol.md:172: `a.b` / `mcp::x` /
// `a-b_c.d` / non-ASCII all reject; `mcp__a__b` is legal). Because the error text
// says "internal error", users report it as a proxy bug.
//
// messages.js (Anthropic) and responses.js have built a reversible
// `buildToolNameMap` since tool hygiene shipped; `src/handlers/chat.js` never
// imported it. This suite pins the Chat surface:
//
//   * every name the wire layer receives is legal;
//   * a name that was already legal is byte-identical (`mcp__a__b`);
//   * the rewrite is REVERSIBLE — the client gets its own spelling back;
//   * history and a forced `tool_choice` are rewritten with the same map, so a
//     follow-up turn cannot name a tool the declarations do not advertise.

process.env.DEVIN_CONNECT = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const MODEL = 'swe-1-6-slow';
const WIRE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const fnTool = (name) => ({
  type: 'function',
  function: {
    name,
    description: `the ${name} tool`,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
});

// The exact inventory from the audit: two illegal spellings, one legal name that
// sanitizes INTO another illegal name's shape, and a space.
const TOOLS = [fnTool('mcp::x'), fnTool('a.b'), fnTool('mcp__a__b'), fnTool('tool with space')];

const body = (extra = {}) => ({
  model: MODEL,
  stream: false,
  messages: [{ role: 'user', content: 'read the file' }],
  tools: TOOLS,
  ...extra,
});

function captureParams(outBody) {
  const seen = [];
  __setConnectDeps({
    toChatCompletion: async (params) => { seen.push(params); return { status: 200, body: outBody(params) }; },
  });
  return seen;
}

const okBody = (calls) => ({
  id: 'chatcmpl-charset',
  object: 'chat.completion',
  created: 1,
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const names = (tools) => tools.map((t) => t?.function?.name || t?.name);

beforeEach(() => {
  __resetConnectDeps();
  // Read live by selectBackend() → getBackendSwitch(), so per-test is enough and
  // an `afterEach` that clears it cannot leak into the next case.
  process.env.DEVIN_CONNECT = '1';
  // The native ToolDef encoder is the real wire (`#10`); it is inert unless the
  // tag map is calibrated, so pin the verified constants for this suite.
  process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = 'outer=10,name=1,description=2,parameters=3';
});

afterEach(() => {
  __resetConnectDeps();
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
});

describe('G1: OpenAI Chat tool names are rewritten to the upstream charset', () => {
  it('every declared name handed to the connect layer is legal, and legal names are untouched', async () => {
    const seen = captureParams(() => okBody([]));
    const r = await handleChatCompletions(body());
    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen.length, 1, 'the request must reach the connect layer');

    const wire = names(seen[0].tools);
    assert.equal(wire.length, TOOLS.length, 'no tool may be dropped by the rewrite');
    for (const name of wire) {
      assert.match(name, WIRE_NAME_RE, `"${name}" would trip the upstream invalid_argument`);
    }
    // Deterministic, readable rewrites of the audit's inputs.
    assert.deepEqual(wire, ['mcp__x', 'a_b', 'mcp__a__b', 'tool_with_space']);
    assert.ok(wire.includes('mcp__a__b'), 'an already-legal name must stay byte-identical');
    assert.equal(new Set(wire).size, wire.length, 'the map must be collision-free');
  });

  it('the #10 ToolDef frames on the real wire carry only legal names', async () => {
    const seen = captureParams(() => okBody([]));
    await handleChatCompletions(body());

    const proto = buildGetChatMessageRequest({
      ...seen[0],
      token: 'devin-session-token$charset.jwt.sig',
      env: process.env,
    });
    const defs = getAllFields(parseFields(proto), 10).filter((f) => f.wireType === 2);
    assert.equal(defs.length, TOOLS.length, 'every tool must ride the wire');
    for (const def of defs) {
      const name = getField(parseFields(def.value), 1, 2)?.value?.toString('utf8');
      assert.match(name || '', WIRE_NAME_RE, `ToolDef name "${name}" is not legal upstream`);
    }
  });

  it('the prompt preamble advertises the WIRE names, not the caller spellings', async () => {
    // The preamble is the only place the model learns the names it may call, so it
    // must agree with the #10 ToolDefs. A heading is the declaration; a description
    // quoting the caller's original text is just prose and stays untouched.
    const seen = captureParams(() => okBody([]));
    await handleChatCompletions(body());
    const text = seen[0].messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const headings = [...text.matchAll(/^### (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, ['mcp__x', 'a_b', 'mcp__a__b', 'tool_with_space'],
      'the model must be told the names the wire will accept');
    for (const h of headings) assert.match(h, WIRE_NAME_RE);
  });

  it('the client gets its own spelling back on the response', async () => {
    // The upstream answers with the WIRE name (that is what the model was told);
    // the caller declared `mcp::x` and must see `mcp::x`.
    const seen = captureParams(() => okBody([
      { id: 'call_1', type: 'function', function: { name: 'mcp__x', arguments: '{"q":"a"}' } },
    ]));
    const r = await handleChatCompletions(body());
    const call = r.body?.choices?.[0]?.message?.tool_calls?.[0];
    assert.equal(call?.function?.name, 'mcp::x', 'the reverse leg must restore the caller name');
    assert.equal(seen[0].tools.find((t) => t.function.name === 'mcp__x')?.function?.name, 'mcp__x');
  });

  it('a forced tool_choice names the same tool the declarations advertise', async () => {
    const seen = captureParams(() => okBody([]));
    const r = await handleChatCompletions(body({ tool_choice: { type: 'function', function: { name: 'a.b' } } }));
    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen[0].toolChoice?.function?.name, 'a_b',
      'a forced call must not name a tool the upstream considers undeclared');
  });

  it('history tool_calls are rewritten with the same map (native #6 replay)', async () => {
    const seen = captureParams(() => okBody([]));
    const r = await handleChatCompletions(body({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'a.b', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
        { role: 'user', content: 'now summarise' },
      ],
    }));
    assert.equal(r.status, 200, JSON.stringify(r?.body));
    const historyCalls = seen[0].messages
      .filter((m) => m?.role === 'assistant' && Array.isArray(m.tool_calls))
      .flatMap((m) => m.tool_calls);
    assert.equal(historyCalls.length, 1, 'the replayed call must survive normalization');
    assert.equal(historyCalls[0].function.name, 'a_b',
      'a replayed assistant call is re-encoded upstream, so it must carry the wire name');
  });

  it('a request whose names are already legal is left byte-identical', async () => {
    const seen = captureParams(() => okBody([]));
    const legal = [fnTool('mcp__a__b'), fnTool('shell_command')];
    const r = await handleChatCompletions(body({ tools: legal }));
    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.deepEqual(names(seen[0].tools), ['mcp__a__b', 'shell_command']);
  });

  it('collides safely: a caller name that sanitizes onto a declared legal name gets a suffix', async () => {
    // `mcp::x` sanitizes to `mcp__x`; if the caller ALSO declared `mcp__x`, the
    // legal name must keep its bytes and the invalid one must move aside.
    const seen = captureParams(() => okBody([]));
    const r = await handleChatCompletions(body({ tools: [fnTool('mcp::x'), fnTool('mcp__x')] }));
    assert.equal(r.status, 200, JSON.stringify(r?.body));
    const wire = names(seen[0].tools);
    assert.deepEqual(wire, ['mcp__x_2', 'mcp__x'],
      'the already-legal name keeps its exact bytes; the rewritten one must not steal it');
  });
});

// ─── P3 (review): the reverse leg on the STREAM path ───────────────────────
//
// The non-stream restore is asserted above. A streamed tool call is the shape
// every agent client actually sees, and its name rides `delta.tool_calls[].function.name`
// — a different code path (the `send` wrapper) from the completion body.
describe('G1: the streamed reverse leg restores the caller name', () => {
  function fakeRes() {
    const listeners = new Map();
    const state = { body: '', writableEnded: false };
    const res = {
      get writableEnded() { return state.writableEnded; },
      get body() { return state.body; },
      write(chunk) { state.body += String(chunk); return true; },
      end(chunk) { if (chunk) res.write(chunk); state.writableEnded = true; },
      on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return res; },
      once(event, cb) { const wrap = (...a) => { res.removeListener(event, wrap); cb(...a); }; res.on(event, wrap); },
      removeListener(event, cb) {
        const list = listeners.get(event) || [];
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      },
      emit(event, ...args) { for (const cb of [...(listeners.get(event) || [])]) cb(...args); },
    };
    return res;
  }

  it('a streamed delta carrying the wire name reaches the client with the caller name', async () => {
    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        seen.push(params);
        send({
          id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: MODEL,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'mcp__x', arguments: '{}' } }] },
            finish_reason: null,
          }],
        });
        send({
          id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
        return { content: '', delivered: '', reasoning: '', toolCalls: [{ id: 'call_1', name: 'mcp__x', argumentsJson: '{}' }], finish_reason: 'tool_calls', usage: null };
      },
    });

    const result = await handleChatCompletions(body({ stream: true }));
    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);

    const frames = res.body.split('\n\n').filter(Boolean)
      .map((f) => f.replace(/^data: /, ''))
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f));
    const callDelta = frames.flatMap((f) => f.choices || [])
      .find((c) => c?.delta?.tool_calls?.length);
    assert.equal(callDelta?.delta?.tool_calls?.[0]?.function?.name, 'mcp::x',
      'the streamed reverse leg must restore the caller name, not leak the wire name');
    assert.equal(res.body.includes('"name":"mcp__x"'), false,
      'the wire name must never reach the client');
    // The upstream leg really was given the wire name.
    assert.equal(seen[0].tools.find((t) => t.function.name === 'mcp__x')?.function?.name, 'mcp__x');
  });
});

// ─── P2 (review): session continuity across a rewritten tool call ──────────
//
// `session-continuity.canonicalize()` hashes the tool NAME. The pair committed
// after turn 1 and the `connectMessages` of turn 2 must therefore use the same
// spelling. Turn 2's history is renamed to the WIRE name before the wire, so the
// commit has to be wire-named too — otherwise `resolveConnectSessionId` never
// matches and a brand-new session_id is minted after every rewritten call, which
// the upstream reads as a fresh conversation (velocity limiter / prompt cache).
describe('G1 × session continuity: a rewritten tool call still reuses the session', () => {
  it('turn 2 resolves to the session_id turn 1 committed', async () => {
    const continuity = await import('../src/session-continuity.js');
    continuity._resetForTests();
    process.env.DEVIN_CONNECT_SESSION_REUSE = '1';

    const sessions = [];
    const okWithCall = () => ({
      status: 200,
      body: {
        id: 'chatcmpl-cont', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp__x', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });

    try {
      __setConnectDeps({
        toChatCompletion: async (params) => {
          sessions.push(params.sessionId);
          return okWithCall();
        },
      });

      // Turn 1: declares the invalid name, gets a call back (wire name upstream).
      const first = await handleChatCompletions(body({ tools: [fnTool('mcp::x')] }), { callerKey: 'session:charset-cont' });
      assert.equal(first.status, 200, JSON.stringify(first?.body));
      assert.equal(first.body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, 'mcp::x');

      // Turn 2: the client echoes its own spelling in the history. The dialog is
      // prefixed with a fresh instruction turn (an agent that prepends a new
      // directive before continuing) so the ROOT-ANCHOR fallback cannot rescue the
      // lookup: session-continuity falls back to the dialog's FIRST input turn when
      // no pair hash matches, which would reuse the id even with a broken pair
      // chain and make this assertion vacuous. With the prefix, only real pair
      // evidence can produce the same id — which is exactly what the name spelling
      // decides.
      const second = await handleChatCompletions(body({
        tools: [fnTool('mcp::x')],
        messages: [
          { role: 'user', content: 'NEW INSTRUCTION: keep going' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'read the file' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp::x', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
          { role: 'user', content: 'now summarise' },
        ],
      }), { callerKey: 'session:charset-cont' });
      assert.equal(second.status, 200, JSON.stringify(second?.body));

      assert.equal(sessions.length, 2);
      assert.ok(sessions[0], 'turn 1 minted a session id');
      assert.equal(sessions[1], sessions[0],
        'a rewritten tool name must not break pair-chain reuse — the commit and the next turn must agree on the spelling');
    } finally {
      delete process.env.DEVIN_CONNECT_SESSION_REUSE;
      continuity._resetForTests();
    }
  });
});
