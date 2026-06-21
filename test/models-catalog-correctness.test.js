import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS,
  resolveModel,
  getModelInfo,
  mergeCloudModels,
} from '../src/models.js';

describe('v2.0.29 model catalog correctness', () => {
  it('maps opus-4.7 shorthand aliases to canonical 4.7 medium keys', () => {
    assert.equal(resolveModel('opus-4.7'), 'claude-opus-4-7-medium');
    assert.equal(resolveModel('o4.7'), 'claude-opus-4-7-medium');
    assert.equal(resolveModel('claude-opus-4.7'), 'claude-opus-4-7-medium');
  });

  it('maps opus-4.7 thinking aliases to medium-thinking canonical key', () => {
    assert.equal(resolveModel('opus-4.7-thinking'), 'claude-opus-4-7-medium-thinking');
    assert.equal(resolveModel('claude-opus-4.7-thinking'), 'claude-opus-4-7-medium-thinking');
    assert.equal(resolveModel('claude-opus-4.7-high-thinking'), 'claude-opus-4-7-high-thinking');
  });

  it('keeps new v2.0.29 model metadata aligned with declared keys', () => {
    assert.equal(getModelInfo('kimi-k2-thinking')?.modelUid, 'MODEL_KIMI_K2_THINKING');
    assert.equal(getModelInfo('kimi-k2-thinking')?.enumValue, 394);
    assert.equal(getModelInfo('kimi-k2-thinking')?.credit, 1);
    assert.equal(getModelInfo('glm-4.7-fast')?.enumValue, 418);
    assert.equal(getModelInfo('glm-4.7-fast')?.modelUid, 'MODEL_GLM_4_7_FAST');
  });

  it('exposes newer cloud-only Kimi and GLM catalog entries with aliases', () => {
    assert.equal(getModelInfo('kimi-k2-7')?.provider, 'moonshot');
    assert.equal(getModelInfo('kimi-k2-7')?.modelUid, 'kimi-k2-7');
    assert.equal(resolveModel('kimi-k2.7'), 'kimi-k2-7');
    assert.equal(resolveModel('kimi-k2-7'), 'kimi-k2-7');

    assert.equal(getModelInfo('glm-5.2')?.provider, 'zhipu');
    assert.equal(getModelInfo('glm-5.2')?.modelUid, 'glm-5-2');
    assert.equal(resolveModel('glm-5-2'), 'glm-5.2');
    assert.equal(resolveModel('glm-5.2'), 'glm-5.2');
  });

  it('validates swe and minimax enum updates from release payload', () => {
    assert.equal(getModelInfo('swe-1.5-thinking')?.enumValue, 369);
    assert.equal(getModelInfo('swe-1.5')?.enumValue, 377);
    assert.equal(getModelInfo('swe-1.6')?.enumValue, 420);
    assert.equal(getModelInfo('swe-1.6-fast')?.enumValue, 421);
    assert.equal(getModelInfo('minimax-m2.5')?.enumValue, 419);
    assert.equal(getModelInfo('minimax-m2.5')?.modelUid, 'MODEL_MINIMAX_M2_1');
  });

  it('supports adaptive as explicit model for dynamic routing', () => {
    assert.equal(resolveModel('adaptive'), 'adaptive');
    assert.equal(getModelInfo('adaptive')?.enumValue, 0);
    assert.equal(getModelInfo('adaptive')?.credit, 1);
  });

  // GPT-5.5 + Opus 4.7 max showed up in the live GetCascadeModelConfigs response
  // on 2026-04-30. They were exposed implicitly through mergeCloudModels with
  // ugly hyphenated names; the explicit catalog entries make the dotted aliases
  // (gpt-5.5-medium, claude-opus-4.7-max) work and pin curated credit values.
  it('exposes gpt-5.5 ladder with cloud-format aliases', () => {
    for (const tier of ['none', 'low', 'medium', 'high', 'xhigh']) {
      assert.ok(getModelInfo(`gpt-5.5-${tier}`), `gpt-5.5-${tier} missing`);
      // cloud sends `gpt-5-5-${tier}`, we should resolve it back
      assert.equal(resolveModel(`gpt-5-5-${tier}`), `gpt-5.5-${tier}`);
      // priority lane (=fast)
      assert.equal(
        resolveModel(`gpt-5-5-${tier}-priority`),
        `gpt-5.5-${tier}-fast`,
      );
    }
    assert.equal(resolveModel('gpt-5.5'), 'gpt-5.5-medium');
    assert.equal(resolveModel('gpt-5-5'), 'gpt-5.5-medium');
    assert.equal(getModelInfo('gpt-5.5-medium')?.modelUid, 'gpt-5-5-medium');
  });

  it('exposes claude-opus-4-7-max with dotted alias', () => {
    assert.ok(getModelInfo('claude-opus-4-7-max'));
    assert.equal(resolveModel('claude-opus-4.7-max'), 'claude-opus-4-7-max');
    assert.equal(getModelInfo('claude-opus-4-7-max')?.modelUid, 'claude-opus-4-7-max');
  });

  // sub2api end-to-end test (v2.0.51) caught these — `gpt-5.2-medium` 400'd
  // because the catalog only had bare `gpt-5.2`. Same shape for 5.4 (had tiers
  // but no bare) and 5.3-codex (had bare but no -medium dotted alias).
  it('cross-tier aliases resolve regardless of which side is canonical', () => {
    assert.equal(resolveModel('gpt-5.2-medium'), 'gpt-5.2');
    assert.equal(resolveModel('gpt-5-2-medium'), 'gpt-5.2');
    assert.equal(resolveModel('gpt-5.4'), 'gpt-5.4-medium');
    assert.equal(resolveModel('gpt-5.3-codex-medium'), 'gpt-5.3-codex');
    assert.equal(resolveModel('gpt-5.2-codex'), 'gpt-5.2-codex-medium');
    // Non-existent tier should still fall through to itself (not silently route)
    assert.equal(resolveModel('gpt-5.2-notarealtier'), 'gpt-5.2-notarealtier');
  });

  it('exposes gpt-5.3-codex tier ladder (low/high/xhigh + priority lane)', () => {
    assert.ok(getModelInfo('gpt-5.3-codex-low'));
    assert.ok(getModelInfo('gpt-5.3-codex-high'));
    assert.ok(getModelInfo('gpt-5.3-codex-xhigh'));
    assert.equal(resolveModel('gpt-5-3-codex-low'), 'gpt-5.3-codex-low');
    assert.equal(resolveModel('gpt-5-3-codex-medium'), 'gpt-5.3-codex'); // bare = legacy alias
    assert.equal(resolveModel('gpt-5-3-codex-high-priority'), 'gpt-5.3-codex-high-fast');
  });

  it('mergeCloudModels should skip already-known model UIDs (dedupe path)', () => {
    const before = Object.keys(MODELS).length;
    const dynamicUid = 'NEW_MODEL_4_7_TEST';
    const dynamicKey = dynamicUid.toLowerCase().replace(/_/g, '-');
    const added = mergeCloudModels([
      { provider: 'MODEL_PROVIDER_OPENAI', modelUid: 'claude-opus-4-7-medium-thinking', creditMultiplier: 999 },
      { provider: 'MODEL_PROVIDER_OPENAI', modelUid: dynamicUid, creditMultiplier: 3 },
    ]);
    const after = Object.keys(MODELS).length;

    assert.equal(added, 1);
    assert.equal(after - before, 1);
    try {
      assert.equal(getModelInfo(dynamicKey)?.credit, 3);
    } finally {
      if (MODELS[dynamicKey]) {
        delete MODELS[dynamicKey];
      }
    }
  });
});
