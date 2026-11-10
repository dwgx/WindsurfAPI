import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __stripMetaTags, fingerprintAfter } from '../src/conversation-pool.js';

// stripMetaTags keeps the reuse fingerprint stable by deleting the
// client-injected meta tags whose bodies change every turn (issue #24).
// These tests pin the exact semantics of the old
// /<names>[^>]*>[\s\S]*?</\1>/g replace — verified byte-identical to the
// regex on a 40-case matrix + 20k-string fuzz — while asserting the new
// linear scanner kills the quadratic blowup (CWE-1333): the regex took
// ~7s on the 256KB unclosed-opens bomb measured on this machine.

describe('stripMetaTags semantics (regex-compatible)', () => {
  it('removes a known tag span including attrs and body', () => {
    assert.equal(__stripMetaTags('hello <system-reminder>state</system-reminder> world'), 'hello  world');
    assert.equal(__stripMetaTags('<system-reminder attr="v" n=2>body</system-reminder>'), '');
  });

  it('strips every tag name in META_TAG_NAMES', () => {
    for (const t of ['system-reminder', 'command-message', 'command-name', 'command-args',
      'local-command-stdout', 'local-command-stderr', 'user-prompt-submit-hook',
      'analysis', 'summary', 'example']) {
      assert.equal(__stripMetaTags(`x<${t}>body</${t}>y`), 'xy', `<${t}> should strip`);
    }
  });

  it('first closer closes the first open; trailing closer stays literal', () => {
    // <a><a></a></a> — regex removes 0..first </a>, leftover is a stray closer.
    assert.equal(__stripMetaTags('<analysis><analysis></analysis></analysis>'), '</analysis>');
    // One closer removes from the outermost open.
    assert.equal(__stripMetaTags('<analysis><analysis></analysis>'), '');
  });

  it('inner different-named tag is removed inside the outer span', () => {
    assert.equal(__stripMetaTags('<analysis><summary></summary></analysis>'), '');
  });

  it('mismatched open/closer pair stays literal', () => {
    assert.equal(__stripMetaTags('<analysis></summary>'), '<analysis></summary>');
  });

  it('unclosed opens and stray closers stay literal', () => {
    assert.equal(__stripMetaTags('<analysis/>x'), '<analysis/>x');
    assert.equal(__stripMetaTags('keep <analysis>unclosed'), 'keep <analysis>unclosed');
    assert.equal(__stripMetaTags('stray </analysis> closer'), 'stray </analysis> closer');
  });

  it('mixed closed and unclosed opens', () => {
    assert.equal(
      __stripMetaTags('a<summary>1</summary>b<analysis>2</analysis>c<example>gone</example>d'),
      'abcd'
    );
    // closed summary removed, unclosed analysis kept
    assert.equal(
      __stripMetaTags('<summary>x</summary> tail <analysis>open'),
      'tail <analysis>open'
    );
  });

  it('attrs are [^>]* — embedded quotes, =, and even < do not end the open', () => {
    assert.equal(__stripMetaTags('<command-args a="1" b="2">body</command-args>'), '');
    // A '<' inside attrs is legal ([^>]* matches it); the open ends at the
    // first '>' — which here belongs to <evil>, and the name is analysis.
    assert.equal(__stripMetaTags('<analysis =<evil>"x</analysis>'), '');
    // '>' inside an attr VALUE ends the open early: <a x="1> is the open,
    // 2"> is body — the whole span still strips (regex has no quote rules).
    assert.equal(__stripMetaTags('<analysis x="1>2">body</analysis>'), '');
  });

  it('tag name is a prefix match — <examplefoo> is an open of `example`', () => {
    // [^>]* absorbs 'foo', so the required closer is </example>, not </examplefoo>.
    assert.equal(__stripMetaTags('<examplefoo>x</example>'), '');
    assert.equal(__stripMetaTags('<examplefoo>x</examplefoo>'), '<examplefoo>x</examplefoo>');
  });

  it('is case-sensitive and requires the name right after <', () => {
    assert.equal(__stripMetaTags('<ANALYSIS>x</ANALYSIS>'), '<ANALYSIS>x</ANALYSIS>');
    assert.equal(__stripMetaTags('<analysis>x</Analysis>'), '<analysis>x</Analysis>');
    assert.equal(__stripMetaTags('< analysis>x</analysis>'), '< analysis>x</analysis>');
    assert.equal(__stripMetaTags('<-analysis>x</analysis>'), '<-analysis>x</analysis>');
  });

  it('requires the exact </name> closer — attrs on the closer do not match', () => {
    assert.equal(__stripMetaTags('<analysis >x</analysis >'), '<analysis >x</analysis >');
    assert.equal(__stripMetaTags('<analysis>x</analysis  >y'), '<analysis>x</analysis  >y');
  });

  it('does not match unknown tag names and strips known tags inside them', () => {
    assert.equal(__stripMetaTags('<evil>x</evil>'), '<evil>x</evil>');
    assert.equal(__stripMetaTags('<a><analysis>x</analysis></a>'), '<a></a>');
  });

  it('crossed spans: first </a> closes the a-open, orphan </b> stays', () => {
    assert.equal(__stripMetaTags('<analysis>a <summary>b</analysis>c</summary>'), 'c</summary>');
  });

  it('applies whitespace cleanup after stripping', () => {
    assert.equal(__stripMetaTags('line1   \nline2\n\n\n\nline3'), 'line1\nline2\n\nline3');
    assert.equal(__stripMetaTags('   padded   '), 'padded');
    assert.equal(__stripMetaTags('<analysis>x</analysis>\n\n\n\ntail'), 'tail');
  });

  it('returns non-string and empty input as-is', () => {
    assert.equal(__stripMetaTags(''), '');
    assert.equal(__stripMetaTags(null), null);
    assert.equal(__stripMetaTags(undefined), undefined);
    assert.equal(__stripMetaTags(42), 42);
  });

  it('caps scanned input at 262144 chars', () => {
    assert.equal(__stripMetaTags('x'.repeat(300000)).length, 262144);
  });
});

