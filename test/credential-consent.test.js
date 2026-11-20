// Operation-level consent for the legacy /auth/login password import.
//
// Login permission is not password-retention consent. The legacy single and
// batch routes must write to the encrypted credential store only when THIS
// operation/row asked for it (storeCredential:true) AND the caller passes the
// same trusted-local / explicit-remote gate the dashboard uses. A loopback
// BIND is not enough: behind a reverse proxy the peer is loopback while the
// real client is remote.
//
// Real server + real route + real addAccountByEmail; only the upstream login
// and the credential-store calls are injected. Every address/key below is a
// throwaway literal and the temp DATA_DIR comes from setup-env.

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../src/server.js';
import { config } from '../src/config.js';
import {
  __setEmailImportDeps,
  _resetLockoutForTests,
  configureBindHost,
  getAccountInternal,
  getAccountList,
  removeAccount,
} from '../src/auth.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';

const originalApiKey = config.apiKey;
const originalPassword = config.dashboardPassword;
const originalHost = config.host;
const originalPort = config.port;

let server = null;
let storeCalls = [];
let storeMode = 'ok';
let storeEnabled = true;
let loginCalls = [];
let keySeq = 0;

function fakeLogin() {
  return async (email) => {
    loginCalls.push(email);
    keySeq += 1;
    return {
      apiKey: `devin-session-token$CONSENT${keySeq}`,
      email,
      identityEmail: String(email).trim().toLowerCase(),
      name: email,
    };
  };
}

function installDeps() {
  __setEmailImportDeps({
    windsurfLogin: fakeLogin(),
    isCredStoreEnabled: () => storeEnabled,
    storeCredential: (email, password) => {
      storeCalls.push({ email, password });
      if (storeMode === 'throw') {
        const err = new Error('store busy');
        err.code = 'ERR_CRED_STORE_BUSY';
        throw err;
      }
      if (storeMode === 'false') return false;
      return true;
    },
  });
}

function waitListening(s) {
  return new Promise((resolve) => { if (s.address()) return resolve(); s.once('listening', resolve); });
}

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        authorization: 'Bearer sk-chat-shared',
        'x-dashboard-password': 'operator-pw',
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function login(body, headers) {
  return request('POST', '/auth/login', body, headers);
}

function accountFor(email) {
  const row = getAccountList().find((a) => String(a.email || '').trim().toLowerCase() === email);
  assert.ok(row, `account ${email} must exist`);
  return getAccountInternal(row.id);
}

before(async () => {
  _resetLockoutForTests();
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  config.apiKey = 'sk-chat-shared';
  config.dashboardPassword = 'operator-pw';
  config.host = '127.0.0.1';
  config.port = 0;
  configureBindHost('127.0.0.1');
  server = startServer();
  await waitListening(server);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  config.apiKey = originalApiKey;
  config.dashboardPassword = originalPassword;
  config.host = originalHost;
  config.port = originalPort;
});

beforeEach(() => {
  _resetLockoutForTests();
  storeCalls = [];
  loginCalls = [];
  storeMode = 'ok';
  storeEnabled = true;
  delete process.env.DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE;
  delete process.env.TRUST_PROXY_X_FORWARDED_FOR;
  installDeps();
});

afterEach(() => {
  __setEmailImportDeps(null);
  for (const row of getAccountList()) removeAccount(row.id);
  delete process.env.DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE;
  delete process.env.TRUST_PROXY_X_FORWARDED_FOR;
});

