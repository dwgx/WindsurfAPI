// REQUEST_REJECTED — an upstream 4xx-class VALIDATOR rejection is a 400, not a 503.
//
// Measured (evidence/AccountMatrix.md §7.1, 2026-10-25): an image request to a
// model whose /v1/models row OMITS `supports_images` (absent, not false) comes
// back as a 106-byte end-of-stream trailer
//
//   {"error":{"code":"invalid_argument","message":"an internal error occurred"}}
//
// and the proxy surfaced it as 503 UPSTREAM_INTERNAL / `upstream_transient_error`.
// The upstream message happens to contain the words "internal error occurred",
// so the transient text arm claimed the frame BEFORE any code-based arm — but
// `invalid_argument` is the request VALIDATOR refusing these exact bytes:
// permanent, account-healthy, and never fixed by a retry. The same code is the
// measured verdict for a malformed tool history (#273.1: "There is an issue with
// this request, please try a different model.").
//
// This file pins the corrected mapping and the transient controls that must NOT
// move: a genuine 5xx backend fault stays 503.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  classifyUpstreamError, isRetryable, streamChat, chatWithRetry, __setRequestImpl,
} from '../src/devin-connect.js';
import {
  handleChatCompletions, connectErrorToHttp, __setConnectDeps, __resetConnectDeps,
} from '../src/handlers/chat.js';
import { setLiveCatalogSelectors, clearLiveCatalogSelectors } from '../src/devin-connect-models.js';
import { getConnectMetrics } from '../src/devin-connect-metrics.js';

// The captured trailer, verbatim (106 B, sha256 f8f40e32…4845268a).
const FRAME_HEX = '03000000651f8b08000000000000ff004c00b3ff7b226572726f72223a7b22636f6465223a22696e76616c69645f617267756d656e74222c226d657373616765223a22616e20696e7465726e616c206572726f72206f63637572726564227d7d0300aee1cf014c000000';
const FRAME = Buffer.from(FRAME_HEX, 'hex');
const UPSTREAM_MESSAGE = 'an internal error occurred';

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY',
  'WINDSURFAPI_STRICT_MODEL', 'DEVIN_CONNECT_FAILOVER_MAX'];
const SAVED_ENV = {};
for (const key of ENV_KEYS) SAVED_ENV[key] = process.env[key];

let hits = 0;
/** Fake connect socket: `status` + raw body chunks, no network. */
function transport(status, chunks) {
  return (_opts, cb) => {
    hits++;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = status;
      setImmediate(() => {
        for (const c of chunks) res.emit('data', c);
        res.emit('end');
      });
      cb(res);
    };
    return req;
  };
}

/** Uncompressed end-of-stream trailer frame (flags 0x02) for `payload`. */
function trailerFrame(payload) {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(5);
  head[0] = 0x02;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Drain streamChat to completion; returns the thrown error (or null). */
async function drainStream(params) {
  try {
    for await (const _ev of streamChat(params)) { /* drain */ }
    return null;
  } catch (e) {
    return e;
  }
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '', writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
  };
}

function parseFrames(raw) {
  return raw.split('\n\n').filter(Boolean).filter((f) => !f.startsWith(':'))
    .map((f) => f.split('\n').find((l) => l.startsWith('data: '))?.slice(6) || '')
    .filter(Boolean)
    .map((d) => (d === '[DONE]' ? '[DONE]' : JSON.parse(d)));
}

const imageMessages = [{
  role: 'user',
  content: [{ type: 'text', text: 'one word: the dominant color' }, { type: 'image_url', image_url: { url: DATA_URL } }],
}];

/** The error the trailer path builds, exactly as devin-connect.js does. */
function classifiedError(text, code, status = null) {
  const c = classifyUpstreamError(text, code, status);
  return Object.assign(new Error(c.message), { code: c.code, status });
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'devin-session-token$test.only';
  delete process.env.WINDSURF_API_KEY;
  delete process.env.WINDSURFAPI_STRICT_MODEL;
  delete process.env.DEVIN_CONNECT_FAILOVER_MAX;
  hits = 0;
});

