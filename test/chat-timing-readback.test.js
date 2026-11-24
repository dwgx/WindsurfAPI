import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTimingFixture } from './fixtures/chat-timing-readback.mjs';

test('Chat history keeps real Connect write, useful data and termination separate', async (t) => {
  const fixture = await startTimingFixture();
  t.after(() => fixture.close());
  const normal = await fixture.send();
  assert.equal(normal.status, 200);
  assert.equal(normal.sawText, true);
  assert.equal(normal.sawTool, true);
  assert.equal(normal.sawDone, true);
  const timing = normal.row.requestTiming;
  assert.ok(timing, 'the public request row needs timestamped observations');
  assert.ok(timing.receivedAt > 0);
  assert.equal(timing.connectAttempt, 1);
  for (const key of ['connectSentMs', 'firstContentMs', 'firstToolMs', 'upstreamTerminalMs', 'gatewayFinishedMs']) {
    assert.ok(Number.isInteger(timing[key]) && timing[key] >= 0, key);
  }
  assert.ok(timing.firstContentMs - timing.connectSentMs >= 180, 'empty first frame is not content');
  assert.ok(timing.firstToolMs - timing.firstContentMs >= 90, 'prose is not tool data');
  assert.ok(timing.upstreamTerminalMs >= timing.firstToolMs);
  assert.ok(timing.gatewayFinishedMs >= timing.upstreamTerminalMs);
  assert.equal(timing.clientDisconnectedMs, null);

  const control = await fixture.send();
  assert.equal(control.sawText, false);
  assert.equal(control.sawTool, false);
  const missing = control.row.requestTiming;
  for (const key of ['connectSentMs', 'upstreamTerminalMs', 'gatewayFinishedMs']) {
    assert.ok(Number.isInteger(missing[key]) && missing[key] >= 0, key);
  }
  assert.equal(missing.firstContentMs, null);
  assert.equal(missing.firstToolMs, null);
  assert.ok(missing.upstreamTerminalMs >= missing.connectSentMs);
  assert.ok(missing.gatewayFinishedMs >= missing.upstreamTerminalMs);
  assert.equal(fixture.count(), 2);
});
