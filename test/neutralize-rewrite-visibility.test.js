// Item 14 — the neutralize pass could silently rewrite caller content, and the guard
// meant to catch that was structurally blind to the shape that did it.
//
// `rule()` warned only when a substitution REMOVED more than
// OVER_DELETION_WARN_BYTES. That check was added for an unbounded-regex
// over-deletion defect (199 bytes in, 18 out, two caller security rules gone). It
// can only fire when the text shrinks — and a7-freeform, the one rule that rewrote
// a bare token, GREW: FREEFORM is 8 bytes, free-form is 9, so `removed` is -1 per
// hit and no byte threshold could ever see it. MEASURED damage while it was silent:
//     CHECK (kind IN ('FREEFORM','STRUCTURED'))  ->  ('free-form','STRUCTURED')
//     if (mode === FREEFORM) { parse(); }        ->  mode === free-form
// The first rewrites a string literal inside a data contract; the second is not
// valid code.
//
// H2 HAS SINCE FIXED THE REWRITE ITSELF. a7-freeform is now scoped to a line that
// carries the apply_patch JSON-wrap clause, so caller SQL/JS comes back byte-identical
// (the first case below pins that). The occurrence guard stays as the safety net for
// any future GLOBAL rule — a4-fastmode and a4-cli-line can still fire repeatedly — and
// the multi-hit case below exercises it through a4-cli-line.
//
// WHY OCCURRENCE COUNT AND NOT BYTES. A byte threshold in the growth direction is the
// wrong instrument twice: a one-byte-per-hit rewrite never reaches a useful figure,
// while an ordinary identity rewrite (a clause replaced by a longer sentence) exceeds
// any small figure on every well-behaved request, training operators to ignore the
// line. What made a7-freeform different was that it was a GLOBAL BARE-TOKEN rule, so
// it could hit an unbounded number of times in text it was never aimed at.
//
// RESIDUAL, stated because it is not covered: a SINGLE-hit rewrite of caller content
// is still silent. `if (mode === FREEFORM)` has one occurrence, which is
// indistinguishable by count from one legitimate hit of the trigger phrase. H2's
// provenance boundary is what protects that shape now, not the count.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { neutralizeClientIdentity } from '../src/handlers/identity-neutralize.js';
import { log } from '../src/config.js';

/** Neutralize while capturing WARN output. */
function neutralize(text, env = {}) {
  const warns = [];
  const original = log.warn;
  log.warn = (...args) => { warns.push(args.join(' ')); };
  let out;
  try {
    out = neutralizeClientIdentity(text, env);
  } finally {
    log.warn = original;
  }
  return {
    out,
    multiHit: warns.filter(w => w.includes('occurrences')),
    overDeletion: warns.filter(w => w.includes('removed')),
  };
}

