// Wave-3 login flows: password, email code, token import, Devin host.
//
// Everything here runs through the real handlers with the transport seam
// injected (`__setLoginTransportForTests`), so the assertions are about OUR
// decisions — which host was asked, which path ran, what reached the caller —
// not about a mocked function being called. No network, no email, no
// credential: every token/code below is a throwaway literal.
//
// The live measurements these fixtures replay (2026-10-22):
//   POST windsurf.com/_devin-auth/connections  → auth_method.has_password
//   POST app.devin.ai/api/auth1/connections    → identical shape
//   POST .../password/login (wrong method)     → 401 {"detail":"Invalid email or password"}
//   POST .../email/start                       → {"email_verification_token":…}
//   POST .../email/complete                    → {"token":"auth1_…"}

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config, log } from '../src/config.js';
import { removeAccount } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import {
  __setLoginTransportForTests,
  _resetEmailLockoutForTests,
  _resetEmailFlowsForTests,
  _resetProbeHostForTests,
  checkEmailLocked,
  emailLoginStart,
  emailLoginComplete,
  probeLoginMethod,
  windsurfLogin,
} from '../src/dashboard/windsurf-login.js';

const EMAIL = 'wave3-login@example.test';
const PASSWORD = 'throwaway-not-real';
const SESSION = 'devin-session-token$WAVE3SESSION';
const AUTH1 = 'auth1_wave3_throwaway';
const VERIFY = 'wave3-verify-token-throwaway';
const CODE = '424242';

const originalDashboardPassword = config.dashboardPassword;
const createdAccountIds = [];

function setFlag(on) {
  if (on) process.env.DEVIN_CONNECT_LOGIN_HOST_FALLBACK = '1';
  else delete process.env.DEVIN_CONNECT_LOGIN_HOST_FALLBACK;
}

function makeTransport(routes) {
  const seen = [];
  const fn = async (url, opts, postData) => {
    seen.push({ url, body: postData ? String(postData) : '' });
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
  fn.seen = seen;
  fn.calls = (needle) => seen.filter((s) => s.url.includes(needle));
  return fn;
}

const CONN_PASSWORD = ['windsurf.com/_devin-auth/connections', {
  status: 200,
  data: {
    connections: [{ id: 'email', type: 'email', enabled: true }],
    auth_method: { method: 'auth1', has_password: true, enterprise_sso_domain: false },
  },
}];
const CONN_EMAIL_CODE = ['windsurf.com/_devin-auth/connections', {
  status: 200,
  data: {
    connections: [
      { id: 'email', type: 'email', enabled: true },
      { id: 'google-windsurf', type: 'google', enabled: true },
    ],
    auth_method: { method: 'auth1', has_password: false, enterprise_sso_domain: false },
  },
}];
const CONN_DEVIN_EMAIL_CODE = ['app.devin.ai/api/auth1/connections', {
  status: 200,
  data: {
    connections: [{ id: 'email', type: 'email', enabled: true }],
    auth_method: { method: 'auth1', has_password: false, enterprise_sso_domain: false },
  },
}];
const PASSWORD_OK = ['_devin-auth/password/login', { status: 200, data: { token: AUTH1 } }];
const PASSWORD_REJECT = ['_devin-auth/password/login', { status: 401, data: { detail: 'Invalid email or password' } }];
const POSTAUTH_OK = ['WindsurfPostAuth', { status: 200, data: { sessionToken: SESSION, accountId: 'account-wave3' } }];
const START_OK = ['_devin-auth/email/start', { status: 200, data: { email_verification_token: VERIFY } }];
const START_OK_DEVIN = ['app.devin.ai/api/auth1/email/start', { status: 200, data: { email_verification_token: VERIFY } }];
const COMPLETE_OK = ['_devin-auth/email/complete', { status: 200, data: { token: AUTH1 } }];

beforeEach(() => {
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  _resetProbeHostForTests();
  setFlag(false);
  config.dashboardPassword = 'dash-secret';
});

afterEach(() => {
  __setLoginTransportForTests(null);
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  _resetProbeHostForTests();
  setFlag(false);
  config.dashboardPassword = originalDashboardPassword;
  for (const id of createdAccountIds.splice(0)) {
    try { removeAccount(id); } catch { /* already gone */ }
  }
});

// ─── A. Password path ─────────────────────────────────────────────────────

describe('password login (has_password:true)', () => {
  it('runs probe → password/login → PostAuth and never asks for an email code', async () => {
    const t = makeTransport([CONN_PASSWORD, PASSWORD_OK, POSTAUTH_OK]);
    __setLoginTransportForTests(t);
    const result = await windsurfLogin(EMAIL, PASSWORD, null);
    assert.equal(result.apiKey, SESSION);
    assert.equal(t.calls('email/start').length, 0, 'no code request on a password account');
    assert.equal(t.calls('_devin-auth/password/login').length, 1);
    assert.equal(t.calls('connections').length, 1, 'one probe, no second host');
  });

  it('a rejected password is ERR_INVALID_CREDENTIALS and counts toward the lockout', async () => {
    const t = makeTransport([CONN_PASSWORD, PASSWORD_REJECT]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null), (err) => {
      assert.equal(err.code, 'ERR_INVALID_CREDENTIALS');
      assert.equal(err.probeUnknown, false, 'the method WAS confirmed, so no alternatives are claimed');
      return true;
    });
    // Threshold is 3 distinct failures: one rejection alone must not lock.
    assert.equal(checkEmailLocked(EMAIL), null);
    for (let i = 0; i < 2; i++) {
      await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null));
    }
    assert.notEqual(checkEmailLocked(EMAIL), null, 'three real credential rejections lock the address');
  });
});