describe('stripMetaTags unknown-tag audit', () => {
  function auditLog(input) {
    const orig = console.error;
    const lines = [];
    console.error = (...a) => lines.push(a.join(' '));
    try { __stripMetaTags(input); } finally { console.error = orig; }
    return lines.join('\n');
  }

  it('logs unknown open tag names once, deduped in first-seen order', () => {
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    try { __stripMetaTags('<evil>a</evil> <badtag>x</badtag> <evil>again</evil>'); }
    finally { console.error = orig; }
    assert.deepEqual(lines, ['[META_TAG_AUDIT] Unknown XML tags in user message: evil, badtag']);
  });

  it('logs unclosed unknown opens (semantic change: more coverage, not less)', () => {
    // The old paired <name>…</name> audit needed a closer; open-only scan
    // still surfaces the name when the closer never arrives. (An open
    // still needs its '>' — `<evil attr` alone is not a tag.)
    assert.match(auditLog('<evil>never closed'), /evil/);
  });

  it('does not log known names or stray closers', () => {
    assert.equal(auditLog('<analysis>unclosed'), '');
    assert.equal(auditLog('stray </evil> only'), '');
  });
});

describe('stripMetaTags ReDoS regression (CWE-1333)', () => {
  // Old impl measured ~7000ms on this input; new impl ~4ms. 500ms is ~30x
  // headroom for CI noise and still 14x under the old impl's time.
  const BUDGET_MS = 500;

  it('256KB of unclosed <system-reminder> opens strips linearly', () => {
    const bomb = '<system-reminder>'.repeat(Math.ceil(262144 / 17));
    const t0 = performance.now();
    const out = __stripMetaTags(bomb);
    const elapsed = performance.now() - t0;
    // No closers exist → nothing strips; input is unchanged (modulo cap).
    assert.equal(out, bomb.slice(0, 262144));
    assert.ok(elapsed < BUDGET_MS, `unclosed-opens bomb took ${elapsed.toFixed(1)}ms (old impl ~7000ms)`);
  });

  it('256KB of <system-reminder with no > at all strips linearly', () => {
    const bomb = '<system-reminder'.repeat(Math.ceil(262144 / 16));
    const t0 = performance.now();
    const out = __stripMetaTags(bomb);
    const elapsed = performance.now() - t0;
    assert.equal(out, bomb.slice(0, 262144));
    assert.ok(elapsed < BUDGET_MS, `no-> bomb took ${elapsed.toFixed(1)}ms`);
  });

  it('256KB residual <x opens do not quadratic the unknown-tag audit', () => {
    // After the strip leaves this untouched, the audit must scan it — the
    // old paired regex spent 42s here; the suggested /<name[^>]*>/ regex
    // would still be O(n²) with no '>' present. The manual scan is linear.
    const bomb = '<x'.repeat(131072);
    const orig = console.error;
    console.error = () => {};
    const t0 = performance.now();
    try { __stripMetaTags(bomb); } finally { console.error = orig; }
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < BUDGET_MS, `audit bomb took ${elapsed.toFixed(1)}ms (old audit ~42000ms)`);
  });

  it('fingerprinting stays correct on a bomb-shaped message', () => {
    const bomb = '<system-reminder>'.repeat(2000);
    const msgs = [
      { role: 'user', content: `u ${bomb}` },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    const t0 = performance.now();
    const fp = fingerprintAfter(msgs, 'm', 'c');
    const elapsed = performance.now() - t0;
    assert.ok(typeof fp === 'string' && fp.length === 64);
    assert.ok(elapsed < BUDGET_MS, `fingerprintAfter took ${elapsed.toFixed(1)}ms`);
  });
});
