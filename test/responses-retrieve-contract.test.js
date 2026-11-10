// What GET /v1/responses/{id} is allowed to say.
//
// Five defects came out of the post-release review of this endpoint, and three of
// them share one shape: the retrieval body asserted something it had not actually
// checked — a hardcoded 'completed', a raw content value assumed to be a string, an
// all-zero usage block. The endpoint is a READ of state someone else recorded, so
// every field it emits must come from that state or be omitted.
//
// The other two were about identity: v3.9.4 made the endpoint reachable by moving
// the caller's scope signal into the URL, which put a value this repo explicitly
// refuses to log (caller-key.js:107 — `user` is "often an end-user email … (PII)")
// into the one place every proxy logs. Headers carry it instead.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleResponses, handleGetResponse } from '../src/handlers/responses.js';
import * as store from '../src/response-store.js';

const CALLER = 'api:contractkey0000000000000000000:user:alice';

const nonStream = (finishReason) => async () => ({
  status: 200,
  body: {
    id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'partial answer' }, finish_reason: finishReason }],
    usage: {},
  },
});

async function createTurn(finishReason) {
  const r = await handleResponses(
    { model: 'm', store: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }] },
    { handleChatCompletions: nonStream(finishReason), context: { callerKey: CALLER } },
  );
  return r.body;
}

beforeEach(() => store.resetResponseStore());

describe('retrieval reports the status the turn actually ended with', () => {
  for (const [finishReason, expected, reason] of [
    ['length', 'incomplete', 'max_output_tokens'],
    ['content_filter', 'incomplete', 'content_filter'],
    ['stop', 'completed', null],
    ['tool_calls', 'completed', null],
  ]) {
    it(`finish_reason=${finishReason} → GET reports ${expected}`, async () => {
      // Hardcoding 'completed' made GET contradict POST for the SAME id. Legitimately
      // truncated turns became storable in 8fa5e97, so retrieval was laundering them
      // into completed ones — the same status divergence this release line kept
      // chasing across the stream / non-stream split.
      const created = await createTurn(finishReason);
      assert.equal(created.status, expected, 'precondition: POST reported this status');
      const got = handleGetResponse(created.id, { context: { callerKey: CALLER } });
      assert.equal(got.status, 200);
      assert.equal(got.body.status, created.status,
        'GET must agree with what POST told the client for this id');
      if (reason) assert.equal(got.body.incomplete_details?.reason, reason);
      else assert.equal(got.body.incomplete_details, undefined);
    });
  }
});

describe('retrieval never presents gateway bookkeeping as model output', () => {
  it('strips the response store\'s own drop notice', () => {
    // capEntryBytes prepends a notice to the first SURVIVING message when it drops
    // earlier ones. When that survivor is the assistant turn, the notice was served
    // back as if the model had written it. It must stay in the chained context (a
    // useful signal to the next turn) but never reach the client as the answer.
    const notice = '[... 3 earlier message(s) dropped by the response store to stay '
      + 'within RESPONSE_STORE_MAX_BYTES ...]\n\n';
    store.putResponse('n1', [{ role: 'assistant', content: `${notice}Got it.` }], CALLER, { model: 'm' });
    const got = handleGetResponse('n1', { context: { callerKey: CALLER } });
    assert.equal(got.body.output_text, 'Got it.');
    assert.equal(/dropped by the response store/.test(JSON.stringify(got.body)), false,
      'internal bookkeeping must not appear anywhere in the response body');
  });

  it('leaves a genuine answer untouched', () => {
    store.putResponse('n2', [{ role: 'assistant', content: 'plain answer' }], CALLER, { model: 'm' });
    assert.equal(handleGetResponse('n2', { context: { callerKey: CALLER } }).body.output_text, 'plain answer');
  });
});

