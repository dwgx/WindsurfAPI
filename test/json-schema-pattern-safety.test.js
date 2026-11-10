// Caller-supplied `pattern` strings are compiled by the platform RegExp engine
// and run against MODEL output on the request path — a caller can aim a
// catastrophic-backtracking regex at this process's event loop.
//
// MEASURED on the audited baseline (Node v24.19.0): the static tripwire in
// src/json-schema.js refused a pattern by SKIPPING it and reporting `ok:true`,
// and it could be defeated by one harmless group — `^((a|a))+$` against 26 `a`s
// plus a near-miss blocked the event loop past a 1 s hard kill. The same skip
// made a perfectly safe `^(cat|dog)+$` "refused", so `not` rejected a value it
// should accept and `oneOf` counted two matches.
//
// The contract pinned here:
//   * every `pattern` is actually EVALUATED, under one request-wide execution
//     budget enforced by a vm watchdog that can interrupt the engine;
//   * a bomb returns an explicit `unable` verdict (code SCHEMA_UNVALIDATED)
//     within the budget — never a silent pass, never a 1 s block;
//   * patterns the old tripwire over-refused are now enforced normally;
//   * the size caps produce `unable`, not `ok:true`;
//   * ordinary patterns (including the look-alike safe shapes) still decide.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateJsonSchema, __jsonSchemaLimits } from '../src/json-schema.js';

const MODULE_URL = new URL('../src/json-schema.js', import.meta.url).href;

// The shape the static tripwire used to "refuse". Each is now RUN. The values
// are deliberately tiny: a long near-miss is itself the bomb, and this file
// must never depend on a catastrophic match finishing.
const BOMB_SHAPES = [
  { pattern: '^(a+)+$',          failing: 'aab' },
  { pattern: '^(a+)*$',          failing: 'aaab' },
  { pattern: '^(\\w*)*$',        failing: '!!!' },
  { pattern: '^([a-z]+)+$',      failing: 'abc1' },
  { pattern: '^(\\d{2,}){2,}$',  failing: '123' },
  { pattern: '^((x|y)+)+$',      failing: 'xxz' },
  { pattern: '^(a|b+)+$',        failing: 'abz' },
  { pattern: '^(a|a)+$',         failing: 'ab' },
  { pattern: '^(a|ab)+$',        failing: 'aabc' },
  { pattern: '^(?:a|a)+$',       failing: 'ab' },
  { pattern: '^(a|a){2,}$',      failing: 'aab' },
  { pattern: '^(a|b)+$',         failing: 'c' },
];

// Shapes that must keep deciding, including the look-alike safe ones the old
// tripwire over-refused.
const ENFORCED = [
  { pattern: '^\\d+$',             ok: '123',   bad: '12a' },
  // A `?` after a group is not an outer quantifier (runs the group at most
  // once); this common optional-fraction shape must keep working.
  { pattern: '^\\d+(\\.\\d+)?$',   ok: '12.5',  bad: '12.' },
  { pattern: '^[a-z]+$',           ok: 'abc',   bad: 'abc1' },
  // `{` inside a character class is a literal, not a quantifier.
  { pattern: '^[{]+$',             ok: '{{{',   bad: '{a' },
  { pattern: '^x{2,4}$',           ok: 'xxx',   bad: 'xxxxx' },
  { pattern: '^(yes|no)$',         ok: 'yes',   bad: 'maybe' },
  // Alternation NOT inside a quantified group — linear, always fine.
  { pattern: '^(a|b)$',            ok: 'a',     bad: 'c' },
  // Nested alternation inside a quantified group is pinned by surrounding
  // literals — not the ambiguous-split shape.
  { pattern: '^(x(a|b)y)+$',       ok: 'xayxby', bad: 'xcy' },
  // `|` inside a character class is a literal, not alternation.
  { pattern: '^[a|b]+$',           ok: 'a|b',   bad: 'c' },
  // An escaped `\|` inside a quantified group is a literal pipe.
  { pattern: '^(a\\|b)+$',         ok: 'a|ba|b', bad: 'ab' },
  // `?` runs the group at most once — not an outer quantifier here.
  { pattern: '^(a|b)?$',           ok: 'a',     bad: 'c' },
];

