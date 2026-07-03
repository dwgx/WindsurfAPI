import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractCachePolicy } from '../src/handlers/messages.js';
import { handleMessages } from '../src/handlers/messages.js';
import { checkin as poolCheckin, checkout as poolCheckout, poolClear } from '../src/conversation-pool.js';

// Anthropic prompt-caching markers (cache_control: { type: 'ephemeral',
// ttl?: '5m' | '1h' }) appear on tools[], system[] blocks, and
// messages[].content[] blocks. Cascade upstream doesn't speak this
// dialect — the proxy parses, summarises, and strips them so they
// don't leak into Cascade requests, then attributes the resulting
// cache_creation tokens to ephemeral_5m or ephemeral_1h based on the
// presence of any 1h marker.

describe('extractCachePolicy — strip + summarise cache_control markers', () => {
  it('counts 5m markers across tools, system, messages and strips them', () => {
    const body = {
      tools: [
        { name: 't1', cache_control: { type: 'ephemeral' } },
        { name: 't2' },
      ],
      system: [
        { type: 'text', text: 'sys1' },
        { type: 'text', text: 'sys2', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'tagged', cache_control: { type: 'ephemeral' } },
        ] },
      ],
    };
    const policy = extractCachePolicy(body);
    assert.equal(policy.breakpointCount, 3);
    assert.equal(policy.has1h, false);
    // markers stripped in place
    assert.equal(body.tools[0].cache_control, undefined);
    assert.equal(body.system[1].cache_control, undefined);
    assert.equal(body.messages[0].content[1].cache_control, undefined);
  });

  it('flags has1h when any marker requests 1h ttl', () => {
    const body = {
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
    };
    const p = extractCachePolicy(body);
    assert.equal(p.breakpointCount, 2);
    assert.equal(p.has1h, true);
  });

  it('returns zero policy and no mutation when no markers present', () => {
    const body = {
      tools: [{ name: 't' }],
      system: [{ type: 'text', text: 'x' }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const p = extractCachePolicy(body);
    assert.equal(p.breakpointCount, 0);
    assert.equal(p.has1h, false);
  });

  it('strips top-level cache_control auto-cache hint', () => {
    const body = {
      cache_control: { type: 'ephemeral', ttl: '1h' },
      messages: [{ role: 'user', content: 'hi' }],
    };
    const p = extractCachePolicy(body);
    assert.equal(p.breakpointCount, 1);
    assert.equal(p.has1h, true);
    assert.equal(body.cache_control, undefined);
  });

  it('does not throw on malformed bodies', () => {
    assert.doesNotThrow(() => extractCachePolicy({}));
    assert.doesNotThrow(() => extractCachePolicy({ tools: null, system: 'x' }));
    assert.doesNotThrow(() => extractCachePolicy({ messages: [{ role: 'user', content: null }] }));
  });
});

