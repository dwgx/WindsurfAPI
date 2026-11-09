// identity-neutralize: the spans must be BOUNDED, and the bound must be a PARAGRAPH
// bound rather than a line bound.
//
// Two independent defects live here, both measured on real prompts:
//
//   WA-002 (end branch). The security rule's tail was `security research[^.]*\.` and
//   `[^.]*` crosses blank lines. A prompt with only the opening phrase and, two
//   paragraphs later, the words "security research." had EVERYTHING between them
//   replaced — including the caller's own "RULE: Preserve the production database."
//   line — with no WARN. Fixed by bounding the terminator search to the paragraph
//   that holds the phrase.
//
//   ANCHOR GAP. `IMPORTANT:` + `\s*` + phrase: the `\s*` crossed a blank line too, so
//   an `IMPORTANT:` at the end of paragraph 1 paired with the phrase at the start of
//   paragraph 2 and the span deleted across the break (the full span, not just the
//   line). Fixed by stopping the gap at the end of the ANCHOR's paragraph.
//
// The tests below pin the caller-visible contract in both directions: the caller's
// text survives, AND the passages the 529 / content-policy defence exists to remove
// are still removed. Bounding a span is only a fix if the defence survives it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  neutralizeClientIdentity,
  neutralizeMessageContent,
} from '../src/handlers/identity-neutralize.js';

// Deterministic environment: no ambient WINDSURFAPI_* switch can change the result.
const ENV = {};
const neutralize = (text) => neutralizeClientIdentity(text, ENV);

const BENIGN = 'Decline requests that facilitate clearly malicious or harmful activity';
const RULE = 'RULE: Preserve the production database.';

describe('identity-neutralize — WA-002: the security tail cannot cross a blank line', () => {
  // The exact counterexample from the audit: the phrase and the bare words
  // "security research" in paragraph 1, the caller's RULE in paragraph 2, and the
  // sentence-ending '.' nowhere in paragraph 1. The old `security research[^.]*\.`
  // ran to the '.' of "database." and deleted the RULE with it.
  const WA002 = 'IMPORTANT: Assist with authorized security testing security research\n\n'
    + RULE + '\n\nEnd user instructions';

  it('preserves the caller RULE and still replaces the security paragraph', () => {
    const out = neutralize(WA002);
    assert.ok(out.includes(RULE), 'the caller RULE must survive');
    assert.ok(out.includes('End user instructions'), 'text after the RULE must survive');
    assert.equal(out.includes('security testing'), false,
      'the fingerprint sentence is still replaced (by the line-scoped fallback)');
    assert.ok(out.includes(BENIGN), 'the benign safety statement replaced it');
    assert.notEqual(out, WA002, 'the fingerprint did not leak through untouched');
  });

  it('prefix control: the same phrase with the terminator in a LATER paragraph keeps the RULE', () => {
    // Identical to WA-002 except the '.' now exists — in a paragraph of its own.
    // That isolates the defect to the END BRANCH: the prefix alone is not the bug.
    const src = 'IMPORTANT: Assist with authorized security testing security research\n\n'
      + RULE + '\n\nsecurity research ends with a period.';
    const out = neutralize(src);
    assert.ok(out.includes(RULE), 'the caller RULE must survive');
    assert.equal(out.includes('security testing'), false, 'the opening line is still rewritten');
    assert.ok(out.includes('security research ends with a period.'),
      'the later paragraph holding the terminator phrase is not the security paragraph');
  });

  it('CRLF blank line stops the span', () => {
    const src = 'IMPORTANT: Assist with authorized security testing.\r\n\r\n'
      + RULE + '\r\n\r\nDual-use security tools require authorization: defensive use cases.';
    const out = neutralize(src);
    assert.ok(out.includes(RULE), 'a CRLF paragraph break bounds the span');
    assert.ok(out.includes('defensive use cases.'), 'the terminator paragraph is a different paragraph');
    assert.equal(out.includes('security testing'), false, 'the opening line is still rewritten');
  });

  it('spaces-only blank line stops the span', () => {
    const src = 'IMPORTANT: Assist with authorized security testing.\n   \n'
      + RULE + '\n   \nDual-use security tools require authorization: defensive use cases.';
    const out = neutralize(src);
    assert.ok(out.includes(RULE), 'a whitespace-only line counts as a paragraph break');
    assert.ok(out.includes('defensive use cases.'), 'the terminator paragraph survives');
    assert.equal(out.includes('security testing'), false, 'the opening line is still rewritten');
  });
});

