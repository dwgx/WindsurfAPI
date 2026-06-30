// reLoginAccount — auto-recovery for dead DEVIN_CONNECT session tokens.
//
// The session token is an opaque server-side session_id with no expiry/refresh,
// so when it dies the ONLY recovery is a fresh email/password Auth1 login. This
// covers the gating (env flag + cred store), the happy path (token swap +
// status reset), the throttle/de-dupe, and the no-credential / failure paths.
//
// Network + the encrypted store are injected via __setReloginDeps so nothing
// here touches a real endpoint or a real key.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, reLoginAccount,
  __setReloginDeps, __resetReloginState,
} from '../src/auth.js';

const EMAIL = 'relogin-test@example.com';
let acct;

function setEnv(on) {
  if (on) process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
  else delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
}

beforeEach(() => {
  __resetReloginState();
  acct = addAccountByKey('devin-session-token$DEAD', EMAIL);
  acct.email = EMAIL;
  acct.method = 'email';
});

afterEach(() => {
  __setReloginDeps(null);
  __resetReloginState();
  setEnv(false);
  if (acct) removeAccount(acct.id);
});

describe('reLoginAccount — gating', () => {
  it('is a no-op when DEVIN_CONNECT_AUTO_RELOGIN is unset', async () => {
    setEnv(false);
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'devin-session-token$NEW' }; },
    });
    const res = await reLoginAccount(acct.id);
    assert.equal(res, false);
    assert.equal(loginCalls, 0, 'must not attempt login when flag off');
  });

  it('is a no-op when the credential store is disabled', async () => {
    setEnv(true);
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => false,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'x' }; },
    });
    assert.equal(await reLoginAccount(acct.id), false);
    assert.equal(loginCalls, 0);
  });

  it('is a no-op when no stored credential exists for the email', async () => {
    setEnv(true);
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => null,
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'x' }; },
    });
    assert.equal(await reLoginAccount(acct.id), false);
    assert.equal(loginCalls, 0);
  });

  it('returns false for an unknown account id', async () => {
    setEnv(true);
    __setReloginDeps({ isCredStoreEnabled: () => true, getCredential: () => 'pw', windsurfLogin: async () => ({ apiKey: 'x' }) });
    assert.equal(await reLoginAccount('no-such-id'), false);
  });
});

describe('reLoginAccount — happy path', () => {
  it('swaps in the fresh token and resets account health', async () => {
    setEnv(true);
    acct.status = 'error';
    acct.errorCount = 5;
    acct._errorAt = Date.now();
    let pwSeen, emailSeen;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: (e) => { emailSeen = e; return 'the-password'; },
      windsurfLogin: async (email, pw) => { pwSeen = pw; return { apiKey: 'devin-session-token$FRESH', refreshToken: 'rt1' }; },
    });
    const res = await reLoginAccount(acct.id);
    assert.equal(res, 'devin-session-token$FRESH');
    assert.equal(acct.apiKey, 'devin-session-token$FRESH');
    assert.equal(acct.status, 'active');
    assert.equal(acct.errorCount, 0);
    assert.equal(acct.refreshToken, 'rt1');
    assert.equal(emailSeen, EMAIL);
    assert.equal(pwSeen, 'the-password');
  });

  it('returns false and keeps the old token when login throws', async () => {
    setEnv(true);
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { throw new Error('upstream 503'); },
    });
    assert.equal(await reLoginAccount(acct.id), false);
    assert.equal(acct.apiKey, 'devin-session-token$DEAD', 'token unchanged on failure');
  });

  it('returns false when login yields no apiKey', async () => {
    setEnv(true);
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => ({ apiKey: '' }),
    });
    assert.equal(await reLoginAccount(acct.id), false);
  });

  it('treats an unusable credential (decrypt throw) as a failure, not a crash', async () => {
    setEnv(true);
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => { throw new Error('Unsupported state or unable to authenticate data'); },
      windsurfLogin: async () => ({ apiKey: 'x' }),
    });
    assert.equal(await reLoginAccount(acct.id), false);
  });
});

describe('reLoginAccount — throttle + de-dupe', () => {
  it('does not re-login twice within the cooldown', async () => {
    setEnv(true);
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'devin-session-token$N' + loginCalls }; },
    });
    await reLoginAccount(acct.id);
    await reLoginAccount(acct.id);
    assert.equal(loginCalls, 1, 'second attempt within cooldown is skipped');
  });

  it('force=true bypasses the cooldown', async () => {
    setEnv(true);
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'devin-session-token$N' + loginCalls }; },
    });
    await reLoginAccount(acct.id);
    await reLoginAccount(acct.id, { force: true });
    assert.equal(loginCalls, 2);
  });

  it('coalesces concurrent callers onto a single login', async () => {
    setEnv(true);
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => {
        loginCalls++;
        await new Promise(r => setTimeout(r, 20));
        return { apiKey: 'devin-session-token$CONC' };
      },
    });
    const [a, b, c] = await Promise.all([
      reLoginAccount(acct.id), reLoginAccount(acct.id), reLoginAccount(acct.id),
    ]);
    assert.equal(loginCalls, 1, 'concurrent callers share one login');
    assert.equal(a, 'devin-session-token$CONC');
    assert.equal(b, 'devin-session-token$CONC');
    assert.equal(c, 'devin-session-token$CONC');
  });
});
