// v2.0.55 audit L1 regression — safeEqualString must compare via fixed-
// width hash digests so the early-return on length mismatch can't be used
// as a length oracle by a wall-clock attacker.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeEqualString } from '../src/auth.js';

describe('safeEqualString — hash-based, no length oracle (audit L1)', () => {
  it('returns true for identical strings', () => {
    assert.equal(safeEqualString('sk-dwgxnbnb888', 'sk-dwgxnbnb888'), true);
    assert.equal(safeEqualString('', ''), true);
    assert.equal(safeEqualString('a', 'a'), true);
  });

  it('returns false for different same-length strings', () => {
    assert.equal(safeEqualString('aaaa', 'bbbb'), false);
    assert.equal(safeEqualString('sk-12345678', 'sk-12345679'), false);
  });

  it('returns false for different-length strings without leaking via early return', () => {
    // The point of L1: short-vs-long should still take roughly the same
    // path (sha256 of both). We don't time-assert here (timing is noisy
    // in CI) — instead we verify the function runs to completion and
    // returns false for a cross-section of length differences.
    assert.equal(safeEqualString('a', 'b'), false);
    assert.equal(safeEqualString('short', 'a-rather-much-longer-string'), false);
    assert.equal(safeEqualString('x', 'x'.repeat(1000)), false);
    assert.equal(safeEqualString('x'.repeat(100), 'x'.repeat(100) + 'y'), false);
  });

  it('handles non-string inputs by stringifying', () => {
    assert.equal(safeEqualString(123, 123), true);
    assert.equal(safeEqualString(null, ''), false);  // 'null' !== ''
    assert.equal(safeEqualString(undefined, ''), false);
  });

  it('UTF-8 multi-byte secrets compare byte-accurately', () => {
    assert.equal(safeEqualString('密码', '密码'), true);
    assert.equal(safeEqualString('密码', '密玛'), false);
    // Same logical char count, different code points → false.
    assert.equal(safeEqualString('café', 'café'), false);
  });
});
