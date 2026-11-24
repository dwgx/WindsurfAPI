// SessionReauth Phase 2 — the dashboard routes that take an account OUT of the
// `reauth` state, and the ones that refuse to fake it.
//
// The contract these pin:
//   - a bound login/paste REPLACES the account's token (same id, no new row);
//   - `{action:'probe'}` is the free escape hatch and only a live probe clears;
//   - `PATCH {status:'active'}` without a replaced token is a 409 (I2);
//   - no route ever returns the raw session token.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  __resetReauthChecks,
  __setReloginDeps,
  addAccountByKey,
  configureBindHost,
  getAccountCount,
  getAccountInternal,
  markNeedsReauth,
  removeAccount,
  setAccountIdentityEmail,
} from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import {
  __setLoginTransportForTests,
  _resetEmailFlowsForTests,
  _resetEmailLockoutForTests,
} from '../src/dashboard/windsurf-login.js';

const PASSWORD_HEADER = { 'x-dashboard-password': 'dash-secret' };
const EMAIL = 'reauth-route@example.test';
const CODE = '246810';
const VERIFY_TOKEN = 'reauth-route-verify-token';
const FRESH_TOKEN = 'devin-session-token$REAUTHROUTEFRESH';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const created = new Set();
let seq = 0;

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function req(headers = PASSWORD_HEADER) {
  return { url: '/dashboard/api/accounts', headers, socket: { remoteAddress: '127.0.0.1' } };
}

async function call(method, subpath, body) {
  const res = fakeRes();
  await handleDashboardApi(method, subpath, body, req(), res);
  return { status: res.statusCode, body: res.json() };
}

function newAccount(label = 'acct', patch = {}) {
  const account = addAccountByKey(`devin-session-token$route-${label}-${++seq}-${Date.now()}`, label);
  Object.assign(account, patch);
  created.add(account.id);
  return account;
}

function benched(label = 'bench') {
  const account = newAccount(label);
  markNeedsReauth(account.id, { source: 'request', code: 'UNAUTHORIZED' });
  return account;
}

function makeTransport(routes) {
  const seen = [];
  const fn = async (url, opts) => {
    seen.push(url);
    for (const [matcher, reply] of routes) {
      if (url.includes(matcher)) {
        if (opts.raw) {
          const buf = Buffer.isBuffer(reply.data) ? reply.data : Buffer.from(JSON.stringify(reply.data));
          return { status: reply.status, data: buf };
        }
        return { status: reply.status, data: reply.data };
      }
    }
    throw new Error(`unexpected request to ${url}`);
  };
  fn.seen = seen;
  return fn;
}

const CONNECTIONS_OAUTH_ONLY = ['windsurf.com/_devin-auth/connections', {
  status: 200,
  data: {
    connections: [{ id: 'email', type: 'email', enabled: true }],
    auth_method: { method: 'auth1', has_password: false },
  },
}];
const EMAIL_START_OK = ['windsurf.com/_devin-auth/email/start', {
  status: 200, data: { email_verification_token: VERIFY_TOKEN },
}];
const EMAIL_COMPLETE_OK = ['windsurf.com/_devin-auth/email/complete', {
  status: 200, data: { token: 'auth1-reauth-route-throwaway' },
}];
const POSTAUTH_OK = ['WindsurfPostAuth', {
  status: 200, data: { sessionToken: FRESH_TOKEN, accountId: 'account-reauth-route' },
}];

beforeEach(() => {
  _resetRuntimeConfigForTests();
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  __resetReauthChecks();
  config.dashboardPassword = 'dash-secret';
  config.apiKey = '';
  configureBindHost('0.0.0.0');
});

afterEach(() => {
  __setLoginTransportForTests(null);
  __setReloginDeps(null);
  __resetReauthChecks();
  for (const id of created) removeAccount(id);
  created.clear();
  _resetEmailFlowsForTests();
  _resetEmailLockoutForTests();
  _resetRuntimeConfigForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
});

