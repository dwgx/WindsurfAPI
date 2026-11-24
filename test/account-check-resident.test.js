import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { addAccountByKey, probeAccount, removeAccount } from '../src/auth.js';
import { WindsurfClient } from '../src/client.js';
import { probeOutcomeEntry } from '../src/dashboard/fleet-jobs.js';
import { __resetLsPoolForTests, getLsAdmissionStatus } from '../src/langserver.js';

const openAccounts = new Set();

afterEach(() => {
  __resetLsPoolForTests();
  for (const id of openAccounts) removeAccount(id);
  openAccounts.clear();
});

function accountWithResidentLs({ activeRequests = 0 } = {}) {
  const account = addAccountByKey('fixture-key-for-account-check', 'fixture account');
  openAccounts.add(account.id);
  __resetLsPoolForTests([{
    key: 'default', port: 42107, generation: 'fixture-resident',
    startedAt: Date.now(), lastUsedAt: Date.now(), ready: true, activeRequests,
  }]);
  return account;
}

test('an idle resident check can use its own lease and reads status once', async (t) => {
  const account = accountWithResidentLs();
  const rpc = t.mock.method(WindsurfClient.prototype, 'getUserStatus', async () => {
    assert.equal(getLsAdmissionStatus().maintenanceRequests, 1);
    return { tierName: 'pro', planName: 'Fixture Pro', allowedModels: [] };
  });
  const result = await probeAccount(account.id, { allowLsStart: false, canary: false });
  assert.equal(rpc.mock.callCount(), 1);
  assert.equal(result.skipped, undefined);
  assert.equal(result.tier, 'pro');
  assert.ok(account.lastProbed > 0);
  assert.equal(getLsAdmissionStatus().maintenanceRequests, 0);
});

test('a resident serving another request remains skipped', async (t) => {
  const account = accountWithResidentLs({ activeRequests: 1 });
  const rpc = t.mock.method(WindsurfClient.prototype, 'getUserStatus', async () => {});
  const result = await probeAccount(account.id, { allowLsStart: false, canary: false });
  assert.equal(result.skipped, true);
  assert.equal(rpc.mock.callCount(), 0);
  assert.equal(account.lastProbed, 0);
});

test('an upstream status failure is a failed check with no successful timestamp', async (t) => {
  const account = accountWithResidentLs();
  const rpc = t.mock.method(WindsurfClient.prototype, 'getUserStatus', async () => {
    throw new Error('fixture status unavailable');
  });
  const result = await probeAccount(account.id, { allowLsStart: false, canary: false });
  assert.equal(rpc.mock.callCount(), 1);
  assert.deepEqual(probeOutcomeEntry(account.id, result), {
    id: account.id, ok: false, error: 'ERR_ACCOUNT_CHECK_STATUS_UNAVAILABLE',
  });
  assert.equal(account.lastProbed, 0);
  assert.equal(getLsAdmissionStatus().maintenanceRequests, 0);
});