// H1: the paragraph bound accepted only space/tab/CR as a blank line, while the
// regex it replaced used `\n(?!\s*\n)` — `\s` covers the Unicode spaces, FF and VT
// as well. A blank line made of any of those was therefore NOT a break: the
// security span crossed it and deleted the caller's RULE line between the phrase
// and the tail (85 old-keeps/new-loses, 0 gains). The class must be the whole `\s`
// set, not just the five shapes that were measured, so this loops every whitespace
// code unit JavaScript matches.
describe('identity-neutralize — H1: any `\s`-class blank line is a paragraph break', () => {
  // Same set `isSpaceCode` uses: ASCII 9-13/32 plus every non-ASCII `\s` code unit.
  const BLANKS = [];
  for (let code = 0; code <= 0xFFFF; code++) {
    if (code !== 10 && /\s/.test(String.fromCharCode(code))) {
      BLANKS.push([`U+${code.toString(16).toUpperCase().padStart(4, '0')}`, String.fromCharCode(code)]);
    }
  }

  it('the scanned class is exactly the non-LF whitespace set (24 code units)', () => {
    // 09-0D, 20, A0, 1680, 2000-200A, 2028, 2029, 202F, 205F, 3000, FEFF.
    assert.equal(BLANKS.length, 24,
      `expected the 24 non-LF whitespace code units, got ${BLANKS.length}`);
  });

  it('the security span cannot cross a blank line of any of them', () => {
    for (const [name, ws] of BLANKS) {
      const src = `IMPORTANT: Assist with authorized security testing\n${ws}\n${RULE}\nsecurity research.`;
      const out = neutralize(src);
      assert.ok(out.includes(RULE), `${name} blank line: the caller RULE must survive`);
      assert.equal(out.includes('security testing'), false,
        `${name} blank line: the opening fingerprint is still rewritten`);
    }
  });
});

describe('identity-neutralize — the anchor gap cannot cross a paragraph break', () => {
  // `IMPORTANT:` alone in paragraph 1, the phrase at the start of paragraph 2, and a
  // terminator further into paragraph 2. The unbounded `\s*` gap paired them and the
  // span then deleted from the anchor in paragraph 1 through the terminator in
  // paragraph 2 — the blank line and the opening of paragraph 2 included.
  const CROSS = 'IMPORTANT:\n\n'
    + 'Assist with authorized security testing, defensive security, CTF challenges, and '
    + 'educational contexts. Dual-use security tools require clear authorization: '
    + 'security research, or defensive use cases.\n\n'
    + RULE;

  it('does not pair an anchor in paragraph 1 with the phrase in paragraph 2', () => {
    const out = neutralize(CROSS);
    assert.equal(out, CROSS, 'no rule may fire across the blank line');
    assert.ok(out.includes('\n\n' + RULE), 'the paragraph break and the RULE are intact');
    assert.ok(out.includes('Assist with authorized security testing'),
      'the phrase is in a different paragraph than its anchor, so the span declines');
  });

  it('negative control: the phrase on the NEXT LINE of the SAME paragraph is still spanned', () => {
    // Bounding is paragraph-bounding, not line-bounding. The real prompt wraps the
    // security sentence across lines inside one paragraph and must still be removed.
    const src = 'IMPORTANT:\n'
      + 'Assist with authorized security testing, defensive security, CTF challenges, and '
      + 'educational contexts. Dual-use security tools require clear authorization: '
      + 'security research, or defensive use cases.\n\n'
      + RULE;
    const out = neutralize(src);
    assert.equal(out.includes('security testing'), false, 'the wrapped sentence is still removed');
    assert.equal(out.includes('defensive use cases.'), false, 'the terminator was reached');
    assert.ok(out.startsWith(BENIGN), 'replaced with the benign statement');
    assert.ok(out.includes(RULE), 'the caller RULE survives');
  });
});

