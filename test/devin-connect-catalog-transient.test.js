import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  fetchUserStatus,
  checkSessionLiveness,
  __setCatalogRequestImpl,
} from '../src/devin-connect-catalog.js';

// P2-A: the catalog unary probe (GetUserStatus / GetCliModelConfigs) historically
// classified every non-200 by HTTP STATUS alone — 401/403 → UNAUTHORIZED. But the
// upstream wraps TRANSIENT faults (capacity "high demand", backend "internal error
// occurred (trace ID: ...)") inside a 401/403 auth-shell on this path too. A blip
// then read as a dead token, and the liveness probe (probeAndRecoverConnectAccount)
// force-re-logins on UNAUTHORIZED → a live token burned on a momentary hiccup
// (the #56/#57 母题). These tests pin transient-first classification on the probe.

// Fake transport: invoke the response callback with a non-200 status + body, the
// same shape https.request would deliver. No real socket.
function mockNon200(statusCode, body) {
  return (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      // Deliver the response asynchronously, like the real socket.
      setImmediate(() => {
        cb(res);
        res.emit('data', Buffer.from(body, 'utf8'));
        res.emit('end');
        // Real sockets emit 'close' on the request once done; unaryCall clears
        // its 30s guard timer on 'close', so emit it or the timer leaks.
        req.emit('close');
      });
    };
    req.destroy = () => {};
    return req;
  };
}

afterEach(() => { __setCatalogRequestImpl(null); });

describe('catalog unary probe — transient-first classification (P2-A)', () => {
  it('classifies a "high demand" body in a 401 shell as CAPACITY, not UNAUTHORIZED', async () => {
    __setCatalogRequestImpl(mockNon200(401,
      "We're currently facing high demand for this model. Please try again later."));
    await assert.rejects(
      fetchUserStatus({ token: 'devin-session-token$abc' }),
      (err) => err.code === 'CAPACITY',
    );
  });

  it('classifies an "internal error occurred (trace ID)" 403 shell as UPSTREAM_INTERNAL', async () => {
    __setCatalogRequestImpl(mockNon200(403,
      'an internal error occurred (trace ID: 9f3a2b1c)'));
    await assert.rejects(
      fetchUserStatus({ token: 'devin-session-token$abc' }),
      (err) => err.code === 'UPSTREAM_INTERNAL',
    );
  });

  it('still classifies a genuine auth-death 401 as UNAUTHORIZED', async () => {
    __setCatalogRequestImpl(mockNon200(401, 'permission_denied: invalid session token'));
    await assert.rejects(
      fetchUserStatus({ token: 'devin-session-token$abc' }),
      (err) => err.code === 'UNAUTHORIZED',
    );
  });

  it('recovers the Connect-RPC code from a JSON error body (unavailable → CAPACITY)', async () => {
    __setCatalogRequestImpl(mockNon200(503,
      JSON.stringify({ code: 'unavailable', message: 'backend down' })));
    await assert.rejects(
      fetchUserStatus({ token: 'devin-session-token$abc' }),
      (err) => err.code === 'CAPACITY',
    );
  });

  it('maps 429 to RATE_LIMITED', async () => {
    __setCatalogRequestImpl(mockNon200(429, 'too many requests'));
    await assert.rejects(
      fetchUserStatus({ token: 'devin-session-token$abc' }),
      (err) => err.code === 'RATE_LIMITED',
    );
  });

  it('checkSessionLiveness surfaces CAPACITY (NOT UNAUTHORIZED) on a 401-shelled capacity blip', async () => {
    // The decisive 母题 guard: probeAndRecoverConnectAccount only force-re-logins
    // when code === 'UNAUTHORIZED'. A CAPACITY here means a live token is left
    // alone instead of being re-logged-in over a transient upstream hiccup.
    __setCatalogRequestImpl(mockNon200(401,
      'the service is temporarily unavailable, please try again later'));
    const res = await checkSessionLiveness({ token: 'devin-session-token$abc' });
    assert.equal(res.alive, false);
    assert.equal(res.code, 'CAPACITY');
  });

  it('checkSessionLiveness still reports UNAUTHORIZED on a real dead token', async () => {
    __setCatalogRequestImpl(mockNon200(401, 'unauthenticated'));
    const res = await checkSessionLiveness({ token: 'devin-session-token$abc' });
    assert.equal(res.alive, false);
    assert.equal(res.code, 'UNAUTHORIZED');
  });
});
