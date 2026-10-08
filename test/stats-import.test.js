import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';

process.env.STATS_MAX_MODELS = '3';
process.env.POLICY_BLOCK_RING = '20';
const { exportStats, getStats, importStats, recordRequest, recordTokenUsage, resetStats } =
  await import('../src/dashboard/stats.js');
const snapshot = () => {
  const out = structuredClone(exportStats());
  delete out._exportedAt;
  return out;
};

before(() => mock.timers.enable({ apis: ['setTimeout'] }));
beforeEach(() => resetStats());
after(() => mock.timers.reset());

describe('statistics snapshot import', () => {
  it('merges model, account, hourly and token statistics with existing data', () => {
    recordRequest('model-a', false, 100, 'acct-aaa');
    recordTokenUsage({ prompt_tokens: 10, completion_tokens: 5 });
    const saved = snapshot();
    resetStats();
    recordRequest('model-a', true, 200, 'acct-aaa');
    recordRequest('model-b', true, 300, 'acct-bbb');
    recordTokenUsage({ prompt_tokens: 20, completion_tokens: 10 });

    assert.deepEqual(importStats(saved), { ok: true, mode: 'merge' });
    const stats = snapshot();
    assert.equal(stats.totalRequests, 3);
    assert.equal(stats.successCount, 2);
    assert.equal(stats.errorCount, 1);
    assert.equal(stats.modelCounts['model-a'].requests, 2);
    assert.equal(stats.modelCounts['model-a'].totalMs, 300);
    assert.deepEqual(stats.modelCounts['model-a'].recentMs, [200, 100]);
    assert.deepEqual(stats.accountCounts['acct-aaa'], { requests: 2, success: 1, errors: 1 });
    assert.deepEqual(stats.accountCounts['acct-bbb'], { requests: 1, success: 1, errors: 0 });
    assert.equal(stats.hourlyBuckets.length, 1);
    assert.equal(stats.hourlyBuckets[0].requests, 3);
    assert.equal(stats.hourlyBuckets[0].errors, 1);
    assert.equal(stats.tokenTotals.fresh_input, 30);
    assert.equal(stats.tokenTotals.output, 15);
    assert.equal(stats.tokenTotals.total, 45);
    assert.equal(stats.tokenTotals.requests_with_usage, 2);
    recordRequest('model-a', true, 50, 'account-a');
    assert.equal(getStats().hourlyBuckets[0].requests, 4);
  });

  it('restores an exported snapshot and can continue recording after replacement', () => {
    recordRequest('model-a', true, 100, 'account-a');
    recordTokenUsage({ prompt_tokens: 10, completion_tokens: 5 });
    const saved = snapshot();
    resetStats();
    assert.deepEqual(importStats(saved, { mode: 'replace' }), { ok: true, mode: 'replace' });
    for (const key of ['totalRequests', 'modelCounts', 'accountCounts', 'hourlyBuckets', 'tokenTotals']) {
      assert.deepEqual(snapshot()[key], saved[key], key);
    }
    recordRequest('model-a', false, 200, 'account-a');
    recordTokenUsage({ prompt_tokens: 2, completion_tokens: 3 });
    assert.equal(getStats().totalRequests, 2);
    assert.equal(getStats().hourlyBuckets[0].requests, 2);
    assert.equal(getStats().tokenTotals.total, 20);
  });

  it('fills missing fields in a legacy snapshot before replacing current state', () => {
    assert.equal(importStats({ totalRequests: 7, successCount: 7,
      modelCounts: { old: { requests: 7, success: 7 } } }, { mode: 'replace' }).ok, true);
    assert.doesNotThrow(() => recordRequest('old', false, 20, 'new-account'));
    assert.doesNotThrow(() => recordTokenUsage({ prompt_tokens: 1, completion_tokens: 2 }));
    assert.equal(getStats().totalRequests, 8);
    assert.equal(getStats().modelCounts.old.errors, 1);
    assert.equal(getStats().tokenTotals.total, 3);
  });

  it('rejects invalid snapshots without mutating current state in either mode', () => {
    recordRequest('keep', true, 20, 'keep-account');
    const before = snapshot();
    const invalid = [null, [], {}, { unrelated: true },
      { _schema: 'windsurfapi-stats-v99', totalRequests: 1 },
      { totalRequests: '2' }, { creditsTotal: -1 }, { modelCounts: [] },
      { modelCounts: { x: { requests: '2' } } }, { tokenTotals: { output: -1 } },
      { hourlyBuckets: [{ hour: 'invalid', requests: 1 }] },
      { recentRequests: [null] }, { recentPolicyBlocks: [{ ts: 'invalid' }] }];
    for (const mode of ['merge', 'replace']) {
      for (const value of invalid) {
        assert.equal(importStats(value, { mode }).ok, false, JSON.stringify({ mode, value }));
        assert.deepEqual(snapshot(), before);
      }
    }
  });

  it('returns a validation error for an unserializable snapshot', () => {
    const before = snapshot();
    const cycle = { totalRequests: 1 };
    cycle.self = cycle;
    assert.equal(importStats(cycle, { mode: 'replace' }).ok, false);
    assert.deepEqual(snapshot(), before);
  });

  it('adds credits and deduplicates recent histories while keeping existing entries', () => {
    const recentRequests = [{ ts: 1, model: 'm', success: true }, { ts: 2, model: 'm', success: true }];
    const recentPolicyBlocks = [{ ts: 1, promptHash: 'h1' }];
    const saved = { creditsTotal: 1.5, creditsByModel: { m: 1.5 },
      creditsByHour: { '2026-01-01T00:00:00.000Z': 1.5 }, creditsByDay: { '2026-01-01': 1.5 },
      recentRequests, recentPolicyBlocks };
    assert.equal(importStats(saved, { mode: 'replace' }).ok, true);
    assert.equal(importStats({ ...saved,
      recentRequests: [{ ...recentRequests[0], success: false }, { ts: 3, model: 'm', success: false }],
      recentPolicyBlocks: [...recentPolicyBlocks, { ts: 2, promptHash: 'h2' }],
    }).ok, true);
    const stats = snapshot();
    assert.equal(stats.creditsTotal, 3);
    assert.equal(stats.creditsByModel.m, 3);
    assert.equal(stats.creditsByHour['2026-01-01T00:00:00.000Z'], 3);
    assert.equal(stats.creditsByDay['2026-01-01'], 3);
    assert.deepEqual(stats.recentRequests.map(r => r.ts), [1, 2, 3]);
    assert.equal(stats.recentRequests[0].success, true);
    assert.equal(stats.recentPolicyBlocks.length, 2);
  });

  it('rejects overflow during a merge before publishing any changes', () => {
    assert.equal(importStats({ creditsTotal: Number.MAX_VALUE }, { mode: 'replace' }).ok, true);
    const before = snapshot();
    assert.equal(importStats({ creditsTotal: Number.MAX_VALUE }).ok, false);
    assert.deepEqual(snapshot(), before);
  });

  it('treats inherited property names as new dictionary keys without changing prototypes', () => {
    const original = Object.getOwnPropertyDescriptors(Object.prototype.toString);
    assert.equal(importStats({ creditsByModel: { toString: 1 },
      modelCounts: { toString: { requests: 1 } }, accountCounts: { toString: { requests: 1 } } }).ok, true);
    const stats = snapshot();
    assert.equal(stats.creditsByModel.toString, 1);
    assert.equal(stats.modelCounts.toString.requests, 1);
    assert.equal(stats.accountCounts.toString.requests, 1);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype.toString), original);
  });

  it('rejects overflow while folding excess models without publishing the snapshot', () => {
    const before = snapshot();
    const modelCounts = Object.fromEntries(Array.from({ length: 5 }, (_, i) =>
      [`m${i}`, { requests: Number.MAX_VALUE, lastTs: i }]));
    for (const mode of ['merge', 'replace']) {
      assert.equal(importStats({ modelCounts }, { mode }).ok, false);
      assert.deepEqual(snapshot(), before);
    }
  });

  it('persists a complete imported state through the existing save timer', () => {
    recordRequest('model-a', true, 10, 'acct-aaa');
    recordTokenUsage({ prompt_tokens: 10, completion_tokens: 5 });
    const saved = snapshot();
    resetStats();
    assert.equal(importStats(saved).ok, true);
    mock.timers.tick(5000);
    const persisted = JSON.parse(readFileSync(join(config.dataDir, 'stats.json'), 'utf8'));
    for (const key of ['totalRequests', 'modelCounts', 'accountCounts', 'hourlyBuckets', 'tokenTotals']) {
      assert.deepEqual(persisted[key], saved[key], key);
    }
  });

  it('returns HTTP 400 for invalid imports and HTTP 200 for a valid replacement', async () => {
    const { handleDashboardApi } = await import('../src/dashboard/api.js');
    const oldPassword = config.dashboardPassword;
    config.dashboardPassword = 'stats-import-test-password';
    const request = { headers: { 'x-dashboard-password': config.dashboardPassword },
      socket: { remoteAddress: '127.0.0.1' }, url: '/dashboard/api/stats/import' };
    const call = async body => {
      const captured = {};
      const response = {
        writeHead(status) { captured.status = status; },
        end(payload) { captured.body = JSON.parse(payload); },
      };
      await handleDashboardApi('POST', '/stats/import', body, request, response);
      return captured;
    };
    try {
      const before = snapshot();
      const rejected = await call({ snapshot: {}, mode: 'replace' });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.ok, false);
      assert.deepEqual(snapshot(), before);
      const accepted = await call({ snapshot: { totalRequests: 7 }, mode: 'replace' });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.ok, true);
      assert.equal(getStats().totalRequests, 7);
      assert.doesNotThrow(() => recordRequest('m', true, 10, 'acct-aaa'));
    } finally {
      config.dashboardPassword = oldPassword;
    }
  });

  it('caps imported models without losing totals and preserves LRU ordering', () => {
    for (const mode of ['merge', 'replace']) {
      resetStats();
      const modelCounts = Object.fromEntries(Array.from({ length: 8 }, (_, i) =>
        [`m${i}`, { requests: 1, success: 1, errors: 0, totalMs: 10, recentMs: [10], lastTs: 1000 + i }]));
      assert.equal(importStats({ totalRequests: 8, successCount: 8, modelCounts }, { mode }).ok, true);
      const stats = getStats();
      assert.equal(Object.keys(stats.modelCounts).filter(k => k !== '(other)').length, 3);
      assert.equal(stats.modelCounts['(other)'].requests, 5);
      assert.equal(Object.values(stats.modelCounts).reduce((sum, m) => sum + m.requests, 0), 8);
      recordRequest('m5', true, 10, null);
      recordRequest('new', true, 10, null);
      assert.ok(getStats().modelCounts.m5, 'a newly touched imported model must survive eviction');
      assert.equal(getStats().modelCounts.m6, undefined, 'the oldest untouched model is evicted');
    }
  });

  it('bounds imported latency samples, history rings and credit maps in both modes', () => {
    const hourlyBuckets = Array.from({ length: 725 }, (_, i) => ({
      hour: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), requests: 1, errors: 0,
    }));
    const recentRequests = Array.from({ length: 505 }, (_, i) => ({ ts: i, model: 'm', success: true }));
    const recentPolicyBlocks = Array.from({ length: 25 }, (_, i) => ({ ts: i, promptHash: `h${i}` }));
    const creditsByHour = Object.fromEntries(hourlyBuckets.map(b => [b.hour, 1]));
    const creditsByDay = Object.fromEntries(Array.from({ length: 95 }, (_, i) =>
      [new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), 1]));
    for (const mode of ['merge', 'replace']) {
      resetStats();
      const result = importStats({ modelCounts: { m: { recentMs: Array(250).fill(1) } },
        hourlyBuckets, recentRequests, recentPolicyBlocks, creditsByHour, creditsByDay }, { mode });
      assert.equal(result.ok, true);
      const stats = snapshot();
      assert.equal(stats.modelCounts.m.recentMs.length, 200);
      assert.equal(stats.hourlyBuckets.length, 720);
      assert.equal(stats.hourlyBuckets[0].hour, hourlyBuckets[5].hour);
      assert.equal(stats.recentRequests.length, 500);
      assert.equal(stats.recentRequests[0].ts, 5);
      assert.equal(stats.recentPolicyBlocks.length, 20);
      assert.equal(Object.keys(stats.creditsByHour).length, 720);
      assert.equal(Object.keys(stats.creditsByDay).length, 90);
    }
  });
});