describe('item 14 — the growth guard stays visible after H2 scoped a7-freeform', () => {
  it('preserves the SQL-DDL caller text H2 took out of a7-freeform scope', () => {
    // The shape the global rule used to corrupt: a column doc mentioning the token
    // twice, with no apply_patch JSON-wrap clause anywhere on the line.
    const sql = 'DB column TYPE is FREEFORM. Validate that FREEFORM entries parse.';
    const { out, multiHit } = neutralize(sql);
    assert.equal(out, sql, 'caller SQL is byte-identical');
    assert.deepEqual(multiHit, [], 'nothing was rewritten, so nothing is reported');
  });

  it('reports a multi-hit length-increasing rewrite with its byte direction', () => {
    // a4-cli-line is a GLOBAL rule that can still fire twice and grows each line;
    // this keeps the occurrence guard exercised now that a7-freeform is scoped.
    const src = 'Claude Code is available as a CLI.\nClaude Code is available as a CLI.';
    const { multiHit } = neutralize(src);
    assert.equal(multiHit.length, 1, 'a multi-hit rewrite must be reported');
    assert.match(multiHit[0], /a4-cli-line/);
    assert.match(multiHit[0], /2 occurrences/);
    // Growth, not shrinkage: the numbers must show the prompt got LONGER, which is
    // precisely why the deletion-only guard could not fire.
    const m = multiHit[0].match(/prompt (\d+) → (\d+) bytes/);
    assert.ok(m, `expected byte figures in: ${multiHit[0]}`);
    assert.ok(Number(m[2]) > Number(m[1]), `expected growth, got ${m[1]} → ${m[2]}`);
  });

  it('stays silent on the single-hit trigger the rule exists for', () => {
    // The codex apply_patch description. Warning here would fire on every legitimate
    // request and train operators to ignore the line.
    const { out, multiHit } = neutralize('apply_patch is a FREEFORM tool, so do not wrap the patch in JSON.');
    assert.deepEqual(multiHit, []);
    // Both fragments still rewritten — the live A/B showed one alone does not clear
    // the content policy.
    assert.equal(out.includes('free-form tool'), true);
    assert.equal(out.includes('provide the patch as plain text'), true);
  });

  it('stays silent on an ordinary identity rewrite', () => {
    const { out, multiHit } = neutralize("You are Claude Code, Anthropic's official CLI for Claude.");
    assert.deepEqual(multiHit, []);
    assert.equal(out.includes('Claude Code'), false);
  });

  it('stays silent when a client repeats its identity line', () => {
    // Phrase rules match once per distinct phrasing, so a doubled identity block must
    // not trip a count threshold aimed at bare-token rules.
    const doubled = "You are Claude Code, Anthropic's official CLI for Claude. "
      + "Remember: Claude Code, Anthropic's official CLI for Claude.";
    assert.deepEqual(neutralize(doubled).multiHit, []);
  });

  it('keeps the over-deletion warning working on a large catalogue deletion', () => {
    // The W2 guard. Its branch is byte-for-byte unchanged, and this pins that: a
    // large single deletion must still be reported, and must NOT be reclassified as
    // a multi-hit rewrite. The fixture now carries the catalogue TERMINATOR: the
    // a4-catalogue-line fallback rewrites only its anchor phrase (it no longer
    // deletes the line), so the full a4-catalogue span is the deletion path left.
    const bigCatalogue = 'The most recent Claude models are ' + 'x'.repeat(600)
      + ' most capable Claude models.\n';
    const { overDeletion, multiHit } = neutralize(bigCatalogue);
    assert.equal(overDeletion.length, 1, 'the over-deletion warning must still fire');
    assert.match(overDeletion[0], /removed \d+ bytes/);
    assert.deepEqual(multiHit, [], 'a deletion must not also be counted as a rewrite');
  });

  it('classifies a large multi-occurrence deletion as a deletion only', () => {
    // The two branches must stay EXCLUSIVE. A rule that deletes a lot AND matches
    // several times is one event, not two, and reporting it twice would make the
    // operator-facing count meaningless. Needs both conditions true at once —
    // >512 bytes removed and >1 occurrence. Two SHORT a4-cli-line bullets are that
    // shape: each is replaced whole (293 bytes removed per line, 586 total) and the
    // rule fires twice, so without the exclusivity the multi-hit branch would report
    // it a second time.
    const line = 'Claude Code is available as a CLI ' + 'x'.repeat(300) + '\n';
    const { overDeletion, multiHit } = neutralize(line + line);
    assert.equal(overDeletion.length, 1, 'the deletion must be reported');
    assert.deepEqual(multiHit, [], 'and must NOT also be reported as a rewrite');
  });

  it('no non-global rule carries a capture group', () => {
    // Pins the premise that makes the growth branch's `re.global` test currently
    // undrivable, so a mutation removing it is a documented survivor rather than an
    // unexplained one. `String.match(nonGlobalRe)` returns [fullMatch, ...groups], so
    // a non-global rule WITH a group would report groups as occurrences and warn
    // spuriously. Today none has one; if that changes, `re.global` starts carrying
    // weight and its mutation should be expected to be CAUGHT.
    const src = readFileSync(new URL('../src/handlers/identity-neutralize.js', import.meta.url), 'utf8');
    const offenders = [];
    for (const m of src.matchAll(/rule\(\s*['"]([a-z0-9-]+)['"]\s*,\s*\/((?:[^/\\\n]|\\.)*)\/([a-z]*)/g)) {
      const [, id, pattern, flags] = m;
      if (!flags.includes('g') && /\((?!\?)/.test(pattern)) offenders.push(id);
    }
    assert.deepEqual(offenders, [], `non-global rules with capture groups: ${offenders.join(', ')}`);
  });

  it('reports nothing when the master switch is off', () => {
    // No rule runs, so no rule can warn.
    const { out, multiHit, overDeletion } = neutralize(
      'DB column TYPE is FREEFORM. Validate that FREEFORM entries parse.',
      { WINDSURFAPI_NEUTRALIZE_CLIENT_ID: '0' },
    );
    assert.equal(out.includes('FREEFORM'), true, 'text must pass through untouched');
    assert.deepEqual(multiHit, []);
    assert.deepEqual(overDeletion, []);
  });
});