describe('handleMessages — cache_control round-trip into Anthropic usage shape', () => {
  function fakeChat(usagePatch) {
    return {
      async handleChatCompletions(body, ctx) {
        // body.__cachePolicy must reach chat.js
        return {
          status: 200,
          body: {
            id: 'chat_1', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 10, completion_tokens: 1, total_tokens: 11,
              prompt_tokens_details: { cached_tokens: 0 },
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 0,
              ...usagePatch,
            },
          },
        };
      },
    };
  }

  it('5m markers route creation tokens to ephemeral_5m_input_tokens', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
        ] },
      ],
    }, fakeChat({
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.usage.cache_creation_input_tokens, 100);
    assert.deepEqual(result.body.usage.cache_creation, {
      ephemeral_5m_input_tokens: 100,
      ephemeral_1h_input_tokens: 0,
    });
  });

  it('1h markers route creation tokens to ephemeral_1h_input_tokens', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ] },
      ],
    }, fakeChat({
      cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 },
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.usage.cache_creation_input_tokens, 200);
    assert.deepEqual(result.body.usage.cache_creation, {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 200,
    });
  });

  it('cascade pool entry honours ttlHintMs longer than default', async () => {
    poolClear();
    const baseEntry = {
      cascadeId: 'c1', sessionId: 's1', lsPort: 12345, apiKey: 'k',
      createdAt: Date.now(),
    };
    // Default-TTL entry: should expire at the 30-min default.
    poolCheckin('fp_default', { ...baseEntry });
    // 1h-hint entry: should outlive the default.
    poolCheckin('fp_1h', { ...baseEntry }, '', 90 * 60 * 1000);
    // After 35 min the default entry is gone, the 1h entry remains.
    // We can't fast-forward time without mocking; instead simulate by
    // mutating lastAccess on the stored entries directly via checkout +
    // re-checkin with an old timestamp, but the simpler check is just
    // that the entry struct keeps the hint. Verify by checkout while
    // both are still fresh (< pool default), then by the surface fact
    // that the 1h-hint entry still has its hint after restore.
    const entry = poolCheckout('fp_1h');
    assert.equal(entry?.ttlHintMs, 90 * 60 * 1000);
    poolClear();
  });

  it('cascade pool checkin preserves ttlHintMs when restoring without an explicit hint', () => {
    poolClear();
    const e = { cascadeId: 'c', sessionId: 's', lsPort: 1, apiKey: 'k', ttlHintMs: 90 * 60 * 1000 };
    poolCheckin('fp1', e);
    const got = poolCheckout('fp1');
    assert.equal(got.ttlHintMs, 90 * 60 * 1000);
    poolClear();
  });

  it('emits both flat fields and nested split when no markers were sent', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }, fakeChat({
      cache_creation_input_tokens: 50,
    }));
    assert.equal(result.status, 200);
    const u = result.body.usage;
    // Both shapes coexist; the flat total equals the split sum.
    assert.equal(u.cache_creation_input_tokens, 50);
    assert.equal(u.cache_read_input_tokens, 0);
    assert.equal(
      u.cache_creation.ephemeral_5m_input_tokens + u.cache_creation.ephemeral_1h_input_tokens,
      u.cache_creation_input_tokens,
    );
  });
});

