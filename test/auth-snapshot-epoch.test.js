// V-26 (audit CORE-007, NEEDS-EVIDENCE) — background billing/status snapshots
// across credential lifecycle epochs.
//
// A snapshot is a statement about ONE credential at ONE point in time. Both
// background readers capture an account row, await an upstream RPC, and then
// publish what they learned. If a re-login installs a new apiKey on that same
// row while the RPC is in flight, the published tier/entitlement/cost data
// describes the OLD credential and is installed on the NEW one.
//
// The pool already has the primitive for this: the guarded credit path
// (`_refreshCreditsImpl`) rejects a result whose account row or apiKey changed
// during the await, and requestReauthCheck / probeAndRecoverConnectAccount use
// the same isCurrentAccount + key-capture pair. These tests first REPRODUCE the
// race on the two unguarded paths (user status, billing) and then pin the
// guard. The delete/re-add ABA sub-claim is probed separately: object identity
// already rejects it, so it is documented, not "fixed" again.
//
// fetchUserStatus is exercised through its real source text with the network
// boundary substituted (the established seam used by s4-r3.test.js for
// refreshCredits): its dependencies are module-level dynamic imports.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addAccountByKey, removeAccount, setAccountTokens, refreshAccountBilling,
  __setModelCatalogDeps, sanitizeLabelText,
} from '../src/auth.js';

const created = [];

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

// ─── fetchUserStatus harness (real source text, substituted RPC boundary) ───
function loadFetchUserStatus({ statuses, ls = {} }) {
  const source = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
  const identity = source.match(/function isCurrentAccount\(account\) \{[^}]*\}/);
  assert.ok(identity, 'isCurrentAccount is present in the production source');
  const start = source.indexOf('export async function fetchUserStatus(');
  const end = source.indexOf('\n// Expanded canary set', start);
  assert.ok(start >= 0 && end > start, 'load the actual production fetchUserStatus block');
  const block = source.slice(start, end).replace(/^export /gm, '')
    .replace("await import('./client.js')", 'await Promise.resolve(_clientMod)')
    .replace("await import('./langserver.js')", 'await Promise.resolve(_lsMod)');

  const account = {
    id: 'a', email: 'v26@example.test', apiKey: 'key-old', tier: 'unknown',
    capabilities: {}, userStatus: null, userStatusLastFetched: 0, tierManual: false,
  };
  const accounts = [account];
  const tokens = [];
  const saves = { count: 0 };
  const _clientMod = {
    WindsurfClient: class {
      constructor(token) { this.token = token; }
      getUserStatus() { tokens.push(this.token); return statuses.promise; }
    },
  };
  const _lsMod = {
    ensureLs: ls.ensureLs || (async () => {}),
    getLsFor: ls.getLsFor || (() => ({ port: 1, csrfToken: 'csrf' })),
  };
  const deps = {
    accounts, _clientMod, _lsMod,
    getEffectiveProxy: () => null,
    getLsAdmissionForAccount: () => ({ wouldStart: false, key: null }),
    residentProbeSkip: () => null,
    safeAccountRef: a => a?.id || '?',
    // The eval'd source calls the real label boundary on upstream fields —
    // inject the actual helper so commit-path tests cannot hit ReferenceError.
    sanitizeLabelText,
    MODELS: {},
    log: { info() {}, warn() {}, debug() {} },
    saveAccounts: () => { saves.count++; },
  };
  const fetchUserStatus = new Function(
    ...Object.keys(deps),
    `${identity[0]}\n${block}\nreturn fetchUserStatus;`,
  )(...Object.values(deps));
  return { account, accounts, tokens, saves, fetchUserStatus };
}

const STATUS_OK = {
  tierName: 'pro', teamsTier: 0, pro: true, planName: 'Pro', email: 'v26@example.test',
  displayName: 'v26', teamId: '', isTeams: false, isEnterprise: false,
  hasPaidFeatures: true, trialEndMs: 0, userUsedPromptCredits: 1, userUsedFlowCredits: 2,
  monthlyPromptCredits: 100, monthlyFlowCredits: 100, maxPremiumChatMessages: 10,
  allowedModels: [],
};

