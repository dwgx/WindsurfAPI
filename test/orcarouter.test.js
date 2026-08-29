import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import {
  isOrcaRouterModel,
  orcaRouterApiKey,
  forwardChatCompletions,
  __setOrcaRouterRequestImpl,
} from '../src/orcarouter.js';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { addAccountByKey, removeAccount } from '../src/auth.js';

// ── fake https.request transport ──────────────────────────────
// Returns a request-like EventEmitter; invokes the response callback with a
// fake res (also an EventEmitter). The last-written body is captured for
// assertions.
let capturedOptions = null;
let capturedPayload = null;
let respond = null; // ({ status, body }) triggers the response path
let failRequest = null; // (err) emits a request-level transport error

function fakeRequest(opts, onRes) {
  capturedOptions = opts;
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.write = (d) => { capturedPayload = String(d); };
  req.end = () => {};
  req.destroy = (err) => { if (err) req.emit('error', err); };
  failRequest = (err) => req.emit('error', err);
  // Store how to fire the response so each test can drive it.
  respond = ({ status, body }) => {
    const res = new EventEmitter();
    res.statusCode = status;
    process.nextTick(() => {
      onRes(res);
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      if (buf.length) res.emit('data', buf);
      res.emit('end');
    });
  };
  return req;
}

const createdAccountIds = [];

afterEach(() => {
  __setOrcaRouterRequestImpl(null);
  capturedOptions = null;
  capturedPayload = null;
  respond = null;
  failRequest = null;
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
  delete process.env.ORCAROUTER_API_KEY;
});

