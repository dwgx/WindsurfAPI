import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, getModelInfo, listModels } from '../src/models.js';
import { resolveConnectSelector } from '../src/devin-connect-models.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { getAllFields, getField, parseFields } from '../src/proto.js';

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

describe('issue #244 — SWE native vision is encoded on the captured wire shape', () => {
  const IMAGE_BASE64 = 'iVBORw0KGgo=';
  const TEXT = 'what color is this?';

  function selectorFor(alias) {
    const resolved = resolveConnectSelector(alias);
    assert.equal(resolved.mapped, true, `${alias} must resolve to a DEVIN_CONNECT selector`);
    return resolved.selector;
  }

  function chatMessagesOf(alias, content) {
    const request = buildGetChatMessageRequest({
      token: 'issue-244-wire-fixture',
      model: selectorFor(alias),
      messages: [{ role: 'user', content }],
      env: {},
    });
    return getAllFields(parseFields(request), 3).map((field) => parseFields(field.value));
  }

  for (const alias of ['swe-1-7', 'swe-1-7-medium']) {
    it(`${alias} keeps one image on the source=USER message at repeated field #10`, () => {
      const messages = chatMessagesOf(alias, [
        { type: 'text', text: TEXT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_BASE64}` } },
      ]);

      assert.equal(messages.length, 1, 'one caller message must remain one wire message');
      const [user] = messages;
      assert.equal(Number(getField(user, 2, 0)?.value), 1, 'ChatMessage.source #2 = USER');
      assert.equal(getField(user, 3, 2)?.value.toString('utf8'), TEXT, 'ChatMessage.text #3');
      assert.equal(getField(user, 6, 2), null, 'no synthetic read tool call');
      assert.equal(getField(user, 7, 2), null, 'no synthetic tool_call_id');

      const images = getAllFields(user, 10).map((field) => parseFields(field.value));
      assert.equal(images.length, 1, 'ChatMessage.images is repeated field #10');
      assert.equal(getField(images[0], 1, 2)?.value.toString('utf8'), IMAGE_BASE64,
        'ImageData.base64_data #1');
      assert.equal(getField(images[0], 2, 2)?.value.toString('utf8'), 'image/png',
        'ImageData.mime_type #2');
    });
  }

  it('swe-1-7 text-only turns keep the same USER wire shape without an image field', () => {
    const messages = chatMessagesOf('swe-1-7', 'write a loop');
    assert.equal(messages.length, 1);
    assert.equal(Number(getField(messages[0], 2, 0)?.value), 1);
    assert.equal(getField(messages[0], 3, 2)?.value.toString('utf8'), 'write a loop');
    assert.equal(getField(messages[0], 10, 2), null);
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
