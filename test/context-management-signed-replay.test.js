/**
 * CTX-01: a finite `clear_thinking_20251015` keep can only be honoured while
 * signed thinking replay is enabled when it retains every replayable signed
 * turn — anthropicToOpenAI re-attaches exactly that signed thinking (the
 * `signedReplay` attach), and the upstream verifies each signature. The edit
 * clears the OLDEST thinking turns, so the check is order-aware:
 * {type:"thinking_turns",N} drops `thinkingTurnIndexes().slice(0, turns - N)`
 * and is accepted when N covers every thinking turn or when no dropped turn is
 * replayable. [signed, mixed] keep 1 therefore rejects (it drops the signed
 * turn) while [mixed, signed] keep 1 accepts (it drops only the mixed turn).
 * keep:"none" keeps none, so it is refused whenever a replayable signed turn
 * exists. keep:"all", {type:"all"}, replay off and histories the translator
 * does not replay stay accepted.
 *
 * M1 — an ABSENT keep is not keep-all: upstream resolves the default per
 * model class ([UNVERIFIED] keep-all on Opus 4.5+ / Sonnet 4.6+ / Fable,
 * last-turn-only on Haiku ≤4.5 / Opus ≤4.1 / Sonnet ≤4.5). Only the keep-all
 * class accepts outright; every other model — including names the resolver
 * cannot classify — runs the same dropped-prefix check an explicit
 * {thinking_turns:1} would.
 *
 * M2 — `redacted_thinking` IS a thinking block for the keep window (upstream
 * preservation rules count it; [UNVERIFIED] against this backend), so a
 * turn carrying only redacted_thinking blocks occupies a slot in
 * thinkingTurnIndexes and shifts which turns a finite keep drops.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessagesRequest } from '../src/handlers/messages.js';

// Catalog model that signedThinkingReplayEnabled resolves to the anthropic
// provider. Fake signature shape borrowed from thinking-signature-replay.test.js.
const MODEL = 'claude-opus-5-5-medium';
const SIG = 'EggKBggLEgKquxgB';
const ENV_KEY = 'DEVIN_CONNECT_REPLAY_SIGNED_THINKING';

// Assistant turns, each carrying one signed thinking block — the shape the
// translator replays. `turns` selects how many replayable signed turns exist.
function signedHistory(turns = 2) {
  const messages = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `secret ${i + 1}`, signature: SIG },
        { type: 'text', text: `answer ${i + 1}` },
      ],
    });
    if (i < turns - 1) messages.push({ role: 'user', content: `again ${i + 1}` });
  }
  messages.push({ role: 'user', content: 'final' });
  return messages;
}

// Single assistant turns for the order-aware cases. `signedTurn` is replayable
// (exactly one signed thinking block); `unsignedTurn` is a thinking turn the
// translator drops; `mixedTurn` mixes one signed and one unsigned thinking
// block, so it counts as a thinking turn but is never replayed.
function signedTurn(label) {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: `secret ${label}`, signature: SIG },
      { type: 'text', text: `answer ${label}` },
    ],
  };
}

function unsignedTurn(label) {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: `unsigned ${label}`, signature: '' },
      { type: 'text', text: `answer ${label}` },
    ],
  };
}

function mixedTurn(label) {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: `secret ${label}`, signature: SIG },
      { type: 'thinking', thinking: `unsigned ${label}`, signature: '' },
      { type: 'text', text: `answer ${label}` },
    ],
  };
}

// M2: an assistant turn whose only thinking block is `redacted_thinking`.
// The translator drops it like every non-signed block, but upstream counts it
// as a thinking turn for the clear_thinking keep window.
function redactedTurn(label) {
  return {
    role: 'assistant',
    content: [
      { type: 'redacted_thinking', data: `redacted-${label}` },
      { type: 'text', text: `answer ${label}` },
    ],
  };
}

// History whose assistant turns appear in the given order, oldest first.
function turnHistory(...turns) {
  const messages = [{ role: 'user', content: 'go' }];
  for (const turn of turns) {
    messages.push(turn, { role: 'user', content: 'again' });
  }
  return messages;
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
  it('accepts keep:{type:"thinking_turns",value:1} when the single signed turn is kept', () => {
    withReplay(true, () => {
      assert.equal(validateMessagesRequest(request({
        messages: signedHistory(1),
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      })), null);
    });
  });

  it('accepts keep:{type:"thinking_turns",value:5} when it exceeds the signed turn count', () => {
    withReplay(true, () => {
      assert.equal(validateMessagesRequest(request({
        messages: signedHistory(1),
        context_management: clearThinking({ type: 'thinking_turns', value: 5 }),
      })), null);
    });
  });

  it('accepts keep:{type:"thinking_turns",value:2} when both signed turns are kept', () => {
    withReplay(true, () => {
      assert.equal(validateMessagesRequest(request({
        context_management: clearThinking({ type: 'thinking_turns', value: 2 }),
      })), null);
    });
  });

  it('rejects keep:{type:"thinking_turns",value:1} when two signed turns would be cleared', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      }));
      assertUnsupportedKeep(err);
    });
  });

  it('rejects keep:1 for [signed, mixed]: the dropped prefix holds the signed turn', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({
        messages: turnHistory(signedTurn('1'), mixedTurn('2')),
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      }));
      assertUnsupportedKeep(err);
    });
  });

  it('accepts keep:1 for [mixed, signed]: the dropped prefix holds only the mixed turn', () => {
    withReplay(true, () => {
      assert.equal(validateMessagesRequest(request({
        messages: turnHistory(mixedTurn('1'), signedTurn('2')),
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      })), null);
    });
  });

  it('rejects keep:1 and accepts keep:2 for [signed, signed]', () => {
    withReplay(true, () => {
      const messages = turnHistory(signedTurn('1'), signedTurn('2'));
      const err = validateMessagesRequest(request({
        messages,
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      }));
      assertUnsupportedKeep(err);
      assert.equal(validateMessagesRequest(request({
        messages,
        context_management: clearThinking({ type: 'thinking_turns', value: 2 }),
      })), null);
    });
  });

  it('rejects keep:1 for [signed, unsigned]: the dropped prefix holds the signed turn', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({
        messages: turnHistory(signedTurn('1'), unsignedTurn('2')),
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      }));
      assertUnsupportedKeep(err);
    });
  });

  it('rejects keep:"none" when replay is on and two signed turns exist', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({ context_management: clearThinking('none') }));
      assertUnsupportedKeep(err);
    });
  });

  it('rejects keep:"none" when replay is on and a single signed turn exists', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({
        messages: signedHistory(1),
        context_management: clearThinking('none'),
      }));
      assertUnsupportedKeep(err);
    });
  });

  it('accepts keep:"all", {type:"all"} and an absent keep on a keep-all-class model', () => {
    withReplay(true, () => {
      assert.equal(validateMessagesRequest(request({ context_management: clearThinking('all') })), null);
      assert.equal(validateMessagesRequest(request({ context_management: clearThinking({ type: 'all' }) })), null);
      // MODEL is claude-opus-5-5-medium — the keep-all class, so an absent keep
      // retains every thinking turn and must be accepted (M1).
      assert.equal(validateMessagesRequest(request({ context_management: clearThinking(undefined) })), null);
    });
  });

  it('rejects an absent keep on a keep-1-class model when it would drop a signed turn (M1)', () => {
    withReplay(true, () => {
      // claude-haiku-4-5 resolves to claude-4.5-haiku: upstream's absent-keep
      // default is the LAST thinking turn only, so over [signed, signed] the
      // edit clears the older signed turn this bridge would re-attach.
      const err = validateMessagesRequest(request({
        model: 'claude-haiku-4-5',
        context_management: clearThinking(undefined),
      }));
      assertUnsupportedKeep(err);
    });
  });

  it('accepts an absent keep on a keep-1-class model when the kept turn covers every signed turn (M1)', () => {
    withReplay(true, () => {
      // keep-1 keeps the LAST thinking turn; with a single signed turn that is
      // the replayed one, so nothing the edit clears is re-attached.
      assert.equal(validateMessagesRequest(request({
        model: 'claude-haiku-4-5',
        messages: signedHistory(1),
        context_management: clearThinking(undefined),
      })), null);
      // [redacted, signed]: the dropped prefix holds only the redacted turn.
      assert.equal(validateMessagesRequest(request({
        model: 'claude-haiku-4-5',
        messages: turnHistory(redactedTurn('1'), signedTurn('2')),
        context_management: clearThinking(undefined),
      })), null);
    });
  });

  it('treats an unclassifiable claude-* model as keep-1 for an absent keep (M1, conservative)', () => {
    withReplay(true, () => {
      // Not in the catalogue: signedThinkingReplayEnabled still resolves it to
      // the anthropic provider via the claude- prefix, and the keep-all class
      // table cannot prove keep-all — so the safe keep-1 check applies.
      const err = validateMessagesRequest(request({
        model: 'claude-opus-9-9-nonexistent',
        context_management: clearThinking(undefined),
      }));
      assertUnsupportedKeep(err);
    });
  });

  it('an absent keep is unaffected when replay is off, on any model class (M1)', () => {
    withReplay(false, () => {
      assert.equal(validateMessagesRequest(request({
        model: 'claude-haiku-4-5',
        context_management: clearThinking(undefined),
      })), null);
    });
  });

  it('counts a redacted_thinking-only turn in the keep window (M2)', () => {
    withReplay(true, () => {
      // [signed, redacted]: upstream counts BOTH as thinking turns, so keep 1
      // retains only the redacted turn and clears the signed one — exactly the
      // case CTX-01 must refuse. Before the fix the redacted turn was not
      // counted, turns.length was 1, and keep 1 was wrongly accepted.
      const err = validateMessagesRequest(request({
        messages: turnHistory(signedTurn('1'), redactedTurn('2')),
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      }));
      assertUnsupportedKeep(err);
      // keep 2 retains both thinking turns — accepted.
      assert.equal(validateMessagesRequest(request({
        messages: turnHistory(signedTurn('1'), redactedTurn('2')),
        context_management: clearThinking({ type: 'thinking_turns', value: 2 }),
      })), null);
      // [redacted, signed]: keep 1 drops only the redacted prefix — accepted.
      assert.equal(validateMessagesRequest(request({
        messages: turnHistory(redactedTurn('1'), signedTurn('2')),
        context_management: clearThinking({ type: 'thinking_turns', value: 1 }),
      })), null);
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

  // G-04: `edits.findIndex` stopped at the FIRST finite keep, so a satisfiable edit
  // earlier in the list hid a later edit that drops a replayable signed turn. Each
  // edit is a directive of its own; the request must be refused at the offending
  // index instead of reaching the upstream with an edit this bridge cannot honour.
  it('rejects edits [keep 2, keep 1] for [signed, signed]: the SECOND edit drops a signed turn', () => {
    withReplay(true, () => {
      const err = validateMessagesRequest(request({
        messages: turnHistory(signedTurn('1'), signedTurn('2')),
        context_management: { edits: [
          { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 2 } },
          { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 1 } },
        ] },
      }));
      assertUnsupportedKeep(err, 1);
    });
  });

  it('accepts edits [keep 2, keep 2] for [signed, signed]: every edit is satisfiable', () => {
    withReplay(true, () => {
      assert.equal(validateMessagesRequest(request({
        messages: turnHistory(signedTurn('1'), signedTurn('2')),
        context_management: { edits: [
          { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 2 } },
          { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 2 } },
        ] },
      })), null);
    });
  });
});
