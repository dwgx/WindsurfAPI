// Request log for the stats panel: per-request rows that join the attempt
// (model/account/status/latency/credit) with its usage block (tokens in/out).
//
// The join is the risky part: recordRequest and recordTokenUsage are called at
// different depths and in either order, and the server is concurrent. These
// tests pin the async-scope join, the query filters/pagination, and the
// aggregate arithmetic (table and aggregates must share one denominator).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  exportStats,
  finalizeStatsScope,
  getRequestLog,
  getStats,
  importStats,
  recordRequest,
  recordTokenUsage,
  resetStats,
  withStatsScope,
} from '../src/dashboard/stats.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { decodeFrame, normalizeConnectUsage } from '../src/devin-connect.js';
import { buildUsageBody } from '../src/handlers/chat.js';
import { accountRef } from '../src/log-safety.js';
import { writeMessageField, writeVarintField } from '../src/proto.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { parseGeneratorMetadata } from '../src/windsurf.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function req(path, headers = {}) {
  return { url: `/dashboard/api${path}`, headers, socket: { remoteAddress: '127.0.0.1' } };
}

function authed(path, extra = {}) {
  return req(path, { 'x-dashboard-password': 'dash-secret', ...extra });
}

function seed(rows) {
  const result = importStats({ recentRequests: rows }, { mode: 'replace' });
  assert.equal(result.ok, true, 'seed snapshot must import');
}

function row(i, overrides = {}) {
  return {
    ts: 1_700_000_000_000 + i * 1000,
    model: 'm',
    success: true,
    ms: 100 + i,
    account: 'acct0001',
    credit: 0,
    ...overrides,
  };
}

beforeEach(() => {
  resetStats();
  _resetRuntimeConfigForTests();
});

afterEach(() => {
  resetStats();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  _resetRuntimeConfigForTests();
});

describe('request log scope join', () => {
  it('attaches usage recorded after the attempt row', () => {
    withStatsScope(() => {
      recordRequest('m-after', true, 25, 'acct-after');
      recordTokenUsage({ prompt_tokens: 10, completion_tokens: 4 }, 'm-after');
    });
    const page = getRequestLog({ model: 'm-after' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].tokensIn, 10);
    assert.equal(page.items[0].tokensOut, 4);
  });

  it('holds usage that arrives before the attempt row', () => {
    withStatsScope(() => {
      recordTokenUsage({ prompt_tokens: 7, completion_tokens: 3 }, 'm-before');
      recordRequest('m-before', true, 30, 'acct-before');
    });
    const page = getRequestLog({ model: 'm-before' });
    assert.equal(page.items[0].tokensIn, 7);
    assert.equal(page.items[0].tokensOut, 3);
  });

  it('never crosses concurrent scopes, even for the same model', async () => {
    await Promise.all([
      withStatsScope(async () => {
        recordRequest('same-model', true, 10, 'acct-a');
        await new Promise(resolve => setTimeout(resolve, 15));
        recordTokenUsage({ prompt_tokens: 11, completion_tokens: 1 }, 'same-model');
      }),
      withStatsScope(async () => {
        recordRequest('same-model', true, 20, 'acct-b');
        recordTokenUsage({ prompt_tokens: 22, completion_tokens: 2 }, 'same-model');
      }),
    ]);
    const page = getRequestLog({ model: 'same-model' });
    const byAccount = Object.fromEntries(page.items.map(r => [r.account, r]));
    assert.equal(byAccount[accountRef('acct-a')].tokensIn, 11);
    assert.equal(byAccount[accountRef('acct-a')].tokensOut, 1);
    assert.equal(byAccount[accountRef('acct-b')].tokensIn, 22);
    assert.equal(byAccount[accountRef('acct-b')].tokensOut, 2);
  });

  it('counts cache read/write as billable input and keeps the breakdown', () => {
    withStatsScope(() => {
      recordRequest('cache-model', true, 40, null);
      recordTokenUsage({
        prompt_tokens: 100,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 40 },
        cache_creation_input_tokens: 5,
      }, 'cache-model');
    });
    const item = getRequestLog({ model: 'cache-model' }).items[0];
    assert.equal(item.cacheRead, 40);
    assert.equal(item.cacheWrite, 5);
    assert.equal(item.tokensIn, 105, 'fresh 60 + cache read 40 + cache write 5');
    assert.equal(item.tokensOut, 9);
  });

  it('stamps the final HTTP status on the last attempt only', () => {
    const scope = { rows: [], pendingUsage: null, status: 451 };
    withStatsScope((s) => {
      Object.assign(scope, s, { status: 451 });
      recordRequest('attempt-model', false, 5, null);
      recordRequest('attempt-model', true, 6, null);
    });
    finalizeStatsScope(scope);
    // withStatsScope reused the object passed in only for assertions; the rows
    // live on that same scope object.
    const page = getRequestLog({ model: 'attempt-model' });
    assert.deepEqual(page.items.map(r => r.status), [451, 500]);
  });

  it('keeps the success-derived status without a scope', () => {
    recordRequest('no-scope-ok', true, 1, null);
    recordRequest('no-scope-err', false, 1, null);
    const page = getRequestLog();
    const byModel = Object.fromEntries(page.items.map(r => [r.model, r.status]));
    assert.equal(byModel['no-scope-ok'], 200);
    assert.equal(byModel['no-scope-err'], 500);
  });
});

