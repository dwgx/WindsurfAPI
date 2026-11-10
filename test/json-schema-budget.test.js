// The execution budget and the tri-state verdict.
//
// MEASURED on the audited baseline (Node v24.19.0):
//   * `pattern` had no execution bound at all — the static tripwire could be
//     defeated by one harmless group, and `^((a|a))+$` on 26 `a`s plus a
//     near-miss blocked the event loop past a 1 s hard kill;
//   * the tripwire's "refuse and skip" made a safe `^(cat|dog)+$` report
//     `ok:true`, so a value that violated the schema was returned as
//     conforming, and the same skip was INVERTED by the combinators:
//       {not:{pattern:'^(cat|dog)+$'}}                    -> ok:false (wrong)
//       {oneOf:[{pattern:'^(cat|dog)+$'},{const:'wolf'}]}  -> ok:false (wrong)
//
// The contract pinned here:
//   * ONE budget per top-level call, threaded through every sub-schema — a
//     nested schema can never reset the allowance;
//   * a traversal ceiling so a huge caller-supplied schema cannot burn
//     wall-clock in plain JavaScript;
//   * three verdicts (`valid` / `invalid` / `unable`) that the combinators
//     propagate instead of folding into a boolean;
//   * the surfaces report `unable` as its own typed failure, never as "the
//     model did not conform" and never as success.
process.env.DEVIN_CONNECT = '0';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema, __jsonSchemaLimits } from '../src/json-schema.js';
import {
  __resetConnectDeps,
  __setConnectDeps,
  handleChatCompletions,
  structuredOutputFailure,
  structuredOutputViolation,
} from '../src/handlers/chat.js';
import { addAccountByKey, getApiKey, removeAccount } from '../src/auth.js';

const CALLER = 'api:budget:user:u1';
const MODEL = 'swe-1-6-slow';
const CASCADE_MODEL = 'gemini-2.5-flash';
const created = [];
let savedDevinConnect = null;

/** A budget whose pattern allowance is already gone, but whose clock is not. */
function spentBudget(overrides = {}) {
  return { expiresAt: performance.now() + 60_000, steps: 0, exhausted: true, ...overrides };
}

function assertUnvalidated(result, label) {
  assert.equal(result.ok, false, `${label}: an unjudged schema must not pass`);
  assert.equal(result.unable, true, `${label}: must be reported as unable, got ${JSON.stringify(result)}`);
  assert.equal(result.code, 'SCHEMA_UNVALIDATED', `${label}: must carry the unvalidated code`);
  assert.equal(typeof result.path, 'string', `${label}: the path is still reported`);
  assert.match(result.message, /could not be validated/, `${label}: the message says what happened`);
}

beforeEach(() => {
  savedDevinConnect = process.env.DEVIN_CONNECT;
});