function assertUnvalidated(result, label) {
  assert.equal(result.ok, false, `${label}: an unjudged pattern must not pass`);
  assert.equal(result.unable, true, `${label}: must be reported as unable, got ${JSON.stringify(result)}`);
  assert.equal(result.code, 'SCHEMA_UNVALIDATED', `${label}: must carry the unvalidated code`);
}

describe('pattern: the old static "refusal" is gone, the pattern is really run', () => {
  it('evaluates every shape the tripwire used to skip', () => {
    for (const { pattern, failing } of BOMB_SHAPES) {
      assert.equal(
        new RegExp(pattern).test(failing), false,
        `fixture error: ${failing} must actually fail ${pattern}`,
      );
      const r = validateJsonSchema(failing, { type: 'string', pattern });
      assert.equal(r.ok, false, `${pattern} must be evaluated, not skipped (got ${JSON.stringify(r)})`);
      assert.equal(r.message, `must match ${pattern}`);
      assert.equal(r.unable, undefined, 'a decided mismatch is not an "unable" verdict');
    }
  });

  it('keeps enforcing legitimate patterns, including look-alike safe shapes', () => {
    for (const { pattern, ok, bad } of ENFORCED) {
      assert.equal(validateJsonSchema(ok, { type: 'string', pattern }).ok, true,
        `${pattern} should accept ${JSON.stringify(ok)}`);
      assert.equal(validateJsonSchema(bad, { type: 'string', pattern }).ok, false,
        `${pattern} should reject ${JSON.stringify(bad)}`);
    }
  });
});

// WF-01: the wrapped-alternation bomb. `hasTopLevelAlternation` only saw depth
// 0, so wrapping the alternation in one harmless group defeated BOTH tripwires
// and the exponential match ran with no bound at all. MEASURED on the audited
// baseline: 18 a's = 43 ms, 22 a's = 375 ms, 26 a's exceeded a 1 s hard kill.
describe('pattern: catastrophic backtracking is bounded (WF-01)', () => {
  const BOMB = '^((a|a))+$';

  it('a 26-char near-miss returns an explicit unvalidated verdict, fast', () => {
    // 26 is the acceptance case, and it is deliberately past the point where
    // EITHER of V8's regexp tiers fits in the budget: the baseline measured
    // 375 ms at 22 a's and ~4x per two more characters. A shorter near-miss
    // (22 a's) is only ~24 ms once V8 has compiled the pattern, so it would
    // make this assertion depend on which run came first.
    const started = performance.now();
    const r = validateJsonSchema('a'.repeat(26) + '!', { type: 'string', pattern: BOMB });
    const ms = performance.now() - started;
    assertUnvalidated(r, BOMB);
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms; the baseline never returned inside a 1 s hard kill`);
  });

  it('a 26-char near-miss cannot block the process for a second', () => {
    // The baseline NEVER returned here: the event loop was inside V8's
    // backtracking. A child process with a hard kill is the only honest way to
    // assert "the process came back", because an in-process assertion on the
    // broken code would hang the runner instead of failing it.
    const source = `
      import { validateJsonSchema } from ${JSON.stringify(MODULE_URL)};
      const started = performance.now();
      const verdict = validateJsonSchema('a'.repeat(26) + '!', { type: 'string', pattern: ${JSON.stringify(BOMB)} });
      console.log(JSON.stringify({ ms: performance.now() - started, verdict }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      timeout: 1500,
      killSignal: 'SIGKILL',
    });
    assert.equal(child.error, undefined,
      `the child had to be killed: the match never returned (${child.error?.code || child.error})`);
    assert.equal(child.status, 0, `child failed: ${child.stderr || child.stdout}`);
    const { ms, verdict } = JSON.parse(child.stdout.trim());
    assertUnvalidated(verdict, `${BOMB} in a child process`);
    assert.ok(ms < 1000, `took ${ms.toFixed(1)} ms; the bound is one second, measured ~60 ms`);
  });

  it('the budget is spent once: a second pattern in the same schema is not run', () => {
    // Two bombs would cost two watchdog windows if each got a fresh budget.
    const schema = { allOf: [{ pattern: BOMB }, { pattern: BOMB }] };
    const started = performance.now();
    const r = validateJsonSchema('a'.repeat(26) + '!', schema);
    const ms = performance.now() - started;
    assertUnvalidated(r, 'two bombs, one budget');
    assert.ok(ms < 1000, `took ${ms.toFixed(1)} ms — the second pattern must not get a second window`);
  });
});

