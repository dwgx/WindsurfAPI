// Two ways the Responses chain broke for ordinary clients, both live-reproduced.
//
// 1. SCOPE CHURN (was a blocker). `previous_response_id` used to feed the
//    callerKey derivation. It changes every turn, so turn 1 (without it) and
//    turn 2 (with it) derived DIFFERENT callerKeys — and the response store keys
//    its per-caller isolation on exactly that. A standard OpenAI SDK client, which
//    sends neither `user` nor `prompt_cache_key`, therefore got
//    `404 response_not_found` on every chained turn: the headline feature of the
//    release was broken for its most common caller shape.
//
// 2. EMPTY INPUT reaching the upstream. /v1/chat/completions and /v1/messages both
//    reject an empty conversation locally (server.js:562, :712). This route
//    forwarded it, the upstream answered "an internal error occurred (trace ID …)"
//    → UPSTREAM_INTERNAL → reportInternalError, and two consecutive of those
//    quarantine the account for two minutes. So any authenticated caller — or a
//    client bug, or an empty prompt box — could walk a multi-account pool offline.
//    Live-confirmed before the fix: {input:[]} produced a trace ID (i.e. really hit
//    the upstream) and a 503, while the sibling routes returned 400 locally.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractBodyCallerSubKey } from '../src/caller-key.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { resetResponseStore } from '../src/response-store.js';

function recorder(reply = 'ok') {
  const seen = [];
  return {
    seen,
    handler: async (body) => {
      seen.push(body);
      return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: reply } }] } };
    },
  };
}
const userTurn = (text) => [{ role: 'user', content: [{ type: 'input_text', text }] }];

beforeEach(() => resetResponseStore());

describe('chain scope stays stable across turns', () => {
  it('previous_response_id alone mints no scope', () => {
    assert.equal(extractBodyCallerSubKey({ previous_response_id: 'resp_abc' }), '');
  });

  it('adding previous_response_id on turn 2 does not change the scope', () => {
    const t1 = extractBodyCallerSubKey({ model: 'm' });
    const t2 = extractBodyCallerSubKey({ model: 'm', previous_response_id: 'resp_1' });
    const t3 = extractBodyCallerSubKey({ model: 'm', previous_response_id: 'resp_2' });
    assert.equal(t1, t2, 'turn 2 must resolve to the same scope as turn 1');
    assert.equal(t2, t3, 'and it must not drift as the id changes each turn');
  });

  it('a stable client signal still wins and stays stable', () => {
    for (const stable of [{ user: 'alice' }, { safety_identifier: 'eu-7' }, { prompt_cache_key: 'conv-1' }]) {
      const bare = extractBodyCallerSubKey(stable);
      const chained = extractBodyCallerSubKey({ ...stable, previous_response_id: 'resp_9' });
      assert.equal(bare, chained, `${Object.keys(stable)[0]} scope must survive chaining`);
      assert.ok(bare, 'a stable signal must still produce a scope');
    }
  });

  it('a guessed :client: identity cannot chain — SEC-W2 isolation', async () => {
    // Behind a reverse proxy every end user collapses to the SAME `:client:<ip+ua>`
    // bucket (verified: identical ip/ua derive a byte-identical callerKey). Storing
    // under that bucket would let user B chain from user A's response id and read
    // A's conversation. Same gate cascade reuse and bindConnectSticky sit behind.
    const rec = recorder('remembered');
    const CLIENT = 'api:hashhashhashhashhashhashhashha:client:fingerprint1';
    const t1 = await handleResponses(
      { model: 'm', input: userTurn('remember 55123') },
      { handleChatCompletions: rec.handler, context: { callerKey: CLIENT } },
    );
    assert.equal(t1.status, 200, 'the turn itself must still be served');

    const t2 = await handleResponses(
      { model: 'm', previous_response_id: t1.body.id, input: userTurn('what number?') },
      { handleChatCompletions: rec.handler, context: { callerKey: CLIENT } },
    );
    assert.equal(t2.status, 404, 'a guessed identity must not get server-side state');
    assert.match(t2.body.error.message, /per-caller identity/,
      'and the error must tell the caller how to fix it');
    assert.match(t2.body.error.message, /WINDSURFAPI_SINGLE_TENANT_CACHE/,
      'including the single-tenant opt-out for a genuine self-host');
  });

  it('a client-supplied identity chains end to end', async () => {
    // The supported shape: any of user / safety_identifier / prompt_cache_key makes
    // callerKey carry a real `:user:` segment.
    const rec = recorder('remembered');
    const SCOPED = 'api:hashhashhashhashhashhashhashha:user:alice';
    const t1 = await handleResponses(
      { model: 'm', input: userTurn('remember 55123') },
      { handleChatCompletions: rec.handler, context: { callerKey: SCOPED } },
    );
    const t2 = await handleResponses(
      { model: 'm', previous_response_id: t1.body.id, input: userTurn('what number?') },
      { handleChatCompletions: rec.handler, context: { callerKey: SCOPED } },
    );
    assert.equal(t2.status, 200);
    assert.equal(rec.seen[1].messages.length, 3, 'the stored turn must be prepended');
  });

});