// ─── B. Probe resilience ──────────────────────────────────────────────────

describe('login-method probe', () => {
  it('treats an empty connections list as unknown, not as "no account"', async () => {
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', { status: 200, data: { connections: [] } }],
      ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: {} }],
    ]);
    __setLoginTransportForTests(t);
    const probe = await probeLoginMethod(EMAIL, null);
    assert.equal(probe.userExists, null);
    assert.equal(probe.hasPassword, null);
    assert.equal(probe.source, 'unknown');
  });

  it('does not offer OAuth providers for a missing account', async () => {
    // The connection list is global: upstream returns google/github even for an
    // address with no account. The sentinel must not become an offer.
    const t = makeTransport([['windsurf.com/_devin-auth/connections', {
      status: 200,
      data: {
        connections: [{ type: 'email', enabled: true }, { type: 'google', enabled: true }],
        auth_method: { method: 'not_found', has_password: false, enterprise_sso_domain: false },
      },
    }]]);
    __setLoginTransportForTests(t);
    const probe = await probeLoginMethod(EMAIL, null);
    assert.equal(probe.userExists, false);
    assert.equal(probe.emailCode, false);
    assert.deepEqual(probe.oauth, []);
  });

  it('answers from app.devin.ai when windsurf.com cannot (flag on) and remembers the host', async () => {
    setFlag(true);
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', new Error('connect ECONNRESET')],
      CONN_DEVIN_EMAIL_CODE,
      ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: {} }],
    ]);
    __setLoginTransportForTests(t);
    const probe = await probeLoginMethod(EMAIL, null);
    assert.equal(probe.hasPassword, false);
    assert.equal(probe.host, 'devin');
    assert.equal(probe.source, 'connections');
  });

  it('never touches the second host when the fallback is off', async () => {
    setFlag(false);
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', new Error('connect ECONNRESET')],
      ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: { userExists: true, hasPassword: true } }],
    ]);
    __setLoginTransportForTests(t);
    const probe = await probeLoginMethod(EMAIL, null);
    assert.equal(probe.hasPassword, true);
    assert.equal(t.calls('app.devin.ai').length, 0);
  });

  it('a malformed address is terminal (ERR_INVALID_EMAIL), not "unknown"', async () => {
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', {
        status: 422,
        data: { detail: 'value is not a valid email address: An email address must have an @-sign.' },
      }],
    ]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => probeLoginMethod('not-an-email', null), (err) => {
      assert.equal(err.code, 'ERR_INVALID_EMAIL');
      return true;
    });
    assert.equal(t.calls('CheckUserLoginMethod').length, 0, 'no second probe for a definitive answer');
  });
});

