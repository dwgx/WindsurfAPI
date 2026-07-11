import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectSelector, FREE_TIER_SELECTOR } from '../src/devin-connect-models.js';

describe('resolveConnectSelector', () => {
  it('resolves the free-tier swe selector (dash and dot forms)', () => {
    assert.deepEqual(resolveConnectSelector('swe-1-6-slow'), { selector: 'swe-1-6-slow', mapped: true });
    assert.deepEqual(resolveConnectSelector('swe-1.6-slow'), { selector: 'swe-1-6-slow', mapped: true });
  });

  it('maps claude friendly names to their captured upstream selectors', () => {
    assert.equal(resolveConnectSelector('claude-opus-4.8').selector, 'claude-opus-4-8-medium');
    // Dashed bare form is a real catalog selector (base model) → resolves to itself;
    // the dotted family alias keeps the curated -thinking default.
    assert.equal(resolveConnectSelector('claude-sonnet-4-6').selector, 'claude-sonnet-4-6');
    assert.equal(resolveConnectSelector('claude-sonnet-4.6').selector, 'claude-sonnet-4-6-thinking');
    assert.equal(resolveConnectSelector('claude-sonnet-4.5').selector, 'MODEL_PRIVATE_2');
    assert.equal(resolveConnectSelector('claude-haiku-4-5').selector, 'MODEL_PRIVATE_11');
  });

  it('maps gpt and gemini families', () => {
    assert.equal(resolveConnectSelector('gpt-5-2-high').selector, 'MODEL_GPT_5_2_HIGH');
    assert.equal(resolveConnectSelector('gemini-3-flash').selector, 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM');
  });

  it('is case-insensitive and strips a provider prefix', () => {
    assert.equal(resolveConnectSelector('Claude-Opus-4.8').selector, 'claude-opus-4-8-medium');
    assert.equal(resolveConnectSelector('anthropic/claude-sonnet-4-5').selector, 'MODEL_PRIVATE_2');
  });

  it('passes enum-form selectors through verbatim', () => {
    assert.deepEqual(resolveConnectSelector('MODEL_CLAUDE_4_5_OPUS_THINKING'),
      { selector: 'MODEL_CLAUDE_4_5_OPUS_THINKING', mapped: true });
  });

  it('degrades unknown names to the free-tier selector (mapped:false)', () => {
    assert.deepEqual(resolveConnectSelector('gpt-9-ultra'), { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector(''), { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector(null), { selector: FREE_TIER_SELECTOR, mapped: false });
  });

  it('resolves a dotted dash-form that normalizes to a real catalog selector', () => {
    // Regression: "gpt-5.5-medium" → norm "gpt-5-5-medium" IS a catalog selector
    // but not a SELECTOR_MAP alias. Before the norm→catalog check it silently
    // degraded to the free tier (mapped:false); it must now resolve mapped:true.
    const r = resolveConnectSelector('gpt-5.5-medium');
    assert.equal(r.selector, 'gpt-5-5-medium');
    assert.equal(r.mapped, true);
  });
});

describe('resolveConnectSelector — live catalog (audit 2026-07-12 snapshot staleness)', () => {
  // The committed snapshot never live-synced, so selectors the upstream added
  // after it was captured (proven on a live account 2026-07-12: qwen-3, glm-5,
  // kimi-k2.5, deepseek-v3, minimax-*) were absent from CATALOG_SELECTORS and
  // got mapped:false → 400'd by the strict gate despite being runnable. The live
  // catalog set (populated from GetCliModelConfigs) fixes this as "snapshot ∪ live".
  const STALE = ['qwen-3', 'glm-5', 'kimi-k2.5', 'deepseek-v3'];

  it('cold start (no live sync): a genuinely-runnable-but-unsnapshotted selector is mapped:false', async () => {
    // Fresh import so _liveSelectors starts empty (module-level Set).
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-a`);
    assert.equal(m.hasLiveCatalog(), false, 'no live sync yet');
    // qwen-3 is not in the frozen snapshot → without live catalog it degrades.
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, false);
  });

  it('after live sync: the same selectors resolve mapped:true to themselves', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-b`);
    // Simulate a GetCliModelConfigs sync feeding the decoded catalog shape.
    m.setLiveCatalogSelectors(STALE.map(s => ({ selector: s })));
    assert.equal(m.hasLiveCatalog(), true);
    for (const s of STALE) {
      const r = m.resolveConnectSelector(s);
      assert.equal(r.mapped, true, `${s} must be recognized after live sync`);
      assert.equal(r.selector, s, `${s} resolves to itself`);
    }
  });

  it('live sync also folds in each entry alias (dotted client form)', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-c`);
    m.setLiveCatalogSelectors([{ selector: 'glm-5-2', alias: 'glm-5.2' }]);
    // Both the canonical selector and the upstream alias are recognized.
    assert.equal(m.resolveConnectSelector('glm-5-2').mapped, true);
    assert.equal(m.resolveConnectSelector('glm-5.2').mapped, true);
  });

  it('a bad/empty sync never blanks out a good live set', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-d`);
    m.setLiveCatalogSelectors([{ selector: 'qwen-3' }]);
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, true);
    m.setLiveCatalogSelectors([]);          // empty → no-op
    m.setLiveCatalogSelectors(null);        // garbage → no-op
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, true, 'prior good set survives a bad sync');
  });

  it('genuine junk still degrades even with a live catalog present', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-e`);
    m.setLiveCatalogSelectors([{ selector: 'qwen-3' }]);
    assert.equal(m.resolveConnectSelector('totally-fake-model-xyz').mapped, false);
  });
});
