// #234 — the connect live catalog must keep syncing as the pool changes.
//
// It used to be one module-level boolean: the first active account to sync set it,
// nothing ever cleared it, so adding a paid account to a free-only pool never
// refreshed the selector set. The pool-wide union was therefore unobtainable.
//
// De-latching alone would have been WORSE than the latch, which is what these
// tests pin: setLiveCatalogSelectors clears and repopulates, so a second account
// syncing after the first would SHRINK the live set to just its own selectors.
// Hence per-account rows unioned before every write.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetModelCatalogState, __setModelCatalogDeps, __waitForModelCatalogSync,
  addAccountByKey, removeAccount, getAccountInternal, setAccountStatus, trySyncModelCatalog,
} from '../src/auth.js';

const created = [];
let liveWrites = [];
let fetchCalls = [];
// Mutable so a test can change what an account answers on a LATER sync — needed to
// prove an empty answer leaves the account eligible rather than latched.
let perAccountRows = {};
const SAVED_CONNECT = process.env.DEVIN_CONNECT;

/** Install seams: record every fetch and every write to the resolver. */
function installDeps({ perAccount, now }) {
  liveWrites = [];
  fetchCalls = [];
  perAccountRows = { ...perAccount };
  __setModelCatalogDeps({
    // Cascade sync is irrelevant here and would make assertions noisy.
    getCascadeModelConfigs: async () => ({ configs: [] }),
    scheduleCatalogRetry: () => () => {},
    fetchConnectCatalog: async ({ token }) => {
      fetchCalls.push(token);
      return perAccountRows[token] || [];
    },
    ...(now ? { now } : {}),
    setLiveCatalogSelectors: (rows) => {
      liveWrites.push((rows || []).map((r) => (typeof r === 'string' ? r : r.selector)));
    },
  });
}

function mk(apiKey, tier = 'free') {
  const a = addAccountByKey(apiKey, 'delatch');
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = tier;
  created.push(a.id);
  return acct;
}

/** The union the resolver was last told about. */
function lastUnion() {
  return liveWrites.length ? [...liveWrites[liveWrites.length - 1]].sort() : [];
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  __resetModelCatalogState();
});