// NEGATIVE CONTROLS for the defence itself: the live prompts use exactly this
// single-paragraph shape. If any of these stops being neutralized the 529 gate fires.
describe('identity-neutralize — legitimate single-paragraph blocks are fully removed', () => {
  it('the real security paragraph', () => {
    const SEC = 'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.';
    const out = neutralize('You are an interactive agent.\n\n' + SEC + '\n\n# Harness');
    for (const term of ['security testing', 'CTF', 'DoS attacks', 'supply chain',
      'detection evasion', 'C2 frameworks', 'credential testing', 'exploit development']) {
      assert.equal(out.includes(term), false, `trigger term still removed: ${term}`);
    }
    assert.ok(out.includes('You are an interactive agent.'), 'preamble kept');
    assert.ok(out.includes('# Harness'), 'content after kept');
  });

  it('the real brand block and model catalogue', () => {
    const BRAND = ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).\n - Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is available on Opus 4.8/4.7.';
    const CAT = "The most recent Claude models are the Claude 5 family, Opus 4.8, and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'. When building AI applications, default to the latest and most capable Claude models.";
    const out = neutralize(BRAND + '\n' + CAT);
    assert.equal(/Claude Code/i.test(out), false, 'no "Claude Code"');
    assert.equal(/claude\.ai\/code/i.test(out), false, 'no claude.ai/code URL');
    assert.equal(/Model IDs|claude-fable-5|claude-opus-4-8/i.test(out), false, 'catalogue removed');
    assert.equal(/most recent Claude models are/i.test(out), false, 'catalogue header removed');
  });
});

