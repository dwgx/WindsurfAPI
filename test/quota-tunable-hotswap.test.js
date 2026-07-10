// v3.0.3 — quota / on-demand spend tunables env→runtime-config migration.
// Mirrors breaker-tunable-hotswap: confirms the three-tier resolution
// (override → env → historical default), the setter whitelist/clamp/null-clear
// semantics, and that an env-only deploy is byte-identical to the pre-migration
// WINDSURFAPI_QUOTA_* constants in auth.js. In-memory only (temp DATA_DIR).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetRuntimeConfigForTests,
  getQuotaTunable, getQuotaTunables, getQuotaOverrides, setQuotaTunables,
} from '../src/runtime-config.js';

const ENV_KEYS = [
  'WINDSURFAPI_QUOTA_COOLDOWN', 'WINDSURFAPI_QUOTA_COOLDOWN_MS',
  'WINDSURFAPI_QUOTA_DRY_THRESHOLD', 'WINDSURFAPI_SPEND_ON_DEMAND',
  'WINDSURFAPI_ON_DEMAND_RESERVE_USD',
];
let saved;

describe('quota tunables — three-tier resolution (v3.0.3)', () => {
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

  it('empty config falls back to the historical auth.js defaults', () => {
    assert.equal(getQuotaTunable('cooldownEnabled'), true);
    assert.equal(getQuotaTunable('cooldownMs'), 30 * 60 * 1000);
    assert.equal(getQuotaTunable('dryThreshold'), 0);
    assert.equal(getQuotaTunable('spendOnDemand'), true);   // default: burn balance (52e255f)
    assert.equal(getQuotaTunable('onDemandReserveUsd'), 0); // default: no reserve floor
  });

  it('env overrides the default (env-only deploy path is byte-identical)', () => {
    const env = {
      WINDSURFAPI_QUOTA_COOLDOWN: '0',
      WINDSURFAPI_QUOTA_COOLDOWN_MS: '600000',
      WINDSURFAPI_QUOTA_DRY_THRESHOLD: '5',
      WINDSURFAPI_SPEND_ON_DEMAND: '0',
      WINDSURFAPI_ON_DEMAND_RESERVE_USD: '25',
    };
    assert.equal(getQuotaTunable('cooldownEnabled', env), false);
    assert.equal(getQuotaTunable('cooldownMs', env), 600000);
    assert.equal(getQuotaTunable('dryThreshold', env), 5);
    assert.equal(getQuotaTunable('spendOnDemand', env), false);
    assert.equal(getQuotaTunable('onDemandReserveUsd', env), 25);
    // default process.env path (nothing set) still gives the default
    assert.equal(getQuotaTunable('spendOnDemand'), true);
  });

  it('runtime-config override beats env', () => {
    setQuotaTunables({ spendOnDemand: false, onDemandReserveUsd: 30 });
    const env = { WINDSURFAPI_SPEND_ON_DEMAND: '1', WINDSURFAPI_ON_DEMAND_RESERVE_USD: '0' };
    assert.equal(getQuotaTunable('spendOnDemand', env), false);
    assert.equal(getQuotaTunable('onDemandReserveUsd', env), 30);
  });

  it('bool env semantics: only literal "0" turns off; other values stay on', () => {
    assert.equal(getQuotaTunable('spendOnDemand', { WINDSURFAPI_SPEND_ON_DEMAND: '0' }), false);
    assert.equal(getQuotaTunable('spendOnDemand', { WINDSURFAPI_SPEND_ON_DEMAND: '1' }), true);
    assert.equal(getQuotaTunable('spendOnDemand', { WINDSURFAPI_SPEND_ON_DEMAND: 'true' }), true);
  });
});

describe('setQuotaTunables — whitelist / clamp / clear (v3.0.3)', () => {
  beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; _resetRuntimeConfigForTests(); });

  it('rejects unknown keys', () => {
    const ov = setQuotaTunables({ bogusKnob: 999, spendOnDemand: false });
    assert.equal('bogusKnob' in ov, false);
    assert.equal(ov.spendOnDemand, false);
  });

  it('clamps numerics to [min,max]', () => {
    assert.equal(setQuotaTunables({ onDemandReserveUsd: 999999 }).onDemandReserveUsd, 100000);
    assert.equal(setQuotaTunables({ onDemandReserveUsd: -5 }).onDemandReserveUsd, 0);
    assert.equal(setQuotaTunables({ dryThreshold: 500 }).dryThreshold, 100);
    assert.equal(setQuotaTunables({ cooldownMs: 100 }).cooldownMs, 1000);
  });

  it('coerces booleans', () => {
    assert.strictEqual(setQuotaTunables({ spendOnDemand: 0 }).spendOnDemand, false);
    assert.strictEqual(setQuotaTunables({ cooldownEnabled: 'yes' }).cooldownEnabled, true);
  });

  it('empty / whitespace string is ignored (never silently 0)', () => {
    setQuotaTunables({ onDemandReserveUsd: 40 });
    setQuotaTunables({ onDemandReserveUsd: '' });
    assert.equal(getQuotaTunable('onDemandReserveUsd'), 40, 'blank left the prior value');
    setQuotaTunables({ onDemandReserveUsd: '   ' });
    assert.equal(getQuotaTunable('onDemandReserveUsd'), 40);
  });

  it('null clears an override → back to env/default', () => {
    setQuotaTunables({ spendOnDemand: false });
    assert.equal(getQuotaTunable('spendOnDemand'), false);
    setQuotaTunables({ spendOnDemand: null });
    assert.equal(getQuotaOverrides().spendOnDemand, null);
    assert.equal(getQuotaTunable('spendOnDemand'), true, 'fell back to default');
  });

  it('getQuotaTunables returns every knob', () => {
    const all = getQuotaTunables();
    assert.equal(Object.keys(all).length, 5);
  });
});