afterEach(async () => {
  while (created.length) removeAccount(created.pop());
  __setModelCatalogDeps(null);
  __resetModelCatalogState();
  if (SAVED_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = SAVED_CONNECT;
});

describe('connect catalog de-latch (#234)', () => {
  it('coalesces per account, not globally, when two accounts need their first sync together', async () => {
    installDeps({
      perAccount: {
        'sk-concurrent-a': [{ selector: 'swe-1-6-slow' }],
        'sk-concurrent-b': [{ selector: 'claude-opus-4-8-medium' }],
      },
    });

    mk('sk-concurrent-a', 'free');
    mk('sk-concurrent-b', 'pro');
    await __waitForModelCatalogSync();

    assert.deepEqual(new Set(fetchCalls), new Set(['sk-concurrent-a', 'sk-concurrent-b']));
  });

  it('refreshes a successful Connect catalog after the five-minute TTL', async () => {
    let now = 1_000_000;
    installDeps({
      perAccount: { 'sk-ttl': [{ selector: 'swe-1-6-slow' }] },
      now: () => now,
    });

    mk('sk-ttl', 'free');
    await __waitForModelCatalogSync();
    assert.equal(fetchCalls.length, 1);

    trySyncModelCatalog();
    await __waitForModelCatalogSync();
    assert.equal(fetchCalls.length, 1, 'fresh catalog is reused inside the TTL');

    now += 5 * 60 * 1000 + 1;
    perAccountRows['sk-ttl'] = [{ selector: 'swe-1-6-slow' }, { selector: 'swe-1-7' }];
    trySyncModelCatalog();
    await __waitForModelCatalogSync();

    assert.equal(fetchCalls.length, 2, 'expired catalog is fetched again');
    assert.ok(lastUnion().includes('swe-1-7'));
  });

  it('syncs a second account instead of latching after the first', async () => {
    installDeps({
      perAccount: {
        'sk-free-acct': [{ selector: 'swe-1-6-slow' }],
        'sk-paid-acct': [{ selector: 'claude-opus-4-8-medium' }],
      },
    });

    mk('sk-free-acct', 'free');
    await __waitForModelCatalogSync();
    mk('sk-paid-acct', 'pro');
    await __waitForModelCatalogSync();

    assert.ok(fetchCalls.includes('sk-paid-acct'),
      'the newly added account must be fetched; a module-level latch skipped it entirely');
  });

  it('unions selectors across accounts rather than replacing them', async () => {
    // The regression that makes a naive de-latch worse than the latch:
    // setLiveCatalogSelectors clears and repopulates, so the second sync would
    // otherwise drop the first account's selectors.
    installDeps({
      perAccount: {
        'sk-free-acct': [{ selector: 'swe-1-6-slow' }],
        'sk-paid-acct': [{ selector: 'claude-opus-4-8-medium' }],
      },
    });

    mk('sk-free-acct', 'free');
    await __waitForModelCatalogSync();
    mk('sk-paid-acct', 'pro');
    await __waitForModelCatalogSync();

    assert.deepEqual(lastUnion(), ['claude-opus-4-8-medium', 'swe-1-6-slow'],
      'the resolver must hold the union of both accounts, not just the last one');
  });

  it('does not let an empty response shrink the union', async () => {
    // Same asymmetry as the Cascade empty-catalog guard: an empty response is no
    // data, not "this account reaches nothing".
    installDeps({
      perAccount: {
        'sk-good-acct': [{ selector: 'swe-1-6-slow' }, { selector: 'claude-opus-4-8-medium' }],
        'sk-empty-acct': [],
      },
    });

    mk('sk-good-acct', 'pro');
    await __waitForModelCatalogSync();
    const afterGood = lastUnion();

    const emptyAcct = mk('sk-empty-acct', 'free');
    await __waitForModelCatalogSync();

    assert.deepEqual(lastUnion(), afterGood,
      'an empty catalog response must leave the existing union in place');
    assert.ok(afterGood.length === 2);

    // The union staying intact is NOT the interesting part — a union with an empty
    // contributor is unchanged arithmetically, so that assertion alone passes even
    // if the empty response was accepted and stored.
    //
    // The real damage of accepting it is that the account gets recorded as SYNCED
    // with nothing to contribute, and the per-key check then skips it forever — so
    // it never picks up selectors it genuinely gains later. Assert that instead:
    // the account must remain eligible, and a later non-empty response must land.
    const beforeRetry = fetchCalls.filter((k) => k === 'sk-empty-acct').length;
    perAccountRows['sk-empty-acct'] = [{ selector: 'glm-5-2-none' }];
    setAccountStatus(emptyAcct.id, 'active');
    await __waitForModelCatalogSync();

    assert.ok(
      fetchCalls.filter((k) => k === 'sk-empty-acct').length > beforeRetry,
      'an account that answered empty must stay eligible for re-sync, not be latched as synced',
    );
    assert.ok(lastUnion().includes('glm-5-2-none'),
      'once it answers non-empty, its selectors must reach the union');
  });

  it('withdraws a removed account\'s contribution from the union', async () => {
    installDeps({
      perAccount: {
        'sk-stay-acct': [{ selector: 'swe-1-6-slow' }],
        'sk-go-acct': [{ selector: 'claude-opus-4-8-medium' }],
      },
    });

    const stay = mk('sk-stay-acct', 'free');
    await __waitForModelCatalogSync();
    const go = mk('sk-go-acct', 'pro');
    await __waitForModelCatalogSync();
    assert.equal(lastUnion().length, 2, 'precondition: both contributed');

    // Remove the paid account directly (not via the shared cleanup list).
    const goIndex = created.indexOf(go.id);
    if (goIndex >= 0) created.splice(goIndex, 1);
    removeAccount(go.id);
    await __waitForModelCatalogSync();

    assert.ok(!lastUnion().includes('claude-opus-4-8-medium'),
      'a departed account must stop widening pool-wide discovery');
    assert.ok(stay.id, 'the remaining account is untouched');
  });

  it('does not re-fetch an account whose key has not changed', async () => {
    // The de-latch must not turn into a per-request fetch storm: the recorded value
    // is the apiKey, so an unchanged key stays satisfied and is skipped.
    installDeps({
      perAccount: { 'sk-stable-acct': [{ selector: 'swe-1-6-slow' }] },
    });

    const acct = mk('sk-stable-acct', 'pro');
    await __waitForModelCatalogSync();
    const firstCount = fetchCalls.filter((k) => k === 'sk-stable-acct').length;
    assert.equal(firstCount, 1, 'precondition: synced exactly once');

    // Drive the same trigger again with nothing changed.
    setAccountStatus(acct.id, 'active');
    await __waitForModelCatalogSync();

    assert.equal(
      fetchCalls.filter((k) => k === 'sk-stable-acct').length,
      firstCount,
      'an unchanged key must not be re-fetched — the de-latch is per key, not per call',
    );
  });
});