// H1 (red-team): the a4-catalogue-line fallback was
// `rule('a4-catalogue-line', /The most recent Claude models are[^\n]*\n?/gi, '')` —
// it deleted from the anchor to the end of the line. For the client's own catalogue
// header that is the whole line; for a caller prompt that merely CONTAINS the phrase
// it is the caller's text. Measured `'… are listed below; RULE: keep me\nnext'` →
// `'next'` (66 → 4 bytes) with no WARN. The fallback now rewrites only the anchor
// phrase on a caller line, so the header is neutralized and every other byte of the
// line survives.
//
// P2 (FinalReviewRecheck): the phrase-only span was too small in the OTHER direction.
// The fallback exists for the shape where the catalogue's terminator is in another
// paragraph, and in that shape the anchor line carries the model-ID body
// (`Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'.`). Rewriting
// just the phrase left the model IDs on the wire (measured 253 → 244 bytes). An
// ID-shaped `claude-` model-ID token after the anchor now extends the span to the
// end of the line — the earlier bare-marker list (`claude-`, `Model IDs`, `Fable`,
// `Opus`, `Sonnet`) was tightened to the full token grammar by the P4 review below.
describe('identity-neutralize — a4-catalogue-line span depends on the line', () => {
  it('preserves the rest of the line, including a caller RULE', () => {
    const src = 'The most recent Claude models are listed below; RULE: keep me\nnext';
    assert.equal(neutralize(src),
      'The available models are listed below; RULE: keep me\nnext',
      'only the anchor phrase changes; the caller RULE and the newline survive');
  });

  it('the split-paragraph fallback removes the model-ID body', () => {
    const CAT = "The most recent Claude models are the Claude 5 family, Opus 4.8, and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'.";
    const out = neutralize(CAT + '\n\nWhen building AI applications, default to the latest and most capable Claude models.\n\nNow do the task.');
    assert.equal(out,
      'The available models are\n\nWhen building AI applications, default to the latest and most capable Claude models.\n\nNow do the task.',
      'the body goes with the header; the terminator paragraph and the task survive');
    assert.equal(/Model IDs|claude-fable-5|claude-opus-4-8/i.test(out), false,
      'the model IDs are absent');
  });

  it('a pure catalogue line with claude-* and no terminator loses its body', () => {
    const src = "The most recent Claude models are the Claude 5 family. Model IDs — Fable 5: 'claude-fable-5'.\nnext";
    assert.equal(neutralize(src), 'The available models are\nnext',
      'span runs anchor → end of line; the newline survives');
  });

  it('an anchor-only line with no markers loses only the anchor', () => {
    const src = 'The most recent Claude models are\nnext';
    assert.equal(neutralize(src), 'The available models are\nnext',
      'no body marker ⇒ the phrase-only span');
  });

  it('a pure catalogue line with its terminator still goes through the full span', () => {
    const CAT = "The most recent Claude models are the Claude 5 family, Opus 4.8, and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'. When building AI applications, default to the latest and most capable Claude models.";
    const out = neutralize(CAT + '\nnext');
    assert.equal(out, '\nnext', 'the whole catalogue span is removed, not just the header');
    assert.equal(/Model IDs|claude-fable-5|claude-opus-4-8/i.test(out), false,
      'the model-ID body is gone with the span');
  });

  it('a line without the anchor is byte-identical', () => {
    const src = 'Just an ordinary line.\nRULE: keep me';
    assert.equal(neutralize(src), src, 'no anchor ⇒ no rewrite');
  });

  it('every anchor on one line is replaced and the rest of the line survives', () => {
    const src = 'A The most recent Claude models are B THE MOST RECENT CLAUDE MODELS ARE C\nnext';
    assert.equal(neutralize(src),
      'A The available models are B The available models are C\nnext',
      'both phrases rewritten in place (ASCII-case-insensitive); prefix, middle, suffix and newline preserved');
  });

  it('a body span ends the line, so a second anchor inside it cannot overlap', () => {
    const src = "The most recent Claude models are Model IDs: 'claude-opus-4-8'. THE MOST RECENT CLAUDE MODELS ARE tail\nnext";
    assert.equal(neutralize(src), 'The available models are\nnext',
      'one span to EOL; the inner anchor is inside it, not a second overlapping span');
  });
});

