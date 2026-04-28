import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractUserStatusBytes } from '../src/windsurf.js';
import { writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';

describe('extractUserStatusBytes', () => {
  it('returns raw top-level user_status submessage bytes', () => {
    const userStatusBytes = Buffer.concat([
      writeVarintField(1, 1),
      writeStringField(7, 'user@example.test'),
    ]);
    const planInfoBytes = writeStringField(2, 'Pro');
    const resp = Buffer.concat([
      writeMessageField(1, userStatusBytes),
      writeMessageField(2, planInfoBytes),
    ]);

    assert.deepEqual(Buffer.from(extractUserStatusBytes(resp)), userStatusBytes);
  });
});
