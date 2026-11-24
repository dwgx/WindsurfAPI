import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCancelFixture } from './fixtures/chat-cancel-readback.mjs';
import { exportStats, getRequestLog, importStats } from '../src/dashboard/stats.js';

test('Chat history distinguishes a client abort from the Connect terminal and accounting fields', async (t) => {
  const fixture = await startCancelFixture();
  t.after(() => fixture.close());
  const interrupted = await fixture.disconnect();
  assert.equal(interrupted.status, 200);
  assert.equal(interrupted.finished, false);
  const row = await fixture.lookup(interrupted.id);
  await fixture.waitForUpstreamClose();
  assert.equal(row.requestHttpStatus, 200);
  assert.equal(row.requestDispatchCount, 1);
  assert.equal(row.reportedUsage, null);
  assert.deepEqual(fixture.counts(), { requests: 1, upstreamSocketCloses: 1 });
  assert.deepEqual(row.requestLifecycle, {
    clientDisconnected: true, gatewayAbortEmitted: true,
    transportAbortObserved: true, upstreamTerminal: 'not_observed',
    upstreamUsageReported: false, upstreamBillingReported: null,
  });
  const timing = row.requestTiming;
  assert.ok(Number.isInteger(timing.clientDisconnectedMs));
  assert.ok(timing.clientDisconnectedMs >= timing.firstContentMs);
  assert.equal(timing.upstreamTerminalMs, null);
  assert.ok(timing.gatewayFinishedMs >= timing.clientDisconnectedMs);

  const finished = await fixture.complete();
  assert.equal(finished.status, 200);
  assert.equal(finished.finished, true);
  const control = await fixture.lookup(finished.id);
  assert.notEqual(interrupted.id, finished.id);
  assert.deepEqual(control.requestLifecycle, {
    clientDisconnected: false, gatewayAbortEmitted: false,
    transportAbortObserved: false, upstreamTerminal: 'end_frame',
    upstreamUsageReported: true, upstreamBillingReported: true,
  });
  assert.deepEqual(fixture.counts(), { requests: 2, upstreamSocketCloses: 1 });
  const snapshot = exportStats();
  assert.equal(importStats(snapshot, { mode: 'replace' }).ok, true);
  assert.deepEqual(getRequestLog({ requestId: interrupted.id }).items[0].requestLifecycle, row.requestLifecycle);
});
