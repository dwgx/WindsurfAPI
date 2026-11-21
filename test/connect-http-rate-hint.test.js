// Connect rate-limit retry hints on the two real HTTP 429 paths.
//
// Contract under test:
//   1. Buffered /v1/chat/completions — the DEVIN_CONNECT terminal error used to
//      return a bare 429: the provider's resetMs never reached the client.
//      A usable hint now rides BOTH the Retry-After header and
//      error.retry_after_ms, through the same clientRetryAfterSeconds clamp the
//      streaming path uses (default floor 30 s, ceiling 600 s, whole seconds).
//   2. Pre-first-content stream — the commit gate already sent Retry-After but
//      its default JSON body dropped the milliseconds. Default body now carries
//      the same advertised delay; custom errorBody builders keep their shape.
//   3. After first content the response is already a committed 200 SSE; the
//      error frame keeps its own retry_after_ms and no 429 rewrite happens.
//
// Offline only: fake adapter via __setConnectDeps, synthetic accounts, no
// upstream. Mirrors the root probe (sole free account A, resetMs=42000).

process.env.STICKY_SESSION_ENABLED = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDeferredSseResponse } from '../src/sse-commit.js';

const {
  __setModelCatalogDeps, __resetModelCatalogState, __waitForModelCatalogSync,
  addAccountByKey, getAccountInternal, removeAccount,
} = await import('../src/auth.js');
const { MODELS, mergeCloudModels, clearCloudModelCatalogs } = await import('../src/models.js');
const { clearLiveCatalogSelectors } = await import('../src/devin-connect-models.js');
const { handleChatCompletions, __setConnectDeps, __resetConnectDeps } = await import('../src/handlers/chat.js');

const selector = 'swe-2-medium';
const ids = [];
const originalEnv = { ...process.env };

function seed() {
  const row = addAccountByKey('offline-rate-hint', 'rate-hint@example.invalid');
  ids.push(row.id);
  const acct = getAccountInternal(row.id);
  acct.status = 'active';
  acct.tier = 'pro';
  acct.credits = { weeklyPercent: 1, dailyPercent: 1, rateTable: { [selector]: 6 } };
  return acct;
}

function priceFree(acct) {
  const uids = [...new Set(Object.values(MODELS).map((m) => m.modelUid).filter(Boolean))];
  mergeCloudModels([
    ...uids.filter((x) => x !== selector).map((modelUid) => ({ modelUid })),
    {
      modelUid: selector,
      provider: 'MODEL_PROVIDER_WINDSURF',
      modelCostTier: 'MODEL_COST_TIER_FREE',
      promoStatus: { isActive: true, endDate: new Date(Date.now() + 86_400_000).toISOString() },
      creditMultiplier: 6,
    },
  ], { accountId: acct.id });
}

async function bufferedRateLimit(error) {
  const acct = seed();
  await __waitForModelCatalogSync();
  priceFree(acct);
  __setConnectDeps({ toChatCompletion: async () => { throw error; } });
  return handleChatCompletions(
    { model: selector, messages: [{ role: 'user', content: 'offline rate hint' }], stream: false },
    { callerKey: 'rate-hint' },
  );
}

function rateLimitError(resetMs) {
  return Object.assign(new Error('Synthetic rate limit'), {
    code: 'RATE_LIMITED',
    ...(resetMs === undefined ? {} : { resetMs }),
  });
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DROUGHT_RESTRICT_PREMIUM = '1';
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  __setModelCatalogDeps({
    getCascadeModelConfigs: async () => ({ configs: [] }),
    fetchConnectCatalog: async () => [{ selector }],
    scheduleCatalogRetry: () => () => {},
  });
});

