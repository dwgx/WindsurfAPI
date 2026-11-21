// P2-6 (evidence/ReviewChatCore.md §P2-6): the DEVIN_CONNECT usage-attribution
// residue must name the SERVED model on every surface, not just the
// client-visible `model` field.
//
// The echoed name was already unified on `connectDisplayModel`
// (mapped ? requested : the name that actually rides the wire). The residue was
// the dashboard rows:
//
//   stream      recordTokenUsage(_sr.usage, reqModelName)      ← requested
//   non-stream  recordTokenUsage(body.usage, body.model||req)  ← served
//   both        finalizeConnectAccount({ model: reqModelName })← requested
//
// so on a degrade (WINDSURFAPI_STRICT_MODEL=0) or a router hop
// (DEVIN_CONNECT_ASSIGN_MODEL=1) the same conversation's streamed and
// non-streamed turns landed in DIFFERENT model buckets, and neither matched the
// request row finalizeConnectAccount writes for both.
//
// These run the real handler with the connect network stubbed and read the
// dashboard state the way the UI does (getStats().tokensByModel / modelCounts).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { addAccountByKey, removeAccount, getAccountInternal } from '../src/auth.js';
import { resetStats, getStats } from '../src/dashboard/stats.js';

const FREE_SELECTOR = 'swe-1-6-slow';
const UNMAPPED_PAID = 'claude-opus-4.9';
const MAPPED_ALIAS = 'claude-sonnet-4.6';
const ASSIGNED = 'claude-opus-4-8-medium';

const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'WINDSURFAPI_STRICT_MODEL', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'DEVIN_CONNECT_ASSIGN_MODEL'];
for (const k of ENV_KEYS) SAVED[k] = process.env[k];

const seeded = [];

function seedAccount() {
  const a = addAccountByKey('sk-p2-6-' + Math.random().toString(36).slice(2, 12), 'p2-6');
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = 'pro';
  seeded.push(a.id);
  return acct;
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '', writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; for (const cb of listeners.get('close') || []) cb(); },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
  };
}

const USAGE = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };

/** A stream stub that mirrors the real adapter: it stamps the display name on
 *  every chunk and returns the terminal usage. */
