import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBrowserLogin, browserLoginOrigin } from '../src/dashboard/devin-browser-login.js';
import { config } from '../src/config.js';

const origin = 'http://127.0.0.1:54123';
const callback = (url, code = 'fixture-code') => new URLSearchParams({ state: new URL(url).searchParams.get('state'), code });

test('a browser receipt authorizes one matching exchange and one account addition', async () => {
  let material;
  let admissions = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const login = createBrowserLogin({ exchange: async value => { material = value; return pending; } });
  const first = login.start(origin);
  const authorize = new URL(first.authorizeUrl);
  assert.equal(authorize.origin, 'https://app.devin.ai');
  assert.equal(authorize.searchParams.get('redirect_uri'), origin + '/callback');
  assert.equal(authorize.searchParams.get('prompt'), 'select_account');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.has('client_id'), false);
  assert.equal(authorize.searchParams.has('client_secret'), false);
  assert.equal(login.start(origin).status, 'busy');
  const admit = key => { assert.equal(key, 'fixture-key'); admissions++; return 'fixture-id'; };
  assert.equal((await login.complete(origin, first.id, admit)).status, 'pending');
  assert.equal(login.callback('http://127.0.0.1:54124', callback(first.authorizeUrl)), false);
  assert.equal(login.callback(origin, new URLSearchParams({ state: 'wrong', code: 'fixture-code' })), false);
  assert.equal(login.callback(origin, callback(first.authorizeUrl)), true);
  assert.equal(login.callback(origin, callback(first.authorizeUrl)), false);
  assert.equal(login.status(origin, first.id).status, 'ready');
  const finishing = login.complete(origin, first.id, admit);
  assert.equal(material.code, 'fixture-code');
  assert.equal(createHash('sha256').update(material.verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
  assert.equal((await login.complete(origin, first.id, admit)).status, 'exchanging');
  release({ candidateKey: 'fixture-key' });
  assert.equal((await finishing).accountId, 'fixture-id');
  assert.equal((await login.complete(origin, first.id, admit)).status, 'added');
  assert.equal(admissions, 1);
  assert.doesNotMatch(JSON.stringify(login.status(origin, first.id)), /fixture-code|fixture-key/);
});

test('provider rejection is terminal and never returns its description', async () => {
  const login = createBrowserLogin({ exchange: () => assert.fail('must not exchange') });
  const turn = login.start(origin);
  const query = callback(turn.authorizeUrl);
  query.set('error', 'unauthorized_client');
  query.set('error_description', 'opaque-fixture');
  assert.equal(login.callback(origin, query), true);
  const result = await login.complete(origin, turn.id, () => assert.fail('must not add'));
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'unauthorized_client');
  assert.doesNotMatch(JSON.stringify(result), /opaque-fixture|fixture-code/);
});

test('cancelled exchanges and expired callbacks do not admit accounts', async () => {
  let now = 0;
  let release;
  const login = createBrowserLogin({
    clock: () => now,
    exchange: () => new Promise(resolve => { release = resolve; }),
  });
  const first = login.start(origin);
  assert.equal(login.callback(origin, callback(first.authorizeUrl)), true);
  const finishing = login.complete(origin, first.id, () => assert.fail('must not add'));
  assert.equal(login.cancel(origin, first.id).status, 'cancelled');
  release({ candidateKey: 'fixture-key' });
  assert.equal((await finishing).status, 'cancelled');
  const second = login.start(origin);
  now = second.expiresAt;
  assert.equal(login.callback(origin, callback(second.authorizeUrl)), false);
  assert.equal(login.status(origin, second.id).status, 'expired');
});

test('browser sign-in is available only on an opted-in direct loopback listener', () => {
  const host = config.host;
  const previous = process.env.DEVIN_BROWSER_LOGIN;
  const req = {
    headers: { host: '127.0.0.1:54123' },
    socket: { localAddress: '127.0.0.1', localPort: 54123, remoteAddress: '127.0.0.1' },
  };
  try {
    config.host = '127.0.0.1';
    delete process.env.DEVIN_BROWSER_LOGIN;
    assert.equal(browserLoginOrigin(req), null);
    process.env.DEVIN_BROWSER_LOGIN = '1';
    assert.equal(browserLoginOrigin(req), origin);
    assert.equal(browserLoginOrigin({ ...req, headers: { host: 'bad.example' } }), null);
    assert.equal(browserLoginOrigin({ ...req, headers: { ...req.headers, forwarded: 'for=127.0.0.1' } }), null);
    config.host = '0.0.0.0';
    assert.equal(browserLoginOrigin(req), null);
  } finally {
    config.host = host;
    if (previous === undefined) delete process.env.DEVIN_BROWSER_LOGIN;
    else process.env.DEVIN_BROWSER_LOGIN = previous;
  }
});