afterEach(() => {
  __setRequestImpl(null);
  __resetConnectDeps();
  clearLiveCatalogSelectors();
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

describe('classifyUpstreamError — 4xx-class validator rejection', () => {
  it('the §7.1 frame (invalid_argument + "internal error occurred") is REQUEST_REJECTED', () => {
    const c = classifyUpstreamError(UPSTREAM_MESSAGE, 'invalid_argument', null);
    assert.equal(c.code, 'REQUEST_REJECTED',
      'an explicit invalid_argument is the request validator rejecting these bytes — it must not '
      + 'be swallowed by the "internal error occurred" TEXT arm (that arm is for a body with no code)');
  });

  it('failed_precondition + the #273.1 "different model" body is REQUEST_REJECTED', () => {
    // Measured for a malformed native tool history: 502 invalid_argument /
    // failed_precondition "There is an issue with this request, please try a
    // different model." Permanent, request-shaped, account-healthy.
    const c = classifyUpstreamError(
      'There is an issue with this request, please try a different model.',
      'failed_precondition', null,
    );
    assert.equal(c.code, 'REQUEST_REJECTED');
  });

  it('keeps the upstream message AND adds a capability hint naming supports_images', () => {
    const c = classifyUpstreamError(UPSTREAM_MESSAGE, 'invalid_argument', null);
    assert.ok(c.message.includes(UPSTREAM_MESSAGE), 'the upstream message must survive verbatim');
    assert.match(c.message, /supports_images/,
      'the hint must name the capability bit a client can check');
    assert.match(c.message, /\/v1\/models/, 'the hint must point at the catalog endpoint');
    assert.match(c.message, /invalid_argument/, 'the hint must name the upstream code');
    // messages.js generalizes any body containing its leak markers, which would
    // erase the hint for an Anthropic client. Keep the hint free of them.
    for (const marker of ['devin_connect', 'session token', 'accounts exhausted', 'pooled account', 'failover', 'cascade']) {
      assert.ok(!c.message.toLowerCase().includes(marker),
        `the client-facing hint must not contain the internal leak marker "${marker}"`);
    }
  });

  it('narrower verdicts still win: quota-dry failed_precondition stays QUOTA_EXHAUSTED', () => {
    const live = 'Your daily usage quota has been exhausted. Visit '
      + 'https://app.devin.ai/settings/usage to review your plan and usage. (trace ID: 6f1c9a2e)';
    const failure = classifyUpstreamError(live, 'failed_precondition', 400);
    assert.equal(failure.code, 'QUOTA_EXHAUSTED');
    assert.equal(failure.quotaPeriod, 'daily');
    assert.equal(classifyUpstreamError('Weekly usage quota is exhausted.', 'failed_precondition', 400).quotaPeriod, 'weekly');
    assert.equal(classifyUpstreamError('Insufficient monthly credit', 'insufficient_quota', 402).quotaPeriod, undefined);
    assert.equal(classifyUpstreamError('Daily quota is not exhausted. Insufficient credit.', 'insufficient_quota', 402).quotaPeriod, undefined);
  });

  it('narrower verdicts still win: content policy on invalid_argument stays CONTENT_BLOCKED', () => {
    assert.equal(classifyUpstreamError(
      'Your request was blocked by our content policy. Please remove sensitive or unsafe content.',
      'invalid_argument', null,
    ).code, 'CONTENT_BLOCKED');
  });

  it('transient-first still wins: capacity text on invalid_argument stays CAPACITY', () => {
    assert.equal(classifyUpstreamError(
      "We're currently facing high demand for this model. Please try again later.",
      'invalid_argument', null,
    ).code, 'CAPACITY');
  });

  it('a genuine 5xx backend fault with NO code is still UPSTREAM_INTERNAL', () => {
    assert.equal(classifyUpstreamError('an internal error occurred (trace ID: abc)', null, 500).code,
      'UPSTREAM_INTERNAL');
    assert.equal(classifyUpstreamError('an internal error occurred', null, 503).code,
      'UPSTREAM_INTERNAL');
  });

  it('is NOT retryable, even when delivered as a 5xx shell', () => {
    assert.equal(isRetryable({ code: 'REQUEST_REJECTED' }), false);
    assert.equal(isRetryable({ code: 'REQUEST_REJECTED', status: 500 }), false,
      'identical bytes fail identically; a same-token replay only amplifies load');
  });

  // P2-5 (Kimi wave review): the status-based UNAUTHORIZED arm used to run
  // BEFORE the explicit-code arm, so a validator verdict delivered in the
  // measured 401/403 shell was charged to the account and started a re-login
  // for a token that was never dead. The code is the more specific evidence.
  it('an explicit validator code wins over a 401/403 auth shell', () => {
    for (const status of [401, 403]) {
      assert.equal(classifyUpstreamError(UPSTREAM_MESSAGE, 'invalid_argument', status).code,
        'REQUEST_REJECTED',
        `invalid_argument in a ${status} shell is the request validator, not a dead token`);
      assert.equal(classifyUpstreamError(
        'There is an issue with this request, please try a different model.',
        'failed_precondition', status,
      ).code, 'REQUEST_REJECTED',
      `failed_precondition in a ${status} shell is the request validator`);
    }
  });

  it('real auth failures with no validator code stay UNAUTHORIZED', () => {
    assert.equal(classifyUpstreamError('permission denied', null, 401).code, 'UNAUTHORIZED');
    assert.equal(classifyUpstreamError('', null, 403).code, 'UNAUTHORIZED');
    assert.equal(classifyUpstreamError('invalid token', null, 401).code, 'UNAUTHORIZED');
    assert.equal(classifyUpstreamError('', 'permission_denied', 403).code, 'UNAUTHORIZED',
      'an explicit auth code must not be reclassified');
    assert.equal(classifyUpstreamError('', 'unauthenticated', 401).code, 'UNAUTHORIZED');
  });
});

describe('connectErrorToHttp — 400 for a request rejection, 503 for transients', () => {
  it('maps REQUEST_REJECTED to 400 invalid_request_error', () => {
    assert.deepEqual(connectErrorToHttp('REQUEST_REJECTED'), {
      status: 400, type: 'invalid_request_error',
    });
  });

  it('leaves UPSTREAM_INTERNAL at 503 upstream_transient_error', () => {
    assert.deepEqual(connectErrorToHttp('UPSTREAM_INTERNAL'), {
      status: 503, type: 'upstream_transient_error',
    });
  });
});

describe('streamChat — the captured frame through the real parser', () => {
  it('classifies the 106-byte trailer as REQUEST_REJECTED (not UPSTREAM_INTERNAL)', async () => {
    __setRequestImpl(transport(200, [FRAME]));
    const err = await chatWithRetry({
      messages: imageMessages,
      model: 'swe-2-medium',
      token: 'devin-session-token$test.only',
      env: { DEVIN_CONNECT_TOKEN: 'devin-session-token$test.only' },
      maxRetries: 2,
    }).then(() => null, (e) => e);
    assert.ok(err, 'the trailer must fail the request');
    assert.equal(err.code, 'REQUEST_REJECTED');
    assert.match(err.message, /supports_images/);
    assert.equal(hits, 1, 'a permanent rejection must NOT be replayed in-process');
  });

  it('a transient internal-error trailer with no code still throws UPSTREAM_INTERNAL', async () => {
    const trailer = trailerFrame({ error: { message: 'an internal error occurred (trace ID: 9f3a)' } });
    __setRequestImpl(transport(200, [trailer]));
    const err = await drainStream({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'swe-2-medium',
      token: 'devin-session-token$test.only',
      env: { DEVIN_CONNECT_TOKEN: 'devin-session-token$test.only' },
    });
    assert.ok(err, 'the trailer must fail the request');
    assert.equal(err.code, 'UPSTREAM_INTERNAL');
  });
});

describe('handleChatCompletions — client surface', () => {
  it('image to an unknown-capability model returns 400 with the upstream message + hint', async () => {
    // The §7.1 catalog row: `supports_images` ABSENT (unknown), so the gate
    // forwards the image exactly as the matrix run did.
    setLiveCatalogSelectors([{ selector: 'swe-2-medium', provider: 'test' }]);
    __setConnectDeps({
      toChatCompletion: async () => { throw classifiedError(UPSTREAM_MESSAGE, 'invalid_argument'); },
    });
    const result = await handleChatCompletions(
      { model: 'swe-2-medium', stream: false, messages: imageMessages },
      { callerKey: '' },
    );
    assert.equal(result.status, 400, 'a permanent capability rejection is the caller\'s to fix, not a 503');
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.equal(result.body.error.code, 'REQUEST_REJECTED');
    assert.match(result.body.error.message, /an internal error occurred/);
    assert.match(result.body.error.message, /supports_images/);
  });

  it('a genuine transient 5xx is unchanged: 503 upstream_transient_error', async () => {
    __setConnectDeps({
      toChatCompletion: async () => {
        throw classifiedError('an internal error occurred (trace ID: abc)', null, 500);
      },
    });
    const result = await handleChatCompletions(
      { model: 'swe-2-medium', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error.type, 'upstream_transient_error');
    assert.equal(result.body.error.code, 'UPSTREAM_INTERNAL');
  });

  it('the streaming surface carries invalid_request_error, not a retryable upstream_error', async () => {
    setLiveCatalogSelectors([{ selector: 'swe-2-medium', provider: 'test' }]);
    __setConnectDeps({
      streamChatCompletion: async () => { throw classifiedError(UPSTREAM_MESSAGE, 'invalid_argument'); },
    });
    const result = await handleChatCompletions(
      { model: 'swe-2-medium', stream: true, messages: imageMessages },
      { callerKey: '' },
    );
    const res = fakeRes();
    await result.handler(res);
    const frames = parseFrames(res.body);
    const errFrame = frames.find((f) => f !== '[DONE]' && f.error);
    assert.ok(errFrame, 'an error frame must be surfaced');
    assert.equal(errFrame.error.code, 'REQUEST_REJECTED');
    assert.equal(errFrame.error.type, 'invalid_request_error',
      'a 400-class rejection must not be typed as a retryable upstream error');
    assert.match(errFrame.error.message, /supports_images/);
  });

  it('counts the rejection without benching the account', async () => {
    // The counter and the blame decision both live in finalizeConnectAccount,
    // which only runs for a POOLED account (the env-token path returns early).
    // A healthy peer voids the last-account exemption, exactly like
    // connect-error-blame.test.js.
    const { addAccountByKey, removeAccount, getAccountInternal } = await import('../src/auth.js');
    const { finalizeConnectAccount } = await import('../src/handlers/chat.js');
    const made = [];
    const seed = (label) => {
      const a = addAccountByKey(
        `devin-session-token$rr-${label}-${Math.random().toString(36).slice(2)}`, label,
      );
      made.push(a.id);
      return a;
    };
    try {
      const victim = seed('victim');
      seed('peer');
      const before = getConnectMetrics().request_rejected;
      for (let i = 0; i < 3; i++) {
        finalizeConnectAccount({ id: victim.id, apiKey: victim.apiKey }, {
          model: 'swe-2-medium', selector: 'swe-2-medium', startTime: Date.now(),
          err: Object.assign(new Error('rejected'), { code: 'REQUEST_REJECTED' }),
        });
      }
      const after = getAccountInternal(victim.id);
      assert.equal(getConnectMetrics().request_rejected - before, 3,
        'the rejection must be visible in the connect metrics');
      assert.notEqual(after.status, 'error',
        'a caller looping on an unsupported image must not walk the pool offline');
      assert.equal(after.errorCount || 0, 0, 'the rejection must not charge the error budget');
    } finally {
      while (made.length) removeAccount(made.pop());
    }
  });
});
