import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { cacheClear, cacheKey, cacheSet } from '../src/cache.js';
import {
  handleChatCompletions, __setConnectDeps, __resetConnectDeps, chatStreamError,
  cascadeCacheIdentity,
} from '../src/handlers/chat.js';

// O12 (ROADMAP-GATE): every successful OpenAI chat.completion /
// chat.completion.chunk body carries service_tier:'default' next to the
// synthetic system_fingerprint. Error bodies are a different shape and
// must not grow this field. No live Devin account is required — connect
// is stubbed, cascade is exercised via the cache-hit constructors.

const CALLER = 'api:test:user:service-tier';
const createdIds = [];
const prevEnv = {};

function seed(label) {
  const a = addAccountByKey(`sk-tier-${label}-${Math.random().toString(36).slice(2, 10)}`, label);
  createdIds.push(a.id);
  return a;
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseChatFrames(raw) {
  return raw
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
      const payload = dataLine?.slice(6) || '';
      return payload === '[DONE]' ? '[DONE]' : JSON.parse(payload);
    });
}

function hasServiceTier(obj) {
  return obj && Object.prototype.hasOwnProperty.call(obj, 'service_tier');
}

afterEach(() => {
  cacheClear();
  __resetConnectDeps();
  while (createdIds.length) removeAccount(createdIds.pop());
  for (const k of Object.keys(prevEnv)) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
    delete prevEnv[k];
  }
});

describe('O12 service_tier on successful chat.completion', () => {
  it('non-stream connect success body has service_tier:default next to system_fingerprint', async () => {
    prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
    process.env.DEVIN_CONNECT = '1';
    seed('ns');
    __setConnectDeps({
      toChatCompletion: async (params, meta) => ({
        status: 200,
        body: {
          id: 'chatcmpl-tier',
          object: 'chat.completion',
          created: 0,
          model: meta.displayModel || params.model,
          system_fingerprint: 'fp_stubstub',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        },
      }),
    });

    const r = await handleChatCompletions(
      { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: CALLER },
    );
    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(r.body.object, 'chat.completion');
    assert.equal(r.body.system_fingerprint, 'fp_stubstub');
    assert.equal(r.body.service_tier, 'default');
  });

  it('non-stream cascade cache-hit body has service_tier:default', async () => {
    seed('cache-ns');
    const body = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: CALLER,
    };
    // Seed under the routed identity: the handler looks up by the effective
    // generation now, not the raw spelling (BLUE-CACHE P2).
    cacheSet(cacheKey(body, CALLER, cascadeCacheIdentity(body)), { text: 'cached answer', thinking: '' });

    const r = await handleChatCompletions(body);
    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(r.body.object, 'chat.completion');
    assert.equal(typeof r.body.system_fingerprint, 'string');
    assert.equal(r.body.service_tier, 'default');
  });
});

describe('O12 service_tier on successful chat.completion.chunk', () => {
  it('every connect stream chunk carries service_tier:default', async () => {
    prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
    process.env.DEVIN_CONNECT = '1';
    seed('st');
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        send({
          id: 'c1', object: 'chat.completion.chunk', created: 1, model: params.model,
          system_fingerprint: 'fp_from_adapter',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        });
        send({
          id: 'c1', object: 'chat.completion.chunk', created: 1, model: params.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        return { content: 'hi', reasoning: '', finish_reason: 'stop', usage: null };
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: CALLER },
    );
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    const res = fakeRes();
    await result.handler(res);
    const chunks = parseChatFrames(res.body).filter(f => f !== '[DONE]' && f?.object === 'chat.completion.chunk');
    assert.ok(chunks.length >= 1, 'expected at least one completion chunk');
    for (const c of chunks) {
      assert.equal(c.service_tier, 'default', JSON.stringify(c));
    }
    assert.equal(chunks[0].system_fingerprint, 'fp_from_adapter');
  });

  it('cascade cache-hit stream chunks carry service_tier:default', async () => {
    seed('cache-st');
    const body = {
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      __callerKey: CALLER,
    };
    cacheSet(cacheKey(body, CALLER, cascadeCacheIdentity(body)), { text: 'cached answer', thinking: '' });

    const result = await handleChatCompletions(body);
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    const res = fakeRes();
    await result.handler(res);
    const chunks = parseChatFrames(res.body).filter(f => f !== '[DONE]' && f?.object === 'chat.completion.chunk');
    assert.ok(chunks.length >= 1);
    for (const c of chunks) {
      assert.equal(c.service_tier, 'default', JSON.stringify(c));
      assert.equal(typeof c.system_fingerprint, 'string');
    }
  });
});

describe('O12 service_tier is absent from error bodies', () => {
  it('n>1 JSON 400 has no service_tier', async () => {
    const r = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      n: 2,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.param, 'n');
    assert.equal(hasServiceTier(r.body), false);
    assert.equal(hasServiceTier(r.body.error), false);
  });

  it('logprobs JSON 400 has no service_tier', async () => {
    const r = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      logprobs: true,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.param, 'logprobs');
    assert.equal(hasServiceTier(r.body), false);
  });

  it('connect non-stream error body has no service_tier', async () => {
    prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
    process.env.DEVIN_CONNECT = '1';
    seed('err');
    __setConnectDeps({
      toChatCompletion: async () => {
        throw Object.assign(new Error('upstream exploded'), { code: 'UPSTREAM_INTERNAL' });
      },
    });
    const r = await handleChatCompletions(
      { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: CALLER },
    );
    assert.ok(r.status >= 400, JSON.stringify(r?.body));
    assert.ok(r.body?.error, JSON.stringify(r?.body));
    assert.equal(hasServiceTier(r.body), false);
    assert.equal(hasServiceTier(r.body.error), false);
  });

  it('chatStreamError frame shape has no service_tier', () => {
    const frame = chatStreamError('boom', 'upstream_error');
    assert.equal(hasServiceTier(frame), false);
    assert.equal(hasServiceTier(frame.error), false);
  });
});

describe('O12 special-agent constructors stamp service_tier', () => {
  it('special-agent success body and stream send include service_tier', () => {
    const src = readFileSync(new URL('../src/special-agent.js', import.meta.url), 'utf8');
    assert.match(src, /service_tier: 'default'/);
    assert.match(src, /data\.service_tier = 'default'/);
  });
});