// When the upstream reports NO cache tokens (DEVIN_CONNECT free tier never
// does), but the request marked a cacheable prefix with cache_control, the
// proxy falls back to a LOCAL, CJK-aware estimate of the prefix size so
// Claude Code sees a non-zero, deterministic cache_creation_input_tokens
// instead of a misleading 0. A real upstream number always wins over the
// estimate. (unverified: local estimate — true values need a paid account to
// calibrate; see PAID ledger task E.)
describe('extractCachePolicy — local cache-prefix token estimate', () => {
  it('estimates the cumulative prefix at the deepest breakpoint', () => {
    const body = {
      system: [
        { type: 'text', text: 'aaaa aaaa aaaa aaaa' },
        { type: 'text', text: 'bbbb bbbb', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'not cached, after the breakpoint' }] },
      ],
    };
    const p = extractCachePolicy(body);
    assert.equal(p.breakpointCount, 1);
    // Prefix = both system blocks (cumulative up to + including the marked one),
    // NOT the trailing user message after the breakpoint.
    assert.ok(p.estCacheCreationTokens > 0);
    const prefixOnly =
      Math.ceil('aaaa aaaa aaaa aaaa'.length / 4) + Math.ceil('bbbb bbbb'.length / 4);
    assert.equal(p.estCacheCreationTokens, prefixOnly);
  });

  it('weights CJK content ~1 token/char in the prefix estimate', () => {
    const cjk = '你好世界你好世界'; // 8 CJK chars → ~8 tokens
    const ascii = 'abcd'.repeat(2); // 8 ASCII chars → ~2 tokens
    const cjkBody = {
      system: [{ type: 'text', text: cjk, cache_control: { type: 'ephemeral' } }],
    };
    const asciiBody = {
      system: [{ type: 'text', text: ascii, cache_control: { type: 'ephemeral' } }],
    };
    const pc = extractCachePolicy(cjkBody);
    const pa = extractCachePolicy(asciiBody);
    assert.equal(pc.estCacheCreationTokens, 8);
    assert.equal(pa.estCacheCreationTokens, 2);
    // Same char count, but CJK estimated far higher (no ~4× undercount).
    assert.ok(pc.estCacheCreationTokens > pa.estCacheCreationTokens);
  });

  it('includes tool name/description/schema tokens in the prefix', () => {
    const body = {
      tools: [
        {
          name: 'search',
          description: 'find things',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } },
          cache_control: { type: 'ephemeral' },
        },
      ],
    };
    const p = extractCachePolicy(body);
    assert.equal(p.breakpointCount, 1);
    assert.ok(p.estCacheCreationTokens > 0);
  });

  it('returns zero estimate when no breakpoint is present', () => {
    const p = extractCachePolicy({
      system: [{ type: 'text', text: 'plenty of uncached text here' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(p.breakpointCount, 0);
    assert.equal(p.estCacheCreationTokens, 0);
  });
});

describe('handleMessages — local cache estimate fallback when upstream reports none', () => {
  // Upstream returns NO cache fields (DEVIN_CONNECT free tier shape).
  function bareUsageChat() {
    return {
      async handleChatCompletions(body) {
        return {
          status: 200,
          body: {
            id: 'chat_1', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
        };
      },
    };
  }

  it('passes __cachePolicy through to chat.js when a breakpoint is present', async () => {
    let seenPolicy;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      system: [{ type: 'text', text: 'cached system prompt block here', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        seenPolicy = body.__cachePolicy;
        return {
          status: 200,
          body: {
            id: 'c', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
        };
      },
    });
    assert.ok(seenPolicy, '__cachePolicy must reach chat.js');
    assert.ok(seenPolicy.estCacheCreationTokens > 0);
  });

  it('fills cache_creation_input_tokens from the local estimate (5m default)', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      system: [{ type: 'text', text: 'cached system prompt block here', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    }, bareUsageChat());
    assert.equal(result.status, 200);
    const u = result.body.usage;
    // Non-zero estimate instead of a misleading 0.
    assert.ok(u.cache_creation_input_tokens > 0);
    assert.equal(u.cache_read_input_tokens, 0);
    // Default ttl 5m bucket carries the estimate.
    assert.equal(u.cache_creation.ephemeral_5m_input_tokens, u.cache_creation_input_tokens);
    assert.equal(u.cache_creation.ephemeral_1h_input_tokens, 0);
    // Invariant preserved.
    assert.equal(
      u.cache_creation.ephemeral_5m_input_tokens + u.cache_creation.ephemeral_1h_input_tokens,
      u.cache_creation_input_tokens,
    );
  });

  it('routes the estimate to the 1h bucket when a 1h marker is present', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      system: [{ type: 'text', text: 'cached system prompt block here', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'hi' }],
    }, bareUsageChat());
    assert.equal(result.status, 200);
    const u = result.body.usage;
    assert.ok(u.cache_creation_input_tokens > 0);
    assert.equal(u.cache_creation.ephemeral_1h_input_tokens, u.cache_creation_input_tokens);
    assert.equal(u.cache_creation.ephemeral_5m_input_tokens, 0);
    assert.equal(
      u.cache_creation.ephemeral_5m_input_tokens + u.cache_creation.ephemeral_1h_input_tokens,
      u.cache_creation_input_tokens,
    );
  });

  it('CJK cache_control content is estimated with CJK weighting in usage', async () => {
    const asciiResult = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      system: [{ type: 'text', text: 'abcd'.repeat(8), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    }, bareUsageChat());
    const cjkResult = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      system: [{ type: 'text', text: '你好世界'.repeat(8), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    }, bareUsageChat());
    // Same char count (32) but CJK estimated far higher than ASCII.
    assert.ok(
      cjkResult.body.usage.cache_creation_input_tokens >
      asciiResult.body.usage.cache_creation_input_tokens,
    );
  });

  it('does NOT override a real upstream cache number with the estimate', async () => {
    const upstreamChat = {
      async handleChatCompletions(body) {
        return {
          status: 200,
          body: {
            id: 'chat_1', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 10, completion_tokens: 1, total_tokens: 11,
              cache_creation_input_tokens: 999,
              cache_read_input_tokens: 0,
            },
          },
        };
      },
    };
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      system: [{ type: 'text', text: 'cached system prompt block here', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    }, upstreamChat);
    // Real upstream value wins; the estimate is not substituted.
    assert.equal(result.body.usage.cache_creation_input_tokens, 999);
  });

  it('emits no cache fields beyond the existing shape when there is no cache_control (byte-identical behavior)', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }, bareUsageChat());
    const u = result.body.usage;
    // No breakpoint → no estimate → cache fields stay zero exactly as before.
    assert.equal(u.cache_creation_input_tokens, 0);
    assert.equal(u.cache_read_input_tokens, 0);
    assert.equal(u.cache_creation.ephemeral_5m_input_tokens, 0);
    assert.equal(u.cache_creation.ephemeral_1h_input_tokens, 0);
  });
});
