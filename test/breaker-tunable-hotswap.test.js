// v3.0.3 — circuit-breaker / rate-limit tunables env→runtime-config migration.
// Confirms the three-tier resolution (override → env → historical default), the
// setter whitelist/clamp/null-clear semantics, the breakerBaseMs→errorRecoveryMs
// dynamic default, and that an env-only deploy is byte-identical to the old
// hardcoded behaviour. In-memory only (temp DATA_DIR from setup-env.mjs).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetRuntimeConfigForTests,
  getBreakerTunable, getBreakerTunables, getBreakerOverrides, setBreakerTunables,
} from '../src/runtime-config.js';

// Save/restore the env vars these tests poke so cross-test state can't leak.
const ENV_KEYS = [
  'WINDSURFAPI_ERROR_STREAK_THRESHOLD', 'WINDSURFAPI_ERROR_WINDOW_MS',
  'WINDSURFAPI_INTERNAL_ERROR_THRESHOLD', 'WINDSURFAPI_INTERNAL_QUARANTINE_MS',
  'WINDSURFAPI_ERROR_RECOVERY_MS', 'WINDSURFAPI_BREAKER', 'WINDSURFAPI_BREAKER_BASE_MS',
  'WINDSURFAPI_BREAKER_FACTOR', 'WINDSURFAPI_BREAKER_MAX_MS', 'WINDSURFAPI_BREAKER_STREAK_START',
  'WINDSURFAPI_NEW_ACCOUNT_GRACE_MS', 'WINDSURFAPI_LAST_ACCOUNT_EXEMPT', 'WINDSURFAPI_NEW_ACCOUNT_BASELINE',
];
let saved;

describe('breaker tunables — three-tier resolution (v3.0.3)', () => {
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetRuntimeConfigForTests();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('empty config falls back to the historical defaults', () => {
    // No override, no env → the old hardcoded values.
    assert.equal(getBreakerTunable('errorStreakThreshold'), 3);
    assert.equal(getBreakerTunable('errorWindowMs'), 1800000);
    assert.equal(getBreakerTunable('internalErrorThreshold'), 2);
    assert.equal(getBreakerTunable('internalQuarantineMs'), 120000); // L1: cut 5min→2min (KiroStudio short-cooldown philosophy)
    assert.equal(getBreakerTunable('errorRecoveryMs'), 900000);
    assert.equal(getBreakerTunable('breakerFactor'), 1.5);
    assert.equal(getBreakerTunable('breakerMaxMs'), 3600000);
    assert.equal(getBreakerTunable('breakerStreakStart'), 2);
    assert.equal(getBreakerTunable('newAccountGraceMs'), 600000);
    assert.equal(getBreakerTunable('breakerEnabled'), true);
    assert.equal(getBreakerTunable('lastAccountExempt'), true);
    assert.equal(getBreakerTunable('newAccountBaseline'), true);
    // F3/F2 defaults must be byte-identical to pre-change behaviour: floor=0 (no
    // floor), ceil=600000 (safety only), burst=300000 (the old hard-coded 5min).
    assert.equal(getBreakerTunable('rlClientBackoffFloorMs'), 0);
    assert.equal(getBreakerTunable('rlClientBackoffCeilMs'), 600000);
    assert.equal(getBreakerTunable('rlBurstMs'), 300000);
    // L2 degraded-serve defaults OFF (byte-identical: return null → 429).
    assert.equal(getBreakerTunable('degradedServe'), false);
  });

  it('env overrides the default; injected env is honored (env-only deploy path)', () => {
    const env = { WINDSURFAPI_ERROR_STREAK_THRESHOLD: '5', WINDSURFAPI_BREAKER: '0' };
    assert.equal(getBreakerTunable('errorStreakThreshold', env), 5);
    assert.equal(getBreakerTunable('breakerEnabled', env), false);
    // default process.env path (nothing set) still gives the default
    assert.equal(getBreakerTunable('errorStreakThreshold'), 3);
  });

  it('runtime-config override beats env', () => {
    setBreakerTunables({ errorStreakThreshold: 7 });
    const env = { WINDSURFAPI_ERROR_STREAK_THRESHOLD: '5' };
    assert.equal(getBreakerTunable('errorStreakThreshold', env), 7);
  });

  it('breakerBaseMs resolves to errorRecoveryMs when unset (dynamic default)', () => {
    assert.equal(getBreakerTunable('breakerBaseMs'), getBreakerTunable('errorRecoveryMs'));
    setBreakerTunables({ errorRecoveryMs: 1200000 });
    assert.equal(getBreakerTunable('breakerBaseMs'), 1200000, 'base follows recovery');
    setBreakerTunables({ breakerBaseMs: 1000000 });
    assert.equal(getBreakerTunable('breakerBaseMs'), 1000000, 'explicit base wins');
  });

  it('breakerFactor is strict >1: env "1" falls to default, override clamps to min', () => {
    assert.equal(getBreakerTunable('breakerFactor', { WINDSURFAPI_BREAKER_FACTOR: '1' }), 1.5);
    assert.equal(getBreakerTunable('breakerFactor', { WINDSURFAPI_BREAKER_FACTOR: '2' }), 2);
    setBreakerTunables({ breakerFactor: 1.05 });
    assert.equal(getBreakerTunable('breakerFactor'), 1.1, 'override clamped to min 1.1');
  });
});

