// Route contract for the DevIn panel:
//   GET /devin/panel
//
// The panel inherits the dashboard auth gate (no new exemption), reads only
// in-process state (no upstream call), and must never put a credential or an
// email in the body. It also pins the shared switch-row helper that
// /runtime-env-status and the panel now both use.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  addAccountByKey,
  configureBindHost,
  recordAccountRequest,
  removeAccount,
  __resetAccountRequestsForTest,
  _resetLockoutForTests,
} from '../src/auth.js';
import { accountRef } from '../src/log-safety.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const created = new Set();

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

function addAccount(label) {
  const key = `panel-key-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const account = addAccountByKey(key, label);
  created.add(account.id);
  return { account, key };
}

function gateOn() {
  _resetRuntimeConfigForTests();
  config.dashboardPassword = 'dash-secret';
  config.apiKey = '';
  configureBindHost('0.0.0.0');
}

afterEach(() => {
  for (const id of created) removeAccount(id);
  created.clear();
  __resetAccountRequestsForTest();
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  configureBindHost('0.0.0.0');
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
});

describe('GET /devin/panel', () => {
  it('fails closed without dashboard auth', async () => {
    gateOn();
    const res = fakeRes();
    await handleDashboardApi('GET', '/devin/panel', {}, req('/devin/panel'), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns the four sections with ok:true', async () => {
    gateOn();
    const res = fakeRes();
    await handleDashboardApi('GET', '/devin/panel', {}, authed('/devin/panel'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.generatedAt, 'number');
    assert.ok(Array.isArray(body.runtime.switches));
    assert.equal(body.runtime.switches.length, 6);
    assert.ok(body.runtime.langServer && typeof body.runtime.langServer.running === 'boolean');
    assert.ok(body.runtime.detach && typeof body.runtime.detach.enabled === 'boolean');
    assert.ok(Array.isArray(body.sessions.sources));
    assert.equal(body.sessions.turns.available, true);
    assert.equal(typeof body.sessions.turns.totalAccounts, 'number');
    assert.equal(typeof body.sessions.turns.capped, 'boolean');
    assert.ok(Array.isArray(body.quota.knobs));
    assert.equal(body.quota.knobs.length, 5);
    assert.ok(body.quota.drought && typeof body.quota.drought.active === 'boolean');
  });

  it('merges a recorded billed turn under the hashed account ref, never the key or email', async () => {
    gateOn();
    const { account, key } = addAccount('panel-turn@example.test');
    recordAccountRequest(account, {
      model: 'swe-2',
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      creditCost: 1.5,
      acuCost: 0.25,
      now: Date.now(),
    });

    const res = fakeRes();
    await handleDashboardApi('GET', '/devin/panel', {}, authed('/devin/panel'), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const turns = body.sessions.turns;
    assert.equal(turns.retained, 1);
    assert.equal(turns.items.length, 1);
    const row = turns.items[0];
    assert.equal(row.accountRef, accountRef(account.id));
    assert.equal(row.model, 'swe-2');
    assert.equal(row.totalTokens, 10);
    assert.equal(row.credit, 1.5);
    assert.equal(row.acu, 0.25);
    assert.ok(!res.body.includes(key), 'the raw account key must not reach the panel body');
    assert.ok(!res.body.includes('panel-turn@example.test'), 'the account email must not reach the panel body');
  });

  it('pages beyond the former 50-turn cutoff without changing the totals', async () => {
    gateOn();
    const start = Date.now() - 5_000;
    for (let i = 0; i < 11; i++) {
      const { account } = addAccount('turn-page-' + i);
      for (let j = 0; j < 100; j++) {
        recordAccountRequest(account, { model: 'swe-2', now: start + i * 100 + j, creditCost: 1 });
      }
    }
    const requestPage = async (query = '') => {
      const res = fakeRes();
      await handleDashboardApi('GET', '/devin/panel', {}, authed('/devin/panel' + query), res);
      assert.equal(res.statusCode, 200);
      return res.json().sessions.turns;
    };
    const legacy = await requestPage();
    assert.equal(legacy.items.length, 50);
    for (const size of [100, 200, 500, 1000]) {
      const first = await requestPage('?turnPage=1&turnPageSize=' + size);
      assert.equal(first.items.length, size);
      assert.equal(first.page.total, 1100);
      assert.equal(first.page.size, size);
      assert.equal(first.retained, 1100);
      assert.equal(first.summary.credit, 1100);
      const next = await requestPage('?turnPage=2&turnPageSize=' + size);
      assert.equal(next.items.length, Math.min(size, 1100 - size));
      assert.equal(next.items[0].ts, first.items.at(-1).ts - 1);
      assert.deepEqual(next.summary, first.summary);
    }
    const tail = await requestPage('?turnPage=9999&turnPageSize=500');
    assert.equal(tail.page.number, 3);
    assert.equal(tail.items.length, 100);
    const unsupported = await requestPage('?turnPage=0&turnPageSize=10000');
    assert.equal(unsupported.page.number, 1);
    assert.equal(unsupported.items.length, 50);
  });

  it('serves the snapshot without touching the network', async () => {
    gateOn();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (...args) => { calls++; return original(...args); };
    try {
      const res = fakeRes();
      await handleDashboardApi('GET', '/devin/panel', {}, authed('/devin/panel'), res);
      assert.equal(res.statusCode, 200);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0, 'opening the panel must not call upstream');
  });

  it('declares the unreadable sources instead of returning empty lists', async () => {
    gateOn();
    const res = fakeRes();
    await handleDashboardApi('GET', '/devin/panel', {}, authed('/devin/panel'), res);
    const sources = res.json().sessions.sources;
    const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
    assert.equal(byId.proxyTurns.available, true);
    assert.equal(byId.cascadeTrajectories.available, false);
    assert.equal(byId.cascadeTrajectories.reason, 'ls_only');
    assert.equal(byId.acpSessions.available, false);
    assert.equal(byId.acpSessions.reason, 'not_tracked');
  });

  it('reports the effective switch values and their source', async () => {
    gateOn();
    const res = fakeRes();
    await handleDashboardApi('GET', '/devin/panel', {}, authed('/devin/panel'), res);
    const switches = res.json().runtime.switches;
    for (const row of switches) {
      assert.equal(typeof row.key, 'string');
      assert.ok('value' in row);
      assert.ok(row.source === 'env' || row.source === 'config');
      assert.equal(typeof row.overridden, 'boolean');
    }
    const cred = res.json().runtime.credentials;
    assert.equal(cred.writable, false);
  });

  it('does not answer for a non-GET method', async () => {
    gateOn();
    const res = fakeRes();
    await handleDashboardApi('POST', '/devin/panel', {}, authed('/devin/panel'), res);
    assert.notEqual(res.statusCode, 200);
  });
});

describe('GET /runtime-env-status (shared switch rows)', () => {
  it('still returns flat effective values plus per-switch detail', async () => {
    gateOn();
    const res = fakeRes();
    await handleDashboardApi('GET', '/runtime-env-status', {}, authed('/runtime-env-status'), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.devinConnect, body.switches.devinConnect.value);
    assert.equal(body.devinCliMode, body.switches.devinCliMode.value);
    for (const key of ['devinConnect', 'devinOnly', 'devinCliMode', 'allowClientTools', 'loginHostFallback', 'autoRelogin']) {
      assert.ok(body.switches[key], `${key} must be present`);
      assert.ok('value' in body.switches[key]);
      assert.ok('override' in body.switches[key]);
      assert.ok('source' in body.switches[key]);
    }
  });

  it('reports config after an override and env after clearing it', async () => {
    gateOn();
    const put = fakeRes();
    await handleDashboardApi('PUT', '/runtime-env-status', { devinConnect: true }, authed('/runtime-env-status'), put);
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().switches.devinConnect.source, 'config');
    assert.equal(put.json().switches.devinConnect.value, true);

    const clear = fakeRes();
    await handleDashboardApi('PUT', '/runtime-env-status', { devinConnect: null }, authed('/runtime-env-status'), clear);
    assert.equal(clear.statusCode, 200);
    assert.equal(clear.json().switches.devinConnect.source, 'env');
    assert.equal(clear.json().switches.devinConnect.override, null);
  });
});
