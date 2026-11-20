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
  __setReloginDeps, __resetReloginState, __reloginGateState,
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
  // A row is auto-relogin eligible only when a successful login proved its
  // identity (or it carries the legacy store binding). The display label is
  // not identity.
  acct.identityEmail = EMAIL;
  acct.credentialEmail = EMAIL;
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
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'devin-session-token$NEW', identityEmail: EMAIL }; },
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
      windsurfLogin: async (email, pw) => { pwSeen = pw; return { apiKey: 'devin-session-token$FRESH', refreshToken: 'rt1', identityEmail: EMAIL }; },
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

describe('reLoginAccount — verified identity', () => {
  it('refuses a row with no verified identity instead of guessing from the label', async () => {
    setEnv(true);
    acct.identityEmail = '';
    acct.credentialEmail = '';
    let loginCalls = 0;
    let credCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => { credCalls++; return 'pw'; },
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'x', identityEmail: EMAIL }; },
    });
    assert.equal(await reLoginAccount(acct.id), false);
    assert.equal(credCalls, 0, 'the label must not be used as a store key');
    assert.equal(loginCalls, 0, 'an unverified row must not spend a login attempt');
    assert.equal(acct.apiKey, 'devin-session-token$DEAD');
  });

  it('uses the verified identity, not a renamed label, for lookup and login', async () => {
    setEnv(true);
    acct.email = 'renamed-label@example.test';
    let credentialKey;
    let loginEmail;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: (key) => { credentialKey = key; return 'pw'; },
      windsurfLogin: async (email) => {
        loginEmail = email;
        return { apiKey: 'devin-session-token$RENAMED', identityEmail: EMAIL };
      },
    });
    assert.equal(await reLoginAccount(acct.id), 'devin-session-token$RENAMED');
    assert.equal(credentialKey, EMAIL, 'the stored record is keyed by the verified address');
    assert.equal(loginEmail, EMAIL, 'the login must not use the renameable label');
    assert.equal(acct.email, 'renamed-label@example.test', 'a re-login does not rewrite the display label');
    assert.equal(acct.identityEmail, EMAIL);
  });

  it('rejects a result that proves a different identity without mutating the row', async () => {
    setEnv(true);
    acct.status = 'error';
    acct.errorCount = 3;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => ({
        apiKey: 'devin-session-token$SOMEONEELSE',
        identityEmail: 'someone-else@example.test',
      }),
    });
    assert.equal(await reLoginAccount(acct.id), false);
    assert.equal(acct.apiKey, 'devin-session-token$DEAD', 'a mismatched token must not be installed');
    assert.equal(acct.status, 'error', 'a mismatched login must not clear the health state');
    assert.equal(acct.errorCount, 3);
    assert.equal(acct.identityEmail, EMAIL);
    assert.equal(acct.credentialEmail, EMAIL, 'a mismatched login must not change the store binding');
  });

  it('rejects a result that proves no identity at all', async () => {
    setEnv(true);
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      // No identityEmail and no email: the result proves nothing about who it is.
      windsurfLogin: async () => ({ apiKey: 'devin-session-token$ANONYMOUS' }),
    });
    assert.equal(await reLoginAccount(acct.id), false);
    assert.equal(acct.apiKey, 'devin-session-token$DEAD');
    assert.equal(acct.identityEmail, EMAIL);
  });

  it('migrates a legacy credentialEmail-only row after a successful re-login', async () => {
    setEnv(true);
    acct.identityEmail = '';
    acct.credentialEmail = EMAIL;
    acct.status = 'error';
    let loginEmail;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: (key) => (key === EMAIL ? 'pw' : null),
      windsurfLogin: async (email) => {
        loginEmail = email;
        return { apiKey: 'devin-session-token$LEGACY', identityEmail: EMAIL };
      },
    });
    assert.equal(await reLoginAccount(acct.id), 'devin-session-token$LEGACY');
    assert.equal(loginEmail, EMAIL, 'the legacy store binding is the identity to verify');
    assert.equal(acct.identityEmail, EMAIL, 'a successful login persists the proven identity');
    assert.equal(acct.status, 'active');
  });
});

describe('reLoginAccount — throttle + de-dupe', () => {
  it('does not re-login twice within the cooldown', async () => {
    setEnv(true);
    let loginCalls = 0;
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'devin-session-token$N' + loginCalls, identityEmail: EMAIL }; },
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
      windsurfLogin: async () => { loginCalls++; return { apiKey: 'devin-session-token$N' + loginCalls, identityEmail: EMAIL }; },
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
        return { apiKey: 'devin-session-token$CONC', identityEmail: EMAIL };
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

describe('reLoginAccount — global concurrency gate (C4)', () => {
  // A mass token-death event: many DIFFERENT accounts re-login at once. The
  // per-account coalescing doesn't help across accounts, so without a global
  // cap all of them would hammer the upstream login in parallel.
  it('caps simultaneous logins fleet-wide and queues the rest', async () => {
    setEnv(true);
    process.env.DEVIN_CONNECT_RELOGIN_MAX_CONCURRENT = '2';
    __resetReloginState(); // pick up the new cap

    const ids = [];
    for (let i = 0; i < 5; i++) {
      const a = addAccountByKey(`devin-session-token$DEAD${i}`, `gate-${i}@example.com`);
      a.email = `gate-${i}@example.com`;
      a.identityEmail = `gate-${i}@example.com`;
      a.credentialEmail = `gate-${i}@example.com`;
      a.method = 'email';
      ids.push(a.id);
    }

    let active = 0;
    let peak = 0;
    const release = [];
    __setReloginDeps({
      isCredStoreEnabled: () => true,
      getCredential: () => 'pw',
      windsurfLogin: async (email) => {
        active++;
        peak = Math.max(peak, active);
        // Block until the test lets this login finish, so all 5 pile up against
        // the gate simultaneously and we can observe the cap.
        await new Promise(r => release.push(r));
        active--;
        return { apiKey: 'devin-session-token$NEW', identityEmail: email };
      },
    });

    const all = Promise.all(ids.map(id => reLoginAccount(id)));
    // Let the gate admit its first batch.
    await new Promise(r => setTimeout(r, 20));
    assert.equal(active, 2, 'only MAX_CONCURRENT logins run at once');
    const gate = __reloginGateState();
    assert.equal(gate.active, 2);
    assert.equal(gate.waiting, 3, 'the other 3 are queued, not stampeding');

    // Drain: release logins one at a time; the queue should feed through.
    while (release.length) {
      release.shift()();
      await new Promise(r => setTimeout(r, 10));
    }
    const results = await all;
    assert.equal(results.filter(r => r === 'devin-session-token$NEW').length, 5, 'all 5 eventually re-login');
    assert.ok(peak <= 2, `peak concurrency ${peak} must not exceed the cap`);

    for (const id of ids) removeAccount(id);
    delete process.env.DEVIN_CONNECT_RELOGIN_MAX_CONCURRENT;
    __resetReloginState();
  });
});
