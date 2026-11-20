// Verified login identity, end to end: enroll -> rename the display label ->
// persist/reload -> auto re-login -> delete.
//
// The real dashboard login route, the real account store (accounts.json under
// the setup-env temp DATA_DIR) and the real encrypted credential store (temp
// file + throwaway key) run here; only the upstream HTTP transport is a fake.
// A separate re-login seam supplies the fresh token. No provider call, no real
// account and no process action.

import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import {
  __loadAccountsForTest,
  __resetReloginState,
  __setEmailImportDeps,
  __setReloginDeps,
  addAccountByEmail,
  addAccountByKey,
  configureBindHost,
  getAccountInternal,
  getAccountList,
  markNeedsReauth,
  reLoginAccount,
  removeAccount,
  setAccountCredentialEmail,
  setAccountIdentityEmail,
  setAccountStatus,
  updateAccountLabel,
} from '../src/auth.js';
import {
  getCredential,
  isCredStoreEnabled,
  listCredentialEmails,
  storeCredential,
} from '../src/devin-connect-credentials.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import {
  __setLoginTransportForTests,
  _resetEmailFlowsForTests,
  _resetEmailLockoutForTests,
  _resetProbeHostForTests,
  emailLoginStart,
} from '../src/dashboard/windsurf-login.js';

const EMAIL = 'lifecycle-owner@example.test';
const EMAIL_NO_STORE = 'lifecycle-nostore@example.test';
const EMAIL_CODE = 'lifecycle-emailcode@example.test';
const RENAMED = 'lifecycle-renamed-label@example.test';
const OTHER = 'lifecycle-other@example.test';
const PASSWORD = ['throwaway', 'lifecycle', 'password'].join('-');
const AUTH1 = 'auth1_lifecycle_throwaway';
const VERIFY = 'lifecycle-verify-token-throwaway';
const CODE = '271828';

const originalDashboardPassword = config.dashboardPassword;
const accountsFile = join(config.sharedDataDir || config.dataDir, 'accounts.json');
const credFile = join(tmpdir(), `windsurfapi-identity-lifecycle-${randomUUID()}.json`);
const previousCredKey = process.env.DEVIN_CONNECT_CRED_KEY;
const previousCredFile = process.env.DEVIN_CONNECT_CRED_FILE;
const previousAutoRelogin = process.env.DEVIN_CONNECT_AUTO_RELOGIN;
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

