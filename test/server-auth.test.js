import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractToken } from '../src/server.js';

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
