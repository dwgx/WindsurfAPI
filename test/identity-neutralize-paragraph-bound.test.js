// identity-neutralize: the multi-line rules deleted the CALLER's text.
//
// b-security, a4-brand-span and a4-catalogue matched `<anchor>[\s\S]*?<terminator>`.
// `[\s\S]` crosses blank lines, so the span did not stop at the end of the offending
// paragraph — it ran to wherever the terminator phrase next appeared, and every byte
// in between was replaced. Anything the client had written there went with it.
//
// Measured on master c3ac2b2, brand-block anchors two paragraphs apart:
//
//   in  213 bytes: "Claude Code is available as a CLI tool and can be used
//                   interactively.\n\nRULE 7: the API key must never be logged.\n
//                   Never delete the production database.\n\nThese models are
//                   available on Opus 4.8/4.6.\n\nNow do the task."
//   out  59 bytes: "This coding assistant runs in a terminal.\n\nNow do the task."
//
// Both of the user's own security rules, silently gone. The catalogue anchors were
// worse — 208 bytes in, 18 out. Neutralization is ON by default
// (WINDSURFAPI_NEUTRALIZE_CLIENT_ID defaults to '1') and the module logged nothing at
// all, so no operator could see it happen.
//
// Two things are asserted here, and the second matters as much as the first:
//
//   1. a span cannot cross a blank line (this file's namesake), AND the passages the
//      529 / content-policy defence exists to remove are STILL removed — bounding a
//      span is only a fix if the defence survives it. Those negative controls are the
//      reason the 53 tests in client-identity-neutralize.test.js and
//      identity-neutralize-shapes.test.js are the specification, not this file.
//   2. an over-large single substitution reaches the operator as a WARN carrying the
//      real byte delta, and an ordinary prompt logs NOTHING (a line per request is
//      noise, and noise gets filtered, which is the same as not logging).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeClientIdentity } from '../src/handlers/identity-neutralize.js';
import { log } from '../src/config.js';

const bytes = (s) => Buffer.byteLength(String(s), 'utf8');

/** Neutralize while capturing whatever the module logged at WARN. */
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
  return { out, warns };
}

// The caller's own instructions, sitting in a paragraph of their own between two
// anchor phrases. Nothing here is a competitor fingerprint; all of it must survive.
const USER_RULES = 'RULE 7: the API key must never be logged.\nNever delete the production database.';

afterEach(() => {
  delete process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID;
});