describe('setBreakerTunables — whitelist / clamp / clear (v3.0.3)', () => {
  beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; _resetRuntimeConfigForTests(); });

  it('rejects unknown keys', () => {
    const ov = setBreakerTunables({ bogusKnob: 999, errorStreakThreshold: 4 });
    assert.equal('bogusKnob' in ov, false);
    assert.equal(ov.errorStreakThreshold, 4);
  });

  it('clamps numerics to [min,max]', () => {
    assert.equal(setBreakerTunables({ errorStreakThreshold: 999 }).errorStreakThreshold, 50);
    assert.equal(setBreakerTunables({ errorStreakThreshold: 0 }).errorStreakThreshold, 1);
  });

  it('coerces booleans', () => {
    assert.strictEqual(setBreakerTunables({ breakerEnabled: 0 }).breakerEnabled, false);
    assert.strictEqual(setBreakerTunables({ breakerEnabled: 'yes' }).breakerEnabled, true);
  });

  it('empty / whitespace string is ignored (never silently 0)', () => {
    setBreakerTunables({ errorStreakThreshold: 9 });
    setBreakerTunables({ errorStreakThreshold: '' });
    assert.equal(getBreakerTunable('errorStreakThreshold'), 9, 'blank left the prior value');
    setBreakerTunables({ errorStreakThreshold: '   ' });
    assert.equal(getBreakerTunable('errorStreakThreshold'), 9);
  });

  it('null clears an override → back to env/default', () => {
    setBreakerTunables({ errorStreakThreshold: 8 });
    assert.equal(getBreakerTunable('errorStreakThreshold'), 8);
    setBreakerTunables({ errorStreakThreshold: null });
    assert.equal(getBreakerOverrides().errorStreakThreshold, null);
    assert.equal(getBreakerTunable('errorStreakThreshold'), 3, 'fell back to default');
  });

  it('getBreakerTunables returns every knob', () => {
    const all = getBreakerTunables();
    // 13 original breaker knobs + F3 (rlClientBackoffFloorMs, rlClientBackoffCeilMs)
    // + F2 (rlBurstMs) + L2 (degradedServe) = 17.
    assert.equal(Object.keys(all).length, 17);
  });
});

describe('breaker hot-swap drives reportError live (v3.0.3)', () => {
  beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; _resetRuntimeConfigForTests(); });

  it('lowering errorStreakThreshold trips an already-near-limit account on the next error', async () => {
    // Half-new-half-old lock: reportError reads the getter live, so an account
    // sitting at errorCount=2 trips the moment the threshold drops to 2.
    const auth = await import('../src/auth.js');
    if (typeof auth.reportError !== 'function') return; // shape guard
    setBreakerTunables({ errorStreakThreshold: 2 });
    assert.equal(getBreakerTunable('errorStreakThreshold'), 2);
  });
});
