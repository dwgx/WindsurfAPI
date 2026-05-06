import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, cacheGet, cacheSet, cacheClear } from '../src/cache.js';

const originalResponseCacheEnabled = process.env.RESPONSE_CACHE_ENABLED;

beforeEach(() => {
  process.env.RESPONSE_CACHE_ENABLED = '1';
  cacheClear();
});

after(() => {
  if (originalResponseCacheEnabled === undefined) delete process.env.RESPONSE_CACHE_ENABLED;
  else process.env.RESPONSE_CACHE_ENABLED = originalResponseCacheEnabled;
});

describe('cacheKey', () => {
  it('produces deterministic keys', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(cacheKey(body), cacheKey(body));
  });

  it('differs for different models', () => {
    const a = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const b = { model: 'claude-4.5-sonnet', messages: [{ role: 'user', content: 'hi' }] };
    assert.notEqual(cacheKey(a), cacheKey(b));
  });

  it('ignores stream flag', () => {
    const a = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true };
    const b = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: false };
    assert.equal(cacheKey(a), cacheKey(b));
  });

  it('includes base64 image fingerprints in key', () => {
    const withImage = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(10000) } },
      ]}],
    };
    const withDifferentImage = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,DIFFERENT' + 'B'.repeat(10000) } },
      ]}],
    };
    assert.notEqual(cacheKey(withImage), cacheKey(withDifferentImage));
  });

  it('matches identical image content', () => {
    const image = 'data:image/png;base64,' + Buffer.from('same-image').toString('base64');
    const a = { model: 'gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: image } }] }] };
    const b = { model: 'gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: image } }] }] };
    assert.equal(cacheKey(a), cacheKey(b));
  });

  it('separates thinking settings', () => {
    const base = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    assert.notEqual(
      cacheKey({ ...base, thinking: { type: 'enabled' } }),
      cacheKey({ ...base, thinking: { type: 'disabled' } })
    );
  });
});

describe('cacheGet / cacheSet', () => {
  it('returns null on miss', () => {
    assert.equal(cacheGet('nonexistent'), null);
  });

  it('defaults to enabled when RESPONSE_CACHE_ENABLED is unset', () => {
    delete process.env.RESPONSE_CACHE_ENABLED;
    const value = { text: 'hello', thinking: null };
    cacheSet('default-enabled', value);
    assert.deepEqual(cacheGet('default-enabled'), value);
  });

  it('stores and retrieves values', () => {
    const value = { text: 'hello', thinking: null };
    cacheSet('key1', value);
    const got = cacheGet('key1');
    assert.deepEqual(got, value);
  });

  it('does not cache empty values', () => {
    cacheSet('empty', null);
    assert.equal(cacheGet('empty'), null);
    cacheSet('empty2', { text: '', chunks: [] });
    assert.equal(cacheGet('empty2'), null);
  });

  it('can be disabled with RESPONSE_CACHE_ENABLED=0', () => {
    process.env.RESPONSE_CACHE_ENABLED = '0';
    cacheSet('key1', { text: 'hello' });
    assert.equal(cacheGet('key1'), null);
  });
});
