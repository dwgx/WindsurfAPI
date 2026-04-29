// QQ-group complaint 2026-04-30: "获取不到模型, 添加模型后也不能调用".
//
// Root cause: fresh accounts have tier='unknown' until probe completes.
// MODEL_TIER_ACCESS.unknown was just [gemini-2.5-flash], so 110/111 catalog
// models would fail the chat.js anyEligible preflight with 403
// "model_not_entitled" until probe finished (10-30s later).
//
// Fix: unknown tier is now optimistic (= pro catalog). Upstream LS will
// reject if the account isn't actually entitled, but that's a more accurate
// failure than the misleading proxy-level 403.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_TIER_ACCESS, getTierModels, listModels } from '../src/models.js';

describe('MODEL_TIER_ACCESS.unknown optimistic (QQ-group 2026-04-30 race)', () => {
  it('unknown tier returns the FULL pro catalog (not just gemini-2.5-flash)', () => {
    const unknown = MODEL_TIER_ACCESS.unknown;
    const pro = MODEL_TIER_ACCESS.pro;
    assert.equal(unknown.length, pro.length,
      `unknown tier must match pro size; got unknown=${unknown.length}, pro=${pro.length}`);
    // Spot-check that high-value pro-only models are in unknown
    assert.ok(unknown.includes('claude-opus-4.6'), 'unknown should include claude-opus-4.6');
    assert.ok(unknown.includes('claude-sonnet-4.6'), 'unknown should include claude-sonnet-4.6');
    assert.ok(unknown.includes('gemini-2.5-flash'), 'unknown should still include gemini-2.5-flash');
  });

  it('free tier stays restrictive (only base + discovered free models)', () => {
    const free = MODEL_TIER_ACCESS.free;
    assert.ok(free.length <= 10, `free tier must stay small; got ${free.length}`);
    assert.ok(free.includes('gemini-2.5-flash'));
    assert.ok(!free.includes('claude-opus-4.6'), 'free MUST NOT include claude-opus-4.6');
  });

  it('expired tier stays empty', () => {
    assert.deepEqual(MODEL_TIER_ACCESS.expired, []);
  });

  it('a fresh (un-probed) account would NOT be 403d on common pro models', () => {
    // Simulate the chat.js anyEligible check: account.tier='unknown' →
    // availableModels = getTierModels('unknown'). With the fix, this contains
    // every catalog key. Without the fix, it was [gemini-2.5-flash].
    const freshAccountAvailableModels = getTierModels('unknown');
    // Use canonical catalog keys (mix of dotted and dashed reflecting v2.0.30
    // catalog conventions for different model families).
    const popularPro = [
      'claude-opus-4.6',
      'claude-sonnet-4.6',
      'claude-sonnet-4.6-thinking',
      'claude-opus-4-7-medium',
      'gpt-5',
      'glm-5.1',
    ];
    for (const model of popularPro) {
      assert.ok(freshAccountAvailableModels.includes(model),
        `fresh account must allow ${model} until probe says otherwise`);
    }
  });

  it('catalog total stays in sync with unknown tier (regression: drift)', () => {
    const catalog = listModels().length;
    const unknown = MODEL_TIER_ACCESS.unknown.length;
    // unknown is keys, catalog drops deprecated. unknown should be >= catalog.
    assert.ok(unknown >= catalog,
      `unknown tier must include all non-deprecated catalog (got unknown=${unknown}, catalog=${catalog})`);
  });
});
