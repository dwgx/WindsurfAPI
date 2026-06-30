import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getAccountList, getApiKey, releaseAccount,
  markRateLimited, getAccountAvailability,
  __setReloginDeps, __resetReloginState,
} from '../src/auth.js';
import {
  handleChatCompletions, __setConnectDeps, __resetConnectDeps,
} from '../src/handlers/chat.js';

// DEVIN_CONNECT cross-account failover: when a pooled account's session token is
// dead (UNAUTHORIZED) and same-account re-login can't revive it, the request
// must fall through to the NEXT healthy pooled account instead of failing.
// These exercise the real handler with the connect network calls + re-login
// mocked, so no token or socket is touched.

const createdIds = [];
const prevEnv = {};

function seed(label) {
  const key = `devin-session-token$fo-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
}

function unauthorized() {
  return Object.assign(new Error('invalid token'), { code: 'UNAUTHORIZED' });
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

function parseFrames(raw) {
  return raw.split('\n\n').filter(Boolean).filter(f => !f.startsWith(':')).map(f => {
    const d = f.split('\n').find(l => l.startsWith('data: '))?.slice(6) || '';
    return d === '[DONE]' ? '[DONE]' : JSON.parse(d);
  });
}

beforeEach(() => {
  prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
  prevEnv.MAX = process.env.DEVIN_CONNECT_FAILOVER_MAX;
  prevEnv.RELOGIN = process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  process.env.DEVIN_CONNECT = '1';
  delete process.env.DEVIN_CONNECT_FAILOVER_MAX;
  delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
});

afterEach(() => {
  __resetConnectDeps();
  __resetReloginState();
  __setReloginDeps(null);
  if (prevEnv.DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = prevEnv.DEVIN_CONNECT;
  if (prevEnv.MAX === undefined) delete process.env.DEVIN_CONNECT_FAILOVER_MAX;
  else process.env.DEVIN_CONNECT_FAILOVER_MAX = prevEnv.MAX;
  if (prevEnv.RELOGIN === undefined) delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  else process.env.DEVIN_CONNECT_AUTO_RELOGIN = prevEnv.RELOGIN;
  while (createdIds.length) removeAccount(createdIds.pop());
});

describe('DEVIN_CONNECT cross-account failover — non-stream', () => {
  it('falls over to the next pooled account when the first token is dead and re-login fails', async () => {
    const a = seed('dead-1');
    const b = seed('healthy-2');
    // Re-login can NOT recover (token-added accounts have no stored password).
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no stored credential'); } });

    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen.push(params.token);
        if (params.token === a.apiKey) throw unauthorized();
        return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'FAILOVER_OK' } }] } };
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'FAILOVER_OK');
    // The dead account was tried first, then the healthy one — never re-picked.
    assert.ok(seen.includes(a.apiKey), 'tried the dead account');
    assert.ok(seen.includes(b.apiKey), 'failed over to the healthy account');
    // No inflight leak: every account (dead + healthy) was finalized/released,
    // so both are immediately re-selectable.
    const reacquire = getApiKey([], null, '');
    assert.ok(reacquire, 'pool is fully released after a failover hop');
    releaseAccount(reacquire.apiKey);
  });

  it('prefers same-account re-login over failover when credentials exist', async () => {
    const a = seed('relogin-1');
    seed('other-2');
    process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
    let freshToken = null;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'stored-password',
      windsurfLogin: async () => {
        freshToken = `devin-session-token$fresh-${Math.random().toString(36).slice(2)}`;
        return { apiKey: freshToken, name: 'relogin-1' };
      },
    });

    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen.push(params.token);
        if (params.token === a.apiKey) throw unauthorized(); // original dead
        return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'RELOGIN_OK' } }] } };
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'RELOGIN_OK');
    // Recovery went through the SAME account's fresh token, not a second account.
    assert.ok(freshToken && seen.includes(freshToken), 'retried on the re-logged-in token');
  });

  it('returns 401 when every pooled account has a dead, unrecoverable token', async () => {
    seed('dead-a');
    seed('dead-b');
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no credential'); } });
    __setConnectDeps({ toChatCompletion: async () => { throw unauthorized(); } });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'UNAUTHORIZED');
  });

  it('honors DEVIN_CONNECT_FAILOVER_MAX=0 (no hop, just same-account re-login)', async () => {
    const a = seed('nofail-1');
    seed('nofail-2');
    process.env.DEVIN_CONNECT_FAILOVER_MAX = '0';
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no credential'); } });
    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => { seen.push(params.token); throw unauthorized(); },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 401);
    // With max=0 only the first account is attempted — no failover hop.
    assert.equal(seen.length, 1, 'no failover hop when max=0');
  });

  it('does NOT fail over on a non-auth upstream error (surfaces it directly)', async () => {
    seed('err-1');
    seed('err-2');
    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen.push(params.token);
        throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' });
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 429);
    assert.equal(seen.length, 1, 'a non-auth error is not a failover trigger');
  });
});

describe('DEVIN_CONNECT cross-account failover — stream', () => {
  it('fails over before any byte is emitted, then streams from the healthy account', async () => {
    const a = seed('s-dead-1');
    const b = seed('s-healthy-2');
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no credential'); } });

    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        seen.push(params.token);
        if (params.token === a.apiKey) throw unauthorized(); // dead before first chunk
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);
    const frames = parseFrames(res.body);
    assert.ok(frames.some(f => f !== '[DONE]' && f.choices?.[0]?.delta?.content === 'OK'), 'streamed content from healthy account');
    assert.ok(seen.includes(a.apiKey) && seen.includes(b.apiKey), 'failed over after dead account');
    assert.equal(frames.at(-1), '[DONE]');
  });

  it('does NOT fail over once a chunk has already been emitted', async () => {
    const a = seed('s-mid-1');
    seed('s-mid-2');
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no credential'); } });

    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        seen.push(params.token);
        // Emit one chunk, THEN fail. A retry would duplicate content, so the
        // loop must surface an error frame instead of hopping accounts.
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] });
        throw unauthorized();
      },
    });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    await result.handler(res);
    const frames = parseFrames(res.body);
    assert.equal(seen.length, 1, 'no failover after a byte is on the wire');
    assert.ok(frames.some(f => f !== '[DONE]' && f.choices?.[0]?.delta?.content === 'partial'), 'emitted the partial chunk');
    assert.ok(frames.some(f => f !== '[DONE]' && f.error), 'surfaced an error frame');
  });
});

describe('DEVIN_CONNECT quota vs tier wall (P1 #33)', () => {
  it('QUOTA_EXHAUSTED cools the account down AND surfaces 402 insufficient_quota', async () => {
    const a = seed('quota-1');
    process.env.DEVIN_CONNECT_FAILOVER_MAX = '0'; // isolate this account
    __setConnectDeps({
      toChatCompletion: async () => {
        throw Object.assign(new Error('insufficient credits remaining'), { code: 'QUOTA_EXHAUSTED' });
      },
    });
    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 402);
    assert.equal(result.body.error.type, 'insufficient_quota');
    // The dry account must now carry a rate-limit cooldown so getApiKey stops
    // re-selecting it (the distinguishing penalty vs a tier wall).
    const avail = getAccountAvailability(a.apiKey, 'swe-1-6-slow');
    assert.equal(avail.reason, 'rate_limited', 'dry account is cooled down');
    assert.ok(avail.retryAfterMs > 0, 'cooldown carries a retry hint');
  });

  it('MODEL_BLOCKED (tier wall) returns 402 but does NOT cool the account down', async () => {
    const a = seed('tier-1');
    process.env.DEVIN_CONNECT_FAILOVER_MAX = '0';
    __setConnectDeps({
      toChatCompletion: async () => {
        throw Object.assign(new Error('please /upgrade to access this model'), { code: 'MODEL_BLOCKED' });
      },
    });
    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 402);
    assert.equal(result.body.error.type, 'model_blocked');
    // No rate-limit cooldown was added — a healthy account hitting a paid wall
    // must not be demoted. (Fresh token accounts read as model_not_available by
    // default; the point is the reason is NOT a rate_limit penalty.)
    const avail = getAccountAvailability(a.apiKey, 'swe-1-6-slow');
    assert.notEqual(avail.reason, 'rate_limited', 'tier wall must not cool the account down');
  });
});

describe('DEVIN_CONNECT pool exhaustion (P0-2)', () => {
  it('returns a clean 429 with retry_after when the whole pool is rate-limited', async () => {
    const a = seed('exhaust-1');
    const b = seed('exhaust-2');
    // Whole pool rate-limited → acquire would yield nothing. Must NOT silently
    // fall back to the un-accounted env token; must return a fast 429.
    markRateLimited(a.apiKey, 5 * 60 * 1000);
    markRateLimited(b.apiKey, 5 * 60 * 1000);
    let upstreamHits = 0;
    __setConnectDeps({ toChatCompletion: async () => { upstreamHits++; return { status: 200, body: {} }; } });

    const result = await handleChatCompletions(
      { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 429);
    assert.equal(result.body.error.type, 'rate_limit_exceeded');
    assert.ok(result.body.error.retry_after_ms > 0, 'carries a retry_after hint');
    assert.ok(result.headers['Retry-After'], 'sets the Retry-After header');
    assert.equal(upstreamHits, 0, 'never touched upstream on an exhausted pool');
  });

  it('still falls back to the env token when the pool is genuinely EMPTY (single-token deploy)', async () => {
    // No accounts seeded. getAccountCount().total === 0 → exhaustion guard is
    // skipped and the connect client uses the env token, preserving the
    // single-token deploy story.
    const prevToken = process.env.DEVIN_CONNECT_TOKEN;
    process.env.DEVIN_CONNECT_TOKEN = 'devin-session-token$env-fallback';
    try {
      __setConnectDeps({
        toChatCompletion: async () => (
          { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'ENV_OK' } }] } }
        ),
      });
      const result = await handleChatCompletions(
        { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
        { callerKey: '' },
      );
      // Empty pool must NOT 429 — it serves via the env-token fallback.
      assert.equal(result.status, 200);
      assert.equal(result.body.choices[0].message.content, 'ENV_OK');
    } finally {
      if (prevToken === undefined) delete process.env.DEVIN_CONNECT_TOKEN;
      else process.env.DEVIN_CONNECT_TOKEN = prevToken;
    }
  });
});

describe('DEVIN_CONNECT re-login storm guard (P0-1)', () => {
  it('a burst of concurrent dead-token requests triggers exactly one windsurfLogin', async () => {
    // The cutover-day scenario: a batch of session tokens dies at once and many
    // in-flight requests hit the same dead account. The request path must NOT
    // force-bypass the cooldown — concurrent callers coalesce on auth.js's
    // inflight promise, so the account re-logs in ONCE, not once-per-request.
    const a = seed('storm-1');
    process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
    process.env.DEVIN_CONNECT_FAILOVER_MAX = '0'; // single account, no hop
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'stored-password',
      // Slow + failing: stays inflight through the burst, never recovers, so
      // every request reaches the re-login decision point under contention.
      windsurfLogin: async () => { loginCalls++; await new Promise(r => setTimeout(r, 25)); throw new Error('auth1 down'); },
    });
    __setConnectDeps({ toChatCompletion: async () => { throw unauthorized(); } });

    const burst = await Promise.all(
      Array.from({ length: 6 }, () => handleChatCompletions(
        { model: 'swe-1-6-slow', stream: false, messages: [{ role: 'user', content: 'hi' }] },
        { callerKey: '' },
      )),
    );
    assert.ok(burst.every(r => r.status === 401), 'all requests get a clean 401 when recovery fails');
    assert.equal(loginCalls, 1, 'one Auth1 login for the whole burst — no storm');
  });
});
