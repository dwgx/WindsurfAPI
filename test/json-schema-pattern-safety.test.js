// Caller-supplied `pattern` strings are compiled by the platform RegExp engine
// and run against MODEL output on the request path — a caller can aim a
// catastrophic-backtracking regex at this process's event loop. The bounds in
// src/json-schema.js keep `pattern` a judgement the proxy can afford:
//   * a nested-quantifier pattern (the `^(a+)+$` family) is refused;
//   * a pattern longer than 1024 chars is refused;
//   * a target string over 256 KiB is not matched (the schema's own `maxLength`,
//     still enforced, is the bound a caller controls).
// "Refused" means treated exactly like an unparseable pattern: skipped, never a
// conformance failure — the module's standing contract for judgements it cannot
// safely make.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema } from '../src/json-schema.js';

// Each entry pairs a refused pattern with a SHORT value the pattern WOULD
// reject if it were ever compiled and run — so ok:true can only mean the
// pattern was refused, not that the value happened to conform. Keep these
// values tiny: a long near-miss is itself the regex bomb.
const REFUSED_NESTED = [
  { pattern: '^(a+)+$',          failing: 'aab' },
  { pattern: '^(a+)*$',          failing: 'aaab' },
  { pattern: '^(\\w*)*$',        failing: '!!!' },
  { pattern: '^([a-z]+)+$',      failing: 'abc1' },
  { pattern: '^(\\d{2,}){2,}$',  failing: '123' },
  { pattern: '^((x|y)+)+$',      failing: 'xxz' },
  { pattern: '^(a|b+)+$',        failing: 'abz' },
  // Top-level alternation inside a quantified group is the ambiguous-split
  // bomb family: `^(a|a)+$` measured 5.4 s on a 26-char near-miss and doubles
  // ~4× per +2 chars — the target-length cap cannot save it. The tripwire
  // refuses the whole shape, including safe members like `(a|b)+`: a refused
  // pattern is skipped (annotation we cannot afford to judge), never a
  // conformance failure, so over-refusal is the safe direction.
  { pattern: '^(a|a)+$',         failing: 'ab' },
  { pattern: '^(a|ab)+$',        failing: 'aabc' },
  { pattern: '^(?:a|a)+$',       failing: 'ab' },
  { pattern: '^(a|a){2,}$',      failing: 'aab' },
  { pattern: '^(a|b)+$',         failing: 'c' },
];

// Shapes the tripwire must NOT touch — each still enforces.
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
  // Alternation NOT inside a quantified group stays enforced — each branch is
  // tried once per position, which is linear.
  { pattern: '^(a|b)$',            ok: 'a',     bad: 'c' },
  // Nested alternation inside a quantified group is pinned by surrounding
  // literals — not the ambiguous-split shape — and stays enforced.
  { pattern: '^(x(a|b)y)+$',       ok: 'xayxby', bad: 'xcy' },
  // `|` inside a character class is a literal, not alternation.
  { pattern: '^[a|b]+$',           ok: 'a|b',   bad: 'c' },
  // An escaped `\|` inside a quantified group is a literal pipe.
  { pattern: '^(a\\|b)+$',         ok: 'a|ba|b', bad: 'ab' },
  // `?` runs the group at most once — not an outer quantifier here.
  { pattern: '^(a|b)?$',           ok: 'a',     bad: 'c' },
];

describe('pattern: nested-quantifier tripwire', () => {
  it('refuses catastrophic-nesting patterns instead of running them', () => {
    for (const { pattern, failing } of REFUSED_NESTED) {
      assert.equal(
        new RegExp(pattern).test(failing), false,
        `fixture error: ${failing} must actually fail ${pattern}`,
      );
      const r = validateJsonSchema(failing, { type: 'string', pattern });
      assert.equal(r.ok, true, `${pattern} must be refused (skipped), not run`);
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

describe('pattern: length bounds', () => {
  it('refuses a pattern longer than 1024 chars', () => {
    const long = '^' + 'a'.repeat(1100) + '$';
    assert.equal(long.length > 1024, true, 'fixture must exceed the cap');
    assert.equal(validateJsonSchema('b', { type: 'string', pattern: long }).ok, true);
  });

  it('still enforces a pattern exactly at 1024 chars', () => {
    const edge = '^' + 'a'.repeat(1022) + '$';
    assert.equal(edge.length, 1024);
    assert.equal(validateJsonSchema('b', { type: 'string', pattern: edge }).ok, false);
  });

  it('skips the match on targets over 256 KiB — other cheap checks still apply', () => {
    const big = 'z'.repeat(256 * 1024 + 1);
    // Not matched: the value would fail ^a+$ if the pattern ran.
    assert.equal(new RegExp('^a+$').test(big), false, 'fixture must fail if run');
    assert.equal(
      validateJsonSchema(big, { type: 'string', pattern: '^a+$' }).ok, true,
      'an over-cap target is not matched (fail-open, documented)',
    );
    // …but the caller's own `maxLength` bound still fires on the same value.
    assert.equal(
      validateJsonSchema(big, { type: 'string', pattern: '^a+$', maxLength: 10 }).ok, false,
      'maxLength remains the enforceable bound for over-cap strings',
    );
  });
});