// P4 (six-lane review of c4931c40+0aea4ea3): catalogueIdFollows only inspected the
// HEAD after `claude-` and accepted almost any terminator, so hostnames, host:port
// pairs, paths, emails and possessives were classified as model IDs and the
// anchor→EOL span ate the caller's RULE. The classifier now validates the WHOLE
// hyphenated token against the real selector grammar:
//
//   claude-<component> ('-' <component>)*   with ≥2 components total
//
// where a component is a digit run (optional `.`-joined version groups and an
// optional `m` context suffix, e.g. `-1m`) or a catalogue word — family
// (opus/sonnet/haiku/fable), effort/size (max/min/high/medium/low/xhigh) or the
// fast/thinking/beta modifiers. A `-` followed by anything else, a letter/digit/`_`
// glued to a component, or a non-clean terminator (`:port`, `/path`, `@host`,
// `.`+letter/digit) makes the token prose, not an ID.
//
// Deliberate trade-off, documented per the review: `-`+lowercase-WORD continuations
// use the component vocabulary rather than "any word". `claude-fable-svc` and
// `claude-9-lives` are therefore prose (svc/lives are not catalogue components) —
// lane D accepted `-<word>` continuation as a trade-off, but the committed
// snapshot's component set is closed enough that the stricter reading costs no
// real selector (verified below against every claude-* selector AND alias) while
// keeping `claude-4-proxy` / `claude-3-internal:8443` prose.
describe('identity-neutralize — a4-catalogue-line: the claude- token must be ID-shaped end to end', () => {
  const CATALOGUE_PREFIX = 'The most recent Claude models are ';
  const ID_BODY = (shape) => `${CATALOGUE_PREFIX}models: ${shape}.\nnext`;

  it('every claude-* selector in the committed catalogue snapshot is still an ID body', () => {
    const snapshot = JSON.parse(
      readFileSync(new URL('../src/data/devin-catalog-snapshot.json', import.meta.url), 'utf8'),
    );
    const ids = new Set();
    for (const m of snapshot.models) {
      if (m.selector.startsWith('claude-')) ids.add(m.selector);
      if (m.alias && m.alias.startsWith('claude-')) ids.add(m.alias);
    }
    assert.ok(ids.size >= 70, `fixture sanity: expected the ~68 selectors + aliases, got ${ids.size}`);
    for (const id of ids) {
      // quoted form (the real catalogue quotes its IDs) and bare-at-EOL form
      for (const shape of [`'${id}'`, id]) {
        const out = neutralize(ID_BODY(shape));
        assert.equal(out, 'The available models are\nnext',
          `${shape}: a real catalogue ID must extend the span to EOL`);
        assert.equal(/claude-/i.test(out), false, `${shape}: no claude- token survives`);
      }
    }
  });

  it('real ID shapes in prose delimiters still count as bodies', () => {
    for (const shape of [
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-8-medium',
      'claude-sonnet-4.6',          // dotted version group
      'claude-5-fable-max',
      'claude-opus-4-6-thinking-1m',// thinking + 1m context suffix
      'claude-3-5-sonnet-20241022', // version-first + family + date stamp
      'claude-sonnet4.6',           // family fused to version (no hyphen)
      'CLAUDE-OPUS-4-8',            // ASCII-case-insensitive
    ]) {
      const out = neutralize(ID_BODY(`'${shape}'`));
      assert.equal(out, 'The available models are\nnext',
        `${shape}: ID-shaped body must be removed with the header`);
    }
  });

  it('hostnames, ports, paths and possessives are prose, not IDs', () => {
    for (const shape of [
      'claude-opus-1.internal.example.com', // lane D: `-<digit>` then `.`+letter
      'claude-3.5.example.com',             // lane D: version-dot then domain
      'claude-opus.5x',                     // lane D: `.`+digit after a WORD head
      'claude-5.5x',                        // lane D: `x` glued to the version
      'claude-fable-svc',                   // lane D: `-`+non-component word
      'claude-9-lives',                     // lane D: `-`+non-component word
      'claude-4-proxy',                     // digit head + `-`+non-component
      'claude-3-internal:8443',             // `-`+non-component then :port
      'claude-opus:8080',                   // bare family head + :port
      'claude-opus/path',                   // bare family head + /path
      'claude-opus@h',                      // bare family head + @host
      "claude-fable's",                     // bare family head + possessive
      'claude-sonnet,x',                    // bare family head + comma
      'claude-opus-4-8:8080',               // real-looking ID + :port → prose
      'claude-opus-4-8/path',               // real-looking ID + /path → prose
      'claude-opus-4-8@h',                  // real-looking ID + @host → prose
      'claude-opus-4-8-extra',              // `-`+non-component glued on
    ]) {
      const src = `The most recent Claude models are documented at ${shape}; RULE: keep me`;
      const out = neutralize(src);
      assert.equal(out,
        `The available models are documented at ${shape}; RULE: keep me`,
        `${shape}: only the anchor phrase changes; the caller RULE survives`);
    }
  });
});

