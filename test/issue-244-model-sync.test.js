import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { resolveModel, getModelInfo, listModels } from '../src/models.js';
import { resolveConnectSelector } from '../src/devin-connect-models.js';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

const createdAccountIds = [];
afterEach(() => {
  delete process.env.DEVIN_CONNECT;
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
});
function withAccount(label) {
  const a = addAccountByKey(`issue244-${Date.now()}-${Math.random().toString(36).slice(2)}`, label);
  createdAccountIds.push(a.id);
  return a;
}

// ---------------------------------------------------------------------------
// Issue #244 — "请同步一下最新模型 gpt5.6-luna / claude5 等...还有 swe1.7
// 不识别图片的问题".
//
// Before this fix: `gpt5.6-luna` / `claude5` (compact, no-dot forms) resolved
// NOWHERE — models.js had no gpt-5.6 entries at all and no claude-5 entries;
// devin-connect-models.js mapped only claude-5-fable / claude-sonnet-5 family
// names, and chat.js passes the RAW request name to resolveConnectSelector, so
// the models.js alias table is invisible to the connect path. Result: 400
// model_not_found for every form the reporter tried.
//
// These tests pin that BOTH resolution layers (Cascade static catalog +
// DEVIN_CONNECT selector resolver) expose the models, so the only remaining
// variable for the reporter is account entitlement, exactly like #203.
// ---------------------------------------------------------------------------

describe('issue #244 — gpt-5.6-luna is fully wired', () => {
  const LUNA_ALIASES = [
    'gpt-5.6-luna',
    'gpt-5-6-luna',
    'gpt5.6-luna',            // issue verbatim (no dot before 5)
    'gpt-5.6-luna-medium',
    'gpt-5-6-luna-medium',
  ];

  for (const alias of LUNA_ALIASES) {
    it(`resolves "${alias}" to the real gpt-5.6-luna-medium catalog entry`, () => {
      const key = resolveModel(alias);
      const info = getModelInfo(key);
      assert.ok(info, `"${alias}" must resolve to a known catalog entry, not a silent passthrough`);
      assert.equal(info.modelUid, 'gpt-5-6-luna-medium');
      assert.equal(info.provider, 'openai');
    });
  }

  it('exposes gpt-5.6-luna in /v1/models', () => {
    const ids = listModels().map((m) => m.id);
    assert.ok(ids.includes('gpt-5.6-luna-medium'), 'gpt-5.6-luna-medium must be listed');
    assert.ok(ids.includes('gpt-5.6-luna-high'), 'gpt-5.6-luna-high must be listed');
  });

  it('maps gpt-5.6-luna to the DEVIN_CONNECT selector (the usable path)', () => {
    const r = resolveConnectSelector('gpt-5.6-luna');
    assert.equal(r.selector, 'gpt-5-6-luna-medium');
    assert.equal(r.mapped, true);
    for (const alias of ['gpt-5-6-luna', 'gpt5.6-luna', 'gpt-5-6-luna-medium']) {
      assert.equal(resolveConnectSelector(alias).mapped, true, `${alias} must map, not degrade`);
    }
    // full tier ladder must not degrade either
    for (const tier of ['none', 'low', 'high', 'xhigh']) {
      assert.equal(
        resolveConnectSelector(`gpt-5-6-luna-${tier}`).mapped,
        true,
        `gpt-5-6-luna-${tier} must map (it is in the snapshot)`,
      );
    }
  });
});

