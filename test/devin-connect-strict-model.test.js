// P1 whitelist guard: on the DEVIN_CONNECT path, a model name that resolves to
// NO real upstream selector (resolveConnectSelector → mapped:false) must be
// rejected with 400 model_not_found BEFORE any upstream call, instead of silently
// degrading to the free-tier selector (swe-1-6-slow). Silent degrade means the
// client's opus/gpt request quietly runs a different free model — wrong output,
// wrong billing — and a junk name can trip UPSTREAM_INTERNAL and burn account
// health. Gated by WINDSURFAPI_STRICT_MODEL (default on).

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

const createdAccountIds = [];

afterEach(() => {
  delete process.env.DEVIN_CONNECT;
  delete process.env.WINDSURFAPI_STRICT_MODEL;
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
});

function withAccount(label) {
  const a = addAccountByKey(`strict-${Date.now()}-${Math.random().toString(36).slice(2)}`, label);
  createdAccountIds.push(a.id);
  return a;
}

describe('DEVIN_CONNECT strict model whitelist (P1)', () => {
  it('rejects an unmapped model with 400 model_not_found (no upstream call)', async () => {
    process.env.DEVIN_CONNECT = '1';
    withAccount('strict-reject');
    const body = {
      model: 'totally-made-up-model-xyz',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = await handleChatCompletions(body);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'model_not_found');
    assert.equal(result.body.error.param, 'model');
    assert.match(result.body.error.message, /not a valid model/i);
  });

  it('does NOT reject a real mapped selector', async () => {
    process.env.DEVIN_CONNECT = '1';
    withAccount('strict-allow');
    // claude-5-fable-medium is a real catalog selector → mapped:true → must pass
    // the guard (it will proceed to the upstream path, which we don't stub here;
    // the assertion is only that it is NOT the 400 model_not_found reject).
    const body = {
      model: 'claude-5-fable-medium',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = await handleChatCompletions(body);
    assert.notEqual(
      result.status === 400 && result.body?.error?.code === 'model_not_found',
      true,
      'a valid selector must not be rejected by the whitelist guard',
    );
  });

  it('WINDSURFAPI_STRICT_MODEL=0 restores the legacy silent-degrade (no 400)', async () => {
    process.env.DEVIN_CONNECT = '1';
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    withAccount('strict-optout');
    const body = {
      model: 'totally-made-up-model-xyz',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = await handleChatCompletions(body);
    // With the guard off, it must NOT 400-model_not_found (it degrades instead).
    assert.notEqual(
      result.status === 400 && result.body?.error?.code === 'model_not_found',
      true,
      'opt-out must not reject; it degrades to free tier as before',
    );
  });
});

// Regression: the server-side default model (used when a request omits `model`)
// MUST resolve to a live DEVIN_CONNECT selector, or every omitted-model request
// on a DEVIN_CONNECT deployment hits the strict guard above → 400 / free downgrade.
// The old default 'claude-4.5-sonnet-thinking' was mapped:false and did exactly
// that. This locks the default to a mapped name so a future edit can't regress it.
describe('config.defaultModel must be mapped on the DEVIN_CONNECT path', () => {
  it('resolveConnectSelector(config.defaultModel) is mapped:true', async () => {
    const { config } = await import('../src/config.js');
    const { resolveConnectSelector } = await import('../src/devin-connect-models.js');
    const r = resolveConnectSelector(config.defaultModel);
    assert.equal(r.mapped, true, `default model "${config.defaultModel}" must map to a live selector (got ${JSON.stringify(r)})`);
  });

  it('an omitted-model request is NOT rejected by the strict whitelist guard', async () => {
    process.env.DEVIN_CONNECT = '1';
    withAccount('strict-default');
    const body = { messages: [{ role: 'user', content: 'hi' }] }; // no model → server default
    const result = await handleChatCompletions(body);
    assert.notEqual(
      result.status === 400 && result.body?.error?.code === 'model_not_found',
      true,
      'omitting model must fall through to a usable server default, not a 400',
    );
  });
});