afterEach(async () => {
  __resetConnectDeps();
  while (ids.length) removeAccount(ids.pop());
  await __waitForModelCatalogSync();
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  clearCloudModelCatalogs();
  clearLiveCatalogSelectors();
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('buffered Connect 429 keeps the provider retry hint', () => {
  it('advertises the same 42000 ms wait in Retry-After and error.retry_after_ms', async () => {
    const result = await bufferedRateLimit(rateLimitError(42000));
    assert.equal(result.status, 429);
    assert.equal(result.headers?.['Retry-After'], '42');
    assert.equal(result.body?.error?.code, 'RATE_LIMITED');
    assert.equal(result.body?.error?.type, 'rate_limit_error');
    assert.equal(result.body?.error?.retry_after_ms, 42000);
  });

  it('rounds a non-integral hint up and reports the same value in both places', async () => {
    const result = await bufferedRateLimit(rateLimitError(42001));
    assert.equal(result.headers?.['Retry-After'], '43');
    assert.equal(result.body?.error?.retry_after_ms, 43000);
  });

  it('lifts a too-short hint to the client backoff floor', async () => {
    const result = await bufferedRateLimit(rateLimitError(2500));
    assert.equal(result.headers?.['Retry-After'], '30');
    assert.equal(result.body?.error?.retry_after_ms, 30000);
  });

  it('clamps an oversized hint to the client backoff ceiling', async () => {
    const result = await bufferedRateLimit(rateLimitError(900000));
    assert.equal(result.headers?.['Retry-After'], '600');
    assert.equal(result.body?.error?.retry_after_ms, 600000);
  });

  it('keeps the historical 429 shape when the provider gives no usable hint', async () => {
    for (const resetMs of [undefined, 0, -1, NaN]) {
      const result = await bufferedRateLimit(rateLimitError(resetMs));
      // Drop the cooled account before the next variant, or its successor would
      // be intercepted by the pool-exhausted preflight instead of the adapter.
      removeAccount(ids.pop());
      assert.equal(result.status, 429);
      assert.equal(result.headers, undefined, `resetMs=${String(resetMs)} must not invent a header`);
      assert.equal(result.body?.error?.retry_after_ms, undefined);
      assert.equal(result.body?.error?.code, 'RATE_LIMITED');
    }
  });
});

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; },
    end(chunk) { if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); this.writableEnded = true; },
    setHeader() {},
    getHeader() {},
    removeHeader() {},
    on() {},
    once() {},
    removeListener() {},
    destroy() { this.writableEnded = true; },
    socket: null,
  };
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function preContentError(retryAfterMs) {
  const real = fakeRes();
  const res = createDeferredSseResponse(real, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  res.write(frame({
    error: {
      message: 'rate limited',
      type: 'rate_limit_error',
      code: 'RATE_LIMITED',
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
    },
  }));
  res.end();
  return { real, body: JSON.parse(real.body) };
}

describe('pre-content stream 429 default JSON matches its Retry-After', () => {
  it('exposes the clamped wait in the body as well as the header', () => {
    const { real, body } = preContentError(42000);
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], '42');
    assert.equal(body.error.retry_after_ms, 42000);
  });

  it('rounds and clamps exactly like the header', () => {
    const short = preContentError(2500);
    assert.equal(short.real.headers['retry-after'], '30');
    assert.equal(short.body.error.retry_after_ms, 30000);

    const huge = preContentError(900000);
    assert.equal(huge.real.headers['retry-after'], '600');
    assert.equal(huge.body.error.retry_after_ms, 600000);
  });

  it('adds neither header nor body field when the frame has no hint', () => {
    const { real, body } = preContentError(undefined);
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], undefined);
    assert.equal(body.error.retry_after_ms, undefined);
  });

  it('preserves the existing JSON error shape for a capacity response', () => {
    const real = fakeRes();
    const response = createDeferredSseResponse(real);
    response.write(frame({ error: { message: 'busy', code: 'CAPACITY', retry_after_ms: 42000 } }));
    response.end();
    assert.equal(real.statusCode, 503);
    assert.equal(real.headers['retry-after'], '42');
    assert.equal(Object.hasOwn(JSON.parse(real.body).error, 'retry_after_ms'), false);
  });

  it('leaves a custom errorBody shape untouched', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, {
      status: 200,
      protocol: 'messages',
      parseError: (obj) => (obj?.type === 'error' ? obj.error : null),
      errorBody: (error, status) => ({ type: 'error', error: { type: 'rate_limit_error', status, custom: true } }),
    });
    res.write(frame({ type: 'error', error: { message: 'busy', code: 'RATE_LIMITED', retry_after_ms: 42000 } }));
    res.end();
    const body = JSON.parse(real.body);
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], '42');
    assert.deepEqual(body, { type: 'error', error: { type: 'rate_limit_error', status: 429, custom: true } });
  });

  it('keeps post-content failures on the committed SSE 200 wire', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    res.write(frame({ choices: [{ delta: { content: 'hi' } }] }));
    res.write(frame({ error: { message: 'rate limited', code: 'RATE_LIMITED', retry_after_ms: 42000 } }));
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.headers['content-type'], 'text/event-stream');
    assert.equal(real.headers['retry-after'], undefined);
    assert.ok(real.body.includes('"retry_after_ms":42000'));
  });
});
