// V-24 (audit A23): a bound login (`accountId`) replaced the selected account's
// token after checking only that a token EXISTED. Nothing compared the identity
// that just authenticated upstream with the identity the account row belongs to,
// so a login for person B silently installed B's session token on person A's
// row (and cleared A's error/ban state on the way).
//
// The rule under test: the expected identity is bound before the credential is
// spent (email flow state / the bound account row) and a mismatch is rejected
// before any token or status mutation. Every fixture below is a throwaway
// literal; the transport seam keeps this offline.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  addAccountByKey, captureAccountCredential, getAccountInternal, isCurrentAccountCredential, removeAccount,
  setAccountCredentialEmail, setAccountIdentityEmail, setAccountStatus, setAccountTokens, updateAccountLabel,
} from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import {
  __setLoginTransportForTests,
  _resetEmailFlowsForTests,
  _resetEmailLockoutForTests,
  _resetProbeHostForTests,
  emailLoginStart,
} from '../src/dashboard/windsurf-login.js';

const OWNER_EMAIL = 'identity-owner@example.test';
const OTHER_EMAIL = 'identity-other@example.test';
const OWNER_KEY = 'devin-session-token$IDENTITYOWNER';
const OTHER_KEY = 'devin-session-token$IDENTITYOTHER';
const PASSWORD = ['throwaway', 'identity', 'password'].join('-');
const AUTH1 = 'auth1_identity_throwaway';
const VERIFY = 'identity-verify-token-throwaway';
const CODE = '314159';

const originalDashboardPassword = config.dashboardPassword;
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

