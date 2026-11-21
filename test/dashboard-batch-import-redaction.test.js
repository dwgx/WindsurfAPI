// V-25 (audit A24): the batch-import response builder echoed the submitted line
// back verbatim (`raw`) and the proxy string including its userinfo
// (`proxyRaw`). A failed import therefore returned the password / token / API key
// the operator had just pasted, in a JSON body a browser may cache — and the
// dashboard then copied it into localStorage login history.
//
// The response must carry structured diagnostics only: line number, error code,
// kind, the (credential-free) proxy label. Nothing derived from the secret.
// `Cache-Control: no-store` keeps the whole body out of any shared cache.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAccountList, removeAccount } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import {
  __setLoginTransportForTests,
  _resetEmailFlowsForTests,
  _resetEmailLockoutForTests,
  _resetProbeHostForTests,
} from '../src/dashboard/windsurf-login.js';

const originalDashboardPassword = config.dashboardPassword;
const originalAllowPrivateProxyHosts = config.allowPrivateProxyHosts;
const created = new Set();

const PROXY_USER = 'proxy-user';
const PROXY_PASS = 'proxy-pass-9c1f';
const ACCOUNT_PASS = 'hunter2-batch-secret';
const BATCH_TOKEN = 'auth1_batch_secret_token_value';

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
    url: '/dashboard/api/batch-import',
    headers: { 'x-dashboard-password': 'batch-dash-secret' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function makeTransport(routes) {
  return async (url, opts, postData) => {
    for (const [matcher, reply] of routes) {
      if (url.includes(matcher)) {
        const data = opts?.raw
          ? (Buffer.isBuffer(reply.data) ? reply.data : Buffer.from(JSON.stringify(reply.data)))
          : reply.data;
        return { status: reply.status, data };
      }
    }
    throw new Error(`unexpected request to ${url}`);
  };
}

async function batchImport(body, { preview = false } = {}) {
  const res = fakeRes();
  const subpath = preview ? '/batch-import/preview' : '/batch-import';
  await handleDashboardApi('POST', subpath, body, { ...authedReq(), url: '/dashboard/api' + subpath }, res);
  return { status: res.statusCode, headers: res.headers, body: res.json(), text: res.body };
}

function assertNoSecrets(text) {
  for (const secret of [PROXY_PASS, ACCOUNT_PASS, BATCH_TOKEN]) {
    assert.equal(text.includes(secret), false, `response leaked ${secret}`);
  }
}

function assertNoRawFields(item) {
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'raw'), false, 'the raw input line must not be echoed');
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'proxyRaw'), false, 'the raw proxy string must not be echoed');
}

afterEach(() => {
  config.dashboardPassword = originalDashboardPassword;
  config.allowPrivateProxyHosts = originalAllowPrivateProxyHosts;
  __setLoginTransportForTests(null);
  _resetEmailFlowsForTests();
  _resetEmailLockoutForTests();
  _resetProbeHostForTests();
  for (const id of created) { try { removeAccount(id); } catch { /* already gone */ } }
  created.clear();
});