describe('identity-neutralize — spans stop at a paragraph break', () => {
  it('brand block: user instructions between the anchors survive (was 213 → 59 bytes)', () => {
    const src = 'Claude Code is available as a CLI tool and can be used interactively.\n\n'
      + USER_RULES + '\n\nThese models are available on Opus 4.8/4.6.\n\nNow do the task.';
    assert.equal(bytes(src), 213, 'fixture is the measured 213-byte input');
    const { out } = neutralize(src);
    assert.ok(out.includes('RULE 7: the API key must never be logged.'), 'user API-key rule kept');
    assert.ok(out.includes('Never delete the production database.'), 'user DB rule kept');
    assert.ok(out.includes('Now do the task.'), 'the actual task kept');
    // The fingerprint is still neutralized — by the line-scoped a4-cli-line fallback.
    assert.equal(/Claude Code/i.test(out), false, 'fingerprint still removed');
    assert.ok(bytes(out) >= 180,
      `only the anchor line may go: expected ~185 bytes, got ${bytes(out)}. `
      + 'The unbounded span produced 59.');
  });

  it('model catalogue: user instructions between the anchors survive (was 208 → 18 bytes)', () => {
    const src = 'The most recent Claude models are the Claude 5 family.\n\n'
      + USER_RULES + '\n\ndefault to the latest and most capable Claude models.\n\nNow do the task.';
    assert.equal(bytes(src), 208, 'fixture is the measured 208-byte input');
    const { out } = neutralize(src);
    assert.ok(out.includes('RULE 7: the API key must never be logged.'), 'user API-key rule kept');
    assert.ok(out.includes('Never delete the production database.'), 'user DB rule kept');
    assert.ok(out.includes('Now do the task.'), 'the actual task kept');
    assert.equal(/most recent Claude models are/i.test(out), false, 'catalogue header still removed');
    assert.ok(bytes(out) >= 145,
      `expected ~153 bytes, got ${bytes(out)}. The unbounded span produced 18.`);
  });

  it('security paragraph: user instructions between the anchors survive', () => {
    const src = 'IMPORTANT: Assist with authorized security testing and defensive security.\n\n'
      + USER_RULES + '\n\nSee also our security research team.\n\nNow do the task.';
    const { out } = neutralize(src);
    assert.ok(out.includes('RULE 7: the API key must never be logged.'), 'user API-key rule kept');
    assert.ok(out.includes('Never delete the production database.'), 'user DB rule kept');
    assert.ok(out.includes('See also our security research team.'),
      'the paragraph holding the terminator phrase is not the security paragraph and must stay');
    assert.equal(/Assist with authorized security testing/i.test(out), false,
      'the fingerprint sentence is still neutralized, by the line-scoped fallback');
  });

  it('a blank line made only of spaces also stops the span', () => {
    // The lookahead is `\n(?!\s*\n)`: the `\s*` is what covers a "blank" line that
    // carries trailing whitespace, which real editors and prompt builders emit.
    const src = 'Claude Code is available as a CLI tool.\n   \nMY RULE.\n   \navailable on Opus 4.8.';
    const { out } = neutralize(src);
    assert.ok(out.includes('MY RULE.'), 'whitespace-only line counts as a paragraph break');
  });

  it('a CRLF blank line also stops the span', () => {
    const src = 'Claude Code is available as a CLI tool.\r\n\r\nMY RULE.\r\n\r\navailable on Opus 4.8.';
    const { out } = neutralize(src);
    assert.ok(out.includes('MY RULE.'), 'CRLF paragraph break stops the span');
  });

  // NEGATIVE CONTROL for the whole bound: it must not have become line-bounding.
  // The real Environment block wraps across single newlines, so a span that stopped
  // at every \n would leave most of the brand block upstream — a silent regression of
  // the 529 / content-policy defence, which is worse than the over-deletion bug.
  it('still spans SINGLE newlines inside one paragraph (bounding is not line-bounding)', () => {
    const src = 'Claude Code is available as a CLI in the terminal,\ndesktop app, and IDE extensions.\n'
      + 'Fast mode is available on Opus 4.8/4.7.\nKeep this.';
    const { out } = neutralize(src);
    assert.equal(/Claude Code/i.test(out), false, 'fingerprint removed');
    assert.equal(out.includes('desktop app'), false,
      'the wrapped middle of the paragraph is still swallowed by the span');
    assert.ok(out.includes('Keep this.'), 'text after the paragraph kept');
  });

  // NEGATIVE CONTROLS for the defence itself, in the single-paragraph shape the live
  // prompts actually use. If any of these stops being neutralized the 529 gate fires.
  it('the real single-paragraph security block is still fully neutralized', () => {
    const SEC = 'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.';
    const { out } = neutralize('You are an interactive agent.\n\n' + SEC + '\n\n# Harness');
    for (const term of ['security testing', 'CTF', 'DoS attacks', 'supply chain',
      'detection evasion', 'C2 frameworks', 'credential testing', 'exploit development']) {
      assert.equal(out.includes(term), false, `trigger term still removed: ${term}`);
    }
    assert.ok(out.includes('You are an interactive agent.'), 'preamble kept');
    assert.ok(out.includes('# Harness'), 'content after kept');
  });

  it('the real single-paragraph brand block and catalogue are still fully neutralized', () => {
    const BRAND = ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).\n - Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is available on Opus 4.8/4.7.';
    const CAT = "The most recent Claude models are the Claude 5 family, Opus 4.8, and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'. When building AI applications, default to the latest and most capable Claude models.";
    const { out } = neutralize(BRAND + '\n' + CAT);
    assert.equal(/Claude Code/i.test(out), false, 'no "Claude Code"');
    assert.equal(/claude\.ai\/code/i.test(out), false, 'no claude.ai/code URL');
    assert.equal(/Model IDs|claude-fable-5|claude-opus-4-8/i.test(out), false, 'catalogue removed');
  });

  it('the paragraph bound does not reopen the off-switch', () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    const src = 'Claude Code is available as a CLI tool.\n\n' + USER_RULES + '\n\navailable on Opus 4.8.';
    const { out, warns } = neutralize(src, process.env);
    assert.equal(out, src, 'opt-out leaves the body verbatim');
    assert.deepEqual(warns, [], 'and logs nothing, since nothing was rewritten');
  });
});

