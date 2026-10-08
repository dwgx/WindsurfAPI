import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { exportStats, importStats, resetStats } from '../src/dashboard/stats.js';

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());
function fresh() {
  resetStats();
  assert.equal(importStats({ totalRequests: 2, creditsByModel: { normal: 1 } }, { mode: 'replace' }).ok, true);
  return { importStats, state() {
    const snapshot = structuredClone(exportStats());
    delete snapshot._exportedAt;
    return snapshot;
  } };
}

test('SEC-4: JSON own __proto__ cannot change the state prototype on replace', () => {
  const api = fresh();
  const proto = Object.getPrototypeOf(api.state());
  const payload = JSON.parse('{"__proto__":{"totalRequests":1},"totalRequests":7,"recentRequests":[]}');
  assert.equal(Object.hasOwn(payload, '__proto__'), true, 'object-literal syntax is not the HTTP JSON attack');
  assert.deepEqual(api.importStats(payload, { mode: 'replace' }), { ok: true, mode: 'replace' });
  assert.equal(Object.getPrototypeOf(api.state()), proto);
  assert.equal(api.state().totalRequests, 7);
  assert.equal(Object.hasOwn(api.state(), '__proto__'), false);
  assert.equal(Object.prototype.totalRequests, undefined);
});

test('SEC-4: constructor/prototype keys are removed recursively in replace and merge', () => {
  for (const mode of ['replace', 'merge']) {
    const api = fresh();
    const input = JSON.parse('{"constructor":{"prototype":{"polluted":true}},"creditsByModel":{"normal":3,"__proto__":{"polluted":true},"constructor":2,"prototype":2},"recentRequests":[]}');
    assert.equal(api.importStats(input, { mode }).ok, true);
    assert.equal(Object.hasOwn(api.state(), 'constructor'), false);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(Object.hasOwn(api.state().creditsByModel, key), false, `${mode}: ${key}`);
    }
    assert.equal(Object.getPrototypeOf(api.state().creditsByModel), Object.prototype);
    assert.equal(api.state().creditsByModel.normal, mode === 'merge' ? 4 : 3);
  }
});

test('SEC-4: object-literal __proto__ is not confused with an own JSON key', () => {
  const api = fresh();
  const input = { __proto__: { totalRequests: 1 }, recentRequests: [] };
  assert.equal(Object.hasOwn(input, '__proto__'), false);
  api.importStats(input, { mode: 'replace' });
  assert.equal(Object.getPrototypeOf(api.state()), Object.prototype);
  assert.equal(api.state().totalRequests, 0);
});

test('SEC-4: clone failure leaves the existing state untouched', () => {
  const api = fresh();
  const before = JSON.stringify(api.state());
  const cycle = {}; cycle.self = cycle;
  assert.deepEqual(api.importStats(cycle, { mode: 'replace' }), { ok: false, error: 'invalid snapshot' });
  assert.equal(JSON.stringify(api.state()), before);
});
