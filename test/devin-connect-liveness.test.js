// Liveness probing for DEVIN_CONNECT session tokens.
//
// checkSessionLiveness reuses the zero-billable GetUserStatus RPC to learn
// whether a session_id is still accepted (200 → alive, 401/403 → dead) without
// spending any inference tokens. probeAndRecoverConnectAccount wires that into
// the account pool: a dead token is marked error + (if configured) re-logged in
// pre-emptively, BEFORE a user request lands on it.
//
// fetchUserStatus is network; here we test the pure liveness mapping by
// injecting the probe + login deps, so nothing touches a real endpoint.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, probeAndRecoverConnectAccount,
  __setReloginDeps, __resetReloginState, getAccountList,
} from '../src/auth.js';

let acct;
function setEnv(on) {
  if (on) process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
  else delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
}
function statusOf(id) { return getAccountList().find(a => a.id === id)?.status; }
function errorCountOf(id) { return getAccountList().find(a => a.id === id)?.errorCount ?? 0; }

beforeEach(() => {
  __resetReloginState();
  acct = addAccountByKey('devin-session-token$PROBE', 'liveness-test@example.com');
  acct.email = 'liveness-test@example.com';
  acct.method = 'email';
});
afterEach(() => {
  __setReloginDeps(null);
  __resetReloginState();
  setEnv(false);
  if (acct) removeAccount(acct.id);
});

describe('probeAndRecoverConnectAccount — alive', () => {
  it('reports alive on a 200 GetUserStatus', async () => {
    __setReloginDeps({ checkSessionLiveness: async () => ({ alive: true, plan: 'free' }) });
    const res = await probeAndRecoverConnectAccount(acct.id);
    assert.deepEqual(res, { alive: true });
  });

  it('restores an errored account to active when it probes alive again', async () => {
    acct.status = 'error';
    acct.errorCount = 4;
    __setReloginDeps({ checkSessionLiveness: async () => ({ alive: true, plan: 'pro' }) });
    const res = await probeAndRecoverConnectAccount(acct.id);
    assert.equal(res.alive, true);
    assert.equal(statusOf(acct.id), 'active');
    assert.equal(errorCountOf(acct.id), 0);
  });

  it('returns NO_ACCOUNT for an unknown id', async () => {
    const res = await probeAndRecoverConnectAccount('nope');
    assert.equal(res.alive, false);
    assert.equal(res.code, 'NO_ACCOUNT');
  });
});

describe('probeAndRecoverConnectAccount — dead session_id', () => {
  it('marks error and triggers re-login on UNAUTHORIZED when configured', async () => {
    setEnv(true);
    let loginCalls = 0;
    __setReloginDeps({
      checkSessionLiveness: async () => ({ alive: false, code: 'UNAUTHORIZED', error: '401' }),
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'devin-session-token$REBORN' }; },
    });
    const res = await probeAndRecoverConnectAccount(acct.id);
    assert.equal(res.alive, false);
    assert.equal(res.code, 'UNAUTHORIZED');
    assert.equal(res.recovered, true);
    assert.equal(loginCalls, 1);
    assert.equal(acct.apiKey, 'devin-session-token$REBORN');
    assert.equal(statusOf(acct.id), 'active', 're-login reset status');
  });

  it('marks dead but does not recover when auto-relogin is off', async () => {
    setEnv(false);
    let loginCalls = 0;
    __setReloginDeps({
      checkSessionLiveness: async () => ({ alive: false, code: 'UNAUTHORIZED' }),
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'x' }; },
    });
    const res = await probeAndRecoverConnectAccount(acct.id);
    assert.equal(res.alive, false);
    assert.equal(res.recovered, false);
    assert.equal(loginCalls, 0);
    assert.ok(errorCountOf(acct.id) >= 1, 'error budget moved on a dead probe');
  });

  it('does NOT re-login on a transient (rate-limit / 5xx) failure', async () => {
    setEnv(true);
    let loginCalls = 0;
    __setReloginDeps({
      checkSessionLiveness: async () => ({ alive: false, code: 'RATE_LIMITED' }),
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'x' }; },
    });
    const res = await probeAndRecoverConnectAccount(acct.id);
    assert.equal(res.alive, false);
    assert.equal(res.code, 'RATE_LIMITED');
    assert.equal(res.recovered, undefined, 'no recovery attempted for a transient failure');
    assert.equal(loginCalls, 0);
  });
});