describe('probe-unknown password rejection (the 3.9.42 failure mode)', () => {
  it('re-asks the method once and reports "no password" instead of "wrong password"', async () => {
    // First probe pass: both endpoints silent (a Vercel outage shape). The
    // password attempt is rejected. The recheck then learns the truth.
    let connectionsCalls = 0;
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', { status: 200, data: {} }],
      ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: {} }],
      PASSWORD_REJECT,
    ]);
    const base = t;
    const withLateAnswer = async (url, opts, postData) => {
      if (url.includes('windsurf.com/_devin-auth/connections')) {
        connectionsCalls += 1;
        // 1st pass (login probe) silent, 2nd pass (recheck) answers.
        if (connectionsCalls >= 2) {
          base.seen.push({ url, body: postData ? String(postData) : '' });
          return { status: 200, data: CONN_EMAIL_CODE[1].data };
        }
      }
      return base(url, opts, postData);
    };
    __setLoginTransportForTests(withLateAnswer);
    await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null), (err) => {
      assert.equal(err.code, 'ERR_NO_PASSWORD_OAUTH_ACCOUNT');
      assert.equal(err.method, 'email_code');
      assert.equal(err.isAuthFail, false);
      return true;
    });
    assert.equal(base.calls('_devin-auth/password/login').length, 1, 'exactly one password attempt');
    assert.equal(checkEmailLocked(EMAIL), null, 'a wrong-method answer must not lock the address');
  });

  it('still reports the rejection, but flags probeUnknown so the UI offers alternatives', async () => {
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', { status: 200, data: {} }],
      ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: {} }],
      PASSWORD_REJECT,
    ]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null), (err) => {
      assert.equal(err.code, 'ERR_INVALID_CREDENTIALS');
      assert.equal(err.probeUnknown, true);
      assert.deepEqual(err.alternatives, ['email_code', 'oauth', 'token']);
      return true;
    });
  });
});

// ─── C. Email-code host choice ────────────────────────────────────────────

describe('email-code flow host choice', () => {
  it('starts on the host that answered the probe', async () => {
    setFlag(true);
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', new Error('connect ECONNRESET')],
      CONN_DEVIN_EMAIL_CODE,
      START_OK_DEVIN,
    ]);
    __setLoginTransportForTests(t);
    await probeLoginMethod(EMAIL, null);
    const started = await emailLoginStart(EMAIL, null);
    assert.equal(started.host, 'devin');
    assert.equal(t.calls('app.devin.ai/api/auth1/email/start').length, 1);
    assert.equal(t.calls('windsurf.com/_devin-auth/email/start').length, 0);
  });

  it('honours an explicit Devin choice with the automatic fallback off', async () => {
    setFlag(false);
    const t = makeTransport([START_OK_DEVIN]);
    __setLoginTransportForTests(t);
    const started = await emailLoginStart(EMAIL, null, { host: 'devin' });
    assert.equal(started.host, 'devin');
    assert.equal(t.calls('app.devin.ai/api/auth1/email/start').length, 1);
  });

  it('completes on the host the code was sent from', async () => {
    setFlag(false);
    const t = makeTransport([
      START_OK_DEVIN,
      ['app.devin.ai/api/auth1/email/complete', { status: 200, data: { token: AUTH1 } }],
      POSTAUTH_OK,
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL, null, { host: 'devin' });
    const result = await emailLoginComplete(flowId, CODE, null);
    assert.equal(result.sessionToken, SESSION);
    assert.equal(result.viaHost, 'app.devin.ai');
    assert.equal(t.calls('windsurf.com/_devin-auth/email/complete').length, 0);
  });
});

// ─── D. Routes ────────────────────────────────────────────────────────────

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

const AUTHED = { 'x-dashboard-password': 'dash-secret' };

async function call(subpath, body, headers = AUTHED) {
  const res = fakeRes();
  await handleDashboardApi('POST', subpath, body, {
    url: '/dashboard/api' + subpath,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  }, res);
  return { status: res.statusCode, body: res.json(), raw: res.body };
}

