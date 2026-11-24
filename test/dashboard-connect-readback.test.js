import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  __resetModelCatalogState, __setModelCatalogDeps, __waitForModelCatalogSync, addAccountByKey,
  getAccountList, removeAccount, setAccountTokens,
} from '../src/auth.js';
import { config } from '../src/config.js';
import { exportStats, getRequestLog, importStats, resetStats } from '../src/dashboard/stats.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { startServer } from '../src/server.js';

test('the account summary only exposes Connect catalog evidence from the current credential', async t => {
  const original = process.env.DEVIN_CONNECT;
  process.env.DEVIN_CONNECT = '1';
  _resetRuntimeConfigForTests();
  __resetModelCatalogState();
  let now = Date.now();
  let catalogReads = 0;
  let failCatalog = false;
  __setModelCatalogDeps({
    now: () => now,
    scheduleCatalogRetry: () => () => {},
    getCascadeModelConfigs: async () => ({ configs: [] }),
    fetchConnectCatalog: async () => {
      catalogReads++;
      if (failCatalog) throw Error('Fixture refresh is unavailable');
      return [{ selector: 'swe-1-7-medium' }, { selector: 'swe-2-medium' }];
    },
  });
  const account = addAccountByKey('devin-session-token$fixture-catalog-evidence', 'Fixture catalog');
  t.after(async () => {
    await __waitForModelCatalogSync();
    removeAccount(account.id);
    __setModelCatalogDeps(null);
    __resetModelCatalogState();
    _resetRuntimeConfigForTests();
    if (original === undefined) delete process.env.DEVIN_CONNECT;
    else process.env.DEVIN_CONNECT = original;
  });
  const read = () => getAccountList({ view: 'summary' }).find(a => a.id === account.id);
  await __waitForModelCatalogSync();
  const callsBefore = catalogReads;
  assert.deepEqual(read().connectCatalog, { state: 'observed', observedAt: now, entryCount: 2 });
  assert.equal(read().lastProbed, 0);
  const observedAt = now;
  now += 9_000_000;
  assert.deepEqual(read().connectCatalog, { state: 'stale', observedAt, entryCount: 2 });
  assert.equal(catalogReads, callsBefore, 'viewing the account must not start any upstream read');

  failCatalog = true;
  setAccountTokens(account.id, { apiKey: 'devin-session-token$fixture-catalog-rotated' });
  await __waitForModelCatalogSync();
  assert.deepEqual(read().connectCatalog, { state: 'unknown', observedAt: null, entryCount: null });
  assert.equal(read().lastProbed, 0);
});

test('pre-admission HTTP failures have a root request row and no billed attempt', async t => {
  const previous = { host: config.host, port: config.port, apiKey: config.apiKey, dashboardPassword: config.dashboardPassword };
  const envKeys = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
  const previousEnv = envKeys.map(key => [key, process.env[key]]);
  process.env.DEVIN_CONNECT = '0';
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  _resetRuntimeConfigForTests();
  resetStats();
  const apiKey = 'fixture-request-readback-key';
  const password = 'fixture-request-readback-admin';
  Object.assign(config, { host: '127.0.0.1', port: 0, apiKey, dashboardPassword: password });
  const server = startServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    Object.assign(config, previous);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetRuntimeConfigForTests();
    resetStats();
  });
  if (!server.listening) await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(origin + '/health').then(res => res.json());
  const cases = [
    ['/v1/chat/completions', 'chat_completions', 503],
    ['/v1/completions', 'completions', 503],
    ['/v1/responses', 'responses', 503],
    ['/v1/messages', 'messages', 529],
    ['/v1beta/models/fixture:generateContent', 'gemini', 503],
  ];
  const seen = new Set();
  for (const [path, surface, status] of cases) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-unparsed', messages: [{ role: 'user', content: 'fixture-no-storage' }] }),
    });
    assert.equal(response.status, status);
    const id = response.headers.get('x-request-id');
    const body = await response.json();
    if (surface === 'gemini') {
      assert.equal(body.error.status, 'UNAVAILABLE');
    } else {
      assert.equal(body.request_id, id);
      assert.equal(body.error.type, surface === 'messages' ? 'overloaded_error' : 'api_error');
    }
    assert.match(id, /^req_[0-9a-f-]{36}$/);
    assert.ok(!seen.has(id));
    seen.add(id);
    const log = await fetch(origin + '/dashboard/api/stats/log?requestId=' + id, {
      headers: { 'x-dashboard-password': password },
    }).then(res => res.json());
    assert.equal(log.items.length, 1, 'the HTTP root must be readable by its public id');
    const [row] = log.items;
    assert.equal(row.requestBootId, health.requestLogBootId);
    assert.equal(row.requestBootId, log.currentBootId);
    assert.equal(row.requestVersion, health.version);
    assert.equal(row.requestBuildSource, health.buildSource);
    assert.equal(row.requestHttpStatus, status);
    assert.equal(row.requestStage, 'account_admission');
    assert.equal(row.requestFailureCode, 'NO_ACTIVE_ACCOUNTS');
    assert.equal(row.requestSurface, surface);
    assert.equal(row.requestDispatchCoverage, 'before_dispatch');
    assert.equal(row.requestDispatchCount, 0);
    assert.equal(row.reportedUsage, null);
    assert.equal(row.requestedModel, null);
    assert.equal(row.credit, 0);
    assert.equal(log.summary.requests, 0, 'gateway rejection is separate from the attempt summary');
    assert.equal(log.summary.admissionRejections, 1);
    assert.ok(!JSON.stringify(log).includes('fixture-no-storage'));
  }
  const saved = exportStats();
  assert.equal(saved.totalRequests, 0);
  assert.equal(new Set(saved.recentRequests.map(row => row.statsRowId)).size, cases.length);
  resetStats();
  assert.equal(importStats(saved, { mode: 'replace' }).ok, true);
  assert.equal(getRequestLog({ status: 503 }).items.length, 4);
  assert.equal(getRequestLog({ status: 529 }).items.length, 1);
});

test('an old row with zero observed handoffs cannot claim zero dispatch', () => {
  resetStats();
  try {
    const requestId = 'req_a45055b6-99d1-4ae2-87b5-5dfb6de3dc62';
    const snapshot = {
      ...exportStats(),
      recentRequests: [{
        ts: Date.now(), model: 'legacy-fixture', success: false, status: 503,
        requestId, requestDispatchCount: 0,
      }],
    };
    assert.equal(importStats(snapshot, { mode: 'replace' }).ok, true);
    const [row] = getRequestLog({ requestId }).items;
    assert.equal(row.requestDispatchCount, null);
    assert.equal(row.requestDispatchCoverage, null);
    assert.equal(row.requestBootId, null);
  } finally {
    resetStats();
  }
});