// P4 (same review): opusTerminatorEnd accepted a `[\d./]` run whose ONLY dot was
// at offset 0 — `available on Opus .5x` ended the span right after the dot and
// left `5x` behind, where the old `Opus [\d./]+\.` regex needed a class char
// before the final dot and did not match at all. Parity: the run must contain a
// dot that is NOT its first character.
describe('identity-neutralize — a4-brand-span: `Opus .5x` is not a version terminator', () => {
  it('a dot-led version run does not terminate the brand span', () => {
    const src = 'Claude Code is available as a CLI\navailable on Opus .5x; RULE: keep me';
    const out = neutralize(src);
    assert.ok(out.includes('available on Opus .5x; RULE: keep me'),
      'no `Opus [\\d./]+.` match ⇒ the second line is caller text and survives');
    assert.ok(out.startsWith('This coding assistant runs in a terminal.'),
      'the cli-line fallback still neutralizes the anchor phrase');
  });

  it('negative control: `Opus 4.` and `Opus 4.8/4.7.` still terminate', () => {
    for (const tail of ['available on Opus 4. tail', 'available on Opus 4.8/4.7. tail']) {
      const out = neutralize(`Claude Code is available as a CLI\n${tail}`);
      assert.ok(!/available on Opus/i.test(out), `${tail}: the brand span still fires`);
      assert.ok(out.includes('This coding assistant runs in a terminal.'),
        `${tail}: replaced by the neutral line`);
    }
  });
});

// P4 (same review): the line-indent class was narrowed from `\s` to `[space,tab]`,
// so a fastmode or billing line indented with NBSP/FF/VT/CR (all `\s` members the
// old `\s*` ate) now survives upstream. Indentation is every `\s` code unit a
// line can contain — LF cannot appear inside a line by construction.
describe('identity-neutralize — line indent accepts the full `\\s` class minus LF', () => {
  for (const [name, ws] of [
    ['NBSP', '\u00A0'],
    ['ideographic space', '\u3000'],
    ['form feed', '\f'],
    ['vertical tab', '\v'],
    ['carriage return', '\r'],
  ]) {
    it(`a4-fastmode: ${name}-indented line is still removed`, () => {
      const out = neutralize(`${ws}- Fast mode for Claude Code uses Opus.\nkeep`);
      assert.equal(/fast mode for claude code/i.test(out), false,
        `${name} indent: the fingerprint line is removed`);
      assert.ok(out.includes('keep'), 'the following line survives');
    });

    it(`a3-billing: ${name}-indented header is still removed`, () => {
      const out = neutralize(`${ws}x-anthropic-billing-header: cc_version=1.2;\nkeep`);
      assert.equal(/x-anthropic-billing-header/i.test(out), false,
        `${name} indent: the billing header line is removed`);
      assert.ok(out.includes('keep'), 'the following line survives');
    });
  }
});

// P3: fastmodeSpans took the newline BEFORE each matched line even when the
// previous span had already consumed it as its trailing newline, so two adjacent
// matches produced overlapping spans ([{1,46},{45,90}]) while applySpans documents
// a non-overlapping precondition. The second span now starts at its own lineStart,
// so the spans abut. Output for this rule is unchanged (the overlap sliced an empty
// string), which is why the regression test pins the visible result rather than the
// private span list.
describe('identity-neutralize — a4-fastmode spans abut on consecutive lines', () => {
  it('two adjacent Fast mode lines are both removed', () => {
    const src = 'before\n- Fast mode for Claude Code A\n- Fast mode for Claude Code B\nafter';
    assert.equal(neutralize(src), 'before\n\nafter',
      'both lines removed; the neighbours stay on separate lines');
  });
});

