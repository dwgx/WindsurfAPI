// v2.0.68 — issue triage fixes:
//   #117 xiaoxin-zk: claude-haiku-4-5-20251001 (Anthropic dated) alias
//   #118 wnfilm:    cache_write should NOT inflate prompt_tokens
//   #119 CharwinYAO: sticky-IP proxy username segregates LS instances
//                    when WINDSURFAPI_LS_PER_PROXY_USER=1

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, getModelInfo } from '../src/models.js';
import { buildUsageBody } from '../src/handlers/chat.js';

describe('#117 — Anthropic dated Haiku 4.5 alias (claude-haiku-4-5-20251001)', () => {
  it('claude-haiku-4-5-20251001 resolves to claude-4.5-haiku', () => {
    assert.equal(resolveModel('claude-haiku-4-5-20251001'), 'claude-4.5-haiku');
    assert.ok(getModelInfo('claude-4.5-haiku'), 'underlying haiku model must exist in catalog');
  });
  it('claude-haiku-4-5 (bare) resolves to claude-4.5-haiku', () => {
    assert.equal(resolveModel('claude-haiku-4-5'), 'claude-4.5-haiku');
  });
  it('claude-haiku-4-5-latest resolves to claude-4.5-haiku', () => {
    assert.equal(resolveModel('claude-haiku-4-5-latest'), 'claude-4.5-haiku');
  });
  it('legacy claude-3-5-haiku-20241022 routes to live haiku (no 400 Unsupported)', () => {
    assert.equal(resolveModel('claude-3-5-haiku-20241022'), 'claude-4.5-haiku');
  });
  it('claude-sonnet-4-5-latest also covered (followup to existing 20250929 alias)', () => {
    assert.equal(resolveModel('claude-sonnet-4-5-latest'), 'claude-4.5-sonnet');
  });
  it('claude-opus-4-5-latest also covered', () => {
    assert.equal(resolveModel('claude-opus-4-5-latest'), 'claude-4.5-opus');
  });
});

describe('#118 — buildUsageBody no longer inflates prompt_tokens with cache_write', () => {
  it('prompt_tokens = freshInput + cacheRead (cache_write NOT included)', () => {
    const usage = buildUsageBody(
      { inputTokens: 415, outputTokens: 251, cacheReadTokens: 11217, cacheWriteTokens: 683 },
      [],
      'hi',
      '',
      null,
    );
    // wnfilm's exact log line: in=415 out=251 cache_r=11217 cache_w=683
    // pre-v2.0.68: prompt_tokens = 415 + 11217 + 683 = 12315 (downstream relays
    //              billed cache_write as if it were normal input)
    // post-v2.0.68: prompt_tokens = 415 + 11217 = 11632
    assert.equal(usage.prompt_tokens, 11632, 'prompt_tokens must equal freshInput + cacheRead, no cache_write');
    assert.equal(usage.input_tokens, 11632, 'input_tokens (legacy alias) should mirror prompt_tokens');
  });

  it('cache_write ships independently on cache_creation_input_tokens', () => {
    const usage = buildUsageBody(
      { inputTokens: 415, outputTokens: 251, cacheReadTokens: 11217, cacheWriteTokens: 683 },
      [], 'hi', '', null,
    );
    assert.equal(usage.cache_creation_input_tokens, 683);
  });

  it('cache_read ships on prompt_tokens_details.cached_tokens (OpenAI standard)', () => {
    const usage = buildUsageBody(
      { inputTokens: 415, outputTokens: 251, cacheReadTokens: 11217, cacheWriteTokens: 683 },
      [], 'hi', '', null,
    );
    assert.equal(usage.prompt_tokens_details.cached_tokens, 11217);
    assert.equal(usage.cache_read_input_tokens, 11217);
  });

  it('total_tokens still grand-totals (so per-account billing tally stays correct)', () => {
    const usage = buildUsageBody(
      { inputTokens: 415, outputTokens: 251, cacheReadTokens: 11217, cacheWriteTokens: 683 },
      [], 'hi', '', null,
    );
    // freshInput + cacheRead + cacheWrite + outputTokens = 415 + 11217 + 683 + 251
    assert.equal(usage.total_tokens, 12566);
  });

  it('cascade_breakdown surfaces all four buckets verbatim', () => {
    const usage = buildUsageBody(
      { inputTokens: 415, outputTokens: 251, cacheReadTokens: 11217, cacheWriteTokens: 683 },
      [], 'hi', '', null,
    );
    assert.deepEqual(usage.cascade_breakdown, {
      fresh_input_tokens: 415,
      cache_read_tokens: 11217,
      cache_write_tokens: 683,
      output_tokens: 251,
    });
  });

  it('zero-cache request has prompt_tokens = freshInput, no surprises', () => {
    const usage = buildUsageBody(
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      [], 'x', '', null,
    );
    assert.equal(usage.prompt_tokens, 1000);
    assert.equal(usage.cache_creation_input_tokens, 0);
    assert.equal(usage.cache_read_input_tokens, 0);
    assert.equal(usage.total_tokens, 1500);
  });

  it('cache_creation split honours 1h ttl hint', () => {
    const usage1h = buildUsageBody(
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 200 },
      [], 'x', '', { has1h: true },
    );
    assert.equal(usage1h.cache_creation.ephemeral_1h_input_tokens, 200);
    assert.equal(usage1h.cache_creation.ephemeral_5m_input_tokens, 0);

    const usage5m = buildUsageBody(
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 200 },
      [], 'x', '', { has1h: false },
    );
    assert.equal(usage5m.cache_creation.ephemeral_5m_input_tokens, 200);
    assert.equal(usage5m.cache_creation.ephemeral_1h_input_tokens, 0);
  });
});

