// Smart bulk import (`POST /accounts/import-text`) must add an email +
// `Token: devin-session-token$…` PAIR to the pool.
//
// The parser classifies the `email` line followed by the token line as a
// `tokenPair` and the route comment promises every pair is added via
// `addAccountByPastedSecret`. A regression left the pair loop calling an
// undefined `addByKind(...)`, so every pair landed in `failed` with
// "addByKind is not defined", created nothing, and the caller still saw 200.
//
// This file drives the real dashboard route and the real account pool. It pins
// the pair contract plus the three invariants the repair must not break:
// auth1 pairs stay skipped, a duplicate re-import keeps the same account row,
// and no token value is ever echoed back.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { getAccountList, getAccountInternal, removeAccount } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';

const DASH_PW = 'final-pair-dashboard-secret';
const EMAIL = 'final.pair@example.test';
const TOKEN = 'devin-session-token$final-pair-session-0001-abcdefghijklmnop';
const AUTH1 = 'auth1_final_pair_secret_value_0123456789';
const AUTH1_EMAIL = 'final.skip@example.test';

const original = {
  dashboardPassword: config.dashboardPassword,
};
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
    url: '/dashboard/api/accounts/import-text',
    headers: { 'x-dashboard-password': DASH_PW },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

async function importText(text) {
  const res = fakeRes();
  await handleDashboardApi('POST', '/accounts/import-text', { text }, authedReq(), res);
  return { status: res.statusCode, body: res.json(), text: res.body };
}

afterEach(() => {
  config.dashboardPassword = original.dashboardPassword;
  for (const id of created) { try { removeAccount(id); } catch { /* already gone */ } }
  created.clear();
  // Belt and braces: a bug that stored the pasted token without reporting its
  // id must still leave the private test pool empty.
  for (const a of getAccountList()) removeAccount(a.id);
});

describe('POST /accounts/import-text — email + session-token pair', () => {
  it('adds the pasted pair to the pool with the pasted email as its label', async () => {
    config.dashboardPassword = DASH_PW;
    const r = await importText(`${EMAIL}\nToken: ${TOKEN}`);

    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.failed, [], `pair must not fail: ${JSON.stringify(r.body.failed)}`);
    assert.equal(r.body.added.length, 1, JSON.stringify(r.body));
    const added = r.body.added[0];
    created.add(added.id);
    assert.equal(added.kind, 'session');

    assert.ok(getAccountList().some((a) => a.id === added.id), 'the added account must exist in the pool');
    const stored = getAccountInternal(added.id);
    assert.ok(stored, 'the stored record must exist');
    // A devin-session-token$ IS the upstream apiKey.
    assert.equal(stored.apiKey, TOKEN);
    // The paired email is the stored label/email.
    assert.equal(stored.email, EMAIL);
    // The raw token never travels back in the response.
    assert.equal(r.text.includes(TOKEN), false, 'the session token must not be echoed');
  });

  it('keeps an auth1 pair skipped and creates no account', async () => {
    config.dashboardPassword = DASH_PW;
    const before = new Set(getAccountList().map((a) => a.id));
    const r = await importText(`${AUTH1_EMAIL}\nToken: ${AUTH1}`);

    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.added, [], JSON.stringify(r.body));
    assert.equal(r.body.skipped.length, 1, JSON.stringify(r.body));
    assert.equal(r.body.skipped[0].kind, 'auth1');
    assert.equal(r.body.skipped[0].email, AUTH1_EMAIL);
    assert.equal(r.body.skipped[0].reason, 'auth1_not_a_pool_key');
    assert.deepEqual(r.body.failed, []);
    for (const a of getAccountList()) {
      assert.ok(before.has(a.id), `auth1 import must not create ${a.id}`);
      assert.notEqual(getAccountInternal(a.id)?.apiKey, AUTH1);
    }
    assert.equal(r.text.includes(AUTH1), false, 'the auth1 value must not be echoed');
  });

  it('reports a duplicate re-import as added and leaves the stored row untouched', async () => {
    config.dashboardPassword = DASH_PW;
    const text = `${EMAIL}\nToken: ${TOKEN}`;
    const first = await importText(text);
    assert.equal(first.body.added.length, 1, JSON.stringify(first.body));
    const id = first.body.added[0].id;
    created.add(id);
    const before = getAccountInternal(id);
    const poolSize = getAccountList().length;

    const again = await importText(text);
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.body.failed, []);
    assert.equal(again.body.added.length, 1, 'duplicate re-import is still reported added');
    assert.equal(again.body.added[0].id, id, 'the same account row is reused');
    assert.equal(getAccountList().length, poolSize, 'no new pool row');

    const after = getAccountInternal(id);
    assert.equal(after.id, before.id);
    assert.equal(after.email, before.email);
    assert.equal(after.apiKey, before.apiKey);
    assert.equal(after.addedAt, before.addedAt);
    assert.equal(again.text.includes(TOKEN), false);
  });

  it('leaks neither the session token nor the auth1 value in any failure text', async () => {
    config.dashboardPassword = DASH_PW;
    // The pair path plus a bare token path in one submission: both are
    // credential-bearing, and neither may surface in the reply.
    const r = await importText(`${EMAIL}\nToken: ${TOKEN}\n${AUTH1}`);
    assert.equal(r.status, 200, r.text);
    for (const added of r.body.added) created.add(added.id);
    const surface = `${r.text} ${JSON.stringify(r.body.failed)} ${JSON.stringify(r.body.skipped)}`;
    assert.equal(surface.includes(TOKEN), false, 'the session token must not be echoed');
    assert.equal(surface.includes(AUTH1), false, 'the auth1 value must not be echoed');
    assert.equal(surface.includes('addByKind'), false, 'no internal helper name in a response');
  });
});