describe('reported request usage', () => {
  it('recognizes only finite, non-negative numbers and keeps the split optional', () => {
    const cases = [
      ['absent', undefined, null],
      ['null', null, null],
      ['empty', {}, null],
      ['invalid', { prompt_tokens: '8', completion_tokens: -1, total_tokens: Infinity }, null],
      ['non-finite', { input_tokens: NaN, output_tokens: null }, null],
      ['zero', { prompt_tokens: 0, completion_tokens: 0 }, { tokensIn: 0, tokensOut: 0 }],
      ['input', { input_tokens: 5 }, { tokensIn: 5 }],
      ['output', { output_tokens: 0 }, { tokensOut: 0 }],
      ['total', { total_tokens: 9 }, { totalTokens: 9 }],
      ['total-zero', { total_tokens: 0 }, { totalTokens: 0 }],
    ];
    for (const [model, usage, expected] of cases) {
      recordRequest(model, true, 1, null, { usage });
      assert.deepEqual(getRequestLog({ model }).items[0].reportedUsage, expected, model);
    }
    assert.equal(getRequestLog({ model: 'input' }).summary.tokensIn, 0, 'the input alias is display evidence only');
  });

  it('joins zero and partial reports on either side of concurrent attempt rows', async () => {
    await Promise.all([
      withStatsScope(async () => {
        recordTokenUsage({ prompt_tokens: 0, completion_tokens: 0 }, 'same-model');
        await Promise.resolve();
        recordRequest('same-model', true, 10, 'acct-zero', { usage: {} });
      }),
      withStatsScope(async () => {
        recordRequest('same-model', true, 20, 'acct-partial');
        await Promise.resolve();
        recordTokenUsage({ completion_tokens: 7 }, 'same-model');
        recordTokenUsage({}, 'same-model');
      }),
    ]);
    const { items, summary } = getRequestLog({ model: 'same-model' });
    const byAccount = Object.fromEntries(items.map(r => [r.account, r.reportedUsage]));
    assert.deepEqual(byAccount[accountRef('acct-zero')], { tokensIn: 0, tokensOut: 0 });
    assert.deepEqual(byAccount[accountRef('acct-partial')], { tokensOut: 7 });
    assert.equal(summary.requests, 2);
    assert.equal(summary.tokensOut, 7);
    assert.equal(getStats().tokenTotals.requests_with_usage, 1, 'zero is data, not extra spend');
    assert.equal(getStats().tokenTotals.total, 7);
  });

  it('restores the marker through snapshot import, the real save callback and module reload', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    recordRequest('reported-zero', true, 1, null, { usage: { prompt_tokens: 0, completion_tokens: 0 } });
    recordRequest('total-only', true, 1, null, { usage: { total_tokens: 13 } });
    const snapshot = exportStats();
    snapshot.recentRequests = [...snapshot.recentRequests,
      row(0, { model: 'legacy-zero', tokensIn: 0, tokensOut: 0 }),
      row(1, { model: 'legacy-positive', tokensIn: 0, tokensOut: 3 }),
    ];
    resetStats();
    assert.equal(importStats(snapshot, { mode: 'merge' }).ok, true);
    t.mock.timers.tick(5000);
    const restored = await import('../src/dashboard/stats.js?usage-readback');
    const items = restored.getRequestLog().items;
    const reports = Object.fromEntries(items.map(r => [r.model, r.reportedUsage]));
    assert.deepEqual(reports, {
      'reported-zero': { tokensIn: 0, tokensOut: 0 },
      'total-only': { totalTokens: 13 },
      'legacy-zero': null,
      'legacy-positive': { tokensOut: 3 },
    });
  });

  it('keeps same-millisecond rows distinct in merge and replace imports', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    withStatsScope(() => recordRequest('tied', true, 1, null, { usage: { completion_tokens: 0 } }));
    withStatsScope(() => recordRequest('tied', true, 1, null, { usage: { completion_tokens: 9 } }));
    const snapshot = exportStats();
    for (const mode of ['merge', 'replace']) {
      assert.equal(importStats(snapshot, { mode }).ok, true, mode);
      assert.deepEqual(getRequestLog().items.map(row => row.reportedUsage), [
        { tokensOut: 9 }, { tokensOut: 0 },
      ], mode);
    }
  });

  it('keeps an in-flight attempt joined to its later usage across a merge import', () => {
    withStatsScope((scope) => {
      recordRequest('in-flight', false, 1, null);
      assert.equal(importStats({ creditsTotal: 0 }).ok, true);
      recordTokenUsage({ completion_tokens: 0 }, 'in-flight');
      scope.status = 429;
      finalizeStatsScope(scope);
    });
    const item = getRequestLog().items[0];
    assert.equal(item.status, 429);
    assert.equal(item.success, false);
    assert.deepEqual(item.reportedUsage, { tokensOut: 0 });
  });

  it('does not count normalized defaults or Cascade estimates as reports', () => {
    const connectFrame = writeMessageField(7, writeVarintField(3, 0));
    const connect = normalizeConnectUsage(decodeFrame(connectFrame).usage);
    assert.equal(connect.prompt_tokens, 0, 'wire shape still supplies its default');
    recordRequest('connect-output', true, 1, null, { usage: connect });

    const metadata = writeMessageField(1, writeMessageField(1,
      writeMessageField(4, writeVarintField(2, 0))));
    const cascade = buildUsageBody(parseGeneratorMetadata(metadata), [], 'example');
    const estimate = buildUsageBody(null, [], 'example');
    assert.equal(cascade.completion_tokens, estimate.completion_tokens, 'wire estimates are unchanged');
    withStatsScope(() => {
      recordRequest('cascade-partial', true, 1, null);
      recordTokenUsage(cascade, 'cascade-partial');
    });
    withStatsScope(() => {
      recordRequest('cascade-missing', true, 1, null);
      recordTokenUsage(estimate, 'cascade-missing');
    });

    const items = Object.fromEntries(getRequestLog().items.map(r => [r.model, r]));
    assert.deepEqual(items['connect-output'].reportedUsage, { tokensOut: 0 });
    assert.deepEqual(items['cascade-partial'].reportedUsage, { tokensIn: 0 });
    assert.equal(items['cascade-missing'].reportedUsage, null);
    assert.equal(getStats().tokenTotals.output, estimate.completion_tokens * 2);
  });
});