describe('an unanswerable conversation is rejected locally, never forwarded', () => {
  // The guard lives in the shared chat layer, not per-route, so these drive the
  // REAL handleChatCompletions rather than a mock — a mock would bypass the very
  // thing under test. That layering is the point: an earlier per-route guard in
  // handleResponses checked `messages.length === 0` and was bypassed by adding
  // `instructions` (length becomes 1), while /v1/chat/completions with only a
  // system message and /v1/messages with only an assistant message were never
  // covered at all. All three reached the upstream, came back UPSTREAM_INTERNAL,
  // and two consecutive of those quarantine the account for 120s.
  //
  // Verified against the real upstream that an assistant-terminated conversation
  // (the Anthropic prefill shape) is NOT supported there either, so turning it into
  // a 400 removes an opaque 503 plus an account penalty without losing anything.
  const unanswerable = [
    ['no messages at all', []],
    ['only a system message', [{ role: 'system', content: 'You are X.' }]],
    ['only an assistant message', [{ role: 'assistant', content: 'hi' }]],
    ['ending on an assistant turn', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]],
  ];

  for (const [label, messages] of unanswerable) {
    it(`rejects ${label} with 400, without acquiring an account`, async () => {
      const res = await handleChatCompletions(
        { model: 'claude-sonnet-4.6', max_tokens: 8, messages },
        { callerKey: 'api:x:user:u' },
      );
      assert.equal(res.status, 400, `${label} must be rejected locally`);
      assert.equal(res.body.error.type, 'invalid_request_error');
      assert.equal(res.body.error.param, 'messages');
    });
  }

  it('accepts a conversation ending on a tool result (the agent-loop shape)', async () => {
    // This must NOT be rejected — every tool round-trip ends here.
    const res = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      max_tokens: 8,
      messages: [
        { role: 'user', content: 'call f' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    }, { callerKey: 'api:x:user:u' });
    assert.notEqual(res.status, 400, 'a tool-terminated conversation is answerable');
  });

  it('accepts a normal system + user conversation', async () => {
    const res = await handleChatCompletions(
      { model: 'claude-sonnet-4.6', max_tokens: 8, messages: [{ role: 'system', content: 'X' }, { role: 'user', content: 'hi' }] },
      { callerKey: 'api:x:user:u' },
    );
    assert.notEqual(res.status, 400);
  });
});

describe('truncation status is reserved for truncation', () => {
  // The rule both paths share: `incomplete` means length / content_filter only.
  // A turn that ends by emitting function calls is a COMPLETE turn — an agent loop
  // depends on that, since every tool round-trip would otherwise look truncated.
  // The streaming translator used to hardcode `completed`, which hid real
  // truncation; aligning it must not swing the other way and mark tool turns
  // incomplete.
  const fakeRes = () => ({
    out: '', writableEnded: false,
    write(c) { this.out += c; return true; },
    end(c) { if (c) this.out += c; this.writableEnded = true; },
    on() { return this; },
  });

  const streamWith = (finishReason, extra = {}) => async () => ({
    status: 200, stream: true,
    handler: async (res) => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }], ...extra })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    },
  });

  const lastEvent = (out) => {
    const evts = [...out.matchAll(/^event: (\S+)$/gm)].map(m => m[1]);
    return evts.at(-1);
  };

  it('finish_reason=length closes the stream as response.incomplete', async () => {
    const t = await handleResponses(
      { model: 'm', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }] },
      { handleChatCompletions: streamWith('length'), context: { callerKey: 'api:x:user:u' } },
    );
    const res = fakeRes();
    await t.handler(res);
    assert.equal(lastEvent(res.out), 'response.incomplete');
    assert.match(res.out, /max_output_tokens/, 'the reason must be surfaced');
  });

  it('finish_reason=tool_calls stays response.completed', async () => {
    const t = await handleResponses(
      { model: 'm', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }] },
      { handleChatCompletions: streamWith('tool_calls'), context: { callerKey: 'api:x:user:u' } },
    );
    const res = fakeRes();
    await t.handler(res);
    assert.equal(lastEvent(res.out), 'response.completed',
      'a tool round-trip is a complete turn — an agent loop depends on this');
  });

  it('finish_reason=stop stays response.completed', async () => {
    const t = await handleResponses(
      { model: 'm', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }] },
      { handleChatCompletions: streamWith('stop'), context: { callerKey: 'api:x:user:u' } },
    );
    const res = fakeRes();
    await t.handler(res);
    assert.equal(lastEvent(res.out), 'response.completed');
  });

  it('content_filter also yields incomplete, with its own reason', async () => {
    const t = await handleResponses(
      { model: 'm', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }] },
      { handleChatCompletions: streamWith('content_filter'), context: { callerKey: 'api:x:user:u' } },
    );
    const res = fakeRes();
    await t.handler(res);
    assert.equal(lastEvent(res.out), 'response.incomplete');
    assert.match(res.out, /content_filter/);
  });
});
