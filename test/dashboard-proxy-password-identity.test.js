// Saved proxy passwords belong to one destination + username. The dashboard
// global editor omits `password` when the field was left blank, which is safe
// only while the edited proxy still dials the same endpoint as the credential.
// These cases pin the identity boundary for both setters and the API refusal
// path: same tuple keeps the secret, a changed tuple requires an explicit
// replacement or an explicit empty value, and a refused edit leaves memory and
// proxy.json untouched.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import {
  getProxyConfig,
  getProxyConfigMasked,
  setGlobalProxy,
  setAccountProxy,
  removeProxy,
} from '../src/dashboard/proxy-config.js';
import { handleDashboardApi } from '../src/dashboard/api.js';

const IDENTITY_ERROR = 'ERR_PROXY_PASSWORD_IDENTITY_CHANGED';
const SECRET = 'fixture-proxy-password-7f3a';
const REPLACEMENT = 'fixture-proxy-password-replaced';
const ACCOUNT_SECRET = 'fixture-account-password-91bc';
const ACCOUNT = 'proxy-identity-account';

const GLOBAL_BASE = Object.freeze({
  type: 'http',
  host: 'proxy-a.example.com',
  port: 8080,
  username: 'alice',
});

const ACCOUNT_BASE = Object.freeze({
  type: 'http',
  host: 'acct-a.example.com',
  port: 8080,
  username: 'carol',
});

const original = {
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
  allowPrivateProxyHosts: config.allowPrivateProxyHosts,
};

function proxyFile() {
  return join(config.dataDir, 'proxy.json');
}

function readProxyFile() {
  const file = proxyFile();
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null;
}

function snapshotMemory() {
  return JSON.parse(JSON.stringify(getProxyConfig()));
}

function withoutPassword(cfg, overrides = {}) {
  return {
    type: cfg.type,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    ...overrides,
  };
}

function seedGlobal(cfg = {}) {
  setGlobalProxy({ ...GLOBAL_BASE, password: SECRET, ...cfg });
}

function seedAccount(cfg = {}) {
  setAccountProxy(ACCOUNT, { ...ACCOUNT_BASE, password: ACCOUNT_SECRET, ...cfg });
}

function assertIdentityRefusal(fn) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, IDENTITY_ERROR);
    assert.match(err.message, /explicit/i);
    assert.match(err.message, /password/i);
    return true;
  });
}

function assertUnchanged(beforeMemory, beforeFile, beforeMasked) {
  assert.deepEqual(getProxyConfig(), beforeMemory, 'in-memory config must not change');
  assert.deepEqual(readProxyFile(), beforeFile, 'proxy.json must not be rewritten');
  assert.deepEqual(getProxyConfigMasked(), beforeMasked, 'masked view must not change');
}

beforeEach(() => {
  removeProxy('global');
  removeProxy('account', ACCOUNT);
});

afterEach(() => {
  removeProxy('global');
  removeProxy('account', ACCOUNT);
});

describe('proxy password identity — global setter', () => {
  it('preserves a saved password when type, host, port and username are unchanged', () => {
    seedGlobal();
    setGlobalProxy(withoutPassword(GLOBAL_BASE));

    assert.equal(getProxyConfig().global.password, SECRET);
    assert.equal(readProxyFile().global.password, SECRET);
    assert.equal(getProxyConfigMasked().global.hasPassword, true);
  });

  for (const [component, overrides] of [
    ['type', { type: 'https' }],
    ['host', { host: 'proxy-b.example.com' }],
    ['port', { port: 3128 }],
    ['username', { username: 'bob' }],
  ]) {
    it(`refuses an omitted password after a ${component} change and leaves storage untouched`, () => {
      seedGlobal();
      const beforeMemory = snapshotMemory();
      const beforeFile = readProxyFile();
      const beforeMasked = getProxyConfigMasked();

      assertIdentityRefusal(() => setGlobalProxy(withoutPassword(GLOBAL_BASE, overrides)));

      assertUnchanged(beforeMemory, beforeFile, beforeMasked);
      assert.equal(getProxyConfig().global.password, SECRET);
    });
  }

  it('accepts an explicit replacement password on a changed destination', () => {
    seedGlobal();
    setGlobalProxy({
      ...GLOBAL_BASE,
      host: 'proxy-b.example.com',
      password: REPLACEMENT,
    });

    assert.equal(getProxyConfig().global.password, REPLACEMENT);
    assert.equal(readProxyFile().global.password, REPLACEMENT);
    assert.equal(getProxyConfigMasked().global.hasPassword, true);
  });

  it('accepts an explicit empty password as a clear on a changed destination', () => {
    seedGlobal();
    setGlobalProxy({
      ...GLOBAL_BASE,
      host: 'proxy-b.example.com',
      password: '',
    });

    assert.equal(getProxyConfig().global.password, '');
    assert.equal(readProxyFile().global.password, '');
    assert.equal(getProxyConfigMasked().global.hasPassword, false);
  });

  it('allows a changed destination when no old password would be inherited', () => {
    seedGlobal({ password: '' });

    setGlobalProxy({
      type: 'https',
      host: 'proxy-b.example.com',
      port: 8443,
      username: 'bob',
    });

    assert.equal(getProxyConfig().global.password, '');
    assert.equal(getProxyConfig().global.host, 'proxy-b.example.com');
    assert.equal(getProxyConfigMasked().global.hasPassword, false);
  });

  it('allows a first-time destination with no prior configuration', () => {
    setGlobalProxy({
      type: 'https',
      host: 'proxy-new.example.com',
      port: 8443,
      username: 'bob',
    });

    assert.equal(getProxyConfig().global.password, '');
    assert.equal(getProxyConfigMasked().global.hasPassword, false);
  });

  it('allows clearing the proxy entirely without a password decision', () => {
    seedGlobal();
    setGlobalProxy(null);

    assert.equal(getProxyConfig().global, null);
    assert.equal(readProxyFile().global, null);
  });
});