describe('POST /batch-import response redaction', () => {
  for (const preview of [true]) {
    it('previews without login or writes on the preview route', async () => {
      config.dashboardPassword = 'batch-dash-secret';
      const key = 'fixture-explicit-batch-key';
      let upstreamCalls = 0;
      __setLoginTransportForTests(async () => { upstreamCalls++; throw new Error('Preview tried to sign in'); });
      const paths = ['accounts.json', 'proxy.json', 'runtime-config.json'];
      const snapshot = () => paths.map(name => {
        const path = join(process.env.DATA_DIR, name);
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      });
      const before = snapshot();
      const accountCount = getAccountList().length;
      const r = await batchImport({
        text: JSON.stringify([
          { apiKey: key, label: 'temporary', proxy: `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:8080` },
          { email: 'preview@example.test', password: ACCOUNT_PASS },
          { token: BATCH_TOKEN },
          'short unknown fixture line',
        ]),
        autoAdd: false, storeCredential: true,
      }, { preview });
      assert.equal(r.status, 200);
      assert.equal(r.headers['Cache-Control'], 'no-store');
      assert.deepEqual(r.body, {
        success: true, preview: true, mode: 'json',
        results: [
          { lineNumber: 1, importKind: 'api_key' },
          { lineNumber: 2, importKind: 'email_password' },
          { lineNumber: 3, importKind: 'token', error: 'ERR_AUTH1_NOT_A_POOL_KEY' },
          { lineNumber: 4, importKind: 'issue', error: 'ERR_FORMAT_INVALID' },
        ],
      });
      assert.equal(upstreamCalls, 0);
      assert.deepEqual(snapshot(), before);
      assert.equal(getAccountList().length, accountCount);
      assert.equal(r.text.includes(key) || r.text.includes(PROXY_USER), false);
      assertNoSecrets(r.text);
    });

  }

  it('reports an added API key and subsequent reuse when adding to the pool', async () => {
    config.dashboardPassword = 'batch-dash-secret';
    const apiKey = 'fixture-explicit-persistent-key';
    const first = await batchImport({ text: JSON.stringify([{ apiKey, label: 'original' }]), autoAdd: true });
    const firstRow = first.body.results[0];
    assert.equal(firstRow.poolDisposition, 'added');
    assert.equal(firstRow.success, true);
    created.add(firstRow.account.id);
    const second = await batchImport({ text: JSON.stringify([{ apiKey, label: 'replacement' }]), autoAdd: true });
    const secondRow = second.body.results[0];
    assert.equal(secondRow.poolDisposition, 'existing');
    assert.deepEqual(secondRow.account, firstRow.account);
    assert.equal(second.text.includes(apiKey), false);
  });

  it('batch import response contains no raw/proxyRaw secrets and sets Cache-Control: no-store', async () => {
    config.dashboardPassword = 'batch-dash-secret';
    // A credentialed proxy on a private host: the SSRF gate rejects it BEFORE
    // any login, so this failure path is offline and deterministic — and the
    // baseline echoed the whole line (password included) plus proxyRaw.
    const text = [
      `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:8080 victim@example.test ${ACCOUNT_PASS}`,
      'this-line-is-not-a-credential',
    ].join('\n');

    const r = await batchImport({ text, autoAdd: true });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertNoSecrets(r.text);
    assert.equal(r.headers['Cache-Control'], 'no-store', 'a credential-bearing body must not be cached');
    assert.equal(r.body.results.length, 2);
    for (const item of r.body.results) assertNoRawFields(item);

    const failed = r.body.results[0];
    assert.equal(failed.success, false);
    assert.equal(failed.email, 'victim@example.test');
    assert.equal(failed.lineNumber, 1);
    assert.equal(typeof failed.error, 'string');
    // The label is the parsed proxy, not the pasted string: host and port are
    // useful to the operator, the userinfo is gone.
    assert.equal(failed.proxy, 'http://127.0.0.1:8080');
    assert.equal(typeof failed.detail, 'string');
    // detail names the parsed shape and the credential-free proxy label; the
    // address and the password stay out of it.
    assert.equal(failed.detail, 'email+password · proxy http://127.0.0.1:8080');
  });

  it('a failed JSON token item does not echo the token or the source object', async () => {
    config.dashboardPassword = 'batch-dash-secret';
    const r = await batchImport({
      text: JSON.stringify([{ token: BATCH_TOKEN, label: 'batch-auth1' }]),
      autoAdd: true,
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertNoSecrets(r.text);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(r.body.results.length, 1);
    const item = r.body.results[0];
    assert.equal(item.success, false);
    assertNoRawFields(item);
    assert.equal(item.lineNumber, 1);
    assert.equal(item.importKind, 'token');
    assert.equal(item.error, 'ERR_AUTH1_NOT_A_POOL_KEY');
  });

  it('a successful item reports the proxy without its userinfo', async () => {
    config.dashboardPassword = 'batch-dash-secret';
    // ALLOW_PRIVATE_PROXY_HOSTS + an IP literal keeps validateProxyHost offline
    // (no DNS in a unit test) while exercising the SUCCESS path, which is where
    // the response used to carry proxyRaw verbatim.
    config.allowPrivateProxyHosts = true;
    const key = `sk-batch-redaction-${Date.now()}`;
    const r = await batchImport({
      text: JSON.stringify([{
        api_key: key,
        label: 'batch-redaction',
        proxy: `http://${PROXY_USER}:${PROXY_PASS}@10.1.2.3:8080`,
      }]),
      autoAdd: true,
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertNoSecrets(r.text);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(r.body.successCount, 1, JSON.stringify(r.body));
    const item = r.body.results[0];
    const accountId = item.account?.id;
    assert.ok(accountId);
    created.add(accountId);
    assert.equal(item.proxy, 'http://10.1.2.3:8080', 'the proxy label must drop user:pass');
    assertNoRawFields(item);
    // The stored account still knows its real proxy; only the RESPONSE is redacted.
    assert.ok(getAccountList().some(a => a.id === accountId));
  });

  it('the login batch route never returns a raw apiKey', async () => {
    config.dashboardPassword = 'batch-dash-secret';
    // autoAdd:false is the one-time-export contract on /windsurf-login (a
    // single login for external tooling). A BATCH response has no such
    // contract: each row is keyed by the address the operator already owns the
    // password for, so a raw key in the body is only a leak.
    const session = 'devin-session-token$BATCHLOGINSESSION';
    __setLoginTransportForTests(makeTransport([
      ['windsurf.com/_devin-auth/connections', {
        status: 200,
        data: {
          connections: [{ id: 'email', type: 'email', enabled: true }],
          auth_method: { method: 'auth1', has_password: true, enterprise_sso_domain: false },
        },
      }],
      ['_devin-auth/password/login', { status: 200, data: { token: 'auth1_batch_login_throwaway' } }],
      ['WindsurfPostAuth', { status: 200, data: { sessionToken: session, accountId: 'account-batch' } }],
    ]));

    const res = fakeRes();
    await handleDashboardApi('POST', '/windsurf-login/batch', {
      accounts: [{ email: 'batch-login@example.test', password: ['throwaway', 'batch'].join('-') }],
      autoAdd: false,
    }, { ...authedReq(), url: '/dashboard/api/windsurf-login/batch' }, res);

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    const item = body.results[0];
    assert.equal(item.success, true, res.body);
    assert.equal(item.apiKey, undefined, 'a batch response must never carry the raw session token');
    assert.equal(res.body.includes(session), false, 'the session token must not appear anywhere in the body');
    assert.equal(item.apiKey_masked, 'devin-se...SION');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });
});