describe('retrieval emits a well-formed body for every stored content shape', () => {
  it('flattens parts-array content instead of nesting an array in `text`', () => {
    // The store legitimately holds Chat-shaped messages whose content is a parts
    // array (Responses `input` items normalize that way). Passing it through raw put
    // an ARRAY where the schema requires a string — a structurally invalid response.
    store.putResponse('a1', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] },
    ], CALLER, { model: 'm' });
    const got = handleGetResponse('a1', { context: { callerKey: CALLER } });
    assert.equal(typeof got.body.output_text, 'string');
    assert.equal(got.body.output_text, 'hello');
    assert.equal(typeof got.body.output[0].content[0].text, 'string',
      'output[].content[].text must be a string, not a nested array');
  });

  it('omits usage rather than reporting an all-zero block', () => {
    // Both official SDKs declare `usage` optional on the Response model, and the
    // store never held it. An all-zero block is indistinguishable from "this turn
    // really used 0 tokens" and a billing relay would meter it as such.
    store.putResponse('u1', [{ role: 'assistant', content: 'x' }], CALLER, { model: 'm' });
    const body = handleGetResponse('u1', { context: { callerKey: CALLER } }).body;
    assert.equal('usage' in body, false, 'absent beats a fabricated zero');
  });

  it('handles a turn whose last message is not an assistant', () => {
    store.putResponse('u2', [{ role: 'user', content: 'only a question' }], CALLER, { model: 'm' });
    const body = handleGetResponse('u2', { context: { callerKey: CALLER } }).body;
    assert.deepEqual(body.output, []);
    assert.equal(body.output_text, '');
  });
});

describe('identity signal does not travel where logs will capture it', () => {
  // caller-key.js states the policy this guards: `user` is often an end-user email
  // and must not be logged. https-proxy.js:20 prints the full URL verbatim, so a
  // query param carrying that value contradicts the repo's own rule.
  const serverSrc = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  // NOTE: the two source greps that used to live here were NOT guards.
  // `assert.match(serverSrc, /x-response-/)` matches any surviving mention of the
  // string, and `serverSrc.includes("'conversation_id'")` can be satisfied by a
  // prose comment. Measured: breaking the header-name derivation (dropping the
  // underscore→hyphen conversion) left 4 of the 6 documented signals returning 404
  // while all 35 retrieval tests stayed green. A source grep cannot tell "the
  // feature works" from "the string is still there".
  //
  // The real guard now lives in responses-retrieve-route.test.js, which SENDS every
  // header over real HTTP. What remains here is the one thing a behavioural test
  // cannot express: the standing reason headers are the primary channel.

  it('the TLS front end redacts the query credential before logging', () => {
    // `?key=` is a documented Gemini credential carrier; S2-F2 made the access
    // log redact it. Keep this pin so a refactor cannot silently restore
    // raw-URL logging — while headers remain the documented primary channel,
    // the query fallback must not leak into journals either.
    const proxySrc = readFileSync(new URL('../https-proxy.js', import.meta.url), 'utf8');
    assert.match(proxySrc, /redactUrlForLog\(url\)/,
      'https-proxy must pass the URL through redactUrlForLog before logging (S2-F2)');
  });

  it('the POST-side scope vocabulary has not grown past what retrieval accepts', () => {
    // Not a substitute for the HTTP tests — this catches the DIVERGENCE case they
    // cannot see: someone adds a 7th signal to extractBodyCallerSubKey, retrieval
    // silently does not accept it, and clients using it cannot read their own
    // responses. That is exactly how v3.9.4 shipped (3 of 6 supported).
    const ckSrc = readFileSync(new URL('../src/caller-key.js', import.meta.url), 'utf8');
    const postSignals = new Set([
      ...[...ckSrc.matchAll(/usableSignal\(body\??\.?(?:\?\.)?([a-z_]+)\)/g)].map(m => m[1]),
      ...[...ckSrc.matchAll(/metadata\?\.([a-z_]+)/g)].map(m => m[1]),
    ]);
    postSignals.delete('metadata');
    assert.ok(postSignals.size >= 5,
      `expected the real POST scope vocabulary, parsed: ${[...postSignals].join(', ')}`);
    // Every one of them must appear in the router's pick() list.
    const pickList = (serverSrc.match(/for \(const k of \[([^\]]+)\]\) \{\s*const v = pick\(k\)/) || [, ''])[1];
    const routerAccepts = new Set([
      ...[...pickList.matchAll(/'([a-z_]+)'/g)].map(m => m[1]),
      ...[...serverSrc.matchAll(/pick\('([a-z_]+)'\)/g)].map(m => m[1]),
    ]);
    const missing = [...postSignals].filter(s => !routerAccepts.has(s));
    assert.deepEqual(missing, [],
      'these signals scope a POST but cannot be replayed on GET/DELETE, so a client '
      + `using them cannot retrieve its own response: ${missing.join(', ')}`);
  });
});
