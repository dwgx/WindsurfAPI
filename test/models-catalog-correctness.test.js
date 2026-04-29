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
