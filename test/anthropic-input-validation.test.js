import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessagesRequest, validateCountTokensRequest } from '../src/handlers/messages.js';

// Batch 3 — entry-point input validation (GATE C1/C3/C4/E4). Every rejection
// must be a 400 with error.type === 'invalid_request_error', matching the
// official Anthropic Messages API. Valid inputs return null (no error).

const baseMsgs = [{ role: 'user', content: 'hi' }];
const MODEL = 'claude-sonnet-4.6'; // V1: model is now required, so isolate other checks with a valid model

describe('validateMessagesRequest — V1 model required', () => {
  it('rejects a missing model (was previously accepted, asymmetric with count_tokens)', () => {
    const err = validateMessagesRequest({ max_tokens: 16, messages: baseMsgs });
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
    assert.match(err.body.error.message, /model/);
  });

  it('rejects an empty-string model', () => {
    const err = validateMessagesRequest({ model: '', max_tokens: 16, messages: baseMsgs });
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
    assert.match(err.body.error.message, /model/);
  });

  it('accepts a present model', () => {
    assert.equal(validateMessagesRequest({ model: MODEL, max_tokens: 16, messages: baseMsgs }), null);
  });
});

describe('validateMessagesRequest — C1 max_tokens required + positive integer', () => {
  it('rejects a missing max_tokens (no silent 8192 fallback)', () => {
    const err = validateMessagesRequest({ model: MODEL, messages: baseMsgs });
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
    assert.match(err.body.error.message, /max_tokens/);
  });

  it('rejects max_tokens = 0 (the `||` fallback used to swallow 0)', () => {
    const err = validateMessagesRequest({ model: MODEL, max_tokens: 0, messages: baseMsgs });
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
  });

  it('rejects negative / non-integer / non-number max_tokens', () => {
    for (const mt of [-5, 1.5, '100', NaN, Infinity, null]) {
      const err = validateMessagesRequest({ model: MODEL, max_tokens: mt, messages: baseMsgs });
      assert.equal(err.status, 400, `max_tokens=${mt} should 400`);
      assert.equal(err.body.error.type, 'invalid_request_error');
    }
  });

  it('accepts a positive integer max_tokens', () => {
    assert.equal(validateMessagesRequest({ model: MODEL, max_tokens: 8192, messages: baseMsgs }), null);
    assert.equal(validateMessagesRequest({ model: MODEL, max_tokens: 1, messages: baseMsgs }), null);
  });
});

describe('validateMessagesRequest — C4 cache_control type/ttl validity', () => {
  const withCc = (cc) => ({
    model: MODEL,
    max_tokens: 16,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: cc }] }],
  });

  it('rejects a non-ephemeral cache_control type', () => {
    const err = validateMessagesRequest(withCc({ type: 'persistent' }));
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
    assert.match(err.body.error.message, /ephemeral/);
  });

  it('rejects an illegal ttl value (used to silently fall back to 5m)', () => {
    const err = validateMessagesRequest(withCc({ type: 'ephemeral', ttl: '30m' }));
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
    assert.match(err.body.error.message, /ttl/);
  });

  it('accepts ephemeral with 5m, 1h, or omitted ttl', () => {
    assert.equal(validateMessagesRequest(withCc({ type: 'ephemeral' })), null);
    assert.equal(validateMessagesRequest(withCc({ type: 'ephemeral', ttl: '5m' })), null);
    assert.equal(validateMessagesRequest(withCc({ type: 'ephemeral', ttl: '1h' })), null);
  });

  it('validates cache_control on tools[] and system[] too', () => {
    const onTool = validateMessagesRequest({
      model: MODEL,
      max_tokens: 16,
      tools: [{ name: 't', cache_control: { type: 'bogus' } }],
      messages: baseMsgs,
    });
    assert.equal(onTool.status, 400);
    const onSystem = validateMessagesRequest({
      model: MODEL,
      max_tokens: 16,
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '2h' } }],
      messages: baseMsgs,
    });
    assert.equal(onSystem.status, 400);
  });
});

describe('validateMessagesRequest — C3 breakpoint count ≤ 4', () => {
  it('accepts exactly 4 breakpoints', () => {
    const body = {
      model: MODEL,
      max_tokens: 16,
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'd', cache_control: { type: 'ephemeral' } },
      ] }],
    };
    assert.equal(validateMessagesRequest(body), null);
  });

  it('rejects a 5th cache_control breakpoint', () => {
    const body = {
      model: MODEL,
      max_tokens: 16,
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'd', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'e', cache_control: { type: 'ephemeral' } },
      ] }],
    };
    const err = validateMessagesRequest(body);
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
    assert.match(err.body.error.message, /maximum of 4/);
  });
});

describe('validateCountTokensRequest — E4 model required', () => {
  it('rejects a missing model', () => {
    const err = validateCountTokensRequest({ messages: baseMsgs });
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
    assert.match(err.body.error.message, /model/);
  });

  it('rejects an empty-string model', () => {
    const err = validateCountTokensRequest({ model: '', messages: baseMsgs });
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
  });

  it('accepts a present model', () => {
    assert.equal(validateCountTokensRequest({ model: 'claude-sonnet-4.6', messages: baseMsgs }), null);
  });
});