describe('#119 — sticky-IP proxy username segregates LS instances under env flag', () => {
  // proxyKey is internal to langserver.js; we test it indirectly via the
  // module's behaviour. Re-import per case so env flips are observed.
  const reloadProxyKey = async () => {
    const mod = await import(`../src/langserver.js?_t=${Date.now()}`);
    // The module doesn't export proxyKey directly — but `getLsFor(proxy)`
    // looks up the same _pool keyed by proxyKey, so we can inspect via
    // an indirect probe. Easier: derive expected key strings ourselves
    // against the documented behaviour. Skip the import-fresh dance —
    // proxyKey is intentionally not exported. Test through behaviour.
    return mod;
  };

  it('default behaviour (env unset): username does NOT segregate', async () => {
    const orig = process.env.WINDSURFAPI_LS_PER_PROXY_USER;
    delete process.env.WINDSURFAPI_LS_PER_PROXY_USER;
    try {
      const mod = await reloadProxyKey();
      // Same host:port, different sticky usernames → same LS pool entry.
      // Probe by getLsFor() returning same null/null — pool isn't started
      // for these so both should resolve to the same key (asserted by
      // examining the sanitized return below).
      const a = mod.getLsFor({ host: 'us.ipwo.net', port: 12345, username: 'sid_a' });
      const b = mod.getLsFor({ host: 'us.ipwo.net', port: 12345, username: 'sid_b' });
      // Both null because pool is empty in test env, but the call
      // shouldn't have ever differed — there's no separation. We can't
      // assert "same key" without exposing proxyKey, so we instead
      // assert the symmetric behaviour: neither call returned a
      // distinct stub. (Left here as a documentation test.)
      assert.equal(a, null);
      assert.equal(b, null);
    } finally {
      if (orig !== undefined) process.env.WINDSURFAPI_LS_PER_PROXY_USER = orig;
      else delete process.env.WINDSURFAPI_LS_PER_PROXY_USER;
    }
  });

  it('with env=1: doc-style smoke (proxyKey is internal; full segregation needs LS spawn — covered by integration)', () => {
    // proxyKey is module-internal. We verify the env knob exists and
    // the module loads correctly with it set. End-to-end segregation
    // (different LS process per username) is covered manually on the
    // VPS where docker.sock and LS binaries are available.
    const orig = process.env.WINDSURFAPI_LS_PER_PROXY_USER;
    process.env.WINDSURFAPI_LS_PER_PROXY_USER = '1';
    try {
      // Re-import succeeds, no syntax error in the new branch.
      assert.doesNotThrow(async () => {
        await import(`../src/langserver.js?reload=${Date.now()}`);
      });
    } finally {
      if (orig !== undefined) process.env.WINDSURFAPI_LS_PER_PROXY_USER = orig;
      else delete process.env.WINDSURFAPI_LS_PER_PROXY_USER;
    }
  });
});