describe('dashboard routes', () => {
  it('/windsurf-login/probe exposes the answering host', async () => {
    const t = makeTransport([CONN_EMAIL_CODE]);
    __setLoginTransportForTests(t);
    const r = await call('/windsurf-login/probe', { email: EMAIL });
    assert.equal(r.status, 200);
    assert.equal(r.body.hasPassword, false);
    assert.equal(r.body.host, 'windsurf');
    assert.equal(r.body.emailCode, true);
  });

  it('/windsurf-login returns method/oauthProviders on a no-password answer', async () => {
    const t = makeTransport([CONN_EMAIL_CODE]);
    __setLoginTransportForTests(t);
    const r = await call('/windsurf-login', { email: EMAIL, password: PASSWORD });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ERR_NO_PASSWORD_OAUTH_ACCOUNT');
    assert.equal(r.body.method, 'email_code');
    assert.deepEqual(r.body.oauthProviders, ['google']);
    assert.equal(t.calls('password/login').length, 0);
  });

  it('/windsurf-login/email/start forwards an allowlisted host only', async () => {
    const t = makeTransport([START_OK_DEVIN]);
    __setLoginTransportForTests(t);
    const ok = await call('/windsurf-login/email/start', { email: EMAIL, host: 'devin' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.host, 'devin');
    // A junk host is ignored, not forwarded: the request goes to windsurf.com
    // and fails there (no route in this fixture) instead of being injected.
    _resetEmailFlowsForTests();
    __setLoginTransportForTests(makeTransport([START_OK]));
    const junk = await call('/windsurf-login/email/start', { email: 'other@example.test', host: 'evil.example' });
    assert.equal(junk.status, 200);
    assert.equal(junk.body.host, 'windsurf');
  });
});

// ─── E. Token import ──────────────────────────────────────────────────────

describe('POST /windsurf-login/token', () => {
  it('imports a bare session token and never echoes it', async () => {
    const r = await call('/windsurf-login/token', { token: SESSION, label: 'wave3' });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.method, 'token');
    assert.ok(r.body.account?.id);
    createdAccountIds.push(r.body.account.id);
    assert.equal(r.raw.includes(SESSION), false, 'the raw token must not appear in the response');
  });

  it('extracts the token from a full deep-link URL', async () => {
    const r = await call('/windsurf-login/token', {
      token: `windsurf://codeium.windsurf?access_token=${encodeURIComponent('devin-session-token$URLTOKEN')}`,
      label: 'wave3-url',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    createdAccountIds.push(r.body.account.id);
    assert.equal(r.raw.includes('windsurf://'), false, 'the whole URL must not be stored or echoed');
  });

  it('rejects an auth1_ intermediate', async () => {
    const r = await call('/windsurf-login/token', { token: AUTH1 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ERR_AUTH1_NOT_A_POOL_KEY');
  });

  it('rejects input with no token in it', async () => {
    const r = await call('/windsurf-login/token', { token: 'https://windsurf.com/auth/callback' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ERR_NO_TOKEN_IN_INPUT');
  });

  it('requires dashboard auth like every other login route', async () => {
    const r = await call('/windsurf-login/token', { token: SESSION }, {});
    assert.equal(r.status, 401);
  });
});

// ─── F. No secret leaves through the log ──────────────────────────────────

describe('secret hygiene', () => {
  it('never logs the verification token, the Auth1 token or the session token', async () => {
    const lines = [];
    const originals = { info: log.info, warn: log.warn, error: log.error, debug: log.debug };
    for (const level of Object.keys(originals)) {
      if (typeof originals[level] !== 'function') continue;
      log[level] = (...args) => { lines.push(args.map((a) => String(a)).join(' ')); };
    }
    try {
      __setLoginTransportForTests(makeTransport([CONN_EMAIL_CODE, START_OK, COMPLETE_OK, POSTAUTH_OK]));
      const { flowId } = await emailLoginStart(EMAIL, null);
      const result = await emailLoginComplete(flowId, CODE, null);
      assert.equal(result.sessionToken, SESSION);
    } finally {
      for (const level of Object.keys(originals)) {
        if (typeof originals[level] === 'function') log[level] = originals[level];
      }
    }
    const joined = lines.join('\n');
    assert.ok(joined.length > 0, 'the flow should have logged something (the guard would be vacuous otherwise)');
    for (const secret of [VERIFY, AUTH1, SESSION, CODE]) {
      assert.equal(joined.includes(secret), false, `a log line leaked ${secret.slice(0, 4)}…`);
    }
    assert.match(joined, /flowHash=/, 'the flow is identified by a hash, not by its token');
  });
});

// ─── G. Dashboard wiring ──────────────────────────────────────────────────

describe('dashboard login tab wiring', () => {
  const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

  it('links to Devin and sends existing credentials through the masked account form', () => {
    assert.match(HTML, /id="devin-sign-in" href="https:\/\/app\.devin\.ai\/" target="_blank" rel="noopener noreferrer"/);
    assert.match(HTML, /onclick="App\.openCredentialPaste\(\)"/);
    assert.match(HTML, /id="acc-key" type="password"/);
    assert.match(HTML, /this\.api\('POST', '\/accounts', body, \{ notify: false \}\)/);
    assert.doesNotMatch(HTML, /redirect_uri=show-auth-token|\/oauth\/start/);
  });

  it('shows the code form with a live status line and a resend countdown', () => {
    assert.match(HTML, /id="wl-email-code-field"/);
    assert.match(HTML, /id="wl-code-status" aria-live="polite"/);
    assert.match(HTML, /id="wl-send-code-label"/);
    assert.match(HTML, /I18n\.t\('emailLogin\.resendInShort', \{ seconds \}\)/);
    assert.match(HTML, /I18n\.t\('emailLogin\.codeSentToDevin'/);
  });

  it('has a Devin retry action and a code alternative on a rejected password', () => {
    assert.match(HTML, /App\.windsurfSendEmailCode\(\{host:'devin'\}\)/);
    assert.match(HTML, /useEmailCodeInstead\(\)/);
    assert.match(HTML, /r\.probeUnknown/);
  });

  it('invalidates a cached probe and an outstanding code flow when the email changes', () => {
    assert.match(HTML, /oninput="App\.onWindsurfEmailInput\(\)"/);
    const methods = ['onWindsurfEmailInput', 'resetEmailCodeForm'].map(name => {
      const from = HTML.indexOf(`\n  ${name}(`);
      const end = HTML.indexOf('\n  },', from);
      assert.ok(from >= 0 && end > from, `missing ${name}`);
      return HTML.slice(from, end + 5);
    });
    for (const flow of [{ email: EMAIL, flowId: 'fixture-id' }, null]) {
      const fields = {
        'wl-email': { value: 'other-login@example.test' },
        'wl-code-status': { textContent: '', dataset: {} },
        'wl-email-code': { value: CODE },
      };
      const document = { getElementById: id => fields[id], querySelector: () => null };
      const form = Function('document', 'I18n', `return ({ ${methods.join('\n')} });`)(document, { t: key => key });
      Object.assign(form, {
        _wlFlow: flow, _wlEmailOp: flow ? null : { email: EMAIL },
        _wlProbeEmail: EMAIL, _wlProbe: {}, updateEmailCodeControls() {},
      });
      form.onWindsurfEmailInput();
      assert.equal(form._wlProbe, null);
      assert.equal(form._wlProbeEmail, null);
      assert.equal(form._wlFlow, null);
      assert.equal(form._wlEmailOp, null);
      assert.equal(fields['wl-email-code'].value, '');
      assert.equal(fields['wl-code-status'].textContent, 'emailLogin.emailChanged');
    }
  });
});

// ─── G. Source invariants ─────────────────────────────────────────────────

describe('source invariants', () => {
  const LOGIN_SRC = readFileSync(new URL('../src/dashboard/windsurf-login.js', import.meta.url), 'utf8');
  const API_SRC = readFileSync(new URL('../src/dashboard/api.js', import.meta.url), 'utf8');

  it('the email flow keeps its verification token server-side', () => {
    const start = LOGIN_SRC.indexOf('export async function emailLoginStart');
    const end = LOGIN_SRC.indexOf('export async function emailLoginComplete');
    const fn = LOGIN_SRC.slice(start, end);
    assert.ok(fn.length > 500, 'emailLoginStart should be found');
    assert.match(fn, /return \{ flowId, sent: true, expiresInMs: EMAIL_FLOW_TTL_MS, host \}/);
    // The one return of this function must carry the opaque flow id and
    // nothing token-shaped.
    const returns = fn.match(/\breturn \{[^}]*\}/g) || [];
    assert.equal(returns.length, 1, `expected exactly one return, saw ${returns.length}`);
    assert.doesNotMatch(returns[0], /token/i, 'the verification token must not be returned to the browser');
  });

  it('the token route never logs its input', () => {
    const block = API_SRC.slice(
      API_SRC.indexOf("subpath === '/windsurf-login/token'"),
      API_SRC.indexOf("subpath === '/windsurf-login/batch'"),
    );
    assert.ok(block.length > 200, 'the token route should exist');
    assert.doesNotMatch(block, /log\.(info|warn|error|debug)\(/, 'the token route must not log at all');
  });
});
