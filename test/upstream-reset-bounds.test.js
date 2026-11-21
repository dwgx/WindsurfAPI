import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResetDuration, classifyUpstreamError } from '../src/devin-connect.js';
import { parseRateLimitCooldownMs, chatStreamError, clientRetryAfterSeconds } from '../src/handlers/chat.js';
import { addAccountByKey, getAccountInternal, markRateLimited, getRateLimitHistory, removeAccount } from '../src/auth.js';
import { quotaResetDelay, resetSecondsToMs, retryAfterHeaderMs } from '../src/reset-hints.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleGemini } from '../src/handlers/gemini.js';

const hour = 3600000;
const now = Date.UTC(2026, 10, 21, 10, 0);

test('both transports parse complete reset duration units before bounding them', () => {
  for (const parse of [parseResetDuration, parseRateLimitCooldownMs]) {
    for (const [value, ms] of [['500ms', 500], ['15m2.5s', 902500], ['3h0m0s', 3 * hour], ['700h', 6 * hour]]) {
      assert.equal(parse('Resets in: ' + value), ms);
    }
  }
  assert.equal(parseRateLimitCooldownMs('Retry after 800 hours'), 6 * hour);
  assert.equal(parseRateLimitCooldownMs('Retry after 500ms'), 500);
  assert.equal(parseRateLimitCooldownMs('Retry after 1.5 seconds'), 1500);
});

test('delta-seconds, proto strings and HTTP dates have the same upper bound', () => {
  assert.equal(resetSecondsToMs('0'), 0);
  assert.equal(resetSecondsToMs('12.5'), 12500);
  assert.equal(resetSecondsToMs(1e200), 6 * hour);
  assert.equal(retryAfterHeaderMs('9999999', now), 6 * hour);
  assert.equal(retryAfterHeaderMs(new Date(now + 30 * hour).toUTCString(), now), 6 * hour);
  for (const v of [null, '', ' ', '-1', 'invalid']) assert.equal(retryAfterHeaderMs(v, now), null);
});

test('a declared account window uses only its matching, plausible reset source and units', () => {
  const cr = { dailyResetAt: (now + hour) / 1000, periodEnd: now + 96 * hour };
  for (const [period, delay] of [['daily', hour], ['weekly', 96 * hour]]) {
    const error = classifyUpstreamError('Your ' + period + ' usage quota has been exhausted.', 'failed_precondition', 400);
    assert.equal(error.quotaPeriod, period);
    assert.equal(quotaResetDelay(cr, period, now), delay);
  }
  assert.equal(quotaResetDelay({ dailyResetAt: now + hour }, 'daily', now), null);
  assert.equal(quotaResetDelay({ periodEnd: now + 193 * hour }, 'weekly', now), null);
  assert.equal(quotaResetDelay({ ...cr, lastError: 'old' }, 'weekly', now), null);
  assert.equal(classifyUpstreamError('Out of credit', 'insufficient_quota', 402).quotaPeriod, undefined);
});

test('the pool records the raw reset while limiting the actual account deadline', () => {
  const account = addAccountByKey('fixture-upstream-reset-window', 'test');
  try {
    const start = Date.now();
    markRateLimited(account.apiKey, 1000 * hour, 'example', 'r');
    const until = getAccountInternal(account.id)._modelRateLimits.example;
    assert.ok(until >= start + 6 * hour && until <= Date.now() + 6 * hour);
    const row = getRateLimitHistory().find(e => e.accountId === account.id);
    assert.equal(row.upstreamMs, 1000 * hour);
    assert.equal(row.effectiveMs, 6 * hour);
    assert.equal(row.clamped, true);
  } finally { removeAccount(account.id); }
});

test('an already committed stream bounds client hints and drops malformed values', () => {
  const hint = chatStreamError('slow down', 'rate_limit_exceeded', 'RATE_LIMITED', { retry_after_ms: 400 * hour });
  assert.equal(hint.error.retry_after_ms, clientRetryAfterSeconds(400 * hour) * 1000);
  assert.equal(chatStreamError('slow down', 'rate_limit_exceeded', null, { retry_after_ms: -1 }).error.retry_after_ms, undefined);
});

for (const route of ['messages', 'responses', 'gemini']) {
  test(route + ' bounds the public error after the first content frame', async () => {
    const frame = o => 'data: ' + JSON.stringify(o) + '\n\n';
    for (const raw of [400 * hour, -1]) {
      const deps = { async handleChatCompletions() { return {
        status: 200, stream: true, async handler(res) {
          res.write(frame({ choices: [{ index: 0, delta: { content: 'first' } }] }));
          res.write(frame({ error: { code: 'RATE_LIMITED', message: 'later', retry_after_ms: raw } }));
          res.end();
        },
      }; } };
      let result;
      if (route === 'messages') result = await handleMessages({ model: 'claude-sonnet-4.6', max_tokens: 16,
        stream: true, messages: [{ role: 'user', content: 'go' }] }, deps);
      if (route === 'responses') result = await handleResponses({ model: 'gpt-5.2', stream: true, input: 'go' }, deps);
      if (route === 'gemini') result = await handleGemini('m', { contents: [{ role: 'user', parts: [{ text: 'go' }] }] }, deps, { stream: true, alt: 'sse' });
      const res = { body: '', writableEnded: false, write(s) { this.body += s; return true; },
        end() { this.writableEnded = true; }, on() {}, once() {}, setHeader() {}, writeHead() {}, flushHeaders() {} };
      await result.handler(res);
      assert.match(res.body, /later/);
      const hints = [...res.body.matchAll(/"retry_after_ms"\s*:\s*(-?\d+)/g)].map(m => Number(m[1]));
      assert.deepEqual(hints, raw < 0 ? [] : [clientRetryAfterSeconds(raw) * 1000]);
    }
  });
}
