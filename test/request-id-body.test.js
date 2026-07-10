import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import { configureBindHost, addAccountByKey, removeAccount, getAccountList, _resetLockoutForTests } from '../src/auth.js';
import { startServer, withRequestId } from '../src/server.js';
import { setRuntimeApiKey } from '../src/runtime-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalApiKey = config.apiKey;
const originalHost = config.host;
const originalPort = config.port;
let runningServer = null;
const createdAccounts = new Set();

afterEach(async () => {
  if (runningServer) {
    await new Promise(resolve => runningServer.close(resolve));
    runningServer = null;
  }
  for (const id of createdAccounts) { removeAccount(id); createdAccounts.delete(id); }
  for (const a of getAccountList()) {
    if (typeof a.label === 'string' && a.label.startsWith('f4-')) removeAccount(a.id);
  }
  _resetLockoutForTests();
  setRuntimeApiKey('');
  config.apiKey = originalApiKey;
  config.host = originalHost;
  config.port = originalPort;
  configureBindHost('127.0.0.1');
});

function waitListening(server) {
  return new Promise(resolve => {
    if (server.address()) return resolve();
    server.once('listening', resolve);
  });
}

async function postJson(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// F4(a): pure function unit tests.
describe('F4 withRequestId — pure function', () => {
  it('injects request_id into an error body (status >= 400)', () => {
    const out = withRequestId(400, { error: { message: 'x' } }, 'req_abc');
    assert.equal(out.request_id, 'req_abc');
    assert.deepEqual(out.error, { message: 'x' });
  });
  it('does NOT inject into a success body (status < 400)', () => {
    const body = { choices: [{ index: 0 }] };
    const out = withRequestId(200, body, 'req_abc');
    assert.equal(out.request_id, undefined);
    assert.equal(out, body, 'success body returned unchanged (same reference)');
  });
  it('passes through null body', () => {
    assert.equal(withRequestId(400, null, 'req_abc'), null);
  });
  it('passes through array body', () => {
    const arr = [1, 2];
    assert.equal(withRequestId(400, arr, 'req_abc'), arr);
  });
  it('passes through non-object body', () => {
    assert.equal(withRequestId(400, 'oops', 'req_abc'), 'oops');
  });
  it('does not clobber an existing request_id', () => {
    const out = withRequestId(400, { error: {}, request_id: 'req_original' }, 'req_new');
    assert.equal(out.request_id, 'req_original');
  });
  it('returns a NEW object, not mutating the input', () => {
    const body = { error: {} };
    const out = withRequestId(400, body, 'req_x');
    assert.notEqual(out, body);
    assert.equal(body.request_id, undefined);
  });
});

// F4(b): source-level prefix assertions (all 4 header sites migrated to req_).
describe('F4 source — request id prefix migrated req- → req_', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
  it('no legacy req- prefix remains', () => {
    assert.doesNotMatch(src, /'req-'\s*\+\s*randomUUID/);
  });
  it('exactly 4 req_ prefixed sites', () => {
    assert.equal((src.match(/'req_'\s*\+\s*randomUUID/g) || []).length, 4);
  });
});

// F4(c): OpenAI endpoint route integration — unknown model → 400 pre-dispatch.
describe('F4 /v1/chat/completions error body carries request_id', () => {
  it('400 error body has request_id === x-request-id header, req_ prefixed', async () => {
    _resetLockoutForTests();
    config.apiKey = 'test-key-f4';
    setRuntimeApiKey('test-key-f4');
    config.host = '127.0.0.1';
    config.port = 0;
    const acct = addAccountByKey('fake-key-f4', 'f4-chat');
    if (acct?.id) createdAccounts.add(acct.id);

    runningServer = startServer();
    await waitListening(runningServer);
    const port = runningServer.address().port;

    const res = await postJson(port, '/v1/chat/completions',
      { model: 'totally-fake-model-xyz', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: 'Bearer test-key-f4' });

    assert.equal(res.statusCode, 400);
    assert.match(res.headers['x-request-id'], /^req_/);
    assert.equal(res.body.error.type, 'invalid_request_error');
    assert.equal(res.body.request_id, res.headers['x-request-id']);
    assert.match(res.body.request_id, /^req_/);
  });
});

// F4(d): Anthropic endpoint route integration.
describe('F4 /v1/messages error body carries request_id', () => {
  it('400 error body has request_id === request-id header, req_ prefixed', async () => {
    _resetLockoutForTests();
    config.apiKey = 'test-key-f4';
    setRuntimeApiKey('test-key-f4');
    config.host = '127.0.0.1';
    config.port = 0;
    const acct = addAccountByKey('fake-key-f4', 'f4-msg');
    if (acct?.id) createdAccounts.add(acct.id);

    runningServer = startServer();
    await waitListening(runningServer);
    const port = runningServer.address().port;

    const res = await postJson(port, '/v1/messages',
      { model: 'totally-fake-model-xyz', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: 'Bearer test-key-f4' });

    assert.equal(res.statusCode, 400);
    assert.match(res.headers['request-id'], /^req_/);
    assert.equal(res.body.type, 'error');
    assert.ok(res.body.error);
    assert.equal(res.body.request_id, res.headers['request-id']);
    assert.match(res.body.request_id, /^req_/);
  });
});

// Regression: an empty-body POST to a dashboard endpoint (App.api('POST', path)
// with no body → Content-Length 0) must NOT be rejected as "Invalid JSON".
// JSON.parse('') throws; the fix treats an empty body as {}. This surfaced as
// the dashboard Update button printing "✗ Invalid JSON" on /self-update.
describe('dashboard empty-body POST is not Invalid JSON', () => {
  function postEmpty(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Length': 0, ...headers },
      }, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('empty-body POST reaches the handler instead of a 400 Invalid JSON', async () => {
    _resetLockoutForTests();
    config.dashboardPassword = 'pw-empty-body';
    config.host = '127.0.0.1';
    config.port = 0;

    runningServer = startServer();
    await waitListening(runningServer);
    const port = runningServer.address().port;

    // /accounts/probe-all is a no-op on an empty pool; the point is the body
    // parser must not short-circuit an empty body to { error: 'Invalid JSON' }.
    const res = await postEmpty(port, '/dashboard/api/accounts/probe-all',
      { 'X-Dashboard-Password': 'pw-empty-body' });

    assert.notEqual(res.body?.error, 'Invalid JSON', 'empty body must not be rejected as Invalid JSON');
    assert.notEqual(res.statusCode, 400);
  });
});