describe('legacy single login: consent + locality matrix', () => {
  it('logs in but stores nothing when storeCredential is absent', async () => {
    const r = await login({ email: 'single-absent@example.test', password: 'throwaway-pw' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(loginCalls.length, 1);
    assert.equal(storeCalls.length, 0, 'login success must not imply retention consent');
    assert.equal(accountFor('single-absent@example.test').credentialEmail || '', '');
  });

  it('stores nothing when storeCredential is explicitly false', async () => {
    const r = await login({ email: 'single-false@example.test', password: 'throwaway-pw', storeCredential: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(storeCalls.length, 0);
    assert.equal(accountFor('single-false@example.test').credentialEmail || '', '');
  });

  it('stores exactly once for an explicit true from a trusted local caller', async () => {
    const email = 'single-local@example.test';
    const r = await login({ email, password: 'throwaway-pw', storeCredential: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(storeCalls.length, 1);
    assert.equal(storeCalls[0].email, email);
    assert.equal(accountFor(email).credentialEmail, email);
  });

  it('does not trust a loopback peer that a trusted proxy reports as remote', async () => {
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    const email = 'single-proxied@example.test';
    const r = await login(
      { email, password: 'throwaway-pw', storeCredential: true },
      { 'x-forwarded-for': '203.0.113.9' },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(storeCalls.length, 0, 'a remote client behind a loopback proxy is not local');
    assert.equal(accountFor(email).credentialEmail || '', '');
  });

  it('keeps the explicit remote-store opt-in working', async () => {
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    process.env.DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE = '1';
    const email = 'single-remote-optin@example.test';
    const r = await login(
      { email, password: 'throwaway-pw', storeCredential: true },
      { 'x-forwarded-for': '203.0.113.9' },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(storeCalls.length, 1);
    assert.equal(accountFor(email).credentialEmail, email);
  });
});

describe('legacy batch login: consent is per row', () => {
  it('stores only the row that asked, and never for token/key rows', async () => {
    const stored = 'batch-yes@example.test';
    const silent = 'batch-silent@example.test';
    const declined = 'batch-no@example.test';
    const r = await login({
      storeCredential: true, // a batch-level flag must NOT consent for every row
      accounts: [
        { email: stored, password: 'throwaway-pw', storeCredential: true },
        { email: silent, password: 'throwaway-pw' },
        { email: declined, password: 'throwaway-pw', storeCredential: false },
        { token: 'devin-session-token$BATCHTOKEN', label: 'batch-token@example.test', storeCredential: true },
        { api_key: 'sk-batch-key-throwaway', label: 'batch-key@example.test', storeCredential: true },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results.length, 5, JSON.stringify(r.body.results));
    assert.equal(r.body.results.filter((row) => row.error).length, 0, JSON.stringify(r.body.results));
    assert.equal(storeCalls.length, 1, 'exactly one password row consented');
    assert.equal(storeCalls[0].email, stored);
    assert.equal(accountFor(stored).credentialEmail, stored);
    assert.equal(accountFor(silent).credentialEmail || '', '');
    assert.equal(accountFor(declined).credentialEmail || '', '');
    assert.equal(accountFor('batch-token@example.test').credentialEmail || '', '');
    assert.equal(accountFor('batch-key@example.test').credentialEmail || '', '');
  });
});

describe('failed persistence never creates a credential binding', () => {
  it('a store that returns false leaves the login successful and unbound', async () => {
    storeMode = 'false';
    const email = 'store-false@example.test';
    const r = await login({ email, password: 'throwaway-pw', storeCredential: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(storeCalls.length, 1, 'the store was actually asked');
    assert.equal(accountFor(email).credentialEmail || '', '', 'a decline is not a binding');
  });

  it('a store that throws leaves the login successful and unbound', async () => {
    storeMode = 'throw';
    const email = 'store-throw@example.test';
    const r = await login({ email, password: 'throwaway-pw', storeCredential: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(storeCalls.length, 1);
    assert.equal(accountFor(email).credentialEmail || '', '');
  });

  it('a disabled store is not called and leaves no binding', async () => {
    storeEnabled = false;
    const email = 'store-disabled@example.test';
    const r = await login({ email, password: 'throwaway-pw', storeCredential: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(storeCalls.length, 0);
    assert.equal(accountFor(email).credentialEmail || '', '');
  });
});