function authedReq(subpath) {
  return {
    url: '/dashboard/api' + subpath,
    headers: { 'x-dashboard-password': 'lifecycle-dash-secret' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

async function post(subpath, body) {
  const res = fakeRes();
  await handleDashboardApi('POST', subpath, body, authedReq(subpath), res);
  return { status: res.statusCode, body: res.json() };
}

function makeTransport(routes) {
  return async (url, opts) => {
    for (const [matcher, reply] of routes) {
      if (url.includes(matcher)) {
        if (reply instanceof Error) throw reply;
        const data = opts?.raw
          ? (Buffer.isBuffer(reply.data) ? reply.data : Buffer.from(JSON.stringify(reply.data)))
          : reply.data;
        return { status: reply.status, data };
      }
    }
    throw new Error(`unexpected request to ${url}`);
  };
}

const CONN_PASSWORD = ['windsurf.com/_devin-auth/connections', {
  status: 200,
  data: {
    connections: [{ id: 'email', type: 'email', enabled: true }],
    auth_method: { method: 'auth1', has_password: true, enterprise_sso_domain: false },
  },
}];
const PASSWORD_OK = ['_devin-auth/password/login', { status: 200, data: { token: AUTH1 } }];
const START_OK = ['_devin-auth/email/start', { status: 200, data: { email_verification_token: VERIFY } }];
const COMPLETE_OK = ['_devin-auth/email/complete', { status: 200, data: { token: AUTH1 } }];

function postauthOk(sessionToken) {
  return ['WindsurfPostAuth', { status: 200, data: { sessionToken, accountId: 'account-lifecycle' } }];
}

function diskRows() {
  return JSON.parse(readFileSync(accountsFile, 'utf8'));
}

function rowFor(email) {
  const row = getAccountList().find((a) => a.loginEmail === email);
  assert.ok(row, `account with verified identity ${email} must exist`);
  return getAccountInternal(row.id);
}

function track(account) {
  created.add(account.id);
  return account;
}

beforeEach(() => {
  __setLoginTransportForTests(null);
  __setReloginDeps(null);
  __resetReloginState();
  _resetEmailFlowsForTests();
  _resetEmailLockoutForTests();
  _resetProbeHostForTests();
  config.dashboardPassword = 'lifecycle-dash-secret';
  configureBindHost('127.0.0.1');
  process.env.DEVIN_CONNECT_CRED_KEY = 'lifecycle-throwaway-key';
  process.env.DEVIN_CONNECT_CRED_FILE = credFile;
  process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
});

afterEach(() => {
  __setEmailImportDeps(null);
  __setLoginTransportForTests(null);
  __setReloginDeps(null);
  __resetReloginState();
  for (const id of created) {
    try { removeAccount(id); } catch { /* already gone */ }
  }
  created.clear();
  for (const path of [credFile, `${credFile}.lock`]) {
    try { if (existsSync(path)) unlinkSync(path); } catch {}
  }
});

after(() => {
  __setLoginTransportForTests(null);
  __setReloginDeps(null);
  config.dashboardPassword = originalDashboardPassword;
  if (previousCredKey === undefined) delete process.env.DEVIN_CONNECT_CRED_KEY;
  else process.env.DEVIN_CONNECT_CRED_KEY = previousCredKey;
  if (previousCredFile === undefined) delete process.env.DEVIN_CONNECT_CRED_FILE;
  else process.env.DEVIN_CONNECT_CRED_FILE = previousCredFile;
  if (previousAutoRelogin === undefined) delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  else process.env.DEVIN_CONNECT_AUTO_RELOGIN = previousAutoRelogin;
});

describe('enroll -> rename -> reload -> re-login -> delete', () => {
  it('keeps the verified identity stable through a rename and a restart', async () => {
    __setLoginTransportForTests(makeTransport([CONN_PASSWORD, PASSWORD_OK, postauthOk('devin-session-token$ENROLL')]));

    const enrolled = await post('/windsurf-login', {
      email: EMAIL,
      password: PASSWORD,
      storeCredential: true,
    });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
    assert.equal(enrolled.body.credentialStored, true);

    const account = track(rowFor(EMAIL));
    assert.equal(account.email, EMAIL);
    assert.equal(account.identityEmail, EMAIL);
    assert.equal(account.credentialEmail, EMAIL);
    assert.deepEqual(listCredentialEmails(), [EMAIL]);

    updateAccountLabel(account.id, RENAMED);
    assert.equal(account.email, RENAMED, 'the display label moved');
    assert.equal(account.identityEmail, EMAIL, 'the verified identity did not move');
    assert.equal(account.credentialEmail, EMAIL, 'the store binding did not move');

    const persisted = diskRows().find((row) => row.identityEmail === EMAIL);
    assert.ok(persisted, 'identityEmail must be serialized');
    assert.equal(persisted.email, RENAMED);
    assert.equal(persisted.credentialEmail, EMAIL);

    // Simulate a process restart: drop the in-memory row (which also removes its
    // store record), restore the credential, then reload the exact bytes the
    // module wrote.
    const rowsBeforeRemoval = diskRows();
    removeAccount(account.id);
    created.delete(account.id);
    assert.equal(storeCredential(EMAIL, PASSWORD), true, 'fixture: restore the password record');
    writeFileSync(accountsFile, JSON.stringify(rowsBeforeRemoval, null, 2));
    __loadAccountsForTest();

    const reloaded = track(rowFor(EMAIL));
    assert.equal(reloaded.id, account.id);
    assert.equal(reloaded.email, RENAMED, 'the display label survived the reload');
    assert.equal(reloaded.identityEmail, EMAIL);
    assert.equal(reloaded.credentialEmail, EMAIL);

    reloaded.status = 'error';
    reloaded.errorCount = 2;
    let loginEmail;
    __setReloginDeps({
      isCredStoreEnabled,
      getCredential,
      windsurfLogin: async (email) => {
        loginEmail = email;
        return {
          apiKey: 'devin-session-token$REFRESHED',
          identityEmail: EMAIL,
          refreshToken: 'lifecycle-refresh-token',
        };
      },
    });

    const fresh = await reLoginAccount(reloaded.id, { force: true });
    assert.equal(fresh, 'devin-session-token$REFRESHED');
    assert.equal(loginEmail, EMAIL, 're-login must use the verified identity, not the renamed label');
    assert.equal(reloaded.email, RENAMED, 're-login must not rewrite the display label');
    assert.equal(reloaded.identityEmail, EMAIL);
    assert.equal(reloaded.credentialEmail, EMAIL);
    assert.equal(reloaded.status, 'active');

    // Deletion removes only the record this row is bound to.
    const other = track(addAccountByKey('devin-session-token$OTHER', OTHER));
    assert.equal(storeCredential(OTHER, 'other-throwaway-pw'), true);
    setAccountCredentialEmail(other.id, OTHER);
    assert.deepEqual(listCredentialEmails().sort(), [EMAIL, OTHER].sort());

    assert.equal(removeAccount(reloaded.id), true);
    created.delete(reloaded.id);
    assert.deepEqual(listCredentialEmails(), [OTHER], 'only the bound record was removed');
  });
});

describe('legacy credential ownership', () => {
  const priorKey = 'devin-session-token$IMPORTPRIOR';
  const freshKey = 'devin-session-token$IMPORTFRESH';

  for (const verifiedFirst of [false, true]) {
    it(`reuses a renamed legacy binding with verified row first=${verifiedFirst}`, async () => {
      const addVerified = () => {
        const account = track(addAccountByKey(priorKey, RENAMED));
        setAccountCredentialEmail(account.id, ` ${EMAIL.toUpperCase()} `);
        return account;
      };
      const addOtherRows = () => {
        track(addAccountByKey('devin-session-token$IMPORTDISPLAY', EMAIL));
        const other = track(addAccountByKey('devin-session-token$IMPORTOTHER', EMAIL));
        setAccountCredentialEmail(other.id, OTHER);
        return other;
      };
      let verified;
      let other;
      if (verifiedFirst) {
        verified = addVerified();
        other = addOtherRows();
      } else {
        other = addOtherRows();
        verified = addVerified();
      }
      assert.equal(getAccountList().find(row => row.id === verified.id)?.loginEmail, EMAIL);
      __setEmailImportDeps({ windsurfLogin: async () => ({ apiKey: freshKey, email: EMAIL }) });

      const imported = track(await addAccountByEmail(EMAIL, PASSWORD));

      assert.equal(imported.id, verified.id);
      assert.equal(verified.apiKey, freshKey);
      assert.equal(verified.identityEmail, EMAIL);
      assert.equal(other.credentialEmail, OTHER);
    });
  }

  it('adds a new account when the only match is an editable label', async () => {
    const historical = track(addAccountByKey(priorKey, EMAIL));
    __setEmailImportDeps({ windsurfLogin: async () => ({ apiKey: freshKey, email: EMAIL }) });

    const imported = track(await addAccountByEmail(EMAIL, PASSWORD));

    assert.notEqual(imported.id, historical.id);
    assert.equal(imported.apiKey, freshKey);
    assert.equal(historical.apiKey, priorKey);
  });

  it('establishes identity on a historical row when the provable key matches', async () => {
    const historical = track(addAccountByKey(priorKey, RENAMED));
    __setEmailImportDeps({ windsurfLogin: async () => ({ apiKey: priorKey, email: EMAIL }) });

    const imported = track(await addAccountByEmail(EMAIL, PASSWORD));

    assert.equal(imported.id, historical.id);
    assert.equal(historical.identityEmail, EMAIL);
  });

  for (const [description, key] of [['rotates', freshKey], ['reproves', priorKey]]) {
    it(`returns a verified row to rotation when re-enrollment ${description} its key`, async () => {
      const account = track(addAccountByKey(priorKey, RENAMED));
      setAccountIdentityEmail(account.id, EMAIL);
      assert.equal(markNeedsReauth(account.id), true);
      assert.equal(getAccountList({ status: 'active' }).some(row => row.id === account.id), false);
      __setEmailImportDeps({ windsurfLogin: async () => ({ apiKey: key, email: EMAIL }) });

      const imported = track(await addAccountByEmail(EMAIL, PASSWORD));

      assert.equal(imported.id, account.id);
      assert.equal(imported.apiKey, key);
      assert.equal(imported.status, 'active');
      assert.equal(imported.reauth, undefined);
      assert.equal(getAccountList({ status: 'active' }).some(row => row.id === account.id), true);
      const persisted = diskRows().find(row => row.id === account.id);
      assert.equal(persisted.status, 'active');
      assert.equal(persisted.reauth, undefined);
    });
  }

  for (const status of ['disabled', 'banned']) {
    it(`preserves the ${status} state on verified legacy re-enrollment`, async () => {
      const account = track(addAccountByKey(priorKey, RENAMED));
      setAccountIdentityEmail(account.id, EMAIL);
      setAccountStatus(account.id, status);
      __setEmailImportDeps({ windsurfLogin: async () => ({ apiKey: freshKey, email: EMAIL }) });

      const imported = track(await addAccountByEmail(EMAIL, PASSWORD));

      assert.equal(imported.id, account.id);
      assert.equal(imported.status, status);
      assert.equal(getAccountList({ status: 'active' }).some(row => row.id === account.id), false);
    });
  }

  it('retains a shared credential until the last verified row is removed', () => {
    const first = track(addAccountByKey(priorKey, RENAMED));
    const last = track(addAccountByKey(freshKey, RENAMED));
    setAccountCredentialEmail(first.id, ` ${EMAIL.toUpperCase()} `);
    setAccountIdentityEmail(last.id, EMAIL);
    assert.equal(storeCredential(EMAIL, PASSWORD), true);

    assert.equal(removeAccount(first.id), true);
    assert.deepEqual(listCredentialEmails(), [EMAIL]);
    assert.equal(removeAccount(last.id), true);
    assert.deepEqual(listCredentialEmails(), []);
  });
});

describe('identity without password retention', () => {
  it('persists the identity of a storeCredential:false password login', async () => {
    __setLoginTransportForTests(makeTransport([CONN_PASSWORD, PASSWORD_OK, postauthOk('devin-session-token$NOSTORE')]));

    const r = await post('/windsurf-login', {
      email: EMAIL_NO_STORE,
      password: PASSWORD,
      storeCredential: false,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Object.hasOwn(r.body, 'credentialStored'), false, 'not asked means no field');

    const account = track(rowFor(EMAIL_NO_STORE));
    assert.equal(account.identityEmail, EMAIL_NO_STORE, 'identity is independent of password retention');
    assert.equal(account.credentialEmail || '', '', 'no password was retained');
    assert.deepEqual(listCredentialEmails(), [], 'the store stayed untouched');
    assert.equal(diskRows().find((row) => row.identityEmail === EMAIL_NO_STORE)?.identityEmail, EMAIL_NO_STORE);

    // The persisted identity is enough to bind a later re-auth login, even
    // though no password exists to auto-relogin with.
    account.status = 'reauth';
    __setLoginTransportForTests(makeTransport([CONN_PASSWORD, PASSWORD_OK, postauthOk('devin-session-token$BOUND')]));
    const bound = await post('/windsurf-login', {
      email: EMAIL_NO_STORE,
      password: PASSWORD,
      accountId: account.id,
    });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.equal(account.apiKey, 'devin-session-token$BOUND');
    assert.equal(account.status, 'active');
    assert.equal(account.identityEmail, EMAIL_NO_STORE);
  });

  it('persists the identity of an email-code login that has no password', async () => {
    __setLoginTransportForTests(makeTransport([START_OK, COMPLETE_OK, postauthOk('devin-session-token$EMAILCODE')]));

    const started = await emailLoginStart(EMAIL_CODE, null, { host: 'windsurf' });
    assert.equal(typeof started.flowId, 'string');
    const r = await post('/windsurf-login/email/complete', {
      flowId: started.flowId,
      code: CODE,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const account = track(rowFor(EMAIL_CODE));
    assert.equal(account.identityEmail, EMAIL_CODE, 'an email-code login proves identity without a password');
    assert.equal(account.credentialEmail || '', '');
    assert.deepEqual(listCredentialEmails(), []);
    assert.equal(diskRows().find((row) => row.identityEmail === EMAIL_CODE)?.identityEmail, EMAIL_CODE);
  });
});
