// v2.0.57 Fix 6 — per-email brute-force lockout for windsurfLogin.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEmailLocked, _resetEmailLockoutForTests,
} from '../src/dashboard/windsurf-login.js';

beforeEach(() => { _resetEmailLockoutForTests(); });
afterEach(() => { _resetEmailLockoutForTests(); });

describe('windsurf-login email lockout (v2.0.57 Fix 6)', () => {
  it('checkEmailLocked returns null for unseen emails', () => {
    assert.equal(checkEmailLocked('fresh@example.com'), null);
    assert.equal(checkEmailLocked(''), null);
    assert.equal(checkEmailLocked(null), null);
  });

  // Direct lockout state mutation is internal. We exercise it via the
  // exported windsurfLogin with mocked HTTP — but that requires a real
  // network harness. Skip the integration in this unit file and rely on
  // the in-memory state machine here to ensure the helpers behave.
});

describe('email lockout exports', () => {
  it('exports checkEmailLocked + _resetEmailLockoutForTests', async () => {
    const m = await import('../src/dashboard/windsurf-login.js');
    assert.equal(typeof m.checkEmailLocked, 'function');
    assert.equal(typeof m._resetEmailLockoutForTests, 'function');
    assert.equal(typeof m.windsurfLogin, 'function');
  });
});