describe('GET /stats/log query', () => {
  beforeEach(() => {
    seed([
      row(0, { model: 'alpha', account: 'acct0001', status: 200, tokensIn: 10, tokensOut: 2, credit: 1 }),
      row(1, { model: 'beta', account: 'acct0002', status: 500, success: false, tokensIn: 0, tokensOut: 0, credit: 0 }),
      row(2, { model: 'alpha', account: 'acct0002', status: 200, tokensIn: 30, tokensOut: 6, credit: 3 }),
      row(3, { model: 'gamma', account: 'acct0001', status: 429, success: false, tokensIn: 0, tokensOut: 0, credit: 0 }),
    ]);
  });

  it('returns newest first with total and retention, not a page-sized total', () => {
    const page = getRequestLog({ limit: 2 });
    assert.deepEqual(page.items.map(r => r.model), ['gamma', 'alpha']);
    assert.equal(page.total, 4);
    assert.equal(page.hasMore, true);
    assert.equal(page.retention.stored, 4);
    assert.equal(page.retention.capacity, 500);
  });

  it('pages by offset and stops claiming more at the end', () => {
    const page = getRequestLog({ limit: 3, offset: 3 });
    assert.deepEqual(page.items.map(r => r.model), ['alpha']);
    assert.equal(page.hasMore, false);
  });

  it('filters by model, account, status and time window', () => {
    assert.deepEqual(getRequestLog({ model: 'alpha' }).items.map(r => r.model), ['alpha', 'alpha']);
    assert.deepEqual(getRequestLog({ account: accountRef('acct0002') }).items.map(r => r.account),
      [accountRef('acct0002'), accountRef('acct0002')]);
    assert.deepEqual(getRequestLog({ status: 200 }).items.map(r => r.status), [200, 200]);
    const from = 1_700_000_000_000 + 2 * 1000;
    const to = 1_700_000_000_000 + 3 * 1000;
    assert.deepEqual(getRequestLog({ from, to }).items.map(r => r.model), ['gamma', 'alpha']);
  });

  it('derives status for legacy rows that predate the status field', () => {
    seed([{ ts: 1_700_000_000_000, model: 'legacy-ok', success: true, ms: 1, account: null, credit: 0 },
      { ts: 1_700_000_001_000, model: 'legacy-err', success: false, ms: 1, account: null, credit: 0 }]);
    const page = getRequestLog();
    assert.deepEqual(page.items.map(r => [r.model, r.status]), [['legacy-err', 500], ['legacy-ok', 200]]);
    assert.equal(page.filters.statuses.includes(500), true);
  });

  it('aggregates over the whole filtered window, not the page', () => {
    const page = getRequestLog({ limit: 1 });
    assert.equal(page.summary.requests, 4);
    assert.equal(page.summary.success, 2);
    assert.equal(page.summary.errors, 2);
    assert.equal(page.summary.tokensIn, 40);
    assert.equal(page.summary.tokensOut, 8);
    assert.equal(page.summary.credits, 4);
    assert.equal(page.summary.avgMs, Math.round((100 + 101 + 102 + 103) / 4));

    const alpha = page.byModel.find(m => m.model === 'alpha');
    assert.equal(alpha.requests, 2);
    assert.equal(alpha.tokensIn, 40);
    assert.equal(alpha.tokensOut, 8);
    assert.equal(alpha.credits, 4);
    assert.equal(alpha.errors, 0);

    const acct2 = page.byAccount.find(a => a.account === accountRef('acct0002'));
    assert.equal(acct2.requests, 2);
    assert.equal(acct2.errors, 1);

    assert.equal(page.byDay.length, 1);
    assert.equal(page.byDay[0].requests, 4);
    assert.equal(page.byDay[0].errors, 2);
  });

  it('keeps filter options stable while a filter is active', () => {
    const page = getRequestLog({ model: 'alpha' });
    assert.deepEqual(page.filters.models, ['alpha', 'beta', 'gamma']);
    assert.deepEqual(page.filters.accounts, [accountRef('acct0001'), accountRef('acct0002')].sort());
    assert.deepEqual(page.filters.statuses, [200, 429, 500]);
  });
});

