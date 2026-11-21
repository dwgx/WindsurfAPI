import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STICKY_SESSION_ENABLED = '1';
process.env.DEVIN_CONNECT = '1';
process.env.RESPONSE_CACHE_ENABLED = '0';
process.env.DEVIN_CONNECT_FAILOVER_MAX = '0';

const sticky = await import('../src/account/sticky-session.js');
const { addAccountByKey, removeAccount, getAccountInternal, getApiKey, releaseAccount,
  __setModelCatalogDeps, __waitForModelCatalogSync } = await import('../src/auth.js');
const { handleChatCompletions, bindConnectSticky, __setConnectDeps, __resetConnectDeps } = await import('../src/handlers/chat.js');
const { handleDashboardApi } = await import('../src/dashboard/api.js');
const { config } = await import('../src/config.js');
const { normalizeConnectUsage } = await import('../src/devin-connect.js');
const caller = 'api:00112233445566778899aabbccddeeff:user:private-fixture';
const selector = 'swe-2-medium';
function usage(read, write = 0) {
  return { prompt_tokens: 25, completion_tokens: 1, total_tokens: 26,
    prompt_tokens_details: { cached_tokens: read }, cache_creation_input_tokens: write };
}

test('an unreported Connect cache field stays unknown while its public JSON retains zero', () => {
  sticky.resetAllBindings();
  const account = { id: 'provider', apiKey: 'fixture' };
  const first = normalizeConnectUsage({ prompt: 12, completion: 2, cache_write_tokens: 7 });
  assert.deepEqual(JSON.parse(JSON.stringify(first)).prompt_tokens_details, { cached_tokens: 0 });
  bindConnectSticky(caller, account, selector, first);
  bindConnectSticky(caller, account, selector, normalizeConnectUsage({ prompt: 12, completion: 2, cache_read_tokens: 0 }));
  const row = sticky.getStickyCacheOutcomes().rows[0];
  assert.deepEqual([row.unknown, row.misses, row.writeTokens], [1, 1, 7]);
});

test('an expired binding cannot regain its counters on a later write to the same account', t => {
  sticky.resetAllBindings();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const account = { id: 'provider', apiKey: 'fixture' };
  bindConnectSticky(caller, account, selector, usage(12));
  const first = sticky.getStickyCacheOutcomes().rows[0];
  now += Number(process.env.STICKY_SESSION_TTL_MS || 1800000) + 1;
  assert.equal(sticky.getStickyCacheOutcomes().total, 0);
  bindConnectSticky(caller, account, selector, usage(0));
  const second = sticky.getStickyCacheOutcomes().rows[0];
  assert.notEqual(second.id, first.id);
  assert.deepEqual([second.hits, second.misses, second.readTokens], [0, 1, 0]);
});

test('account and selector identify separate cache histories; replacement retires earlier samples', () => {
  sticky.resetAllBindings();
  const a = { id: 'first-account', apiKey: 'private-key-A' }, b = { id: 'second-account', apiKey: 'private-key-B' };
  bindConnectSticky(caller, a, 'alpha', usage(0, 9));
  bindConnectSticky(caller, b, 'beta', usage(14));
  bindConnectSticky(caller, a, 'alpha', null);
  bindConnectSticky('api:00112233445566778899aabbccddeeff', a, 'alpha', usage(3));
  assert.equal(sticky.peekStickyBinding(caller, null, 'alpha').accountId, a.id);
  assert.equal(sticky.peekStickyBinding(caller, null, 'beta').accountId, b.id);
  const page = sticky.getStickyCacheOutcomes();
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map(r => [r.selector, r.hits, r.misses, r.unknown, r.readTokens, r.writeTokens]).sort(),
    [['alpha', 0, 1, 1, 0, 9], ['beta', 1, 0, 0, 14, 0]]);
  for (const secret of [caller, a.id, b.id, a.apiKey, b.apiKey]) assert.ok(!JSON.stringify(page).includes(secret));
  const oldId = page.rows.find(row => row.selector === 'alpha').id;
  bindConnectSticky(caller, b, 'alpha', usage(4));
  const rebound = sticky.getStickyCacheOutcomes().rows.find(row => row.selector === 'alpha');
  assert.notEqual(rebound.id, oldId);
  assert.deepEqual([rebound.hits, rebound.misses, rebound.unknown], [1, 0, 0]);
  sticky.clearStickyBinding(caller, null, 'beta');
  assert.equal(sticky.getStickyCacheOutcomes().total, 1);
});

test('successful buffered and streamed Connect turns attribute provider usage once', async t => {
  sticky.resetAllBindings();
  __setModelCatalogDeps({ fetchConfig: async () => ({ configs: [] }), fetchConnectCatalog: async () => [{ selector }], scheduleCatalogRetry: () => () => {} });
  const account = addAccountByKey('devin-session-token$offline-sticky-stat-fixture', 'sample');
  t.after(() => { removeAccount(account.id); __resetConnectDeps(); __setModelCatalogDeps(null); });
  await __waitForModelCatalogSync();
  const live = getAccountInternal(account.id);
  live.tier = 'pro'; live.credits = { weeklyPercent: 80, dailyPercent: 80 };
  let requests = 0;
  __setConnectDeps({
    async toChatCompletion() {
      requests++;
      return { status: 200, body: { model: selector, choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: usage(0, 7) } };
    },
    async streamChatCompletion(params, send) {
      requests++;
      await send({ choices: [{ index: 0, delta: { content: 'hello' } }] });
      return { delivered: true, content: 'hello', finish_reason: 'stop', usage: usage(12) };
    },
  });
  for (const stream of [false, true]) {
    const r = await handleChatCompletions({ model: selector, stream, messages: [{ role: 'user', content: 'hello' }] }, { callerKey: caller });
    assert.equal(r.status, 200);
    if (stream) {
      const res = { writableEnded: false, write() { return true; }, end() { this.writableEnded = true; }, on() {}, once() {}, removeListener() {}, setHeader() {}, writeHead() {}, flushHeaders() {} };
      await r.handler(res);
    }
  }
  assert.equal(requests, 2);
  const before = sticky.getStickyStats().hits;
  const next = getApiKey([], null, caller, selector);
  assert.equal(next.id, account.id);
  releaseAccount(next.apiKey);
  assert.equal(sticky.getStickyStats().hits, before + 1, 'the real lookup reads the same selector-bound record');
  const q = '/dashboard/api/connect-metrics?cacheBindings=1';
  const old = config.dashboardPassword; config.dashboardPassword = 'fixture-dashboard';
  let body;
  try {
    await handleDashboardApi('GET', '/connect-metrics', null, { url: q, headers: { 'x-dashboard-password': config.dashboardPassword }, socket: { remoteAddress: '127.0.0.1' } },
      { writeHead(status) { assert.equal(status, 200); }, end(text) { body = JSON.parse(text); } });
  } finally { config.dashboardPassword = old; }
  assert.equal(body.sticky.cacheOutcomes.total, 1);
  assert.equal(body.poolHealth, undefined);
  assert.ok(!JSON.stringify(body).includes(account.id));
  const row = body.sticky.cacheOutcomes.rows[0];
  assert.deepEqual([row.selector, row.hits, row.misses, row.unknown, row.readTokens, row.writeTokens], [selector, 1, 1, 0, 12, 7]);
});
