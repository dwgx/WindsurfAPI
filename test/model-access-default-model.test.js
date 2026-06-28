// #198 (kevin5251984): when a request's model is not on the allowlist (or is
// on the blocklist), the operator can configure a fallback "default model"
// instead of rejecting the request outright. isModelAllowed() must surface the
// configured default on every rejection path so the chat handler can retarget
// the request. An empty default means "reject", the safe default.
//
// The contributor's original PR added the dashboard field but its chat-handler
// fallback destructured `defaultModel` off an isModelAllowed() result that
// never carried it — the fallback path was unreachable. These tests lock in
// the contract that rejections DO carry `defaultModel`.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getModelAccessConfig,
  getDefaultModel,
  isModelAllowed,
  setDefaultModel,
  setModelAccessList,
  setModelAccessMode,
} from '../src/dashboard/model-access.js';

const original = getModelAccessConfig();
after(() => {
  setModelAccessMode(original.mode);
  setModelAccessList(original.list);
  setDefaultModel(original.defaultModel || '');
});

describe('isModelAllowed default-model fallback (#198)', () => {
  test('setDefaultModel trims and getDefaultModel echoes it', () => {
    setDefaultModel('  claude-opus-4-7-medium  ');
    assert.equal(getDefaultModel(), 'claude-opus-4-7-medium');
    setDefaultModel('');
    assert.equal(getDefaultModel(), '');
  });

  test('non-string default normalizes to empty', () => {
    setDefaultModel(null);
    assert.equal(getDefaultModel(), '');
    setDefaultModel(undefined);
    assert.equal(getDefaultModel(), '');
  });

  test('allowlist rejection carries the configured default model', () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-opus-4-7-medium']);
    setDefaultModel('claude-opus-4-7-medium');
    const res = isModelAllowed('gpt-4o');
    assert.equal(res.allowed, false);
    assert.equal(res.defaultModel, 'claude-opus-4-7-medium',
      'allowlist rejection must surface defaultModel for the chat-handler fallback');
  });

  test('blocklist rejection carries the configured default model', () => {
    setModelAccessMode('blocklist');
    setModelAccessList(['gpt-4o']);
    setDefaultModel('claude-opus-4-7-medium');
    const res = isModelAllowed('gpt-4o');
    assert.equal(res.allowed, false);
    assert.equal(res.defaultModel, 'claude-opus-4-7-medium');
  });

  test('empty default surfaces empty string (reject path)', () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-opus-4-7-medium']);
    setDefaultModel('');
    const res = isModelAllowed('gpt-4o');
    assert.equal(res.allowed, false);
    assert.equal(res.defaultModel, '');
  });

  test('allowed models do not carry a fallback (no rejection)', () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['gpt-4o']);
    setDefaultModel('claude-opus-4-7-medium');
    const res = isModelAllowed('gpt-4o');
    assert.equal(res.allowed, true);
    assert.equal(res.defaultModel, undefined);
  });

  test("'all' mode never rejects regardless of default", () => {
    setModelAccessMode('all');
    setDefaultModel('claude-opus-4-7-medium');
    assert.equal(isModelAllowed('anything-at-all').allowed, true);
  });
});
