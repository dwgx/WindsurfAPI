import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginChatRequestLog, finalizeStatsScope, getRequestLog, recordRequest, resetStats, withStatsScope } from '../src/dashboard/stats.js';
import { startAttemptUsageFixture } from './fixtures/chat-attempt-usage-readback.mjs';

test('Connect failover keeps each upstream usage and charge on its own account and request', async t => {
  const fixture = await startAttemptUsageFixture();
  t.after(() => fixture.close());
  const { main, other, traffic } = await fixture.run();
  const [first, parallel, fallback] = traffic.filter(x => x.event === 'dispatch');
  assert.deepEqual(traffic.map(x => [x.event, x.step]), [
    ['dispatch', 'initial'], ['dispatch', 'concurrent'], ['report', 'initial'],
    ['dispatch', 'fallback'], ['report', 'fallback'], ['report', 'concurrent'],
  ]);
  assert.notEqual(first.account, fallback.account);
  assert.equal(parallel.account, fallback.account);
  assert.notEqual(main.id, other.id);
  assert.deepEqual([main.status, main.sawDone, main.reply], [200, true, 'fallback']);
  assert.deepEqual([other.status, other.sawDone, other.reply], [200, true, 'concurrent']);
  assert.deepEqual(main.rows.map(row => [row.account, row.success]), [[fallback.account, true], [first.account, false]]);
  assert.deepEqual(other.rows.map(row => [row.account, row.success]), [[parallel.account, true]]);
  assert.deepEqual(main.rows[0].requestDispatches, ['swe-1-7-medium', 'swe-1-7-medium']);
  assert.deepEqual(other.rows[0].requestDispatches, ['swe-1-7-medium']);
  const [mainRow] = getRequestLog({ requestId: main.id }).items;
  const [otherRow] = getRequestLog({ requestId: other.id }).items;
  assert.deepEqual(mainRow.requestAttemptUsage, [
    { account: first.account, observed: true, usage: { tokensIn: 11, tokensOut: 0 }, billing: null },
    { account: fallback.account, observed: true, usage: { tokensIn: 23, tokensOut: 5 }, billing: { credits: 47, acu: 2 } },
  ]);
  assert.deepEqual(otherRow.requestAttemptUsage, [
    { account: parallel.account, observed: true, usage: { tokensOut: 19 }, billing: { credits: 0 } },
  ]);
  assert.notEqual(mainRow.credit, 47, 'Existing accounting estimate is a separate field');
  assert.equal(mainRow.credit, otherRow.credit, 'Accounting estimate still uses the common model rate');
  assert.equal(main.rows[1].credit, 0);
});

test('a delayed transport report still updates its original dispatch after HTTP finalization', t => {
  resetStats();
  t.after(resetStats);
  const id = 'req_10000000-0000-4000-8000-000000000001';
  const otherId = 'req_10000000-0000-4000-8000-000000000002';
  const first = 'acct-00000001';
  const second = 'acct-00000002';
  const lookup = root => getRequestLog({ requestId: root }).items[0].requestAttemptUsage;

  const delayed = withStatsScope(scope => {
    const dispatch = beginChatRequestLog(scope, id, 'fixture', null);
    const observe = dispatch('fixture', first);
    dispatch('fixture', second)({ usage: { completion_tokens: 7 }, billing: { credit_cost: 5 } });
    recordRequest('fixture', true, 1, second);
    finalizeStatsScope(scope);
    return observe;
  });
  assert.deepEqual(lookup(id)[0], { account: first, observed: false, usage: null, billing: null });
  withStatsScope(scope => {
    const dispatch = beginChatRequestLog(scope, otherId, 'fixture', null);
    dispatch('fixture', second)({ usage: { completion_tokens: 13 } });
    recordRequest('fixture', true, 1, second);
    finalizeStatsScope(scope);
    delayed({ usage: { completion_tokens: 3 }, billing: { credit_cost: 0 } });
  });

  assert.deepEqual(lookup(id), [
    { account: first, observed: true, usage: { tokensOut: 3 }, billing: { credits: 0 } },
    { account: second, observed: true, usage: { tokensOut: 7 }, billing: { credits: 5 } },
  ]);
  assert.deepEqual(lookup(otherId), [
    { account: second, observed: true, usage: { tokensOut: 13 }, billing: null },
  ]);
});
