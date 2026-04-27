// Regression for issue #77 — `Stream error after retries:` with EMPTY message.
//
// When `waitForAccount()` times out after QUEUE_MAX_WAIT_MS and returns null
// (every eligible account is rate-limited, has no entitlement for the
// requested model, or is otherwise unavailable), both the stream and non-
// stream retry loops used to `break` without ever assigning lastErr. The
// final log line then printed an empty string and the SSE error event sent
// to the client carried no useful diagnostic — appearing as a 30 second
// silent stall to clients like Cherry Studio.
//
// This test reads chat.js statically and asserts that both queue-timeout
// branches now populate lastErr with a real error object that names the
// reason (rate-limited / temporarily unavailable / no entitlement).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

test('stream queue-timeout no longer breaks with empty lastErr (#77)', () => {
  const src = readFileSync(join(root, 'src/handlers/chat.js'), 'utf8');

  // Find the stream-path waitForAccountFn call and inspect what happens on
  // the null-return branch. Must populate lastErr before breaking.
  const streamCall = src.indexOf('await waitForAccountFn(tried, abortController.signal');
  assert.ok(streamCall > -1, 'stream waitForAccountFn call must exist');

  // The next 1500 chars after the call should contain a lastErr assignment
  // before any `break` token is reached on the if (!acct) branch.
  const slice = src.slice(streamCall, streamCall + 1500);
  assert.match(
    slice,
    /lastErr\s*=/,
    'stream queue-timeout branch must assign lastErr so the final log line and SSE error frame surface a real diagnostic',
  );
  assert.match(
    slice,
    /isAllTemporarilyUnavailable\(modelKey\)|isAllRateLimited\(modelKey\)/,
    'stream queue-timeout branch must classify the reason (rate-limited / temporarily unavailable) so the operator knows what kept the queue empty',
  );
});

test('non-stream queue-timeout no longer breaks with empty lastErr (#77)', () => {
  const src = readFileSync(join(root, 'src/handlers/chat.js'), 'utf8');

  // Non-stream path uses waitForAccountFn(tried, null, ...) — different signal.
  const nonStreamCall = src.indexOf('await waitForAccountFn(tried, null');
  assert.ok(nonStreamCall > -1, 'non-stream waitForAccountFn call must exist');

  const slice = src.slice(nonStreamCall, nonStreamCall + 1500);
  assert.match(
    slice,
    /lastErr\s*=/,
    'non-stream queue-timeout branch must assign lastErr so the response carries a real error body',
  );
  assert.match(
    slice,
    /isAllTemporarilyUnavailable\(modelKey\)|isAllRateLimited\(modelKey\)/,
    'non-stream queue-timeout branch must classify the reason for empty pool',
  );
});

test('Stream error after retries log uses a fallback when lastErr is null (#77)', () => {
  const src = readFileSync(join(root, 'src/handlers/chat.js'), 'utf8');

  // The retries-failed log must not rely on `lastErr?.message` alone; if it
  // does, a null lastErr leaks an empty error message to the operator log.
  assert.match(
    src,
    /log\.error\('Stream error after retries:',\s*lastErr\?\.message\s*\|\|/,
    'log.error must include a fallback after lastErr?.message so an empty/null lastErr never produces an unidentifiable log line',
  );
});