// H1: the paragraph bound was hand-written to accept only space/tab/CR as a blank
// line, while the regex it replaced used `\n(?!\s*\n)` — `\s` covers the Unicode
// spaces, FF and VT as well. A prompt whose paragraph separator was one of those
// therefore had NO break, so the security/brand/catalogue span crossed it and
// deleted the caller's RULE line sitting between the anchor and the terminator
// (measured differential: 85 old-keeps/new-loses, 0 gains). The security half of
// the class is pinned in identity-neutralize-integrity.test.js; this block pins
// brand + catalogue plus the exact measured shapes.
const UNICODE_BLANKS = [
  ['NBSP (U+00A0)', '\u00A0'],
  ['ideographic space (U+3000)', '\u3000'],
  ['em space (U+2003)', '\u2003'],
  ['form feed (U+000C)', '\u000C'],
  ['vertical tab (U+000B)', '\u000B'],
];

describe('identity-neutralize — a Unicode-whitespace blank line is a paragraph break', () => {
  it('security: the measured NBSP shape keeps the caller RULE', () => {
    const src = 'IMPORTANT: Assist with authorized security testing\n\u00A0\nsecurity research.\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
    assert.equal(/Assist with authorized security testing/i.test(out), false,
      'the opening fingerprint is still removed');
  });

  it('brand: the measured NBSP shape keeps the caller RULE', () => {
    const src = 'Claude Code is available as a CLI\n\u00A0\navailable on Opus 4.8.\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
    assert.equal(/Claude Code/i.test(out), false, 'the opening fingerprint is still removed');
  });

  it('catalogue: the measured U+3000 shape keeps the caller RULE', () => {
    const src = 'The most recent Claude models are\n\u3000\nmost capable Claude models.\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
    assert.equal(/most recent Claude models are/i.test(out), false,
      'the opening fingerprint is still removed');
  });

  // The deletion shape: the terminator sits after the caller's rules, so before the
  // fix the unbroken "paragraph" reached it and took the rules with it.
  for (const [name, ws] of UNICODE_BLANKS) {
    it(`brand: ${name} blank line does not carry the span across the caller RULE`, () => {
      const src = `Claude Code is available as a CLI\n${ws}\n${USER_RULES}\navailable on Opus 4.8.`;
      const { out } = neutralize(src);
      assert.ok(out.includes('RULE 7: the API key must never be logged.'), 'user API-key rule kept');
      assert.ok(out.includes('Never delete the production database.'), 'user DB rule kept');
      assert.ok(out.includes('available on Opus 4.8.'),
        'the paragraph after the blank line is outside the span');
      assert.equal(/Claude Code/i.test(out), false, 'the opening fingerprint is still removed');
    });

    it(`catalogue: ${name} blank line does not carry the span across the caller RULE`, () => {
      const src = `The most recent Claude models are\n${ws}\n${USER_RULES}\nmost capable Claude models.`;
      const { out } = neutralize(src);
      assert.ok(out.includes('RULE 7: the API key must never be logged.'), 'user API-key rule kept');
      assert.ok(out.includes('Never delete the production database.'), 'user DB rule kept');
      assert.ok(out.includes('most capable Claude models.'),
        'the paragraph after the blank line is outside the span');
      assert.equal(/most recent Claude models are/i.test(out), false,
        'the opening fingerprint is still removed');
    });
  }
});

// P2 (FinalReviewRecheck): with the anchor and the terminator in DIFFERENT
// paragraphs, a4-catalogue correctly declines to cross the break and
// a4-catalogue-line is the only rule left. While that fallback rewrote just the
// anchor phrase, the model-ID body sitting on the anchor line stayed on the wire —
// the very fingerprint the paragraph bound must not cost us. The span now runs to
// the end of the anchor's line when a catalogue body marker follows it, and stays
// phrase-only on a caller line that has none.
const SPLIT_CAT = "The most recent Claude models are the Claude 5 family, Opus 4.8, and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'.\n\nWhen building AI applications, default to the latest and most capable Claude models.\n\nNow do the task.";