function stubStream() {
  const seen = { wire: null, display: null };
  __setConnectDeps({
    streamChatCompletion: async (params, send, meta) => {
      seen.wire = params.model;
      seen.display = meta.displayModel;
      send({
        id: 's', object: 'chat.completion.chunk', created: 0, model: meta.displayModel,
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      });
      send({
        id: 's', object: 'chat.completion.chunk', created: 0, model: meta.displayModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      return { usage: USAGE };
    },
  });
  return seen;
}

/** Non-stream stub, same display-name precedence as the real adapter. */
function stubNonStream() {
  const seen = { wire: null, display: null };
  __setConnectDeps({
    toChatCompletion: async (params, meta) => {
      seen.wire = params.model;
      seen.display = meta.displayModel;
      return {
        status: 200,
        body: {
          id: 'c', object: 'chat.completion', created: 0,
          model: meta.displayModel || params.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: USAGE,
        },
      };
    },
  });
  return seen;
}

async function runStream(model) {
  const res = await handleChatCompletions(
    { model, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    { callerKey: 'p2-6-caller' },
  );
  assert.equal(res.status, 200, `stream precondition: handler returned ${res.status}`);
  const fake = fakeRes();
  await res.handler(fake);
  return fake;
}

async function runNonStream(model) {
  return handleChatCompletions(
    { model, stream: false, messages: [{ role: 'user', content: 'hi' }] },
    { callerKey: 'p2-6-caller' },
  );
}

function buckets() {
  const stats = getStats();
  return {
    usage: Object.keys(stats.tokensByModel || {}),
    requests: Object.keys(stats.modelCounts || {}),
  };
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  delete process.env.DEVIN_CONNECT_ASSIGN_MODEL;
  resetStats();
  seedAccount();
});

afterEach(() => {
  while (seeded.length) removeAccount(seeded.pop());
  __resetConnectDeps();
  resetStats();
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('P2-6: usage attribution follows the served model', () => {
  it('an unmapped name is rejected and files nothing (no degrade path remains)', async () => {
    // STRICT_MODEL is gone: unmapped never runs, so there is no served selector
    // to attribute. Both transports 400 and leave the buckets empty.
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    const seen = stubStream();

    const res = await handleChatCompletions(
      { model: UNMAPPED_PAID, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: 'p2-6-caller' },
    );

    assert.equal(res.status, 400);
    assert.equal(res.body?.error?.code, 'model_not_found');
    assert.equal(seen.wire, null, 'nothing reached the adapter');
    const b = buckets();
    assert.deepEqual(b.usage, [], 'a rejected request must file no usage rows');
    assert.deepEqual(b.requests, [], 'and no request rows either');
  });

  it('non-stream: the same rejection files the same (empty) buckets', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    const seen = stubNonStream();

    const res = await runNonStream(UNMAPPED_PAID);

    assert.equal(res.status, 400);
    assert.equal(res.body?.error?.code, 'model_not_found');
    assert.equal(seen.wire, null);
    const b = buckets();
    assert.deepEqual(b.usage, []);
    assert.deepEqual(b.requests, []);
  });

  it('stream and non-stream reject identically for the same model', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    stubStream();
    const sres = await handleChatCompletions(
      { model: UNMAPPED_PAID, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: 'p2-6-caller' },
    );
    const streamBuckets = buckets();
    resetStats();
    stubNonStream();
    const nres = await runNonStream(UNMAPPED_PAID);
    const nonStreamBuckets = buckets();

    assert.equal(sres.status, 400);
    assert.equal(nres.status, 400);
    assert.deepEqual(streamBuckets, nonStreamBuckets,
      'the same rejection must look the same on both transports');
    assert.deepEqual(streamBuckets.usage, []);
    assert.deepEqual(streamBuckets.requests, []);
  });

  it('a mapped alias keeps the requested name on BOTH transports (documented alias behaviour)', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    const seen = stubStream();
    await runStream(MAPPED_ALIAS);
    assert.notEqual(seen.wire, MAPPED_ALIAS, 'precondition: the wire selector differs from the alias');
    assert.equal(seen.display, MAPPED_ALIAS, 'precondition: the alias is echoed');
    assert.deepEqual(buckets().usage, [MAPPED_ALIAS],
      'a mapped alias is not a degrade — attribution follows the echoed name');

    resetStats();
    stubNonStream();
    await runNonStream(MAPPED_ALIAS);
    assert.deepEqual(buckets().usage, [MAPPED_ALIAS]);
    assert.deepEqual(buckets().requests, [MAPPED_ALIAS]);
  });

  it('stream: a router hop files usage under the ASSIGNED uid, not the router name', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    process.env.DEVIN_CONNECT_ASSIGN_MODEL = '1';
    const seen = stubStream();
    __setConnectDeps({ assignModel: async () => ({ model_uid: ASSIGNED }) });

    await runStream('adaptive');

    assert.equal(seen.wire, ASSIGNED, 'precondition: the router hop put the assigned uid on the wire');
    const b = buckets();
    assert.deepEqual(b.usage, [ASSIGNED],
      `usage must be filed under the model the router assigned, got [${b.usage}]`);
    assert.deepEqual(b.requests, [ASSIGNED]);
  });

  // The Responses route runs this same chat handler underneath, so it must
  // inherit the attribution — the report lists it as the third surface, and its
  // client-visible name was already deferred to the served name. Driven through
  // the real handler (no stubbed chatHandler) to prove the inheritance.
  it('Responses non-stream: an unmapped name is rejected and files nothing', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    stubNonStream();
    const { handleResponses } = await import('../src/handlers/responses.js');

    const res = await handleResponses({
      model: UNMAPPED_PAID,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }, { context: { callerKey: 'p2-6-responses' } });

    assert.equal(res.status, 400);
    const b = buckets();
    assert.deepEqual(b.usage, []);
    assert.deepEqual(b.requests, []);
  });

  it('Responses stream: the same rejection files the same (empty) bucket', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    stubStream();
    const { handleResponses } = await import('../src/handlers/responses.js');

    const res = await handleResponses({
      model: UNMAPPED_PAID,
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }, { context: { callerKey: 'p2-6-responses' } });
    assert.equal(res.status, 400);

    const b = buckets();
    assert.deepEqual(b.usage, []);
    assert.deepEqual(b.requests, []);
  });
});
