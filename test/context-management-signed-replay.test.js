/**
 * CTX-01: a finite `clear_thinking_20251015` keep cannot be honoured while
 * signed thinking replay is enabled — anthropicToOpenAI re-attaches exactly the
 * signed thinking the edit asks to clear (the `signedReplay` attach), and the
 * upstream verifies each signature, so a partial keep cannot be replayed
 * either. The proxy must answer 400 unsupported_parameter instead of logging
 * the edit as satisfied. keep:"all", absent keep, replay off and histories the
 * translator does not replay stay accepted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessagesRequest } from '../src/handlers/messages.js';

// Catalog model that signedThinkingReplayEnabled resolves to the anthropic
// provider. Fake signature shape borrowed from thinking-signature-replay.test.js.
const MODEL = 'claude-opus-5-5-medium';
const SIG = 'EggKBggLEgKquxgB';
const ENV_KEY = 'DEVIN_CONNECT_REPLAY_SIGNED_THINKING';

// Two assistant turns, each carrying one signed thinking block — the shape the
// translator replays.
function signedHistory() {
  return [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'first secret', signature: SIG },
        { type: 'text', text: 'one' },
      ],
    },
    { role: 'user', content: 'again' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'second secret', signature: SIG },
        { type: 'text', text: 'two' },
      ],
    },
    { role: 'user', content: 'final' },
  ];
}

function clearThinking(keep) {
  const edit = { type: 'clear_thinking_20251015' };
  if (keep !== undefined) edit.keep = keep;
  return { edits: [edit] };
}

function request(overrides = {}) {
  return {
    model: MODEL,
    max_tokens: 128000,
    context_management: clearThinking('all'),
    messages: signedHistory(),
    ...overrides,
  };
}

function withReplay(enabled, fn) {
  const saved = process.env[ENV_KEY];
  if (enabled) process.env[ENV_KEY] = '1';
  else delete process.env[ENV_KEY];
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

function assertUnsupportedKeep(err, index = 0) {
  assert.ok(err, 'expected a 400');
  assert.equal(err.status, 400);
  assert.equal(err.body.error.type, 'invalid_request_error');
  assert.equal(err.body.error.code, 'unsupported_parameter');
  assert.equal(err.body.error.param, `context_management.edits[${index}].keep`);
  assert.match(err.body.error.message, /signed thinking replay is enabled/i);
  assert.match(err.body.error.message, /keep:"all"/, 'message must name the accepted form');
  assert.match(err.body.error.message, /disable|remove/i, 'message must offer a way out');
}

describe('CTX-01 clear_thinking_20251015 finite keep vs signed replay', () => {
  it('rejects keep:{type:"thinking_turns",value:1} when replay is on and signed history exists', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      }));
      assertUnsupportedKeep(err);
    });
  });

  it('rejects keep:"none" when replay is on and signed history exists', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({ context_management: clearThinking('none') }));
      assertUnsupportedKeep(err);
    });
  });

  it('accepts keep:"all" and an absent keep with replay on and signed history', () => {
    withReplay(true, () => {
      assert.equal(validateMessagesRequest(request({ context_management: clearThinking('all') })), null);
      assert.equal(validateMessagesRequest(request({ context_management: clearThinking(undefined) })), null);
    });
  });

  it('accepts a finite keep when replay is off', () => {
    withReplay(false, () => {
      assert.equal(validateMessagesRequest(request({ context_management: clearThinking('none') })), null);
      assert.equal(validateMessagesRequest(request({
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      })), null);
    });
  });

  it('accepts a finite keep when the history has no signed thinking', () => {
    withReplay(true, () => {
      const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
        { role: 'user', content: 'again' },
      ];
      assert.equal(validateMessagesRequest(request({ messages, context_management: clearThinking('none') })), null);
      assert.equal(validateMessagesRequest(request({
        messages,
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      })), null);
    });
  });

  it('accepts a finite keep for history the translator does not replay (unsigned or multi-block turn)', () => {
    withReplay(true, () => {
      const unsigned = [{
        role: 'user', content: 'go',
      }, {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'not signed', signature: '' },
          { type: 'text', text: 'one' },
        ],
      }];
      assert.equal(validateMessagesRequest(request({ messages: unsigned, context_management: clearThinking('none') })), null);

      const multiBlock = [{
        role: 'user', content: 'go',
      }, {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'a', signature: SIG },
          { type: 'thinking', thinking: 'b', signature: SIG },
          { type: 'text', text: 'one' },
        ],
      }];
      assert.equal(validateMessagesRequest(request({
        messages: multiBlock,
        context_management: clearThinking('none'),
      })), null);
    });
  });

  it('keeps keep shape errors first: a malformed keep is still invalid_request_error', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({ context_management: clearThinking('sometimes') }));
      assert.ok(err, 'expected a 400');
      assert.equal(err.status, 400);
      assert.equal(err.body.error.type, 'invalid_request_error');
      assert.equal(err.body.error.code, undefined, 'shape errors are not unsupported_parameter');
      assert.equal(err.body.error.param, undefined);
    });
  });

  it('names the offending edit index when a later edit carries the finite keep', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({
        context_management: { edits: [
          { type: 'clear_thinking_20251015', keep: 'all' },
          { type: 'clear_thinking_20251015', keep: 'none' },
        ] },
      }));
      assertUnsupportedKeep(err, 1);
    });
  });
});