describe('identity-neutralize — the split-paragraph catalogue fallback removes the model-ID body', () => {
  it('the measured shape: model IDs gone, terminator paragraph and task kept', () => {
    assert.equal(bytes(SPLIT_CAT), 253, 'fixture is the measured 253-byte input');
    const { out } = neutralize(SPLIT_CAT);
    assert.equal(bytes(out), 128,
      `expected 128 bytes, got ${bytes(out)}. The anchor-only fallback produced 244.`);
    assert.equal(/Model IDs|claude-fable-5|claude-opus-4-8/i.test(out), false,
      'the model-ID body is removed with the header');
    assert.ok(out.startsWith('The available models are\n\n'),
      'header rewritten in place; the line break is preserved');
    assert.ok(out.includes('When building AI applications, default to the latest and most capable Claude models.'),
      'the terminator paragraph is outside the span');
    assert.ok(out.includes('Now do the task.'), 'the task is kept');
  });

  it('the caller prefix before the anchor and a RULE after the break survive', () => {
    const src = "Always answer in French. The most recent Claude models are the Claude 5 family. Model IDs — Fable 5: 'claude-fable-5'.\n\nRULE: keep me\n\nmost capable Claude models.\n\nNow do the task.";
    const { out } = neutralize(src);
    assert.ok(out.startsWith('Always answer in French. The available models are\n\n'),
      'the prefix before the anchor is the caller\'s and survives');
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
    assert.equal(/claude-fable-5|Model IDs/i.test(out), false, 'model IDs removed');
    assert.ok(out.includes('most capable Claude models.'), 'the other paragraph untouched');
  });

  it('a caller line with NO catalogue marker keeps its RULE', () => {
    const src = 'The most recent Claude models are listed below; RULE: keep me\nnext';
    const { out } = neutralize(src);
    assert.equal(out, 'The available models are listed below; RULE: keep me\nnext',
      'no body marker ⇒ phrase-only span; every other byte of the line survives');
  });

  // G-06: the body test accepted bare English (`claude-`, `fable`, `opus`,
  // `sonnet`) and the phrase `Model IDs` anywhere after the anchor, so a caller
  // sentence that merely mentions one of them was taken for the client's catalogue
  // and lost everything to the end of its line. The body must be ID-SHAPED:
  // `claude-<family|version>` (`claude-fable-5`, `claude-opus-4-8`,
  // `claude-3-5-sonnet`). `Model IDs` alone is a phrase, and `claude-` alone is a
  // prefix that also starts domains (`claude-docs.example.com`).
  it('a caller line mentioning Sonnet keeps its RULE (a bare model name is not a body)', () => {
    const src = 'The most recent Claude models are documented at /docs; Sonnet is our default. RULE: keep me';
    const { out } = neutralize(src);
    assert.equal(out,
      'The available models are documented at /docs; Sonnet is our default. RULE: keep me',
      'only the anchor phrase changes; a bare model NAME must not extend the span');
  });

  it('a caller line mentioning "Model IDs" keeps its RULE (a phrase is not a body)', () => {
    const src = 'The most recent Claude models are documented under Model IDs in the docs. RULE: keep me';
    const { out } = neutralize(src);
    assert.equal(out,
      'The available models are documented under Model IDs in the docs. RULE: keep me',
      'only the anchor phrase changes; the phrase "Model IDs" must not extend the span');
  });

  it('a caller line mentioning claude-docs.example.com keeps its RULE (a domain is not a model ID)', () => {
    const src = 'The most recent Claude models are documented at claude-docs.example.com; RULE: keep me';
    const { out } = neutralize(src);
    assert.equal(out,
      'The available models are documented at claude-docs.example.com; RULE: keep me',
      'only the anchor phrase changes; the `claude-` prefix alone must not extend the span');
  });

  // P3 (external audit): the head alone was not enough. A digit head accepted ANY
  // following character, so hostnames whose first label starts with a digit were
  // classified as model IDs and the span ate the caller's RULE.
  it('a caller line mentioning claude-3d.example.com keeps its RULE (digit+letter is a hostname)', () => {
    const src = 'The most recent Claude models are documented at claude-3d.example.com; RULE: keep me';
    const { out } = neutralize(src);
    assert.equal(out,
      'The available models are documented at claude-3d.example.com; RULE: keep me',
      'only the anchor phrase changes; a digit followed by an identifier letter is a hostname');
  });

  it('a caller line mentioning claude-1password.example.com keeps its RULE (digit run + letter is a hostname)', () => {
    const src = 'The most recent Claude models are documented at claude-1password.example.com; RULE: keep me';
    const { out } = neutralize(src);
    assert.equal(out,
      'The available models are documented at claude-1password.example.com; RULE: keep me',
      'only the anchor phrase changes; a digit run followed by a letter is a hostname');
  });

  it('a caller line mentioning claude-opus.example.com keeps its RULE (family + domain dot is a hostname)', () => {
    const src = 'The most recent Claude models are documented at claude-opus.example.com; RULE: keep me';
    const { out } = neutralize(src);
    assert.equal(out,
      'The available models are documented at claude-opus.example.com; RULE: keep me',
      'only the anchor phrase changes; a family name followed by a domain dot is not an ID token');
  });
});