function authedReq() {
  return {
    url: '/dashboard/api/windsurf-login',
    headers: { 'x-dashboard-password': 'identity-dash-secret' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function makeTransport(routes) {
  const seen = [];
  const fn = async (url, opts, postData) => {
    seen.push({ url, body: postData ? String(postData) : '' });
    for (const [matcher, reply] of routes) {
      if (url.includes(matcher)) {
        if (reply instanceof Error) throw reply;
        // PostAuth is fetched with `raw: true` and decoded from bytes; the
        // fixture supplies an object, so serialise it exactly as the real
        // transport would deliver a JSON body.
        const data = opts?.raw
          ? (Buffer.isBuffer(reply.data) ? reply.data : Buffer.from(JSON.stringify(reply.data)))
          : reply.data;
        return { status: reply.status, data };
      }
    }
    throw new Error(`unexpected request to ${url}`);
  };
  fn.seen = seen;
  return fn;
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
  return ['WindsurfPostAuth', { status: 200, data: { sessionToken, accountId: 'account-identity' } }];
}

function seedOwner() {
  const account = addAccountByKey(OWNER_KEY, OWNER_EMAIL);
  // The row's stable identity is the address a login proved. The display email
  // is only a label and must not be the expected identity for a bound login.
  setAccountIdentityEmail(account.id, OWNER_EMAIL);
  created.add(account.id);
  return account;
}

// A `reauth` row is the real-world shape of this route: the token is known dead
// and a login is the only thing that may revive it. That makes both halves of
// "no mutation" observable — the key AND the status.
function seedReauthOwner() {
  const account = seedOwner();
  setAccountStatus(account.id, 'reauth');
  return account;
}

async function post(subpath, body) {
  const res = fakeRes();
  const req = authedReq();
  req.url = '/dashboard/api' + subpath;
  await handleDashboardApi('POST', subpath, body, req, res);
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => {
  _resetEmailFlowsForTests();
  _resetEmailLockoutForTests();
  _resetProbeHostForTests();
  config.dashboardPassword = 'identity-dash-secret';
});

afterEach(() => {
  __setLoginTransportForTests(null);
  _resetEmailFlowsForTests();
  _resetEmailLockoutForTests();
  _resetProbeHostForTests();
  config.dashboardPassword = originalDashboardPassword;
  for (const id of created) { try { removeAccount(id); } catch { /* already gone */ } }
  created.clear();
});

describe('bound login identity (password flow)', () => {
  it('a token belonging to a different upstream identity is rejected before account token mutation', async () => {
    const owner = seedReauthOwner();
    assert.equal(owner.apiKey, OWNER_KEY);
    __setLoginTransportForTests(makeTransport([CONN_PASSWORD, PASSWORD_OK, postauthOk(OTHER_KEY)]));

    const r = await post('/windsurf-login', {
      email: OTHER_EMAIL,
      password: PASSWORD,
      accountId: owner.id,
    });

    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'ERR_LOGIN_IDENTITY_MISMATCH');
    const after = getAccountInternal(owner.id);
    assert.equal(after.apiKey, OWNER_KEY, 'the other identity’s token must not replace this account’s key');
    assert.equal(after.status, 'reauth', 'a rejected login must not revive the account');
    // The diagnostic must not echo the addresses it is comparing.
    assert.doesNotMatch(JSON.stringify(r.body), /identity-(owner|other)@example\.test/);
  });

  it('a login for the bound identity still installs the fresh token', async () => {
    const owner = seedReauthOwner();
    const fresh = 'devin-session-token$IDENTITYFRESH';
    __setLoginTransportForTests(makeTransport([CONN_PASSWORD, PASSWORD_OK, postauthOk(fresh)]));

    const r = await post('/windsurf-login', {
      email: OWNER_EMAIL.toUpperCase(),
      password: PASSWORD,
      accountId: owner.id,
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reauthenticated, true);
    const after = getAccountInternal(owner.id);
    assert.equal(after.apiKey, fresh, 'case differences are not an identity difference');
    assert.equal(after.status, 'active');
  });
});

describe('bound login identity — unverified and legacy rows', () => {
  it('refuses to bind a row that has no verified identity', async () => {
    const account = addAccountByKey('devin-session-token$UNVERIFIED', OWNER_EMAIL);
    created.add(account.id);
    setAccountStatus(account.id, 'reauth');
    __setLoginTransportForTests(makeTransport([CONN_PASSWORD, PASSWORD_OK, postauthOk('devin-session-token$TAKEOVER')]));

    const r = await post('/windsurf-login', {
      email: OWNER_EMAIL,
      password: PASSWORD,
      accountId: account.id,
    });

    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'ERR_ACCOUNT_IDENTITY_UNVERIFIED');
    const after = getAccountInternal(account.id);
    assert.equal(after.apiKey, 'devin-session-token$UNVERIFIED', 'no token mutation without a verified expectation');
    assert.equal(after.status, 'reauth', 'no health mutation without a verified expectation');
    assert.equal(after.identityEmail || '', '', 'a refused bind must not invent an identity');
  });

  it('lets a legacy credentialEmail binding verify the row and persists the identity', async () => {
    const account = addAccountByKey('devin-session-token$LEGACY', OWNER_EMAIL);
    created.add(account.id);
    setAccountCredentialEmail(account.id, OWNER_EMAIL);
    setAccountStatus(account.id, 'reauth');
    const fresh = 'devin-session-token$LEGACYFRESH';
    __setLoginTransportForTests(makeTransport([CONN_PASSWORD, PASSWORD_OK, postauthOk(fresh)]));

    const r = await post('/windsurf-login', {
      email: OWNER_EMAIL,
      password: PASSWORD,
      accountId: account.id,
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = getAccountInternal(account.id);
    assert.equal(after.apiKey, fresh);
    assert.equal(after.identityEmail, OWNER_EMAIL, 'the successful login promotes the store binding to a verified identity');
    assert.equal(after.status, 'active');
  });

  it('refuses an email-code bind for an unverified row before the code is spent', async () => {
    const account = addAccountByKey('devin-session-token$EMAILUNVERIFIED', OWNER_EMAIL);
    created.add(account.id);
    setAccountStatus(account.id, 'reauth');
    __setLoginTransportForTests(makeTransport([START_OK, COMPLETE_OK, postauthOk('devin-session-token$EMAILTAKEOVER')]));

    const started = await emailLoginStart(OWNER_EMAIL, null, { host: 'windsurf' });
    const first = await post('/windsurf-login/email/complete', {
      flowId: started.flowId,
      code: CODE,
      accountId: account.id,
    });
    assert.equal(first.status, 409, JSON.stringify(first.body));
    assert.equal(first.body.error, 'ERR_ACCOUNT_IDENTITY_UNVERIFIED');

    // The early refusal did not consume the flow: a second call reports the same
    // binding error, not ERR_EMAIL_FLOW_USED.
    const second = await post('/windsurf-login/email/complete', {
      flowId: started.flowId,
      code: CODE,
      accountId: account.id,
    });
    assert.equal(second.body.error, 'ERR_ACCOUNT_IDENTITY_UNVERIFIED', JSON.stringify(second.body));
    const after = getAccountInternal(account.id);
    assert.equal(after.apiKey, 'devin-session-token$EMAILUNVERIFIED');
    assert.equal(after.status, 'reauth');
  });
});

describe('bound login identity (email-code flow)', () => {
  it('refuses a missing bound row before using the code flow', async () => {
    const transport = makeTransport([START_OK, COMPLETE_OK, postauthOk(OWNER_KEY)]);
    __setLoginTransportForTests(transport);
    const started = await emailLoginStart(OWNER_EMAIL, null, { host: 'windsurf' });

    const result = await post('/windsurf-login/email/complete', {
      flowId: started.flowId, code: CODE, accountId: 'missing-row',
    });

    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'ERR_ACCOUNT_NOT_FOUND');
    assert.equal(transport.seen.length, 1, 'only the code request reached the fake provider');
  });

  it('rejects a code flow started for another address before the code is spent', async () => {
    const owner = seedReauthOwner();
    __setLoginTransportForTests(makeTransport([START_OK, COMPLETE_OK, postauthOk(OTHER_KEY)]));

    const started = await emailLoginStart(OTHER_EMAIL, null, { host: 'windsurf' });
    assert.equal(typeof started.flowId, 'string');

    const first = await post('/windsurf-login/email/complete', {
      flowId: started.flowId,
      code: CODE,
      accountId: owner.id,
    });

    assert.equal(first.status, 409, JSON.stringify(first.body));
    assert.equal(first.body.error, 'ERR_LOGIN_IDENTITY_MISMATCH');
    assert.equal(getAccountInternal(owner.id).apiKey, OWNER_KEY, 'no token mutation on a rejected identity');
    assert.equal(getAccountInternal(owner.id).status, 'reauth', 'no status mutation on a rejected identity');

    // The rejection must happen BEFORE the upstream exchange: the code is
    // single-use, so a check that ran after it would leave the flow consumed
    // (ERR_EMAIL_FLOW_USED) and the operator needing a new email.
    const second = await post('/windsurf-login/email/complete', {
      flowId: started.flowId,
      code: CODE,
      accountId: owner.id,
    });
    assert.equal(second.body.error, 'ERR_LOGIN_IDENTITY_MISMATCH', JSON.stringify(second.body));
  });

  it('accepts the flow for the bound identity and installs the session token', async () => {
    const owner = seedOwner();
    const fresh = 'devin-session-token$IDENTITYEMAILFRESH';
    __setLoginTransportForTests(makeTransport([START_OK, COMPLETE_OK, postauthOk(fresh)]));

    const started = await emailLoginStart(OWNER_EMAIL, null, { host: 'windsurf' });
    const r = await post('/windsurf-login/email/complete', {
      flowId: started.flowId,
      code: CODE,
      accountId: owner.id,
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(getAccountInternal(owner.id).apiKey, fresh);
  });
});

describe('credential revision during relogin', () => {
  it('ignores display edits and detects rotation back to the same key', () => {
    const owner = seedOwner();
    const original = captureAccountCredential(owner);

    updateAccountLabel(owner.id, 'Renamed fixture');
    assert.equal(isCurrentAccountCredential(original), true);

    setAccountTokens(owner.id, { apiKey: OTHER_KEY });
    setAccountTokens(owner.id, { apiKey: OWNER_KEY });
    assert.equal(isCurrentAccountCredential(original), false);
  });

  for (const method of ['password', 'email code']) {
    it(`discards a stale ${method} result after the credential revision changes`, async () => {
      const owner = seedReauthOwner();
      const refreshed = 'devin-session-token$IDENTITYREFRESHED';
      const transport = makeTransport([
        CONN_PASSWORD, PASSWORD_OK, START_OK, COMPLETE_OK, postauthOk(OWNER_KEY),
      ]);
      __setLoginTransportForTests(async (url, ...args) => {
        const result = await transport(url, ...args);
        if (url.includes('WindsurfPostAuth')) setAccountTokens(owner.id, { apiKey: refreshed });
        return result;
      });

      let result;
      if (method === 'password') {
        result = await post('/windsurf-login', {
          email: OWNER_EMAIL, password: PASSWORD, accountId: owner.id, storeCredential: true,
        });
      } else {
        const started = await emailLoginStart(OWNER_EMAIL, null, { host: 'windsurf' });
        result = await post('/windsurf-login/email/complete', {
          flowId: started.flowId, code: CODE, accountId: owner.id,
        });
      }

      assert.equal(result.status, 409);
      assert.equal(result.body.error, 'ERR_REAUTH_ACCOUNT_CHANGED');
      assert.equal(owner.apiKey, refreshed);
      assert.equal(owner.status, 'reauth');
      assert.equal(owner.credentialEmail || '', '');
    });
  }
});