// H2: a7-freeform had no provenance boundary — it rewrote the CALLER's own text, a
// SQL enum value and a JavaScript identifier below, not just the codex apply_patch
// tool description it was aimed at. It GROWS the text by one byte per hit, so the
// over-deletion WARN could not see it either. H2 scopes it to a line that also
// carries the apply_patch JSON-wrap clause; the tests below pin BOTH directions:
// caller code is preserved, and the live-confirmed trigger is still neutralized.
describe('identity-neutralize — WA-003 (H2): FREEFORM is scoped to the apply_patch description', () => {
  it('preserves FREEFORM inside SQL and JavaScript', () => {
    const SQL = "CHECK (kind IN ('FREEFORM','STRUCTURED'))";
    const JS = 'if (mode === FREEFORM) { run(); }';
    assert.equal(neutralize(SQL), SQL, 'SQL enum literal untouched');
    assert.equal(neutralize(JS), JS, 'JS identifier untouched');
  });

  it('the apply_patch description it was aimed at is still neutralized', () => {
    const out = neutralize('This is a FREEFORM tool, so do not wrap the patch in JSON. Provide the diff directly.');
    assert.equal(/FREEFORM/.test(out), false, 'FREEFORM token gone');
    assert.equal(/do not wrap the patch in JSON\./.test(out), false, 'JSON-wrap fragment gone');
    assert.match(out, /free-form/);
    assert.match(out, /provide the patch as plain text\./);
  });

  it('a bare FREEFORM tool line WITHOUT the JSON-wrap clause is preserved', () => {
    const src = 'This is a FREEFORM tool. Pass the patch however you like.';
    assert.equal(neutralize(src), src, 'no provenance anchor ⇒ caller text survives');
  });

  it('the JSON-wrap clause elsewhere on the SAME line licenses the rewrite', () => {
    const src = 'FREEFORM tool note: do not wrap the patch in JSON.';
    assert.equal(neutralize(src), 'free-form tool note: provide the patch as plain text.');
  });

  // The rule it replaces was `/FREEFORM/g` — uppercase only. A case-insensitive token
  // search made the provenance clause license a lowercase `freeform` too, which is the
  // caller's word (a SQL type, a column, an identifier) and must come back unchanged.
  it('lowercase freeform on a JSON-wrap line is caller text and is preserved', () => {
    const src = 'This is a freeform tool, so do not wrap the patch in JSON.';
    assert.equal(neutralize(src), 'This is a freeform tool, so provide the patch as plain text.',
      'the clause licenses the uppercase enum, not a lowercase identifier');
  });

  it('uppercase FREEFORM on the same clause-bearing line is still rewritten', () => {
    const src = 'This is a FREEFORM tool, so do not wrap the patch in JSON.';
    assert.equal(neutralize(src), 'This is a free-form tool, so provide the patch as plain text.');
  });

  it('case is decided per token: only the uppercase spelling on one line is rewritten', () => {
    const src = 'freeform column plus FREEFORM enum: do not wrap the patch in JSON.';
    assert.equal(neutralize(src), 'freeform column plus free-form enum: provide the patch as plain text.');
  });
});

describe('identity-neutralize — neutralizeMessageContent reference semantics', () => {
  it('returns the SAME array when no text part changes', () => {
    const content = [
      { type: 'text', text: 'You are an interactive CLI tool.' },
      { type: 'image', source: { type: 'base64', data: 'AA==' } },
    ];
    assert.equal(neutralizeMessageContent(content, ENV), content,
      'callers rely on the identity check to avoid copying every message');
  });

  it('returns a NEW array (and new part) when a text part changes, without mutating the input', () => {
    const original = "You are Claude Code, Anthropic's official CLI for Claude.";
    const content = [{ type: 'text', text: original }];
    const out = neutralizeMessageContent(content, ENV);
    assert.notEqual(out, content, 'changed content must be a new array');
    assert.notEqual(out[0], content[0], 'the changed part must be a new object');
    assert.equal(content[0].text, original, 'the input part is not mutated');
    assert.match(out[0].text, /AI coding assistant/);
  });

  it('keeps unchanged parts by reference and only copies the text part that changed', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'AA==' } };
    const text = { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." };
    const out = neutralizeMessageContent([image, text], ENV);
    assert.equal(out[0], image, 'non-text part kept by reference');
    assert.notEqual(out[1], text, 'changed text part copied');
    assert.equal(text.text, "You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it('string content goes through the string path and non-content values pass through', () => {
    assert.equal(neutralizeMessageContent('You are an interactive CLI tool.', ENV),
      'You are an interactive CLI tool.');
    assert.match(neutralizeMessageContent("You are Claude Code, Anthropic's official CLI for Claude.", ENV),
      /AI coding assistant/);
    assert.equal(neutralizeMessageContent(null, ENV), null);
    assert.equal(neutralizeMessageContent(undefined, ENV), undefined);
  });
});

