import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.STICKY_SESSION_ENABLED = '1';

const auth = await import('../src/auth.js');
const sticky = await import('../src/account/sticky-session.js');
const { __testing: { waitForAccount, waitForOwnPin } } = await import('../src/handlers/chat.js');

const fixtureKey = 'queue-wakeup-fixture';
const callerKey = 'queue-wakeup-caller';

function seedAccount(t, pinWaitMs = 0) {
  const env = {
    DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT: '1',
    WINDSURFAPI_STICKY_QUEUE_ON_PIN_MS: String(pinWaitMs),
  };
  const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  auth.__setModelCatalogDeps({
    fetchConnectCatalog: async () => [],
    getCascadeModelConfigs: async () => null,
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const account = auth.addAccountByKey(fixtureKey, 'Queue wakeup fixture');
  t.after(async () => {
    await auth.__waitForModelCatalogSync();
    auth.removeAccount(account.id);
    auth.__setModelCatalogDeps(null);
    sticky.resetAllBindings();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return account;
}

function accounting(account, checkout) {
  const observed = {
    acquired: checkout?.id === account.id,
    inflight: account._inflight || 0,
    rpm: auth.getRpmStats()[account.id].used,
  };
  if (checkout) auth.releaseAccountById(checkout.id);
  return observed;
}

for (const state of ['cancelled', 'expired', 'active']) {
  test(`an account queue wakeup respects a waiting request that is ${state}`, async t => {
    const account = seedAccount(t);
    const first = auth.getApiKey();
    assert.ok(first);
    const controller = new AbortController();
    const waitMs = state === 'expired' ? 750 : 2000;
    const waiting = waitForAccount([], controller.signal, waitMs);
    await Promise.resolve();

    t.mock.timers.tick(500);
    auth.releaseAccountById(first.id);
    if (state === 'cancelled') controller.abort();
    t.mock.timers.tick(500);

    const checkout = await waiting;
    assert.deepEqual(accounting(account, checkout), state === 'active'
      ? { acquired: true, inflight: 1, rpm: 2 }
      : { acquired: false, inflight: 0, rpm: 1 });
  });
}

test('zero wait budget retains the immediate lookup contract', async t => {
  const account = seedAccount(t);
  const checkout = await waitForAccount([], AbortSignal.abort(), 0);
  assert.deepEqual(accounting(account, checkout), { acquired: true, inflight: 1, rpm: 1 });
});

test('a sticky wait also observes the caller queue deadline', async t => {
  const account = seedAccount(t, 3000);
  sticky.setStickyBinding(callerKey, null, account.id, fixtureKey);
  auth.markRateLimited(fixtureKey, 1000);

  const waiting = waitForAccount([], null, 1000, null, callerKey);
  t.mock.timers.tick(1000);

  const checkout = await waiting;
  assert.deepEqual(accounting(account, checkout), { acquired: false, inflight: 0, rpm: 0 });
});

test('a pinned poll does not acquire at its own timeout boundary', async t => {
  const account = seedAccount(t, 1000);
  sticky.setStickyBinding(callerKey, null, account.id, fixtureKey);
  auth.markRateLimited(fixtureKey, 1000);

  const waiting = waitForOwnPin([], null, null, callerKey, null);
  t.mock.timers.tick(1000);

  const result = await waiting;
  assert.equal(result.aborted, false);
  assert.deepEqual(accounting(account, result.acct), { acquired: false, inflight: 0, rpm: 0 });
});

test('an active caller can fall back after its pin wait expires', async t => {
  const account = seedAccount(t, 1000);
  const substitute = auth.addAccountByKey('queue-wakeup-substitute', 'Queue substitute fixture');
  t.after(() => auth.removeAccount(substitute.id));
  sticky.setStickyBinding(callerKey, null, account.id, fixtureKey);
  auth.markRateLimited(fixtureKey, 1000);

  const waiting = waitForAccount([], null, 3000, null, callerKey);
  t.mock.timers.tick(500);
  auth.markRateLimited(fixtureKey, 1000);
  t.mock.timers.tick(500);

  const checkout = await waiting;
  assert.equal(auth.getRpmStats()[account.id].used, 0);
  assert.deepEqual(accounting(substitute, checkout), { acquired: true, inflight: 1, rpm: 1 });
});

for (const reason of ['cooldown', 'RPM window']) {
  test(`a pin can observe ${reason} recovery between ordinary polls`, async t => {
    const account = seedAccount(t, 1500);
    sticky.setStickyBinding(callerKey, null, account.id, fixtureKey);
    if (reason === 'cooldown') {
      auth.markRateLimited(fixtureKey, 1200);
    } else {
      const oldest = Date.now() - 58_800;
      const { limit } = auth.getRpmStats()[account.id];
      account._rpmHistory = Array.from({ length: limit }, (_, index) => oldest + index);
    }
    assert.equal(auth.getAccountAvailability(fixtureKey).retryAfterMs, 1200);

    const waiting = waitForOwnPin([], null, null, callerKey, null);
    t.mock.timers.tick(1000);
    await Promise.resolve();
    t.mock.timers.tick(200);
    await Promise.resolve();
    const inflightAtRecovery = account._inflight || 0;
    t.mock.timers.tick(1);
    await Promise.resolve();
    const inflightAfterRecovery = account._inflight || 0;
    t.mock.timers.tick(299);

    const result = await waiting;
    if (result.acct) auth.releaseAccountById(result.acct.id);
    assert.deepEqual(
      { inflightAtRecovery, inflightAfterRecovery, accountId: result.acct?.id },
      { inflightAtRecovery: reason === 'cooldown' ? 1 : 0, inflightAfterRecovery: 1, accountId: account.id },
    );
  });
}

test('a stale pin recovery hint adds only one probe', async t => {
  const account = seedAccount(t, 1500);
  sticky.setStickyBinding(callerKey, null, account.id, fixtureKey);
  auth.markRateLimited(fixtureKey, 1200);
  const schedule = globalThis.setTimeout;
  const pollDelays = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms <= 1500) pollDelays.push(ms);
    return schedule(fn, ms, ...args);
  });

  const waiting = waitForOwnPin([], null, null, callerKey, null);
  t.mock.timers.tick(1000);
  auth.markRateLimited(fixtureKey, 1000);
  await Promise.resolve();
  t.mock.timers.tick(200);
  await Promise.resolve();
  t.mock.timers.tick(300);

  const result = await waiting;
  assert.deepEqual(accounting(account, result.acct), { acquired: false, inflight: 0, rpm: 0 });
  assert.deepEqual(pollDelays, [1000, 200, 300]);
});
