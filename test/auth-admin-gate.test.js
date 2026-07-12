// H1 (Grok audit): account-pool management (/auth/login, /auth/accounts,
// DELETE /auth/accounts/:id) must require OPERATOR auth, not just a chat API
// key. A shared chat key used to grant full pool control to any client. These
// tests drive the real server over loopback and assert:
//   - bare chat key (Bearer) → 403 admin_required on login/list/delete
//   - correct dashboard password (x-dashboard-password) → passes the admin gate
//   - /auth/status stays chat-key-visible (counts only, no email list)
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../src/server.js';
import { config } from '../src/config.js';
import { _resetLockoutForTests, configureBindHost } from '../src/auth.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';

const origApiKey = config.apiKey;
const origPw = config.dashboardPassword;
const origHost = config.host;
const origPort = config.port;
let server = null;

function waitListening(s) {
  return new Promise(r => { if (s.address()) return r(); s.once('listening', r); });
}
function req(port, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path, method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } },
      res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { let b; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode, body: b }); }); });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}

beforeEach(() => {
  _resetLockoutForTests();
  setRuntimeApiKey(''); setRuntimeDashboardPassword('');
  config.apiKey = 'sk-chat-shared';
  config.dashboardPassword = 'operator-pw';
  config.host = '127.0.0.1';
  configureBindHost('127.0.0.1');
  config.port = 0;
});
afterEach(async () => {
  if (server) { await new Promise(r => server.close(r)); server = null; }
  _resetLockoutForTests();
  config.apiKey = origApiKey; config.dashboardPassword = origPw;
  config.host = origHost; config.port = origPort;
});

describe('H1: account-pool management requires operator auth', () => {
  it('bare chat key → 403 on login / accounts / delete; status still 200', async () => {
    server = startServer(); await waitListening(server);
    const port = server.address().port;
    const chat = { authorization: 'Bearer sk-chat-shared' };

    const login = await req(port, 'POST', '/auth/login', chat, { api_key: 'x' });
    assert.equal(login.status, 403, 'login with chat key must be 403');
    assert.equal(login.body?.error?.code, 'admin_required');

    const list = await req(port, 'GET', '/auth/accounts', chat);
    assert.equal(list.status, 403, 'accounts list with chat key must be 403');

    const del = await req(port, 'DELETE', '/auth/accounts/whatever', chat);
    assert.equal(del.status, 403, 'delete with chat key must be 403');

    // status stays visible to a chat key (counts only, no email list).
    const status = await req(port, 'GET', '/auth/status', chat);
    assert.equal(status.status, 200);
    assert.equal(status.body?.accounts, undefined, 'status must NOT include the account/email list');
  });

  it('wrong/no key → 401 before even reaching the admin gate', async () => {
    server = startServer(); await waitListening(server);
    const port = server.address().port;
    const list = await req(port, 'GET', '/auth/accounts', { authorization: 'Bearer wrong' });
    assert.equal(list.status, 401, 'wrong chat key is 401 at the outer gate');
  });

  it('operator dashboard password passes the admin gate (list → 200)', async () => {
    server = startServer(); await waitListening(server);
    const port = server.address().port;
    const list = await req(port, 'GET', '/auth/accounts',
      { authorization: 'Bearer sk-chat-shared', 'x-dashboard-password': 'operator-pw' });
    assert.equal(list.status, 200, 'chat key + operator password lists accounts');
    assert.ok(Array.isArray(list.body?.accounts), 'returns the account list');
  });
});

describe('H-2 (audit 2026-07-13): /auth/* admin gate has brute-force lockout', () => {
  it('repeated wrong operator passwords get locked out (429) like /dashboard/api/*', async () => {
    server = startServer(); await waitListening(server);
    const port = server.address().port;
    // 5 wrong operator-password guesses (chat key valid, dashboard pw wrong) → 403 each,
    // feeding the lockout; the 6th should be 429 locked_out.
    let sawLock = false;
    for (let i = 0; i < 7; i++) {
      const r = await req(port, 'GET', '/auth/accounts',
        { authorization: 'Bearer sk-chat-shared', 'x-dashboard-password': 'wrong-guess-' + i });
      if (r.status === 429 && r.body?.error?.code === 'locked_out') { sawLock = true; break; }
      assert.equal(r.status, 403, `attempt ${i} expected 403 before lock, got ${r.status}`);
    }
    assert.ok(sawLock, 'brute-force lockout must trigger 429 after repeated wrong operator passwords');
  });
});
