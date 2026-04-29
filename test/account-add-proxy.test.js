import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost, getAccountList, removeAccount } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { getProxyConfig, removeProxy } from '../src/dashboard/proxy-config.js';

const originalAllowPrivateProxyHosts = config.allowPrivateProxyHosts;
const createdAccountIds = [];
const testDeps = {
  ensureLsForAccount: async () => {},
  probeAccount: async () => ({}),
};

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function accountPayload(extra = {}) {
  return {
    api_key: `test-key-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    label: 'proxy-test',
    ...extra,
  };
}

afterEach(() => {
  config.allowPrivateProxyHosts = originalAllowPrivateProxyHosts;
  configureBindHost('0.0.0.0');
  while (createdAccountIds.length) {
    const id = createdAccountIds.pop();
    removeProxy('account', id);
    removeAccount(id);
  }
});

describe('dashboard account add with proxy validation', () => {
  it('rejects invalid proxy format before creating an account', async () => {
    configureBindHost('127.0.0.1');
    const before = getAccountList().length;

    const res = fakeRes();
    await handleDashboardApi('POST', '/accounts', accountPayload({ proxy: 'invalid-proxy-url' }), { headers: {} }, res, testDeps);

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'ERR_PROXY_FORMAT_INVALID');
    assert.equal(getAccountList().length, before);
  });

  it('rejects private proxy hosts by default before creating an account', async () => {
    configureBindHost('127.0.0.1');
    config.allowPrivateProxyHosts = false;
    const before = getAccountList().length;

    const res = fakeRes();
    await handleDashboardApi('POST', '/accounts', accountPayload({ proxy: 'http://127.0.0.1:8080' }), { headers: {} }, res, testDeps);

    assert.equal(res.statusCode, 400);
    assert.match(String(res.json().error || ''), /ERR_PROXY_PRIVATE_IP|ERR_PROXY_PRIVATE_HOST/);
    assert.equal(getAccountList().length, before);
  });

  it('creates account and binds proxy when proxy is valid', async () => {
    configureBindHost('127.0.0.1');
    config.allowPrivateProxyHosts = true;
    const before = getAccountList().length;

    const res = fakeRes();
    await handleDashboardApi('POST', '/accounts', accountPayload({ proxy: 'http://127.0.0.1:8080' }), { headers: {} }, res, testDeps);

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().success, true);
    const accountId = res.json().account?.id;
    assert.ok(accountId);
    createdAccountIds.push(accountId);
    assert.equal(getAccountList().length, before + 1);
    assert.deepEqual(getProxyConfig().perAccount[accountId], {
      type: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: '',
      password: '',
    });
  });

  it('creates account without proxy binding when proxy is omitted', async () => {
    configureBindHost('127.0.0.1');
    const before = getAccountList().length;

    const res = fakeRes();
    await handleDashboardApi('POST', '/accounts', accountPayload(), { headers: {} }, res, testDeps);

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().success, true);
    const accountId = res.json().account?.id;
    assert.ok(accountId);
    createdAccountIds.push(accountId);
    assert.equal(getAccountList().length, before + 1);
    assert.equal(getProxyConfig().perAccount[accountId], undefined);
  });
});
