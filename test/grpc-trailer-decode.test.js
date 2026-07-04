import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGrpcMessage } from '../src/grpc.js';

describe('grpc-message trailer decode hardening', () => {
  it('does not throw URIError on a malformed percent-escape', () => {
    // A bare '%' would throw out of decodeURIComponent; the helper must not.
    assert.doesNotThrow(() => decodeGrpcMessage('%'));
    assert.doesNotThrow(() => decodeGrpcMessage('bad %zz escape'));
    assert.doesNotThrow(() => decodeGrpcMessage('trailing %'));
  });

  it('falls back to the raw value when decoding fails', () => {
    assert.equal(decodeGrpcMessage('%'), '%');
    assert.equal(decodeGrpcMessage('bad %zz escape'), 'bad %zz escape');
  });

  it('still decodes well-formed percent-encoded messages', () => {
    assert.equal(decodeGrpcMessage('resource%20exhausted'), 'resource exhausted');
    assert.equal(decodeGrpcMessage('quota%3A%20100%25'), 'quota: 100%');
  });

  it('is a no-op for plain unencoded messages', () => {
    assert.equal(decodeGrpcMessage('plain message'), 'plain message');
    assert.equal(decodeGrpcMessage(''), '');
  });

  it('surfaces a malformed trailer as an Error message without crashing', () => {
    // Mirrors the end-listener path: non-OK status + malformed grpc-message.
    const grpcMessage = 'boom %';
    let err;
    assert.doesNotThrow(() => {
      const msg = grpcMessage ? decodeGrpcMessage(grpcMessage) : 'gRPC status 8';
      err = new Error(msg);
    });
    assert.equal(err.message, 'boom %');
  });
});