describe('identity-neutralize — an over-large deletion is observable', () => {
  // Threshold is 512 bytes per substitution, calibrated on the fixtures the 49
  // pinning tests use (largest legitimate removal: the security paragraph at 322,
  // then the brand block at 275). A <executing_actions_with_care> block keeps an
  // unbounded span on purpose — both ends are delimiters the client wrote — so it is
  // the rule where a runaway removal is actually reachable, and therefore the one
  // worth proving is visible.
  const bigCareBlock = () => 'Before.\n<executing_actions_with_care>\n'
    + 'Double-check destructive commands before running them. '.repeat(12)
    + '\n</executing_actions_with_care>\nAfter.';

  it('logs one WARN naming the rule and the REAL byte delta', () => {
    const src = bigCareBlock();
    const { out, warns } = neutralize(src);
    const removed = bytes(src) - bytes(out);
    assert.ok(removed > 512, `fixture must exceed the threshold, removed ${removed}`);
    assert.equal(warns.length, 1, `expected exactly one WARN, got:\n${warns.join('\n')}`);
    assert.match(warns[0], /a6-grok2-care/, 'the WARN names which rule did it');
    // The number must be MEASURED, not a constant: a log line that prints the
    // threshold, or the whole prompt size, tells an operator nothing.
    const m = /removed (\d+) bytes/.exec(warns[0]);
    assert.ok(m, `WARN must carry a byte count, got: ${warns[0]}`);
    assert.equal(Number(m[1]), removed,
      `the logged delta must equal the real one (${removed}), got ${m[1]} in: ${warns[0]}`);
  });

  // NEGATIVE CONTROL: the ordinary case must stay silent, or the WARN is noise.
  it('an ordinary Claude Code prompt logs NOTHING', () => {
    const src = "You are Claude Code, Anthropic's official CLI for Claude.\n\n"
      + 'You are an interactive CLI tool that helps users with software engineering tasks.\n\n'
      + 'RULE: never log the API key.\n\nNow do the task.';
    const { out, warns } = neutralize(src);
    // It DID rewrite — this is not silence for lack of work.
    assert.equal(/Claude Code/i.test(out), false, 'the identity line was rewritten');
    assert.ok(out.includes('RULE: never log the API key.'), 'user rule untouched');
    assert.deepEqual(warns, [],
      `a ~26-byte identity rewrite must not log; a line per request is noise. Got:\n${warns.join('\n')}`);
  });

  // The delta must be BYTES, not characters. A CJK prompt is ~3 bytes per char, so a
  // char count under-reports what the prompt loses on the wire by a factor of three —
  // enough to sit under the threshold and log nothing at all while 600+ bytes vanish.
  it('counts BYTES, not characters, on a multibyte prompt', () => {
    const cjk = '请勿删除生产数据库，也不要记录任何密钥。'.repeat(11);
    const src = `Before.\n<executing_actions_with_care>\n${cjk}\n</executing_actions_with_care>\nAfter.`;
    const { out, warns } = neutralize(src);
    const removedBytes = bytes(src) - bytes(out);
    const removedChars = src.length - out.length;
    assert.ok(removedBytes > 512, `byte delta must exceed the threshold, got ${removedBytes}`);
    assert.ok(removedChars <= 512,
      `fixture only proves byte-vs-char if the CHAR delta is under the threshold, got ${removedChars}`);
    assert.equal(warns.length, 1,
      `a char count would be ${removedChars} — under 512 — and log nothing. Got:\n${warns.join('\n')}`);
    const m = /removed (\d+) bytes/.exec(warns[0]);
    assert.equal(Number(m[1]), removedBytes,
      `logged ${m[1]}, real byte delta ${removedBytes} (char delta ${removedChars})`);
  });

  // The care block keeps an unbounded span ON PURPOSE — both ends are delimiters the
  // client wrote — and real safety prose spans paragraphs. Paragraph-bounding it here
  // would leave the tags and half the block upstream, i.e. would not neutralize.
  it('the <executing_actions_with_care> block is still stripped across a blank line', () => {
    const src = 'Before.\n<executing_actions_with_care>\nDouble-check destructive commands.\n\n'
      + 'Confirm before deleting anything.\n</executing_actions_with_care>\nAfter.';
    const { out } = neutralize(src);
    assert.equal(/executing_actions_with_care/i.test(out), false, 'both tags removed');
    assert.equal(out.includes('Double-check destructive commands.'), false, 'first paragraph removed');
    assert.equal(out.includes('Confirm before deleting anything.'), false,
      'the paragraph after the blank line is inside the block and must go too');
    assert.ok(out.includes('Before.') && out.includes('After.'), 'surrounding text kept');
  });

  // NEGATIVE CONTROL: the threshold is PER SUBSTITUTION, not cumulative. A real
  // multi-client prompt trips many rules at once; if the check summed them it would
  // warn on every heavy-but-legitimate request and the signal would be worthless.
  it('many small legitimate rewrites totalling past the threshold still log nothing', () => {
    const src = [
      'x-anthropic-billing-header: cc_version=2.1.204.5d3; cc_entrypoint=sdk-cli;',
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      'You are Grok 4.5 released by xAI.',
      'You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.',
      'You are powered by the model claude-5-fable-max.',
      'The exact model ID is claude-opus-4-8.',
      '<executing_actions_with_care>Take care with destructive commands.</executing_actions_with_care>',
      // 322 bytes removed on its own — the largest legitimate single removal there is,
      // and still under the 512 threshold. It is what takes the TOTAL past it.
      'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.',
      'Keep this final instruction.',
    ].join('\n');
    const { out, warns } = neutralize(src);
    const removed = bytes(src) - bytes(out);
    assert.ok(removed > 512,
      `the fixture must remove more than 512 bytes IN TOTAL, removed ${removed}`);
    assert.ok(out.includes('Keep this final instruction.'), 'user text kept');
    assert.deepEqual(warns, [],
      'no single substitution exceeded the threshold, so nothing should be logged. '
      + `Got:\n${warns.join('\n')}`);
  });
});