describe('issue #244 — claude5 is fully wired', () => {
  it('compact "claude5" and "claude-5" resolve to claude-sonnet-5-medium', () => {
    for (const alias of ['claude5', 'claude-5']) {
      const info = getModelInfo(resolveModel(alias));
      assert.ok(info, `"${alias}" must resolve to a known catalog entry`);
      assert.equal(info.modelUid, 'claude-sonnet-5-medium');
      assert.equal(info.provider, 'anthropic');
    }
  });

  it('all three Claude 5 families appear in /v1/models', () => {
    const ids = listModels().map((m) => m.id);
    for (const id of [
      'claude-5-fable-medium',
      'claude-sonnet-5-medium',
      'claude-opus-5-medium',
      'claude-opus-5-max-fast',
    ]) {
      assert.ok(ids.includes(id), `${id} must be listed`);
    }
  });

  it('maps claude5 family names to DEVIN_CONNECT selectors without degrading', () => {
    const cases = [
      ['claude5', 'claude-sonnet-5-medium'],
      ['claude-5-fable', 'claude-5-fable-medium'],
      ['claude-sonnet-5', 'claude-sonnet-5-medium'],
      ['claude-opus-5', 'claude-opus-5-medium'],
    ];
    for (const [alias, expected] of cases) {
      const r = resolveConnectSelector(alias);
      assert.equal(r.mapped, true, `${alias} must map, not degrade`);
      assert.equal(r.selector, expected, `${alias} should resolve to ${expected}`);
    }
    // full fable/sonnet/opus ladders are in the snapshot → verbatim map
    for (const tier of ['low', 'high', 'xhigh', 'max']) {
      assert.equal(resolveConnectSelector(`claude-5-fable-${tier}`).mapped, true);
      assert.equal(resolveConnectSelector(`claude-sonnet-5-${tier}`).mapped, true);
      assert.equal(resolveConnectSelector(`claude-opus-5-${tier}`).mapped, true);
      assert.equal(resolveConnectSelector(`claude-opus-5-${tier}-fast`).mapped, true);
    }
  });
});

describe('issue #244 — SWE image requests are allowed to reach the native vision path', () => {
  function imageBody(model) {
    return {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what color is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      }],
    };
  }

  it('swe-1-7 + image is not rejected by a hardcoded model_no_vision guard', async () => {
    process.env.DEVIN_CONNECT = '1';
    withAccount('issue244-swe-vision');
    const result = await handleChatCompletions(imageBody('swe-1-7'));
    assert.notEqual(
      result.status === 400 && result.body?.error?.code === 'model_no_vision',
      true,
      'the captured upstream wire proves swe-1-7 accepts source=USER images #10',
    );
  });

  it('swe-1-7-lightning is not rejected merely because it belongs to the SWE family', async () => {
    process.env.DEVIN_CONNECT = '1';
    withAccount('issue244-swe-vision-lt');
    const result = await handleChatCompletions(imageBody('swe-1-7-lightning'));
    assert.notEqual(
      result.status === 400 && result.body?.error?.code === 'model_no_vision',
      true,
    );
  });

  it('a vision-capable model is NOT rejected by the swe guard', async () => {
    process.env.DEVIN_CONNECT = '1';
    withAccount('issue244-claude-vision');
    const result = await handleChatCompletions(imageBody('claude-sonnet-4-6'));
    // Must NOT be the swe no-vision reject; it proceeds toward the upstream path
    // (un-stubbed here), so anything other than model_no_vision is acceptable.
    assert.notEqual(
      result.status === 400 && result.body?.error?.code === 'model_no_vision',
      true,
      'claude-sonnet-4-6 must not be rejected by a family-name heuristic',
    );
  });

  it('swe-1-7 + text-only request is NOT rejected (text/code still fine)', async () => {
    process.env.DEVIN_CONNECT = '1';
    withAccount('issue244-swe-text');
    const result = await handleChatCompletions({
      model: 'swe-1-7',
      messages: [{ role: 'user', content: 'write a loop' }],
    });
    assert.notEqual(
      result.status === 400 && result.body?.error?.code === 'model_no_vision',
      true,
      'text-only swe-1-7 must not trip the no-vision guard',
    );
  });
});

describe('issue #244 — existing models did not regress', () => {
  it('gpt-5.5 still resolves (gpt-5.6 addition did not shadow it)', () => {
    assert.equal(resolveModel('gpt-5.5'), 'gpt-5.5-medium');
    assert.equal(resolveConnectSelector('gpt-5.5').mapped, true);
  });

  it('claude-opus-4.8 and claude-5-fable are distinct entries (no collision)', () => {
    const uid48 = getModelInfo(resolveModel('claude-opus-4.8')).modelUid;
    const uid5 = getModelInfo(resolveModel('claude-5-fable')).modelUid;
    assert.notEqual(uid48, uid5);
    assert.equal(uid48, 'claude-opus-4-8-medium');
    assert.equal(uid5, 'claude-5-fable-medium');
  });
});
