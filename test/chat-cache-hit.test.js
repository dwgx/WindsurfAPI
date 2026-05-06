import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { cacheClear, cacheKey, cacheSet } from '../src/cache.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

const createdAccountIds = [];
const originalResponseCacheEnabled = process.env.RESPONSE_CACHE_ENABLED;

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseChatFrames(raw) {
  return raw
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
      const payload = dataLine?.slice(6) || '';
      return payload === '[DONE]' ? '[DONE]' : JSON.parse(payload);
    });
}

afterEach(() => {
  cacheClear();
  if (originalResponseCacheEnabled === undefined) delete process.env.RESPONSE_CACHE_ENABLED;
  else process.env.RESPONSE_CACHE_ENABLED = originalResponseCacheEnabled;
  while (createdAccountIds.length) {
    removeAccount(createdAccountIds.pop());
  }
});

describe('chat cache-hit stream shape', () => {
  it('matches the live-stream finish chunk plus terminal usage chunk shape', async () => {
    const account = addAccountByKey(`cache-key-${Date.now()}`, 'cache-hit');
    createdAccountIds.push(account.id);

    const body = {
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    };
    process.env.RESPONSE_CACHE_ENABLED = '1';
    cacheSet(cacheKey(body), { text: 'cached answer', thinking: 'cached thinking' });

    const result = await handleChatCompletions(body);
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    const res = fakeRes();
    await result.handler(res);
    const frames = parseChatFrames(res.body);
    const finishChunk = frames.at(-3);
    const usageChunk = frames.at(-2);

    assert.equal(finishChunk.choices[0].finish_reason, 'stop');
    assert.equal('usage' in finishChunk, false);
    assert.deepEqual(usageChunk.choices, []);
    assert.deepEqual(usageChunk.usage, {
      cached: true,
      prompt_tokens: 1,
      completion_tokens: 4,
      total_tokens: 5,
      input_tokens: 1,
      output_tokens: 4,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    assert.equal(frames.at(-1), '[DONE]');
  });
});