describe('proxy password identity — normalization', () => {
  it('treats host case and surrounding whitespace as the same destination', () => {
    seedGlobal({ host: 'Proxy-A.Example.COM' });

    setGlobalProxy({
      type: 'http',
      host: '  proxy-a.example.com  ',
      port: '8080',
      username: 'alice',
    });

    assert.equal(getProxyConfig().global.password, SECRET);
    assert.equal(getProxyConfig().global.host, 'proxy-a.example.com');
  });

  it('treats an omitted port as the stored 8080 default for HTTP', () => {
    seedGlobal({ port: 8080 });

    setGlobalProxy({
      type: 'http',
      host: 'proxy-a.example.com',
      username: 'alice',
    });

    assert.equal(getProxyConfig().global.port, 8080);
    assert.equal(getProxyConfig().global.password, SECRET);
  });

  it('treats an omitted port as 8080, not 443, for HTTPS', () => {
    seedGlobal({ type: 'https', port: 8080 });

    setGlobalProxy({
      type: 'https',
      host: 'proxy-a.example.com',
      username: 'alice',
    });

    assert.equal(getProxyConfig().global.port, 8080);
    assert.equal(getProxyConfig().global.password, SECRET);
  });

  it('refuses HTTPS 443 → omitted port because the effective port changes to 8080', () => {
    seedGlobal({ type: 'https', port: 443 });
    const beforeMemory = snapshotMemory();
    const beforeFile = readProxyFile();
    const beforeMasked = getProxyConfigMasked();

    assertIdentityRefusal(() => setGlobalProxy(withoutPassword(GLOBAL_BASE, { type: 'https', port: undefined })));

    assertUnchanged(beforeMemory, beforeFile, beforeMasked);
  });

  it('treats socks, socks5 and socks5h spellings as the same transport', () => {
    seedGlobal({ type: 'socks', host: 'proxy-s.example.com', port: 1080 });

    setGlobalProxy({
      type: 'socks5h',
      host: 'proxy-s.example.com',
      port: 1080,
      username: 'alice',
    });

    assert.equal(getProxyConfig().global.password, SECRET);
  });

  it('does not treat HTTP and SOCKS as the same transport', () => {
    seedGlobal({ type: 'socks5', host: 'proxy-s.example.com', port: 1080 });
    const beforeMemory = snapshotMemory();
    const beforeFile = readProxyFile();
    const beforeMasked = getProxyConfigMasked();

    assertIdentityRefusal(() => setGlobalProxy({
      type: 'http',
      host: 'proxy-s.example.com',
      port: 1080,
      username: 'alice',
    }));

    assertUnchanged(beforeMemory, beforeFile, beforeMasked);
  });
});

describe('proxy password identity — per-account scope', () => {
  it('preserves an account password on the same tuple', () => {
    seedAccount();
    setAccountProxy(ACCOUNT, withoutPassword(ACCOUNT_BASE));

    assert.equal(getProxyConfig().perAccount[ACCOUNT].password, ACCOUNT_SECRET);
    assert.equal(readProxyFile().perAccount[ACCOUNT].password, ACCOUNT_SECRET);
    assert.equal(getProxyConfigMasked().perAccount[ACCOUNT].hasPassword, true);
  });

  it('refuses a changed account tuple without touching global or account state', () => {
    seedGlobal();
    seedAccount();
    const beforeMemory = snapshotMemory();
    const beforeFile = readProxyFile();
    const beforeMasked = getProxyConfigMasked();

    assertIdentityRefusal(() => setAccountProxy(
      ACCOUNT,
      withoutPassword(ACCOUNT_BASE, { host: 'acct-b.example.com' }),
    ));

    assertUnchanged(beforeMemory, beforeFile, beforeMasked);
    assert.equal(getProxyConfig().perAccount[ACCOUNT].password, ACCOUNT_SECRET);
    assert.equal(getProxyConfig().global.password, SECRET);
  });

  it('never inherits the global password into an account scope', () => {
    seedGlobal();
    setAccountProxy(ACCOUNT, withoutPassword(ACCOUNT_BASE));

    assert.equal(getProxyConfig().perAccount[ACCOUNT].password, '');
    assert.equal(getProxyConfigMasked().perAccount[ACCOUNT].hasPassword, false);

    setAccountProxy(ACCOUNT, {
      type: 'https',
      host: 'acct-b.example.com',
      port: 8443,
      username: 'dave',
    });

    assert.equal(getProxyConfig().perAccount[ACCOUNT].password, '');
    assert.equal(getProxyConfig().global.password, SECRET);
  });
});

