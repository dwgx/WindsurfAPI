import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, cacheGet, cacheSet, cacheClear, cacheStats } from '../src/cache.js';

beforeEach(() => {
  delete process.env.RESPONSE_CACHE_MAX_BYTES;
  delete process.env.WINDSURFAPI_RESPONSE_CACHE_MAX_BYTES;
  cacheClear();
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

  it('separates output-affecting params (stop, seed)', () => {
    const base = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    assert.notEqual(cacheKey({ ...base, stop: ['END'] }), cacheKey(base));
    assert.notEqual(cacheKey({ ...base, seed: 1 }), cacheKey({ ...base, seed: 2 }));
  });

  it('audit #9: top_k is part of the key (a live DEVIN_CONNECT sampling knob)', () => {
    // Two requests differing only in top_k are different generations; without
    // top_k in the key the second would get a reply sampled under the first's.
    const base = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    assert.notEqual(cacheKey({ ...base, top_k: 10 }), cacheKey({ ...base, top_k: 40 }));
    assert.notEqual(cacheKey({ ...base, top_k: 10 }), cacheKey(base));
    // identical top_k still collapses to one slot
    assert.equal(cacheKey({ ...base, top_k: 20 }), cacheKey({ ...base, top_k: 20 }));
  });

  it('O3: max_completion_tokens and equal max_tokens collapse to one slot', () => {
    // The two spellings are the same generation, so they must share a cache key —
    // otherwise a client migrating from max_tokens to max_completion_tokens would
    // never hit the warm cache for an identical request.
    const base = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(
      cacheKey({ ...base, max_completion_tokens: 256 }),
      cacheKey({ ...base, max_tokens: 256 })
    );
  });

  it('O3: differing output caps still key apart', () => {
    const base = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    assert.notEqual(
      cacheKey({ ...base, max_completion_tokens: 256 }),
      cacheKey({ ...base, max_completion_tokens: 512 })
    );
  });

  it('O3: max_completion_tokens takes precedence over max_tokens in the key', () => {
    // Both present → the modern field wins, matching handleChatCompletions. So a
    // body with max_completion_tokens:500 keys the same regardless of max_tokens.
    const base = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(
      cacheKey({ ...base, max_completion_tokens: 500, max_tokens: 100 }),
      cacheKey({ ...base, max_completion_tokens: 500 })
    );
  });
});

describe('cacheGet / cacheSet', () => {
  it('returns null on miss', () => {
    assert.equal(cacheGet('nonexistent'), null);
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

  it('skips entries larger than the configured byte limit', () => {
    process.env.RESPONSE_CACHE_MAX_BYTES = '80';
    cacheSet('too-large', { text: 'x'.repeat(200) });

    assert.equal(cacheGet('too-large'), null);
    const stats = cacheStats();
    assert.equal(stats.size, 0);
    assert.equal(stats.skips, 1);
    assert.equal(stats.maxBytes, 80);
  });

  it('accepts byte units for the configured byte limit', () => {
    process.env.RESPONSE_CACHE_MAX_BYTES = '0.25kb';
    cacheSet('unit-sized', { text: 'x'.repeat(200) });

    assert.deepEqual(cacheGet('unit-sized'), { text: 'x'.repeat(200) });
    assert.equal(cacheStats().maxBytes, 256);
  });

  it('replaces an existing key with no cache entry when the new value is too large', () => {
    process.env.RESPONSE_CACHE_MAX_BYTES = '80';
    cacheSet('same', { text: 'small' });
    cacheSet('same', { text: 'x'.repeat(200) });

    assert.equal(cacheGet('same'), null);
    assert.equal(cacheStats().skips, 1);
  });

  it('evicts oldest entries to stay under the configured byte limit', () => {
    process.env.RESPONSE_CACHE_MAX_BYTES = '120';
    cacheSet('first', { text: 'a'.repeat(40) });
    cacheSet('second', { text: 'b'.repeat(40) });
    cacheSet('third', { text: 'c'.repeat(40) });

    assert.equal(cacheGet('first'), null);
    assert.deepEqual(cacheGet('second'), { text: 'b'.repeat(40) });
    assert.deepEqual(cacheGet('third'), { text: 'c'.repeat(40) });

    const stats = cacheStats();
    assert.equal(stats.size, 2);
    assert.ok(stats.bytes <= stats.maxBytes);
    assert.equal(stats.evictions, 1);
  });
});
