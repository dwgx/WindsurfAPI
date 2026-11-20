import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __inflightStaleMs, __runInflightCleanup, __setModelCatalogDeps,
  __waitForModelCatalogSync, acquireAccountByKey, addAccountByKey,
  getApiKey, getRpmStats, releaseAccountById, removeAccount, reportError, setAccountTokens,
} from '../src/auth.js';
import { handleSpecialAgentChatCompletion } from '../src/special-agent.js';

const model = 'swe-1.6';
const testKey = 'pool-rotation-fixture-original';
const rotatedKey = 'pool-rotation-fixture-replacement';

function seedAccount(t) {
  const env = {
    WINDSURFAPI_SPECIAL_AGENT_BACKEND: 'devin-cli',
    DEVIN_CLI_MODE: 'acp',
    DEVIN_CLI_USE_ACCOUNT_POOL: '1',
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  __setModelCatalogDeps({
    fetchConnectCatalog: async () => [],
    getCascadeModelConfigs: async () => null,
  });
  const account = addAccountByKey(testKey, 'ACP accounting fixture');
  t.after(async () => {
    await __waitForModelCatalogSync();
    removeAccount(account.id);
    __setModelCatalogDeps(null);
    for (const [name, oldValue] of Object.entries(savedEnv)) {
      if (oldValue === undefined) delete process.env[name];
      else process.env[name] = oldValue;
    }
  });
  return account;
}

async function startTurn(t, { stream = false, fails = false } = {}) {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const completion = handleSpecialAgentChatCompletion({
    model,
    stream,
    messages: [{ role: 'user', content: 'A held test turn' }],
  }, { modelKey: model }, {
    probeDevinCliAvailable: () => ({ available: true }),
    runDevinAcp: async (_prompt, { apiKey }) => {
      assert.ok(apiKey === testKey, 'runner received the original checkout credential');
      started.resolve();
      await finish.promise;
      if (fails) throw new Error('Simulated backend failure');
      return { text: 'completed turn' };
    },
  }).then(async response => {
    if (!stream) return response;
    assert.equal(response.status, 200);
    let output = '';
    await response.handler({
      writableEnded: false,
      write(chunk) { output += chunk; },
      end() { this.writableEnded = true; },
    });
    return output;
  });
  await Promise.race([started.promise, completion.then(() => {
    throw new Error('ACP turn finished before the test runner started');
  })]);
  return {
    async complete() {
      finish.resolve();
      return completion;
    },
  };
}

for (const stream of [false, true]) {
  const responseMode = stream ? 'streaming' : 'buffered';
  for (const fails of [false, true]) {
    const outcome = fails ? 'failed' : 'successful';
    test(`a ${outcome} ${responseMode} ACP turn settles its own checkout after key rotation`, async t => {
      const account = seedAccount(t);
      const turn = await startTurn(t, { stream, fails });
      assert.equal(account._inflight, 1);
      assert.equal(getRpmStats()[account.id].used, 1);

      assert.equal(setAccountTokens(account.id, { apiKey: rotatedKey }), true);
      const later = acquireAccountByKey(rotatedKey, model);
      assert.ok(later, 'the same account accepted another request after rotation');
      assert.equal(account._inflight, 2);
      assert.equal(getRpmStats()[account.id].used, 2);

      const response = await turn.complete();
      if (stream) {
        assert.match(response, fails ? /"finish_reason":"error"/ : /completed turn/);
        assert.match(response, /data: \[DONE\]/);
      } else {
        assert.equal(response.status, fails ? 502 : 200);
      }
      assert.deepEqual({
        inflight: account._inflight,
        rpmUsed: getRpmStats()[account.id].used,
        laterCharged: account._rpmHistory.includes(later.reservationTimestamp),
      }, { inflight: 1, rpmUsed: fails ? 1 : 2, laterCharged: true });

      releaseAccountById(later.id);
      assert.equal(account._inflight, 0);
    });
  }
}

test('a late ACP completion leaves a checkout admitted after stale cleanup intact', async t => {
  const account = seedAccount(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const turn = await startTurn(t, { fails: true });
  assert.equal(account._inflight, 1);

  now += __inflightStaleMs() + 1000;
  assert.equal(__runInflightCleanup(), 1);
  const later = acquireAccountByKey(testKey, model);
  assert.ok(later);
  assert.equal(account._inflight, 1);
  assert.equal(getRpmStats()[account.id].used, 1);

  const response = await turn.complete();
  assert.equal(response.status, 502);
  assert.equal(account._inflight, 1, 'cleanup already retired the original checkout');
  assert.equal(getRpmStats()[account.id].used, 1);
  releaseAccountById(later.id);
  assert.equal(account._inflight, 0);
});

test('a failed ACP turn keeps the later reservation after its own RPM entry expires', async t => {
  const account = seedAccount(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const turn = await startTurn(t, { fails: true });

  now += 61_000;
  assert.equal(setAccountTokens(account.id, { apiKey: rotatedKey }), true);
  const later = acquireAccountByKey(rotatedKey, model);
  assert.ok(later);
  assert.equal(account._inflight, 2);
  assert.equal(getRpmStats()[account.id].used, 1);

  const response = await turn.complete();
  assert.equal(response.status, 502);
  assert.equal(account._inflight, 1);
  assert.deepEqual(account._rpmHistory, [later.reservationTimestamp]);
  releaseAccountById(later.id);
});

test('settling a tracked checkout again has no effect on account accounting', t => {
  const account = seedAccount(t);
  const original = getApiKey([], model, null, null, { trackReservation: true });
  const later = acquireAccountByKey(testKey, model);
  assert.ok(original && later);
  assert.equal(account._inflight, 2);

  original.settleReservation(false);
  original.settleReservation(true);
  assert.equal(account._inflight, 1, 'only the first settlement releases a slot');
  assert.equal(getRpmStats()[account.id].used, 2, 'a success keeps its charge');
  releaseAccountById(later.id);
});

test('a late untracked completion leaves the live ACP checkout intact', async t => {
  const account = seedAccount(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const original = acquireAccountByKey(testKey, model);
  assert.ok(original);
  now += __inflightStaleMs() + 1000;
  assert.equal(__runInflightCleanup(), 1);

  const turn = await startTurn(t);
  assert.equal(account._inflight, 1);
  releaseAccountById(original.id);
  assert.equal(account._inflight, 1, 'the late release cannot consume the live ACP slot');

  const response = await turn.complete();
  assert.equal(response.status, 200);
  assert.equal(account._inflight, 0);
});

test('a late streaming failure leaves the replacement account healthy', async t => {
  const original = seedAccount(t);
  const turn = await startTurn(t, { stream: true, fails: true });
  assert.equal(setAccountTokens(original.id, { apiKey: rotatedKey }), true);
  const replacement = addAccountByKey(testKey, 'Replacement ACP fixture');
  t.after(() => removeAccount(replacement.id));

  assert.match(await turn.complete(), /"finish_reason":"error"/);
  assert.equal(replacement.errorCount, 0);
  assert.equal(original._inflight, 0);
  assert.equal(getRpmStats()[original.id].used, 0);
});

test('a failed ACP turn settles its checkout after the account is removed', async t => {
  const original = seedAccount(t);
  const turn = await startTurn(t, { fails: true });
  assert.equal(removeAccount(original.id), true);
  const replacement = addAccountByKey(testKey, 'Recreated ACP fixture');
  t.after(() => removeAccount(replacement.id));

  const later = acquireAccountByKey(testKey, model);
  assert.ok(later);
  assert.equal(later.id, replacement.id);
  const response = await turn.complete();
  assert.equal(response.status, 502);
  const rpm = getRpmStats();
  assert.deepEqual({
    originalInflight: original._inflight,
    originalRpm: original._rpmHistory.length,
    removed: rpm[original.id] === undefined,
    replacementInflight: replacement._inflight,
    replacementRpm: rpm[replacement.id].used,
    replacementErrors: replacement.errorCount,
  }, {
    originalInflight: 0,
    originalRpm: 0,
    removed: true,
    replacementInflight: 1,
    replacementRpm: 1,
    replacementErrors: 0,
  });
  releaseAccountById(later.id);
});

test('returning to a previous key leaves the earlier buffered health result stale', async t => {
  const account = seedAccount(t);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const turn = await startTurn(t);
  assert.equal(setAccountTokens(account.id, { apiKey: rotatedKey }), true);
  assert.equal(setAccountTokens(account.id, { apiKey: testKey }), true);
  reportError(testKey);
  assert.equal(account.errorCount, 1);

  const response = await turn.complete();
  assert.equal(response.status, 200);
  assert.equal(account.errorCount, 1, 'the current credential keeps its own health state');
  assert.equal(account._inflight, 0);
  assert.equal(getRpmStats()[account.id].used, 1);
});

test('current ACP credentials still receive success and failure health signals', async t => {
  const account = seedAccount(t);
  const failed = await startTurn(t, { stream: true, fails: true });
  assert.match(await failed.complete(), /"finish_reason":"error"/);
  assert.equal(account.errorCount, 1);

  const successful = await startTurn(t);
  const response = await successful.complete();
  assert.equal(response.status, 200);
  assert.equal(account.errorCount, 0);
});