describe('POST /accounts/:id/reauth {action:"token"}', () => {
  it('binds to the SAME account, adds no row, clears reauth and masks the key', async () => {
    const account = benched('token-bind');
    const before = getAccountCount().total;

    const { status, body } = await call('POST', `/accounts/${account.id}/reauth`, {
      action: 'token', token: FRESH_TOKEN,
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.reauthenticated, true);
    assert.equal(body.account.id, account.id, 'the row is replaced, not duplicated');
    assert.equal(getAccountCount().total, before, 'no new account row');
    const live = getAccountInternal(account.id);
    assert.equal(live.status, 'active');
    assert.equal(live.apiKey, FRESH_TOKEN);
    assert.equal(live.reauth, undefined);
    assert.equal('apiKey' in body, false, 'the raw key is never returned');
    assert.match(body.apiKey_masked, /\.\.\./);
    assert.equal(JSON.stringify(body).includes(FRESH_TOKEN), false);
  });

  it('accepts a show-auth-token URL, not just the bare token', async () => {
    const account = benched('token-url');
    const { status, body } = await call('POST', `/accounts/${account.id}/reauth`, {
      action: 'token',
      token: `https://windsurf.com/editor/show-auth-token#access_token=${FRESH_TOKEN}&state=x`,
    });
    assert.equal(status, 200);
    assert.equal(body.reauthenticated, true);
    assert.equal(getAccountInternal(account.id).apiKey, FRESH_TOKEN);
  });

  it('refuses to "re-authenticate" with the SAME retired key', async () => {
    const account = benched('same-key-paste');
    const deadKey = getAccountInternal(account.id).apiKey;
    for (const [route, body] of [
      [`/accounts/${account.id}/reauth`, { action: 'token', token: deadKey }],
      ['/accounts', { token: deadKey, accountId: account.id }],
      ['/windsurf-login/token', { token: deadKey, accountId: account.id }],
    ]) {
      const { status, body: res } = await call('POST', route, body);
      assert.equal(status, 409, `${route} must refuse the unchanged key`);
      assert.equal(res.error, 'ERR_REAUTH_TOKEN_UNCHANGED');
      const live = getAccountInternal(account.id);
      assert.equal(live.status, 'reauth', `${route} must not clear the state`);
      assert.ok(live.reauth, `${route} must keep the evidence`);
      assert.equal(live.apiKey, deadKey);
    }
  });

  it('404s an unknown id', async () => {
    const { status, body } = await call('POST', '/accounts/nope/reauth', { action: 'token', token: FRESH_TOKEN });
    assert.equal(status, 404);
    assert.equal(body.error, 'ERR_ACCOUNT_NOT_FOUND');
  });

  it('409s a disabled account (operator intent outranks a token install)', async () => {
    const account = newAccount('disabled', { status: 'disabled' });
    const { status, body } = await call('POST', `/accounts/${account.id}/reauth`, {
      action: 'token', token: FRESH_TOKEN,
    });
    assert.equal(status, 409);
    assert.equal(body.error, 'ERR_REAUTH_NOT_APPLICABLE');
    assert.equal(getAccountInternal(account.id).apiKey, account.apiKey);
  });

  it('rejects an auth1 intermediate and a non-session token', async () => {
    const account = benched('bad-token');
    const auth1 = await call('POST', `/accounts/${account.id}/reauth`, {
      action: 'token', token: 'auth1_this_is_' + 'an_intermediate_ticket_value',
    });
    assert.equal(auth1.status, 400);
    assert.equal(auth1.body.error, 'ERR_AUTH1_NOT_A_POOL_KEY');

    const junk = await call('POST', `/accounts/${account.id}/reauth`, { action: 'token', token: 'not-a-token' });
    assert.equal(junk.status, 400);
    assert.equal(junk.body.error, 'ERR_REAUTH_TOKEN_INVALID');
    assert.equal(getAccountInternal(account.id).status, 'reauth', 'a rejected paste must not change the state');
  });

  it('rejects an unknown action', async () => {
    const account = benched('action');
    const { status, body } = await call('POST', `/accounts/${account.id}/reauth`, { action: 'delete-everything' });
    assert.equal(status, 400);
    assert.equal(body.error, 'ERR_REAUTH_ACTION_INVALID');
  });

  it('classifies recovery failures without replacing the credential or echoing callback data', async () => {
    const account = benched('recovery-stage');
    const previous = getAccountInternal(account.id).apiKey;
    const inputs = [
      ['https://app.devin.ai/', 'ERR_REAUTH_DEVIN_PORTAL_URL'],
      ['https://devin.ai/', 'ERR_REAUTH_DEVIN_PORTAL_URL'],
      ['cog_fixture_public_api', 'ERR_REAUTH_DEVIN_API_CREDENTIAL'],
      ['https://example.invalid/auth/callback?error=invalid_redirect_uri&state=fixture-hidden', 'ERR_REAUTH_REDIRECT_REJECTED'],
      ['https://example.invalid/auth/callback?error=access_denied&error_description=fixture-hidden', 'ERR_REAUTH_CALLBACK_FAILED'],
      ['devin-session-token$', 'ERR_REAUTH_TOKEN_INVALID'],
    ];
    for (const [token, expected] of inputs) {
      const { status, body } = await call('POST', '/accounts', { token, accountId: account.id });
      assert.equal(status, 400);
      assert.equal(body.error, expected);
      assert.doesNotMatch(JSON.stringify(body), /fixture-hidden/);
      const current = getAccountInternal(account.id);
      assert.equal(current.status, 'reauth');
      assert.equal(current.apiKey, previous);
    }
  });
});

describe('POST /accounts/:id/reauth {action:"probe"}', () => {
  it('clears the state when the token answers upstream', async () => {
    const account = benched('probe-alive');
    __setReloginDeps({ checkSessionLiveness: async () => ({ alive: true }) });
    const { status, body } = await call('POST', `/accounts/${account.id}/reauth`, { action: 'probe' });
    assert.equal(status, 200);
    assert.equal(body.checked, true);
    assert.equal(body.alive, true);
    assert.equal(getAccountInternal(account.id).status, 'active');
  });

  it('keeps the state when the probe still says UNAUTHORIZED', async () => {
    const account = benched('probe-dead');
    __setReloginDeps({ checkSessionLiveness: async () => ({ alive: false, code: 'UNAUTHORIZED' }) });
    const { status, body } = await call('POST', `/accounts/${account.id}/reauth`, { action: 'probe' });
    assert.equal(status, 200);
    assert.equal(body.alive, false);
    assert.equal(getAccountInternal(account.id).status, 'reauth');
  });

  it('a transient probe verdict leaves the state alone', async () => {
    const account = benched('probe-transient');
    __setReloginDeps({ checkSessionLiveness: async () => ({ alive: false, code: 'CAPACITY' }) });
    const { body } = await call('POST', `/accounts/${account.id}/reauth`, { action: 'probe' });
    assert.equal(body.checked, true);
    assert.equal(body.marked, false);
    assert.equal(getAccountInternal(account.id).status, 'reauth');
  });

  it('404s an unknown id and 409s a disabled one', async () => {
    const missing = await call('POST', '/accounts/nope/reauth', { action: 'probe' });
    assert.equal(missing.status, 404);
    const disabled = newAccount('probe-disabled', { status: 'disabled' });
    const r = await call('POST', `/accounts/${disabled.id}/reauth`, { action: 'probe' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ERR_REAUTH_NOT_APPLICABLE');
  });
});

describe('bound add/re-login paths', () => {
  it('POST /accounts {token, accountId} replaces instead of adding', async () => {
    const account = benched('paste-bind');
    const before = getAccountCount().total;
    const { status, body } = await call('POST', '/accounts', { token: FRESH_TOKEN, accountId: account.id });
    assert.equal(status, 200);
    assert.equal(body.reauthenticated, true);
    assert.equal(body.account.id, account.id);
    assert.equal(getAccountCount().total, before);
    assert.equal(getAccountInternal(account.id).status, 'active');
  });

  it('POST /windsurf-login/token {accountId} replaces instead of adding', async () => {
    const account = benched('token-login-bind');
    const before = getAccountCount().total;
    const { status, body } = await call('POST', '/windsurf-login/token', { token: FRESH_TOKEN, accountId: account.id });
    assert.equal(status, 200);
    assert.equal(body.reauthenticated, true);
    assert.equal(body.method, 'token');
    assert.equal(body.account.id, account.id);
    assert.equal(getAccountCount().total, before);
    assert.equal(getAccountInternal(account.id).apiKey, FRESH_TOKEN);
  });

  it('email/complete {accountId} re-authenticates the same row', async () => {
    const account = benched('email-bind');
    account.email = EMAIL;
    setAccountIdentityEmail(account.id, EMAIL);
    const before = getAccountCount().total;
    __setLoginTransportForTests(makeTransport([CONNECTIONS_OAUTH_ONLY, EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]));

    const start = await call('POST', '/windsurf-login/email/start', { email: EMAIL });
    assert.equal(start.status, 200);
    const { status, body } = await call('POST', '/windsurf-login/email/complete', {
      flowId: start.body.flowId, code: CODE, accountId: account.id,
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.reauthenticated, true);
    assert.equal(body.account.id, account.id);
    assert.equal(body.account.status, 'active');
    assert.equal(getAccountCount().total, before, 'a bound login must not add a duplicate row');
    assert.equal(getAccountInternal(account.id).apiKey, FRESH_TOKEN);
    assert.equal(getAccountInternal(account.id).status, 'active');
    assert.equal('apiKey' in body, false, 'a bound re-auth never echoes the raw key');
  });

  it('email/complete {accountId} refuses a banned account (409) and changes nothing', async () => {
    const account = benched('email-banned');
    account.email = EMAIL;
    setAccountIdentityEmail(account.id, EMAIL);
    account.status = 'banned';
    account.bannedAt = Date.now();
    account.bannedReason = 'account suspended';
    const deadKey = account.apiKey;
    __setLoginTransportForTests(makeTransport([CONNECTIONS_OAUTH_ONLY, EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]));

    const start = await call('POST', '/windsurf-login/email/start', { email: EMAIL });
    const { status, body } = await call('POST', '/windsurf-login/email/complete', {
      flowId: start.body.flowId, code: CODE, accountId: account.id,
    });

    assert.equal(status, 409);
    assert.equal(body.error, 'ERR_REAUTH_NOT_APPLICABLE');
    const live = getAccountInternal(account.id);
    assert.equal(live.status, 'banned', 'a login must not un-ban an account');
    assert.equal(live.apiKey, deadKey, 'the refused token must not be installed');
    assert.equal(live.bannedReason, 'account suspended', 'the ban evidence survives the refusal');
  });

  it('email/complete {accountId} 404s an unknown account and adds nothing', async () => {
    const before = getAccountCount().total;
    __setLoginTransportForTests(makeTransport([CONNECTIONS_OAUTH_ONLY, EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]));
    const start = await call('POST', '/windsurf-login/email/start', { email: EMAIL });
    const { status, body } = await call('POST', '/windsurf-login/email/complete', {
      flowId: start.body.flowId, code: CODE, accountId: 'does-not-exist',
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'ERR_ACCOUNT_NOT_FOUND');
    assert.equal(getAccountCount().total, before);
  });
});

describe('PATCH cannot put a retired key back in rotation (I2)', () => {
  it('409s reauth → active without force, then accepts force', async () => {
    const account = benched('patch');
    const refused = await call('PATCH', `/accounts/${account.id}`, { status: 'active' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'ERR_REAUTH_TOKEN_UNCHANGED');
    assert.equal(getAccountInternal(account.id).status, 'reauth');

    const forced = await call('PATCH', `/accounts/${account.id}`, { status: 'active', force: true });
    assert.equal(forced.status, 200);
    assert.equal(getAccountInternal(account.id).status, 'active');
    assert.equal(getAccountInternal(account.id).reauth, undefined);
  });

  it('409s resetErrors on a reauth account', async () => {
    const account = benched('patch-reset');
    const r = await call('PATCH', `/accounts/${account.id}`, { resetErrors: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ERR_REAUTH_TOKEN_UNCHANGED');
  });

  it('still disables a reauth account', async () => {
    const account = benched('patch-disable');
    const r = await call('PATCH', `/accounts/${account.id}`, { status: 'disabled' });
    assert.equal(r.status, 200);
    assert.equal(getAccountInternal(account.id).status, 'disabled');
  });

  it('batch enable reports the refusal per item instead of hiding it', async () => {
    const account = benched('batch');
    const { status, body } = await call('POST', '/accounts/batch', { op: 'enable', ids: [account.id] });
    assert.equal(status, 200);
    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0].error, 'ERR_REAUTH_TOKEN_UNCHANGED');
    assert.equal(getAccountInternal(account.id).status, 'reauth');
  });
});

describe('PATCH status allowlist (only the three operator statuses)', () => {
  // `banned` and `reauth` are evidence-gated: they enter through the ban detector
  // and the UNAUTHORIZED probe, never through a hand-written string. A typo used to
  // be persisted verbatim, and resolveAccountState maps unknown statuses to 'active'
  // while selection filters on `status === 'active'` — an invisible, unroutable
  // account that survives restart.
  it('400s every status outside active/disabled/error and persists nothing', async () => {
    const account = newAccount('status-garbage');
    assert.equal(getAccountInternal(account.id).status, 'active');
    for (const garbage of ['reauth', 'banned', 'garbage', 'ACTIVE', 'Active', '', null]) {
      const r = await call('PATCH', `/accounts/${account.id}`, { status: garbage });
      assert.equal(r.status, 400, `${JSON.stringify(garbage)} must be refused`);
      assert.equal(r.body.error, 'ERR_ACCOUNT_STATUS_INVALID');
      assert.equal(getAccountInternal(account.id).status, 'active',
        `${JSON.stringify(garbage)} must not be written to the account`);
    }
  });

  it('accepts the three operator statuses', async () => {
    const account = newAccount('status-allowed');
    for (const ok of ['disabled', 'error', 'active']) {
      const r = await call('PATCH', `/accounts/${account.id}`, { status: ok });
      assert.equal(r.status, 200, `${ok} must be accepted`);
      assert.equal(getAccountInternal(account.id).status, ok);
    }
  });

  it('rejects the whole PATCH: a garbage status does not let a label through', async () => {
    const account = newAccount('status-atomic');
    const originalLabel = getAccountInternal(account.id).email;
    const r = await call('PATCH', `/accounts/${account.id}`, { status: 'garbage', label: 'renamed' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ERR_ACCOUNT_STATUS_INVALID');
    assert.equal(getAccountInternal(account.id).email, originalLabel);
  });

  it('does not preempt the reauth refusal: active is allowlisted, the token is not', async () => {
    const account = benched('status-reauth');
    const r = await call('PATCH', `/accounts/${account.id}`, { status: 'active' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ERR_REAUTH_TOKEN_UNCHANGED');
    assert.equal(getAccountInternal(account.id).status, 'reauth');
  });
});

describe('pool-events surface', () => {
  it('reports the coarse state as reauth, not a self-healing cooldown', async () => {
    const account = benched('pool-event');
    // Even with a live cooldown, the terminal state must win — otherwise the
    // dashboard promises a recovery that never comes.
    account.rateLimitedUntil = Date.now() + 60_000;
    const { status, body } = await call('GET', '/pool-events', {});
    assert.equal(status, 200);
    const row = body.accounts.find((a) => a.id === account.id);
    assert.equal(row.status, 'reauth');
    assert.equal(row.state, 'reauth');
  });
});