describe('GET /dashboard/api/stats/log', () => {
  beforeEach(() => {
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    seed([
      row(0, { model: 'alpha', account: 'acct0001', status: 200, tokensIn: 5, tokensOut: 1, credit: 2 }),
      row(1, { model: 'beta', account: 'acct0002', status: 502, success: false }),
    ]);
  });

  it('fails closed without dashboard auth', async () => {
    const res = fakeRes();
    await handleDashboardApi('GET', '/stats/log', {}, req('/stats/log'), res);
    assert.equal(res.statusCode, 401);
  });

  it('parses filters and pagination from the query string', async () => {
    const res = fakeRes();
    await handleDashboardApi('GET', '/stats/log', {}, authed('/stats/log?model=alpha&status=200&limit=10&offset=0'), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].model, 'alpha');
    assert.equal(body.items[0].tokensIn, 5);
    assert.deepEqual(body.items[0].reportedUsage, { tokensIn: 5, tokensOut: 1 });
    assert.equal(body.total, 1);
    assert.equal(body.summary.requests, 1);
  });

  it('clamps a hostile limit and keeps /stats compatible', async () => {
    const logRes = fakeRes();
    await handleDashboardApi('GET', '/stats/log', {}, authed('/stats/log?limit=99999'), logRes);
    assert.equal(logRes.statusCode, 200);
    assert.equal(logRes.json().limit, 200);

    const statsRes = fakeRes();
    await handleDashboardApi('GET', '/stats', {}, authed('/stats'), statsRes);
    assert.equal(statsRes.statusCode, 200);
    const stats = statsRes.json();
    assert.equal(typeof stats.totalRequests, 'number');
    assert.equal(typeof stats.modelCounts, 'object');
    assert.equal(typeof stats.tokenTotals, 'object');
    assert.equal(typeof stats.modelBilling, 'object');
    assert.equal(stats.accountAttribution.total, stats.totalRequests);
    assert.equal(stats.accountAttribution.attributed + stats.accountAttribution.unattributed, stats.totalRequests);
  });
});