function mkRes() {
  const captured = { status: null, body: null };
  const res = {
    headersSent: false,
    writeHead(status) {
      captured.status = status;
      res.headersSent = true;
      return res;
    },
    end(p) {
      try {
        captured.body = JSON.parse(p);
      } catch {
        captured.body = p;
      }
    },
    setHeader() {},
    on() {},
  };
  return { res, captured };
}

function mkAuthedReq() {
  return {
    headers: { 'x-dashboard-password': 'admin-pw' },
    socket: { remoteAddress: '203.0.113.5' },
  };
}

describe('proxy password identity — dashboard routes', () => {
  beforeEach(() => {
    config.apiKey = '';
    config.dashboardPassword = 'admin-pw';
    config.allowPrivateProxyHosts = true;
    configureBindHost('0.0.0.0');
  });

  afterEach(() => {
    config.apiKey = original.apiKey;
    config.dashboardPassword = original.dashboardPassword;
    config.allowPrivateProxyHosts = original.allowPrivateProxyHosts;
    configureBindHost('0.0.0.0');
  });

  it('PUT /proxy/global refuses an identity change without a password and leaves state intact', async () => {
    setGlobalProxy({
      type: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password: SECRET,
    });
    const beforeMemory = snapshotMemory();
    const beforeFile = readProxyFile();
    const beforeMasked = getProxyConfigMasked();

    const { res, captured } = mkRes();
    await handleDashboardApi(
      'PUT',
      '/proxy/global',
      { type: 'https', host: '127.0.0.1', port: 8080, username: 'alice' },
      mkAuthedReq(),
      res,
    );

    assert.equal(captured.status, 400);
    assert.match(String(captured.body?.error), /ERR_PROXY_PASSWORD_IDENTITY_CHANGED/);
    assert.match(String(captured.body?.error), /explicit/i);
    assertUnchanged(beforeMemory, beforeFile, beforeMasked);

    const { res: getRes, captured: getCaptured } = mkRes();
    await handleDashboardApi('GET', '/proxy', null, mkAuthedReq(), getRes);
    assert.equal(getCaptured.status, 200);
    assert.equal(getCaptured.body.global.hasPassword, true);
    assert.equal(Object.hasOwn(getCaptured.body.global, 'password'), false);
  });

  it('PUT /proxy/global accepts the same tuple, an explicit replacement and an explicit clear', async () => {
    setGlobalProxy({
      type: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password: SECRET,
    });

    const same = mkRes();
    await handleDashboardApi(
      'PUT',
      '/proxy/global',
      { type: 'http', host: '127.0.0.1', port: 8080, username: 'alice' },
      mkAuthedReq(),
      same.res,
    );
    assert.equal(same.captured.status, 200);
    assert.equal(getProxyConfig().global.password, SECRET);

    const replaced = mkRes();
    await handleDashboardApi(
      'PUT',
      '/proxy/global',
      { type: 'https', host: '127.0.0.1', port: 8443, username: 'bob', password: REPLACEMENT },
      mkAuthedReq(),
      replaced.res,
    );
    assert.equal(replaced.captured.status, 200);
    assert.equal(getProxyConfig().global.password, REPLACEMENT);

    const cleared = mkRes();
    await handleDashboardApi(
      'PUT',
      '/proxy/global',
      { type: 'https', host: '127.0.0.1', port: 8443, username: 'bob', password: '' },
      mkAuthedReq(),
      cleared.res,
    );
    assert.equal(cleared.captured.status, 200);
    assert.equal(getProxyConfig().global.password, '');
    assert.equal(readProxyFile().global.password, '');
  });

  it('PUT /proxy/accounts/:id refuses a changed tuple without a password and leaves state intact', async () => {
    setAccountProxy(ACCOUNT, {
      type: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password: ACCOUNT_SECRET,
    });
    const beforeMemory = snapshotMemory();
    const beforeFile = readProxyFile();
    const beforeMasked = getProxyConfigMasked();

    const { res, captured } = mkRes();
    await handleDashboardApi(
      'PUT',
      `/proxy/accounts/${ACCOUNT}`,
      { type: 'http', host: '127.0.0.1', port: 3128, username: 'alice', warmup: true },
      mkAuthedReq(),
      res,
    );

    assert.equal(captured.status, 400);
    assert.match(String(captured.body?.error), /ERR_PROXY_PASSWORD_IDENTITY_CHANGED/);
    assertUnchanged(beforeMemory, beforeFile, beforeMasked);
    assert.equal(getProxyConfig().perAccount[ACCOUNT].password, ACCOUNT_SECRET);
  });
});
