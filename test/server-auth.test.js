import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bodyTooLargePayload, extractToken, readBody } from '../src/server.js';
import { EventEmitter } from 'node:events';

describe('server auth token extraction', () => {
  it('parses Bearer authorization case-insensitively and trims the token', () => {
    assert.equal(extractToken({ headers: { authorization: 'bearer  abc123  ' } }), 'abc123');
    assert.equal(extractToken({ headers: { authorization: 'BEARER xyz' } }), 'xyz');
  });

  it('rejects malformed or duplicate Authorization headers instead of treating them as raw tokens', () => {
    assert.equal(extractToken({ headers: { authorization: 'raw-secret' } }), '');
    assert.equal(extractToken({ headers: { authorization: 'Bearer one, Bearer two', 'x-api-key': 'fallback' } }), '');
  });

  it('falls through to x-api-key when Authorization is absent', () => {
    assert.equal(extractToken({ headers: { 'x-api-key': 'fallback-key' } }), 'fallback-key');
  });
});

describe('server body parsing', () => {
  it('preserves request-body-too-large as a 413-class error', async () => {
    const req = new EventEmitter();
    req.resume = () => {};

    const promise = readBody(req);
    req.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
    req.emit('end');

    await assert.rejects(promise, (err) => {
      assert.equal(err.statusCode, 413);
      assert.equal(err.code, 'ERR_REQUEST_BODY_TOO_LARGE');
      return true;
    });
  });

  it('keeps oversized body payloads protocol-shaped instead of Invalid JSON', () => {
    assert.deepEqual(bodyTooLargePayload('openai'), {
      error: { message: 'Request body too large', type: 'invalid_request' },
    });
    // D1: 413 uses the dedicated request_too_large type (not invalid_request_error).
    assert.deepEqual(bodyTooLargePayload('anthropic'), {
      type: 'error',
      error: { type: 'request_too_large', message: 'Request body too large' },
    });
    assert.deepEqual(bodyTooLargePayload('dashboard'), {
      ok: false,
      error: 'ERR_REQUEST_BODY_TOO_LARGE',
      message: 'Request body too large',
    });
  });
});