function add(label) {
  const account = addAccountByKey(
    `v26-${label}-${Date.now()}-${created.length}-${Math.random().toString(36).slice(2)}`,
    label,
  );
  created.push(account.id);
  return account;
}

afterEach(() => {
  __setModelCatalogDeps(null);
  while (created.length) removeAccount(created.pop());
});

describe('V-26 — background snapshots are bound to one credential epoch', () => {
  it('a deferred old-key user-status snapshot cannot commit onto the new credential epoch', async () => {
    const status = deferred();
    const s = loadFetchUserStatus({ statuses: status });
    const pending = s.fetchUserStatus('a');
    await drain();
    assert.deepEqual(s.tokens, ['key-old'], 'the RPC ran under the credential captured at entry');

    // A re-login installs a new upstream key on the SAME row (setAccountTokens /
    // reLoginAccount do exactly this) while the status RPC is still in flight.
    s.account.apiKey = 'key-new';
    status.resolve(STATUS_OK);
    const result = await pending;

    assert.equal(result, null, 'the stale-epoch snapshot is discarded, not published');
    assert.equal(s.account.tier, 'unknown', 'the old credential plan does not set the new tier');
    assert.equal(s.account.userStatus, null, 'no entitlement snapshot from the old credential');
    assert.equal(s.account.userStatusLastFetched, 0, 'the new epoch is still unprobed');
    assert.deepEqual(s.account.capabilities, {}, 'no capability verdicts from the old credential');
    assert.equal(s.saves.count, 0, 'nothing is persisted for a discarded snapshot');
  });

  it('a deferred snapshot from a deleted/re-added account cannot commit to the new epoch', async () => {
    const status = deferred();
    const s = loadFetchUserStatus({ statuses: status });
    const pending = s.fetchUserStatus('a');
    await drain();

    // Delete + re-add that REUSES the id (the ABA case a lifecycle epoch would
    // have to catch). Object identity is what rejects it here.
    const readded = {
      id: 'a', email: 'v26@example.test', apiKey: 'key-old', tier: 'unknown',
      capabilities: {}, userStatus: null, userStatusLastFetched: 0, tierManual: false,
    };
    s.accounts.splice(0, s.accounts.length, readded);
    status.resolve(STATUS_OK);
    await pending;

    assert.equal(readded.tier, 'unknown', 'the new row keeps its own tier');
    assert.equal(readded.userStatus, null, 'the new row gets no entitlement snapshot');
    assert.equal(readded.userStatusLastFetched, 0);
  });

  it('a deferred old-key billing snapshot cannot publish onto the new credential epoch', async () => {
    const account = add('billing-epoch');
    const configs = deferred();
    const tokens = [];
    __setModelCatalogDeps({
      getCascadeModelConfigs: (token) => { tokens.push(token); return configs.promise; },
    });

    const pending = refreshAccountBilling(account.id, { force: true, now: 40_000_000 });
    await drain();
    assert.deepEqual(tokens, [account.apiKey], 'the RPC ran under the captured credential');

    setAccountTokens(account.id, { apiKey: `${account.apiKey}-rotated` });
    configs.resolve({ configs: [{ modelUid: 'uid-v26', creditMultiplier: 3 }] });
    const result = await pending;

    assert.equal(result.ok, false, 'the stale-epoch billing response is rejected');
    assert.equal(result.applied, undefined, 'no cost tier / rate was published');
    assert.equal(result.error, 'ACCOUNT_CHANGED');
  });

  it('a same-epoch billing snapshot still publishes (control)', async () => {
    const account = add('billing-control');
    const configs = deferred();
    __setModelCatalogDeps({
      getCascadeModelConfigs: () => configs.promise,
    });
    const pending = refreshAccountBilling(account.id, { force: true, now: 41_000_000 });
    await drain();
    configs.resolve({ configs: [{ modelUid: 'uid-v26-control', creditMultiplier: 1.5 }] });
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.rateRows, 1);
  });
});
