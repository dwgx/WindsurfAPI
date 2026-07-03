// devin-connect-relogin-live.test.js — REAL-credential recovery chain.
//
// The mock-injected coverage (devin-connect-relogin.test.js / -failover) proves
// the GATING and CONTROL FLOW of reLoginAccount + probeAndRecoverConnectAccount
// with a fake windsurfLogin. This file is the missing other half: it exercises
// the SAME chain end-to-end against the REAL windsurfLogin + the REAL AES-256-GCM
// credential store, so #23/#24/#27 are proven with an actual login — not a stub.
//
// It is OPT-IN and zero-billable. It runs only when fully armed:
//   RELOGIN_LIVE=1
//   RELOGIN_LIVE_EMAIL=<email>  RELOGIN_LIVE_PASSWORD=<password>
//   DEVIN_CONNECT_CRED_KEY=<master key>   (a throwaway key is fine)
// Otherwise every case is skipped (no token, no network) so CI stays green.
//
// What it proves, on a real account:
//   1. storeCredential → getCredential round-trips the real password (AES-GCM).
//   2. An account with a deliberately-dead token probes UNAUTHORIZED.
//   3. probeAndRecoverConnectAccount fires the REAL reLogin and swaps in a fresh,
//      live session token (verified with a zero-billable GetUserStatus).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, reLoginAccount,
  probeAndRecoverConnectAccount, __resetReloginState,
} from '../src/auth.js';
import {
  storeCredential, getCredential, deleteCredential, isCredStoreEnabled,
} from '../src/devin-connect-credentials.js';
import { fetchUserStatus } from '../src/devin-connect-catalog.js';

const LIVE = process.env.RELOGIN_LIVE === '1';
const EMAIL = process.env.RELOGIN_LIVE_EMAIL || '';
const PASSWORD = process.env.RELOGIN_LIVE_PASSWORD || '';
// Armed only when the live flag, real credentials, AND a cred-store key are all
// present. Anything missing → skip (this is opt-in, never a CI failure).
const ARMED = LIVE && Boolean(EMAIL) && Boolean(PASSWORD) && isCredStoreEnabled();

const SKIP_MSG = 'not armed — set RELOGIN_LIVE=1 + RELOGIN_LIVE_EMAIL/PASSWORD + DEVIN_CONNECT_CRED_KEY';

let acct;

afterEach(() => {
  __resetReloginState();
  delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  if (acct) { removeAccount(acct.id); acct = null; }
  if (ARMED && EMAIL) { try { deleteCredential(EMAIL); } catch { /* best-effort */ } }
});

describe('reLogin live recovery chain (real credentials)', { skip: ARMED ? false : SKIP_MSG }, () => {
  beforeEach(() => {
    // Set per-test: afterEach clears it, so a once-only `before` would leave
    // tests 2+ running with auto-relogin disarmed (reLogin then bails false).
    process.env.DEVIN_CONNECT_AUTO_RELOGIN = '1';
  });

  it('round-trips the real password through the AES-GCM store', () => {
    assert.equal(storeCredential(EMAIL, PASSWORD), true);
    assert.equal(getCredential(EMAIL), PASSWORD);
  });

  it('revives a deliberately-dead token via a real login', async () => {
    // Arm the store with the real password, then plant a dead token.
    storeCredential(EMAIL, PASSWORD);
    acct = addAccountByKey('devin-session-token$DEAD-FOR-TEST', EMAIL);
    acct.email = EMAIL;
    acct.method = 'email';

    const fresh = await reLoginAccount(acct.id, { force: true });
    assert.ok(typeof fresh === 'string' && fresh.startsWith('devin-session-token$'),
      `reLogin returned a fresh session token (got ${typeof fresh})`);
    assert.notEqual(fresh, 'devin-session-token$DEAD-FOR-TEST', 'token actually changed');
    assert.equal(acct.apiKey, fresh, 'account token swapped in place');
    assert.equal(acct.status, 'active', 'account marked active after recovery');

    // The fresh token is genuinely live (zero-billable status probe).
    const st = await fetchUserStatus({ token: fresh });
    assert.ok(st && (st.plan || st.isPaid !== undefined), 'fresh token answers GetUserStatus');
  });

  it('probeAndRecoverConnectAccount detects death and recovers', async () => {
    storeCredential(EMAIL, PASSWORD);
    acct = addAccountByKey('devin-session-token$DEAD-AGAIN', EMAIL);
    acct.email = EMAIL;
    acct.method = 'email';

    const r = await probeAndRecoverConnectAccount(acct.id);
    // The dead planted token probes UNAUTHORIZED → recovered via real reLogin.
    assert.equal(r.alive, false, 'planted dead token probes not-alive');
    assert.equal(r.recovered, true, 'recovered through the real login path');
    assert.ok(acct.apiKey.startsWith('devin-session-token$') && acct.apiKey !== 'devin-session-token$DEAD-AGAIN',
      'account now holds a fresh token');
  });
});