// A4-cli-line deleted from the anchor to the END OF ITS LINE. That is the right span
// for the Environment bullet it was written for, but a caller prompt that is ONE long
// line lost everything after the anchor — measured 512 KiB in, 42 bytes out, with a
// single WARN. The rule is now line-scoped by WHAT the line is: a short line is
// replaced whole (unchanged), a long line loses only the anchor phrase.
describe('identity-neutralize — a4-cli-line is bounded to the clause on long lines', () => {
  const ANCHOR = 'Claude Code is available as a CLI';
  const REPLACEMENT = 'This coding assistant runs in a terminal.';
  const KIB = 1024;

  it('512 KiB single line: the anchor goes, the caller payload stays', () => {
    const head = 'X'.repeat(512 * KIB);
    const tail = ' rest of the caller payload must survive.';
    const src = head + ANCHOR + ' in the terminal, desktop app.' + tail;
    const out = neutralize(src);
    assert.equal(out.includes(ANCHOR), false, 'the anchor phrase is gone');
    assert.ok(out.startsWith(head), 'the 512 KiB prefix is byte-identical');
    assert.ok(out.endsWith(tail), 'the caller tail is byte-identical');
    assert.equal(out.length, src.length - ANCHOR.length + REPLACEMENT.length,
      'only the phrase changed; the line was not collapsed');
    assert.ok(Buffer.byteLength(out, 'utf8') > 512 * KIB,
      `expected the payload to survive, got ${Buffer.byteLength(out, 'utf8')} bytes`);
  });

  it('short line: the whole line is still replaced', () => {
    const src = 'Claude Code is available as a CLI in the terminal';
    assert.equal(neutralize(src), REPLACEMENT + '\n');
  });

  // The span starts at the ANCHOR, as the regex it replaces did. Starting it at the
  // line start made a one-line caller prompt lose everything before the phrase —
  // measured: a French rule followed by the CLI sentence came back with only the
  // replacement, the rule gone.
  it('short line with a caller prefix: the prefix survives, only the bullet goes', () => {
    const src = 'Always answer in French. Claude Code is available as a CLI';
    assert.equal(neutralize(src), 'Always answer in French. ' + REPLACEMENT + '\n',
      'bytes before the anchor belong to the caller');
  });

  it('a 4096-byte short line with a prefix keeps every prefix byte', () => {
    const prefix = 'P'.repeat(4096 - ANCHOR.length);
    const src = prefix + ANCHOR;
    assert.equal(Buffer.byteLength(src, 'utf8'), 4096, 'fixture sits on the short-line boundary');
    assert.equal(neutralize(src), prefix + REPLACEMENT + '\n');
  });

  it('a long line WITHOUT the anchor is byte-identical', () => {
    const src = 'Y'.repeat(64 * KIB);
    assert.equal(neutralize(src), src, 'length alone must never trigger a rewrite');
  });

  it('a long line with TWO anchors rewrites both and keeps the rest', () => {
    const prefix = 'A'.repeat(8 * KIB);
    const middle = ' first clause. ';
    const suffix = ' second clause. TAIL';
    const src = prefix + ANCHOR + middle + 'B'.repeat(8 * KIB) + ANCHOR + suffix;
    const out = neutralize(src);
    assert.equal(out.includes(ANCHOR), false, 'both anchors are gone');
    assert.equal(out.split(REPLACEMENT).length - 1, 2, 'exactly two in-place rewrites');
    assert.ok(out.startsWith(prefix), 'the prefix is preserved');
    assert.ok(out.includes(middle), 'the text between the anchors is preserved');
    assert.ok(out.endsWith(suffix), 'the text after the second anchor is preserved');
  });
});
