// A16 — operator terminal states are authoritative.
//
// `disabled` and `banned` are operator decisions, not health verdicts. A request
// acquired before the operator flipped the switch can report its outcome after
// it (late success/error), and background recovery (auto re-login, liveness
// probe, token refresh) can finish after the flip. None of those may promote the
// credential back into rotation: only an explicit operator reset may leave a
// terminal state. These tests pin the transition table and the post-await
// identity/status revalidation that makes the flip durable.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetReauthChecks,
  __resetReloginState,
  __setReloginDeps,
  addAccountByKey,
  getAccountInternal,
  probeAndRecoverConnectAccount,
  reLoginAccount,
  removeAccount,
  reportBanSignal,
  reportError,
  reportSuccess,
  requestReauthCheck,
} from '../src/auth.js';

let seq = 0;
const created = new Set();

function newAccount(status = 'active', label = 'terminal') {
  const account = addAccountByKey(
    `devin-session-token$terminal-${++seq}-${Date.now()}`,
    `${label}-${seq}@example.com`,
  );
  account.email = `${label}-${seq}@example.com`;
  account.identityEmail = account.email;
  account.credentialEmail = account.email;
  account.method = 'email';
  if (status !== 'active') account.status = status;
  created.add(account.id);
  return account;
}

function setAutoRelogin(on) {
  if (on) process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
  else delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
}

beforeEach(() => {
  __resetReloginState();
  __resetReauthChecks();
});

afterEach(() => {
  for (const id of created) removeAccount(id);
  created.clear();
  __setReloginDeps(null);
  __resetReloginState();
  __resetReauthChecks();
  setAutoRelogin(false);
});

describe('late outcomes cannot override operator terminal states', () => {
  for (const status of ['disabled', 'banned']) {
    it(`late success leaves a ${status} account ${status}`, () => {
      const account = newAccount(status, `late-success-${status}`);
      account.errorCount = 3;
      account._errorAt = Date.now();
      if (status === 'banned') {
        account.bannedAt = 123456;
        account.bannedReason = 'Account suspended';
      }

      reportSuccess(account.apiKey);

      const live = getAccountInternal(account.id);
      assert.equal(live.status, status, 'a late success is not an operator reset');
      if (status === 'banned') {
        assert.equal(live.bannedAt, 123456, 'ban evidence survives');
        assert.equal(live.bannedReason, 'Account suspended');
      }
    });

    it(`late errors cannot walk a ${status} account into self-healing 'error'`, () => {
      const account = newAccount(status, `late-error-${status}`);
      for (let i = 0; i < 6; i++) reportError(account.apiKey);

      const live = getAccountInternal(account.id);
      assert.equal(live.status, status);
      assert.equal(live.errorCount, 0, 'a terminal account accumulates no error budget');
    });

    it(`ban signals cannot replace an operator ${status} with 'banned'`, () => {
      const account = newAccount(status, `ban-signal-${status}`);
      reportBanSignal(account.apiKey, 'Account suspended');
      reportBanSignal(account.apiKey, 'Invalid API key');

      assert.equal(getAccountInternal(account.id).status, status);
    });
  }

  it('CONTROL: success still promotes a self-healing error account to active', () => {
    const account = newAccount('error', 'error-control');
    account.errorCount = 4;
    account.erroredAt = Date.now();

    reportSuccess(account.apiKey);

    assert.equal(getAccountInternal(account.id).status, 'active');
    assert.equal(getAccountInternal(account.id).errorCount, 0);
  });

  it('CONTROL: a real error streak still disables an active account', () => {
    const peer = newAccount('active', 'error-peer');
    assert.ok(peer);
    const account = newAccount('active', 'error-control-active');
    for (let i = 0; i < 3; i++) reportError(account.apiKey);
    assert.equal(getAccountInternal(account.id).status, 'error');
  });
});

describe('automatic re-login cannot resurrect a terminal account', () => {
  for (const status of ['disabled', 'banned']) {
    it(`does not even attempt a login for a ${status} account`, async () => {
      setAutoRelogin(true);
      let loginCalls = 0;
      const account = newAccount(status, `relogin-start-${status}`);
      const originalKey = account.apiKey;
      __setReloginDeps({
        isCredStoreEnabled: () => true,
        getCredential: () => 'pw',
        windsurfLogin: async () => {
          loginCalls++;
          return { apiKey: 'devin-session-token$FRESH' };
        },
      });

      assert.equal(await reLoginAccount(account.id), false);
      assert.equal(loginCalls, 0, 'terminal accounts are out of the recovery path');
      assert.equal(getAccountInternal(account.id).status, status);
      assert.equal(getAccountInternal(account.id).apiKey, originalKey);
    });
  }

  it('discards a login that finished after the operator disabled the account', async () => {
    setAutoRelogin(true);
    const account = newAccount('active', 'relogin-mid-disable');
    const originalKey = account.apiKey;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => {
        account.status = 'disabled';
        return { apiKey: 'devin-session-token$FRESH', identityEmail: account.email };
      },
    });

    assert.equal(await reLoginAccount(account.id), false);
    const live = getAccountInternal(account.id);
    assert.equal(live.status, 'disabled', 'status revalidated after the awaited login');
    assert.equal(live.apiKey, originalKey, 'the discarded login must not install a token');
  });

  it('discards a login that finished after the account was removed', async () => {
    setAutoRelogin(true);
    const account = newAccount('active', 'relogin-mid-remove');
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => {
        removeAccount(account.id);
        return { apiKey: 'devin-session-token$FRESH', identityEmail: account.identityEmail };
      },
    });

    assert.equal(await reLoginAccount(account.id), false);
    assert.equal(getAccountInternal(account.id), null, 'a stale result cannot recreate the row');
  });

  it('discards a login that finished after the operator installed a different key', async () => {
    setAutoRelogin(true);
    const account = newAccount('active', 'relogin-mid-key');
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => {
        account.apiKey = 'devin-session-token$OPERATOR';
        return { apiKey: 'devin-session-token$FRESH', identityEmail: account.identityEmail };
      },
    });

    assert.equal(await reLoginAccount(account.id), false);
    assert.equal(getAccountInternal(account.id).apiKey, 'devin-session-token$OPERATOR');
  });
});