afterEach(() => {
  __resetConnectDeps();
  if (savedDevinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = savedDevinConnect;
  while (created.length) {
    try { removeAccount(created.pop()); } catch {}
  }
});

// ---------------------------------------------------------------------------
// WF-02 — the three `wolf` cases that the fail-open skip got wrong.
// `^(cat|dog)+$` is a perfectly safe pattern; the old tripwire refused it
// because alternation sat under a `+`, then folded the refusal into a pass.
// ---------------------------------------------------------------------------
describe('pattern: a safe alternation decides instead of being refused (WF-02)', () => {
  const SAFE = '^(cat|dog)+$';

  it('a value that does not match is a conformance failure', () => {
    const r = validateJsonSchema('wolf', { type: 'string', pattern: SAFE });
    assert.equal(r.ok, false, 'the baseline returned ok:true here — a violation reported as a pass');
    assert.equal(r.message, `must match ${SAFE}`);
    assert.equal(r.unable, undefined);
  });

  it('`not` accepts a value the forbidden shape rejects', () => {
    const r = validateJsonSchema('wolf', { not: { pattern: SAFE } });
    assert.equal(r.ok, true, 'the baseline inverted the skip into a violation');
  });

  it('`oneOf` counts only the branch that really matched', () => {
    const r = validateJsonSchema('wolf', { oneOf: [{ pattern: SAFE }, { const: 'wolf' }] });
    assert.equal(r.ok, true, 'the baseline counted the skipped branch as a second match');
  });
});

// ---------------------------------------------------------------------------
// One budget per top-level call, threaded through every recursion.
// The fixture is deterministic: an already-spent pattern allowance is passed
// in, so the ONLY way a nested pattern can come back "unable" is that the
// sub-schema saw the parent's budget instead of creating a fresh one.
// ---------------------------------------------------------------------------
describe('budget: one deadline and one step ceiling for the whole schema tree', () => {
  it('a pattern nested under properties cannot reset the budget', () => {
    const schema = { type: 'object', properties: { a: { type: 'string', pattern: '^a+$' } } };
    assert.equal(validateJsonSchema({ a: 'aaa' }, schema).ok, true, 'control: a fresh budget passes');
    assertUnvalidated(validateJsonSchema({ a: 'aaa' }, schema, { budget: spentBudget() }), 'nested property pattern');
  });

  it('a pattern nested under array items cannot reset the budget', () => {
    const schema = { type: 'array', items: { type: 'string', pattern: '^a+$' } };
    assert.equal(validateJsonSchema(['aaa', 'aa'], schema).ok, true, 'control: a fresh budget passes');
    assertUnvalidated(validateJsonSchema(['aaa', 'aa'], schema, { budget: spentBudget() }), 'nested item pattern');
  });

  it('a pattern behind a $ref cannot reset the budget', () => {
    const schema = {
      $defs: { word: { type: 'string', pattern: '^a+$' } },
      type: 'object',
      properties: { a: { $ref: '#/$defs/word' } },
    };
    assert.equal(validateJsonSchema({ a: 'aaa' }, schema).ok, true, 'control: a fresh budget passes');
    assertUnvalidated(validateJsonSchema({ a: 'aaa' }, schema, { budget: spentBudget() }), 'pattern behind $ref');
  });

  it('a pattern inside a combinator cannot reset the budget', () => {
    const schema = { anyOf: [{ type: 'number' }, { allOf: [{ pattern: '^a+$' }] }] };
    assert.equal(validateJsonSchema('aaa', schema).ok, true, 'control: a fresh budget passes');
    assertUnvalidated(validateJsonSchema('aaa', schema, { budget: spentBudget() }), 'pattern inside anyOf/allOf');
  });

  it('the step ceiling is charged by nested calls, not reset by them', () => {
    // One step is spent at the top level, so a nested call is the one that
    // crosses the line. A sub-schema with a fresh counter would pass.
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const nearCeiling = {
      expiresAt: performance.now() + 60_000,
      steps: __jsonSchemaLimits.MAX_SCHEMA_STEPS - 1,
      exhausted: false,
    };
    const r = validateJsonSchema({ a: 'x' }, schema, { budget: nearCeiling });
    assertUnvalidated(r, 'step ceiling crossed by a nested call');
    assert.match(r.message, /evaluation steps/);
  });

  it('a schema past the traversal ceiling is unable, not silently accepted', () => {
    // 20k branches is a schema a caller can send; without a ceiling this is
    // unbounded JavaScript work that no regex watchdog can interrupt.
    const allOf = Array.from({ length: __jsonSchemaLimits.MAX_SCHEMA_STEPS + 5 }, () => ({ type: 'string' }));
    const started = performance.now();
    const r = validateJsonSchema('x', { allOf });
    const ms = performance.now() - started;
    assertUnvalidated(r, 'oversized schema');
    assert.ok(ms < 2000, `took ${ms.toFixed(1)} ms — the ceiling must stop the walk, not the clock`);
  });

  it('a spent budget does not leak into the next call', () => {
    assertUnvalidated(
      validateJsonSchema('aaa', { type: 'string', pattern: '^a+$' }, { budget: spentBudget() }),
      'spent budget',
    );
    assert.equal(validateJsonSchema('aaa', { type: 'string', pattern: '^a+$' }).ok, true,
      'each top-level call gets its own allowance');
  });

  it('safe patterns are not disturbed by the budget', () => {
    // Search (unanchored) semantics: `pattern` is not an implicit full match.
    assert.equal(validateJsonSchema('xabcx', { type: 'string', pattern: 'abc' }).ok, true);
    assert.equal(validateJsonSchema('xyz', { type: 'string', pattern: 'abc' }).ok, false);
    // Literal parentheses and escapes stay literal.
    assert.equal(validateJsonSchema('(x)', { type: 'string', pattern: '^\\(x\\)$' }).ok, true);
    assert.equal(validateJsonSchema('x', { type: 'string', pattern: '^\\(x\\)$' }).ok, false);
    // A long but legal value still matches exactly.
    const long = 'ab'.repeat(20_000);
    assert.equal(validateJsonSchema(long, { type: 'string', pattern: '^(ab)+$' }).ok, true);
    assert.equal(validateJsonSchema(`${long}a`, { type: 'string', pattern: '^(ab)+$' }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Tri-state propagation. `unable` is not a pass and not a failure: each
// combinator either keeps it visible or returns a verdict that is still
// provable from the branches it did judge.
// ---------------------------------------------------------------------------
describe('tri-state: combinators propagate "unable" instead of folding it', () => {
  const UNJUDGED = { pattern: '^x+$' };      // unable under a spent budget
  const VALID = { type: 'string' };
  const INVALID = { type: 'number' };

  it('`not` does not invert an unjudged child into a pass', () => {
    assertUnvalidated(validateJsonSchema('abc', { not: UNJUDGED }, { budget: spentBudget() }), 'not(unable)');
  });

  it('`allOf` reports a genuine counterexample from a sibling', () => {
    const r = validateJsonSchema('abc', { allOf: [UNJUDGED, INVALID] }, { budget: spentBudget() });
    assert.equal(r.ok, false);
    assert.equal(r.unable, undefined, 'a provable failure is not "unable"');
    assert.match(r.message, /expected number/);
  });

  it('`allOf` is unable when nothing is provably wrong', () => {
    assertUnvalidated(validateJsonSchema('abc', { allOf: [UNJUDGED, VALID] }, { budget: spentBudget() }), 'allOf(unable, valid)');
  });

  it('`anyOf` is unable when no branch is a witness', () => {
    assertUnvalidated(validateJsonSchema('abc', { anyOf: [UNJUDGED, INVALID] }, { budget: spentBudget() }), 'anyOf(unable, invalid)');
  });

  it('`anyOf` passes on a witness even if another branch is unjudged', () => {
    // A conforming branch proves the disjunction; refusing to report it would
    // be a second kind of dishonesty.
    assert.equal(validateJsonSchema('abc', { anyOf: [UNJUDGED, VALID] }, { budget: spentBudget() }).ok, true);
  });

  it('`oneOf` is unable when an unjudged branch could be the second match', () => {
    assertUnvalidated(validateJsonSchema('abc', { oneOf: [UNJUDGED, { const: 'abc' }] }, { budget: spentBudget() }), 'oneOf(unable, valid)');
  });

  it('`oneOf` is invalid when two branches already matched', () => {
    const r = validateJsonSchema('abc', { oneOf: [{ const: 'abc' }, VALID, UNJUDGED] }, { budget: spentBudget() });
    assert.equal(r.ok, false);
    assert.equal(r.unable, undefined, 'two matches disprove oneOf whatever the third branch says');
    assert.match(r.message, /matched 2/);
  });

  it('`oneOf` is invalid when no branch matched and nothing was unjudged', () => {
    const r = validateJsonSchema('abc', { oneOf: [INVALID, { const: 'zzz' }] });
    assert.equal(r.ok, false);
    assert.match(r.message, /matched 0/);
  });

  it('a nested unable result keeps the child path', () => {
    const r = validateJsonSchema(
      { a: 'abc' },
      { type: 'object', properties: { a: { pattern: '^x+$' } } },
      { budget: spentBudget() },
    );
    assertUnvalidated(r, 'nested path');
    assert.equal(r.path, '$.a');
  });
});

// ---------------------------------------------------------------------------
// The surfaces. `unable` must reach the caller as its own typed failure.
// ---------------------------------------------------------------------------
describe('structuredOutputViolation: an unjudged payload is its own verdict', () => {
  const BOMB = '^((a|a))+$';

  it('a real mismatch keeps the old shape exactly', () => {
    assert.deepEqual(
      structuredOutputViolation('{"answer":1}', { type: 'object', required: ['answer', 'unit'] }),
      { path: '$', message: 'missing required property "unit"' },
      'the backward-compatible shape must not grow an `unable` marker',
    );
  });

  it('a budget-exhausted pattern is marked unable with its code', () => {
    const text = JSON.stringify('a'.repeat(26) + '!');
    const v = structuredOutputViolation(text, { type: 'string', pattern: BOMB });
    assert.ok(v, 'the baseline returned null here — an unjudged payload passed as conforming');
    assert.equal(v.unable, true);
    assert.equal(v.code, 'SCHEMA_UNVALIDATED');
    assert.equal(v.path, '$');
    assert.match(v.message, /within budget/);
  });

  it('the failure helper tells the two cases apart', () => {
    const unvalidated = structuredOutputFailure({ path: '$.a', message: 'x', unable: true });
    assert.equal(unvalidated.code, 'STRUCTURED_OUTPUT_UNVALIDATED');
    assert.match(unvalidated.message, /could not validate/);
    assert.doesNotMatch(unvalidated.message, /does not conform/, 'this is a statement about the proxy, not the model');

    const nonConforming = structuredOutputFailure({ path: '$.a', message: 'x' });
    assert.equal(nonConforming.code, 'STRUCTURED_OUTPUT_NOT_CONFORMING');
    assert.match(nonConforming.message, /does not conform/);
  });
});

// ---------------------------------------------------------------------------
// Stream / response terminals. The failure must be ONE typed error frame with
// no clean-finish sentinel, and the payload must never be delivered.
// ---------------------------------------------------------------------------
function seedAccount(label) {
  const a = addAccountByKey(`budget-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  return a;
}

function schemaBody(schema, extra = {}) {
  return {
    model: MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'Answer as JSON.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'bounded', strict: true, schema } },
    ...extra,
  };
}

function connectDeps(content) {
  __setConnectDeps({
    toChatCompletion: async () => ({
      status: 200,
      body: {
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    }),
  });
}

function cascadeDeps(text) {
  class FakeClient {
    async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
      if (opts.onChunk) await opts.onChunk({ text, thinking: '', isError: false });
      const chunks = [];
      chunks.toolCalls = [];
      chunks.totalYielded = text.length;
      chunks.totalThinking = 0;
      return chunks;
    }
  }
  return {
    waitForAccount(tried) { return tried.length === 0 ? getApiKey(tried) : null; },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17888, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
    callerKey: CALLER,
  };
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
    once(event, cb) { this.on(event, cb); return this; },
    removeListener() {},
    writeHead() { return this; },
  };
}

function frames(res) {
  return res.body.split('\n\n').filter(Boolean).map((frame) => {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return null;
    try { return JSON.parse(line.slice(6)); } catch { return null; }
  }).filter(Boolean);
}

describe('terminals: an unjudged payload is a typed failure, never a completed turn', () => {
  const BOMB = '^((a|a))+$';
  // The acceptance case: 26 a's plus a near-miss is past the point where
  // either V8 regexp tier fits in the budget, so the verdict is deterministic.
  const PAYLOAD = JSON.stringify('a'.repeat(26) + '!');
  // An over-long pattern is the same "unable" verdict without spending the
  // budget, which keeps the non-stream case instant.
  const OVER_LONG = '^' + 'a'.repeat(1100) + '$';

  it('Cascade stream: one error frame, no stop, no [DONE], payload not delivered', async () => {
    seedAccount('cascade');
    const result = await handleChatCompletions(
      schemaBody({ type: 'string', pattern: BOMB }, { stream: true, model: CASCADE_MODEL }),
      cascadeDeps(PAYLOAD),
    );
    const res = fakeRes();
    await result.handler(res);

    const chunks = frames(res);
    const errors = chunks.filter((c) => c.error);
    assert.equal(errors.length, 1, `expected one error frame, got ${JSON.stringify(chunks)}`);
    assert.equal(errors[0].error.code, 'STRUCTURED_OUTPUT_UNVALIDATED');
    assert.match(errors[0].error.message, /could not validate/);
    assert.doesNotMatch(errors[0].error.message, /does not conform/,
      'the model was not shown to violate the schema — the proxy ran out of budget');
    assert.equal(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'), false,
      'finish_reason:stop would tell the caller its schema held');
    assert.equal(res.body.includes('data: [DONE]'), false, 'no clean-finish sentinel on a failure');
    assert.equal(res.body.includes(PAYLOAD.slice(1, -1)), false, 'the unjudged payload must not be delivered');
  });

  it('Connect non-stream: 502 with the unvalidated code, not a conformance message', async () => {
    process.env.DEVIN_CONNECT = '1';
    seedAccount('connect');
    connectDeps(PAYLOAD);
    const result = await handleChatCompletions(
      schemaBody({ type: 'string', pattern: BOMB }),
      { callerKey: CALLER },
    );
    assert.equal(result.status, 502, `expected a typed failure, got ${result.status} ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error.code, 'STRUCTURED_OUTPUT_UNVALIDATED');
    assert.match(result.body.error.message, /could not validate/);
    assert.doesNotMatch(result.body.error.message, /does not conform/);
    assert.equal(result.body.error.type, 'server_error');
  });
});