// Differential audit (OLD scanner vs NEW, .agent/diff-audit/REPORT.md): two
// under-redaction regressions where NEW kept fingerprint bytes that OLD removed.
// F1: `IMPORTANT:` alone on its line, then ONLY whitespace (including the blank
// line the live preamble emits), then the security phrase — the paragraph-bound
// gap refused to cross the break, so the whole sentence went upstream. F2: a
// billing header behind a lone \r / U+2028 / U+2029 never anchored, because
// forEachLine only split on \n while the old `/^…/m` rules accepted every JS
// line terminator.
describe('identity-neutralize — differential audit under-redaction fixes', () => {
  const SEC_PHRASE = /Assist with authorized security testing/i;
  const SEC_TAIL = 'defensive security, CTF challenges. Dual-use tools require authorization: security research, or defensive use cases.';

  it('security: IMPORTANT: alone, blank line, then the phrase — still neutralized', () => {
    const src = 'IMPORTANT:\n\nAssist with authorized security testing, ' + SEC_TAIL + '\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.equal(SEC_PHRASE.test(out), false,
      'the all-whitespace gap must let IMPORTANT: pair with the phrase (F1)');
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
  });

  it('security: same shape with a whitespace-only line between', () => {
    const src = 'IMPORTANT:\n   \nAssist with authorized security testing, ' + SEC_TAIL + '\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.equal(SEC_PHRASE.test(out), false,
      'a whitespace-only blank line is still whitespace for the gap');
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
  });

  it('security: same shape with an NBSP-only line between', () => {
    const src = 'IMPORTANT:\n \nAssist with authorized security testing, ' + SEC_TAIL + '\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.equal(SEC_PHRASE.test(out), false,
      'an NBSP-only blank line is still whitespace for the gap');
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
  });

  it('security: anchor mid-line keeps the pairing too', () => {
    const src = 'preamble text IMPORTANT:\n\nAssist with authorized security testing, ' + SEC_TAIL + '\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.equal(SEC_PHRASE.test(out), false, 'fingerprint leaked');
    assert.ok(out.includes('preamble text'), 'text before the anchor kept');
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
  });

  // NEGATIVE CONTROL — the WA-002 bound still holds: when the anchor's own
  // paragraph continues with real text, a phrase one paragraph later is NOT
  // paired and must survive exactly as OLD left it.
  it('security: anchor followed by real text still does NOT pair across the break', () => {
    const src = 'IMPORTANT: keep this instruction.\n\nAssist with authorized security testing, ' + SEC_TAIL + '\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.ok(out.includes('keep this instruction.'), 'the anchor paragraph survives');
    assert.ok(SEC_PHRASE.test(out),
      'a phrase in the NEXT paragraph is not the anchor\'s sentence — OLD left it too');
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
  });

  it('billing: a header behind a lone CR is still stripped', () => {
    const src = 'preamble\rx-anthropic-billing-header: cc_version=2.1.0;\rtail keep me';
    const { out } = neutralize(src);
    assert.equal(out.includes('x-anthropic-billing-header'), false,
      'a lone CR is a line terminator — the header must not leak (F2)');
    assert.ok(out.includes('preamble'), 'text before kept');
    assert.ok(out.includes('tail keep me'), 'text after kept');
  });

  it('billing: a header behind U+2028 / U+2029 is still stripped', () => {
    for (const [name, sep] of [['U+2028', ' '], ['U+2029', ' ']]) {
      const src = 'preamble' + sep + 'x-anthropic-billing-header: cc_version=2.1.0;' + sep + 'tail keep me';
      const { out } = neutralize(src);
      assert.equal(out.includes('x-anthropic-billing-header'), false,
        `${name} is a JS line terminator — the header must not leak (F2)`);
      assert.ok(out.includes('tail keep me'), `${name}: text after kept`);
    }
  });
});