describe('orcarouter module', () => {
  it('isOrcaRouterModel only matches provider orcarouter', () => {
    assert.equal(isOrcaRouterModel({ provider: 'orcarouter' }), true);
    assert.equal(isOrcaRouterModel({ provider: 'openai' }), false);
    assert.equal(isOrcaRouterModel(null), false);
    assert.equal(isOrcaRouterModel(undefined), false);
  });

  it('orcaRouterApiKey reads ORCAROUTER_API_KEY and trims', () => {
    assert.equal(orcaRouterApiKey({ ORCAROUTER_API_KEY: '  sk-orca-abc  ' }), 'sk-orca-abc');
    assert.equal(orcaRouterApiKey({}), '');
    assert.equal(orcaRouterApiKey({ ORCAROUTER_API_KEY: '' }), '');
  });

  it('forwardChatCompletions rejects when no API key configured', async () => {
    await assert.rejects(
      forwardChatCompletions({ model: 'orcarouter/fusion', messages: [] }),
      /ORCAROUTER_API_KEY is not set/
    );
  });

  it('builds the request to api.orcarouter.ai with Bearer auth and JSON body', async () => {
    __setOrcaRouterRequestImpl(fakeRequest);
    const p = forwardChatCompletions(
      { model: 'orcarouter/fusion', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'sk-orca-test' },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.hostname, 'api.orcarouter.ai');
    assert.equal(capturedOptions.path, '/v1/chat/completions');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer sk-orca-test');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
    const parsed = JSON.parse(capturedPayload);
    assert.equal(parsed.model, 'orcarouter/fusion');
  });

  it('resolves with upstream status and body (including error responses)', async () => {
    __setOrcaRouterRequestImpl(fakeRequest);
    const p = forwardChatCompletions({ model: 'orcarouter/fusion', messages: [] }, { apiKey: 'sk-orca-test' });
    await new Promise((r) => setImmediate(r));
    respond({ status: 200, body: JSON.stringify({ id: 'x', choices: [] }) });
    const { status, body } = await p;
    assert.equal(status, 200);
    assert.equal(JSON.parse(body.toString('utf8')).id, 'x');

    // error path — relayed, not rejected
    __setOrcaRouterRequestImpl(fakeRequest);
    const p2 = forwardChatCompletions({ model: 'orcarouter/fusion', messages: [] }, { apiKey: 'sk-orca-test' });
    await new Promise((r) => setImmediate(r));
    respond({ status: 401, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad key' } }) });
    const r2 = await p2;
    assert.equal(r2.status, 401);
    assert.equal(JSON.parse(r2.body.toString('utf8')).error.message, 'bad key');
  });

  it('resolves with an SSE body when stream=true', async () => {
    __setOrcaRouterRequestImpl(fakeRequest);
    const p = forwardChatCompletions({ model: 'orcarouter/fusion', stream: true, messages: [] }, { apiKey: 'sk-orca-test' });
    await new Promise((r) => setImmediate(r));
    const sseBody = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n';
    respond({ status: 200, body: sseBody });
    const { status, body } = await p;
    assert.equal(status, 200);
    assert.equal(body.toString('utf8'), sseBody);
  });
});

describe('chat handler orcarouter routing', () => {
  it('rejects orcarouter/* requests with a clear 503 when no API key is set', async () => {
    const account = addAccountByKey(`orca-${Date.now()}-nokey`, 'orca');
    createdAccountIds.push(account.id);

    const result = await handleChatCompletions({
      model: 'orcarouter/fusion',
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: 'api:test:orcanokey',
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'orcarouter_not_configured');
    assert.match(result.body.error.message, /ORCAROUTER_API_KEY/);
  });

  it('forwards non-stream orcarouter/* requests to the gateway and relays the JSON body', async () => {
    __setOrcaRouterRequestImpl(fakeRequest);
    process.env.ORCAROUTER_API_KEY = 'sk-orca-live-test';
    const account = addAccountByKey(`orca-${Date.now()}-ok`, 'orca');
    createdAccountIds.push(account.id);

    const p = handleChatCompletions({
      model: 'orcarouter/fusion',
      messages: [{ role: 'user', content: 'Say hi' }],
      __callerKey: 'api:test:orcaok',
    });
    await new Promise((r) => setImmediate(r));
    // chat.js's forwardOrcaRouterChat awaits forwardChatCompletions; drive the
    // fake response after the request is built.
    respond({
      status: 200,
      body: JSON.stringify({
        id: 'chatcmpl-orca',
        model: 'orcarouter/fusion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
      }),
    });
    const result = await p;
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'Hi!');
    // The forwarded body carries the original model name.
    const sent = JSON.parse(capturedPayload);
    assert.equal(sent.model, 'orcarouter/fusion');
  });

  it('forwards raw orcarouter/<dynamic-id> models even without a static catalog entry', async () => {
    __setOrcaRouterRequestImpl(fakeRequest);
    process.env.ORCAROUTER_API_KEY = 'sk-orca-live-test';
    const account = addAccountByKey(`orca-${Date.now()}-dyn`, 'orca');
    createdAccountIds.push(account.id);

    const p = handleChatCompletions({
      model: 'orcarouter/deepseek/deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: 'api:test:orcadyan',
    });
    await new Promise((r) => setImmediate(r));
    respond({ status: 200, body: JSON.stringify({ id: 'x', model: 'orcarouter/deepseek/deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'yo' }, finish_reason: 'stop' }] }) });
    const result = await p;
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'yo');
  });

  it('maps transport failures to a clean 502 upstream_error', async () => {
    __setOrcaRouterRequestImpl(fakeRequest);
    process.env.ORCAROUTER_API_KEY = 'sk-orca-live-test';
    const account = addAccountByKey(`orca-${Date.now()}-err`, 'orca');
    createdAccountIds.push(account.id);

    const p = handleChatCompletions({
      model: 'orcarouter/fusion',
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: 'api:test:orcaerr',
    });
    await new Promise((r) => setImmediate(r));
    failRequest(new Error('ECONNRESET'));
    const result = await p;
    assert.equal(result.status, 502);
    assert.equal(result.body.error.type, 'upstream_error');
    assert.equal(result.body.error.code, 'orcarouter_upstream_error');
    assert.match(result.body.error.message, /ECONNRESET/);
  });
});