describe('liveness probe cannot resurrect a terminal account', () => {
  it('does not probe a disabled or banned account', async () => {
    for (const status of ['disabled', 'banned']) {
      const account = newAccount(status, `probe-start-${status}`);
      let probeCalls = 0;
      __setReloginDeps({
        checkSessionLiveness: async () => {
          probeCalls++;
          return { alive: true };
        },
      });
      const res = await probeAndRecoverConnectAccount(account.id);
      assert.equal(probeCalls, 0);
      assert.equal(res.alive, false);
      assert.equal(getAccountInternal(account.id).status, status);
    }
  });

  it('discards an ALIVE verdict that arrives after the operator disabled the account', async () => {
    const account = newAccount('error', 'probe-mid-disable-alive');
    account.errorCount = 4;
    __setReloginDeps({
      checkSessionLiveness: async () => {
        account.status = 'disabled';
        return { alive: true };
      },
    });

    const res = await probeAndRecoverConnectAccount(account.id);
    assert.equal(res.alive, false);
    assert.equal(getAccountInternal(account.id).status, 'disabled');
    assert.equal(getAccountInternal(account.id).errorCount, 4);
  });

  it('discards a DEAD verdict after the operator disabled the account (no error, no re-login)', async () => {
    setAutoRelogin(true);
    const account = newAccount('active', 'probe-mid-disable-dead');
    let loginCalls = 0;
    __setReloginDeps({
      checkSessionLiveness: async () => {
        account.status = 'disabled';
        return { alive: false, code: 'UNAUTHORIZED' };
      },
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => {
        loginCalls++;
        return { apiKey: 'devin-session-token$FRESH' };
      },
    });

    const res = await probeAndRecoverConnectAccount(account.id);
    assert.equal(res.alive, false);
    assert.equal(loginCalls, 0);
    assert.equal(getAccountInternal(account.id).status, 'disabled');
    assert.equal(getAccountInternal(account.id).errorCount, 0);
  });

  it('discards a verdict for an account removed while the probe was in flight', async () => {
    const account = newAccount('active', 'probe-mid-remove');
    __setReloginDeps({
      checkSessionLiveness: async () => {
        removeAccount(account.id);
        return { alive: true };
      },
    });

    const res = await probeAndRecoverConnectAccount(account.id);
    assert.equal(res.alive, false);
    assert.equal(getAccountInternal(account.id), null);
  });

  it('discards a verdict for a token the operator replaced mid-probe', async () => {
    const account = newAccount('error', 'probe-mid-key');
    account.errorCount = 2;
    __setReloginDeps({
      checkSessionLiveness: async () => {
        account.apiKey = 'devin-session-token$OPERATOR';
        return { alive: true };
      },
    });

    const res = await probeAndRecoverConnectAccount(account.id);
    assert.equal(res.alive, false);
    assert.equal(getAccountInternal(account.id).status, 'error');
    assert.equal(getAccountInternal(account.id).apiKey, 'devin-session-token$OPERATOR');
  });

  it('does not stamp a failed re-login verdict onto a row re-added with the same id', async () => {
    setAutoRelogin(true);
    const account = newAccount('active', 'probe-aba');
    const id = account.id;
    __setReloginDeps({
      checkSessionLiveness: async () => ({ alive: false, code: 'UNAUTHORIZED' }),
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => {
        // Delete + re-add under the same id while the recovery RPC is pending.
        removeAccount(id);
        const replacement = addAccountByKey('devin-session-token$replacement', 'replacement@example.com');
        replacement.id = id;
        throw new Error('login failed after ABA');
      },
    });

    const res = await probeAndRecoverConnectAccount(id);
    assert.equal(res.alive, false);
    assert.equal(res.recovered, false);
    const live = getAccountInternal(id);
    assert.ok(live, 'the replacement row exists');
    assert.equal(live.status, 'active', 'the old probe must not mark the new row reauth');
  });
});

describe('reauth probe verdicts cannot be applied to a changed row', () => {
  it('discards an ALIVE verdict after a mid-probe operator disable', async () => {
    const account = newAccount('active', 'reauth-probe-disable');
    __setReloginDeps({
      checkSessionLiveness: async () => {
        account.status = 'disabled';
        return { alive: true };
      },
    });

    const res = await requestReauthCheck(account.id, { force: true });
    assert.equal(res.checked, false);
    assert.equal(res.reason, 'NOT_ELIGIBLE');
    assert.equal(getAccountInternal(account.id).status, 'disabled');
  });

  it('discards an UNAUTHORIZED verdict for a row removed mid-probe', async () => {
    const account = newAccount('active', 'reauth-probe-remove');
    __setReloginDeps({
      checkSessionLiveness: async () => {
        removeAccount(account.id);
        return { alive: false, code: 'UNAUTHORIZED' };
      },
    });

    const res = await requestReauthCheck(account.id, { force: true });
    assert.equal(res.checked, false);
    assert.equal(res.reason, 'ACCOUNT_CHANGED');
    assert.equal(getAccountInternal(account.id), null);
  });
});