describe('pattern: size caps are explicit "unable", never a silent pass', () => {
  it('a pattern longer than the cap cannot be evaluated', () => {
    const long = '^' + 'a'.repeat(1100) + '$';
    assert.equal(long.length > __jsonSchemaLimits.MAX_PATTERN_CHARS, true, 'fixture must exceed the cap');
    assertUnvalidated(validateJsonSchema('b', { type: 'string', pattern: long }), 'over-long pattern');
  });

  it('still enforces a pattern exactly at the cap', () => {
    const edge = '^' + 'a'.repeat(1022) + '$';
    assert.equal(edge.length, __jsonSchemaLimits.MAX_PATTERN_CHARS);
    assert.equal(validateJsonSchema('b', { type: 'string', pattern: edge }).ok, false);
  });

  it('a target over the cap cannot be matched — and says so', () => {
    const big = 'z'.repeat(__jsonSchemaLimits.MAX_PATTERN_TARGET_CHARS + 1);
    // Not matched: the value would fail ^a+$ if the pattern ran.
    assert.equal(new RegExp('^a+$').test(big), false, 'fixture must fail if run');
    assertUnvalidated(
      validateJsonSchema(big, { type: 'string', pattern: '^a+$' }),
      'over-cap target',
    );
    // …but the caller's own `maxLength` bound still fires on the same value.
    assert.equal(
      validateJsonSchema(big, { type: 'string', pattern: '^a+$', maxLength: 10 }).ok, false,
      'maxLength remains the enforceable bound for over-cap strings',
    );
  });

  it('a target just under the cap is matched, not truncated', () => {
    const atCap = 'a'.repeat(__jsonSchemaLimits.MAX_PATTERN_TARGET_CHARS);
    assert.equal(validateJsonSchema(atCap, { type: 'string', pattern: '^a+$' }).ok, true);
    // One trailing character past the run must be seen: a truncated match
    // would call this conforming.
    const onePast = atCap + 'b';
    assertUnvalidated(validateJsonSchema(onePast, { type: 'string', pattern: '^a+$' }), 'one char past the cap');
    // Just under the cap, the trailing character is visible and decides.
    const under = 'a'.repeat(__jsonSchemaLimits.MAX_PATTERN_TARGET_CHARS - 1) + 'b';
    assert.equal(validateJsonSchema(under, { type: 'string', pattern: '^a+$' }).ok, false);
  });
});

// A malformed `pattern` is NOT an unknown keyword: `pattern` is a keyword this
// module supports, and the caller wrote it wrong. Folding that into a pass is
// the same fail-open as refusing a valid pattern — and the combinators invert
// it exactly the same way (measured on the first cut of this fix:
// `{not:{pattern:'('}}` reported a violation and
// `{oneOf:[{pattern:'('},{const:'x'}]}` reported "matched 2").
describe('pattern: a malformed pattern is a schema we cannot evaluate', () => {
  const INVALID = '(';

  it('is reported as unable, not as a pass', () => {
    const r = validateJsonSchema('anything', { type: 'string', pattern: INVALID });
    assertUnvalidated(r, 'invalid pattern');
    assert.equal(r.reason, 'invalid-pattern');
    assert.match(r.message, /not a valid regular expression/);
  });

  it('is not inverted by `not` into a violation', () => {
    assertUnvalidated(validateJsonSchema('anything', { not: { pattern: INVALID } }), 'not(invalid pattern)');
  });

  it('is not counted by `oneOf` as a second match', () => {
    const r = validateJsonSchema('x', { oneOf: [{ pattern: INVALID }, { const: 'x' }] });
    assertUnvalidated(r, 'oneOf(invalid pattern, const)');
    assert.doesNotMatch(r.message, /matched 2/);
  });

  it('is not a witness for `anyOf`', () => {
    assertUnvalidated(validateJsonSchema('x', { anyOf: [{ pattern: INVALID }, { type: 'number' }] }), 'anyOf(invalid pattern, number)');
  });
});
