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

describe('identity-neutralize — WA-003 pin: FREEFORM is still rewritten in caller code', () => {
  // WA-003 (H2, OPEN) is a DIFFERENT defect from WA-001/WA-002: `a7-freeform` is a
  // bare-token rule with no provenance boundary, so it rewrites the CALLER's own text
  // — a SQL enum value and a JavaScript identifier below — not just the codex
  // apply_patch tool description it was aimed at. It GROWS the text by one byte per
  // hit, so the over-deletion WARN cannot see it either.
  //
  // This test PINS the current behaviour so the damage is visible and deliberate. An
  // H2 fix that adds a provenance boundary MUST update this test; it must not be
  // deleted to make a change look green.
  it('rewrites FREEFORM inside SQL and JavaScript (current behaviour, H2 open)', () => {
    const SQL = "CHECK (kind IN ('FREEFORM','STRUCTURED'))";
    const JS = 'if (mode === FREEFORM) { run(); }';
    assert.equal(neutralize(SQL), "CHECK (kind IN ('free-form','STRUCTURED'))",
      'SQL enum literal rewritten: WA-003 damage, pinned');
    assert.equal(neutralize(JS), 'if (mode === free-form) { run(); }',
      'JS identifier rewritten: WA-003 damage, pinned');
  });

  it('the apply_patch description it was aimed at is still neutralized', () => {
    const out = neutralize('This is a FREEFORM tool, so do not wrap the patch in JSON. Provide the diff directly.');
    assert.equal(/FREEFORM/.test(out), false, 'FREEFORM token gone');
    assert.equal(/do not wrap the patch in JSON\./.test(out), false, 'JSON-wrap fragment gone');
    assert.match(out, /free-form/);
    assert.match(out, /provide the patch as plain text\./);
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
