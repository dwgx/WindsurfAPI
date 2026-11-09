// G02 — the Responses surface forwards `text.verbosity` as a top-level
// `verbosity` on the internal chat body (responses.js). `buildCompletionConfig`
// has no verbosity field, so the value is accepted and intentionally a no-op on
// the wire — but it must not be silently dropped at the proxy boundary. It is
// carried in `connectParams.completion` so the request's intent stays visible.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { cacheClear } from '../src/cache.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';

const CALLER = 'api:test:user:verbosity';
const MODEL = 'swe-1-6-slow';

function nonStream(content = 'ok') {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-verbosity', object: 'chat.completion', created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  };
}

describe('verbosity reaches the connect completion overrides', () => {
  let accountId = null;
  let savedConnect;
  let captured = [];

  beforeEach(() => {
    savedConnect = process.env.DEVIN_CONNECT;
    process.env.DEVIN_CONNECT = '1';
    cacheClear();
    captured = [];
    accountId = addAccountByKey(
      `devin-session-token$verbosity-${Math.random().toString(36).slice(2)}`,
      'verbosity-test',
    ).id;
    __setConnectDeps({
      toChatCompletion: async (params) => { captured.push(params); return nonStream(); },
    });
  });

  afterEach(() => {
    __resetConnectDeps();
    cacheClear();
    if (accountId) removeAccount(accountId);
    accountId = null;
    if (savedConnect === undefined) delete process.env.DEVIN_CONNECT;
    else process.env.DEVIN_CONNECT = savedConnect;
  });

  it('carries a string verbosity into connectParams.completion', async () => {
    const res = await handleChatCompletions({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      verbosity: 'high',
      __callerKey: CALLER,
    }, { callerKey: CALLER });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].completion?.verbosity, 'high');
  });

  it('does not invent a verbosity override for a non-string value', async () => {
    const res = await handleChatCompletions({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      verbosity: 3,
      temperature: 0.2,
      __callerKey: CALLER,
    }, { callerKey: CALLER });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].completion?.verbosity, undefined);
    assert.equal(captured[0].completion?.temperature, 0.2, 'the other overrides still ride along');
  });
});