// F5 (diff-audit): the FREEFORM provenance boundary was line-scoped, so a
// preamble whose clause and token wrapped across lines leaked the token.
// Paragraph scope covers the wrap while a bare token in caller text — the
// WA-003 corruption the line bound exists to stop — still survives.
describe('identity-neutralize — FREEFORM provenance is paragraph-scoped', () => {
  it('token on the line AFTER the clause is still rewritten', () => {
    const src = 'return the patch and do not wrap the patch in json,\nrespond in FREEFORM.\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.equal(out.includes('FREEFORM'), false, 'wrapped clause+token must not leak (F5)');
    assert.ok(out.includes('free-form'), 'token rewritten to the benign form');
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
  });

  it('token on the line BEFORE the clause is still rewritten', () => {
    const src = 'respond in FREEFORM,\ndo not wrap the patch in json.\n\nRULE: keep me';
    const { out } = neutralize(src);
    assert.equal(out.includes('FREEFORM'), false, 'token-before-clause in one paragraph');
    assert.ok(out.includes('RULE: keep me'), 'caller RULE kept');
  });

  it('clause in paragraph 1, token in paragraph 2 — the token survives', () => {
    const src = 'do not wrap the patch in json.\n\nCHECK (kind IN (\'FREEFORM\',\'STRUCTURED\'))';
    const { out } = neutralize(src);
    assert.ok(out.includes("'FREEFORM'"),
      'a token outside the clause paragraph is caller content — keep it');
  });

  it('a bare FREEFORM token with no clause anywhere still survives (WA-003)', () => {
    const src = "if (mode === FREEFORM) { run(); }\nSELECT * FROM t WHERE kind = 'FREEFORM'";
    const { out } = neutralize(src);
    assert.equal(out, src, 'caller code tokens are not the fingerprint');
  });
});
