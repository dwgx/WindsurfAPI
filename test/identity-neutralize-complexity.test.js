// identity-neutralize: the multi-line rules must stay LINEAR.
//
// Two defects came from the regex ENGINE rather than from the pattern:
//
//   `(?:^|\n)\s*-?\s*Fast mode for Claude Code…` is O(n²) per start position. On a
//   prompt of 2,048 newlines plus one character (2,049 bytes) the a4-fastmode rule
//   alone took 676 ms of synchronous event-loop time on master c3ac2b2.
//
//   An unbounded `[\s\S]*?` between two anchors is O(n²) over the whole prompt: a
//   512 KiB system prompt that repeats a brand-block or care-block anchor with no
//   terminator made the scanner re-search the whole suffix from every occurrence.
//
// Both are synchronous: while they run, every other request on the process is
// stopped. The rewrite replaced them with cursor-advancing scanners (O(rules × n)).
//
// These are PERMANENT regression tests: the bounds are ~40× above the measured cost
// of the linear scanners on the machine this was written on, and far below the old
// multi-second behaviour, so they fail loudly if a quadratic shape comes back
// without being flaky on a slower box. Measured on the rewrite:
//   2,049 B newline family   2.4 ms   (bound 100 ms)
//   512 KiB brand, no term   9.5 ms   (bound 500 ms)
//   512 KiB care, no close  14.7 ms   (bound 500 ms)
//   512 KiB newlines        24.1 ms   (bound 500 ms)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { neutralizeClientIdentity } from '../src/handlers/identity-neutralize.js';

const KIB = 1024;

/** Build exactly `bytes` bytes by repeating `unit` (and slicing the tail). */
const fill = (unit, bytes) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

/** Neutralize `src` and return the elapsed wall time in milliseconds. */
function timed(src) {
  const started = performance.now();
  const out = neutralizeClientIdentity(src);
  return { ms: performance.now() - started, out };
}

describe('identity-neutralize — linear scanners (no quadratic blow-up)', () => {
  it('2,049 bytes of newlines + X: under 100 ms (was 676 ms for a4-fastmode alone)', () => {
    const src = '\n'.repeat(2048) + 'X';
    assert.equal(src.length, 2049, 'fixture is the measured 2,049-byte input');
    const { ms, out } = timed(src);
    assert.equal(out, src, 'nothing in a newline run is a fingerprint');
    assert.ok(ms < 100, `took ${ms.toFixed(1)} ms, bound is 100 ms; the old regex took 676 ms`);
  });

  it('512 KiB of the brand anchor with no terminator: under 500 ms', () => {
    const src = fill('Claude Code is available as a CLI ', 512 * KIB);
    assert.equal(src.length, 512 * KIB);
    const { ms, out } = timed(src);
    assert.equal(/Claude Code/i.test(out), false, 'the fingerprint line is still removed');
    assert.ok(ms < 500,
      `took ${ms.toFixed(1)} ms, bound is 500 ms; the unbounded span re-searched the suffix per anchor`);
  });

  it('512 KiB of an unterminated <executing_actions_with_care>: under 500 ms', () => {
    const src = fill('<executing_actions_with_care>', 512 * KIB);
    assert.equal(src.length, 512 * KIB);
    const { ms, out } = timed(src);
    // No close tag ⇒ no block ⇒ nothing may be deleted (an open with no close means
    // no LATER open has one either, so the scan stops instead of re-searching).
    assert.equal(out, src, 'an unterminated block deletes nothing');
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms, bound is 500 ms`);
  });

  it('512 KiB of newlines + X: under 500 ms', () => {
    const src = '\n'.repeat(512 * KIB) + 'X';
    assert.equal(src.length, 512 * KIB + 1);
    const { ms, out } = timed(src);
    assert.equal(out, src);
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms, bound is 500 ms`);
  });
});

// H1: paragraphEndAt now asks `isSpaceCode` about every character after a newline
// (the Unicode branch runs a regex per non-ASCII code unit), and the billing scan
// walks every line. These 512 KiB shapes keep that per-character work from becoming
// synchronous event-loop time, and the Unicode prefix must come through byte-identical
// — the module folds ASCII code units instead of lowercasing a copy precisely because
// 'İ' changes length under toLowerCase.
describe('identity-neutralize — 512 KiB whitespace / Unicode bounds (H1)', () => {
  it('512 KiB single line of spaces and of NBSP: under 500 ms, unchanged', () => {
    for (const unit of [' ', '\u00A0']) {
      const src = unit.repeat(512 * KIB);
      assert.equal(src.length, 512 * KIB);
      const { ms, out } = timed(src);
      assert.equal(out, src, `nothing in a ${JSON.stringify(unit)} run is a fingerprint`);
      assert.ok(ms < 500,
        `${JSON.stringify(unit)} run took ${ms.toFixed(1)} ms, bound is 500 ms`);
    }
  });

  it('512 KiB of four-space lines (the billing scan shape): under 500 ms, unchanged', () => {
    const src = fill('    \n', 512 * KIB);
    assert.equal(src.length, 512 * KIB);
    assert.equal(src.split('\n').length - 1, Math.floor((512 * KIB) / 5),
      'fixture is 104,857 four-space lines');
    const { ms, out } = timed(src);
    assert.equal(out, src, 'no billing header means no rewrite');
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms, bound is 500 ms`);
  });

  it('512 KiB Unicode-prefix prompt: under 500 ms, prefix intact', () => {
    const prefix = 'İİİ 😀 ';
    const brand = ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), '
      + 'web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).\n'
      + ' - Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade '
      + 'to a smaller model). It can be toggled with /fast and is available on Opus 4.8/4.7.';
    const head = prefix.repeat(Math.ceil((512 * KIB - brand.length) / prefix.length));
    const src = head + brand;
    const { ms, out } = timed(src);
    assert.ok(out.startsWith(head), 'the Unicode prefix is unchanged');
    assert.equal(/Claude Code/i.test(out), false, 'the brand block is still neutralized');
    assert.equal(/claude\.ai\/code/i.test(out), false, 'the URL is gone');
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms, bound is 500 ms`);
  });
});

// NEGATIVE CONTROL: speed must not have been bought by skipping the work. A normal
// 8 KiB prompt carrying the real brand block, model catalogue and security paragraph
// still has every fingerprint removed.
describe('identity-neutralize — the linear pass still neutralizes a real 8 KiB prompt', () => {
  const REAL = [
    "You are Claude Code, Anthropic's official CLI for Claude.",
    '',
    'You are an interactive CLI tool that helps users with software engineering tasks.',
    '',
    'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.',
    '',
    ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).',
    ' - Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is available on Opus 4.8/4.7.',
    '',
    "The most recent Claude models are the Claude 5 family, Opus 4.8, and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'. When building AI applications, default to the latest and most capable Claude models.",
    '',
    '# Harness',
    '',
    'You have access to tools. Prefer reading a file before editing it. Keep changes small and verify them. '.repeat(70),
    '',
    'RULE: Preserve the production database.',
    'TASK: add a health endpoint.',
  ].join('\n');

  it('removes the brand/catalogue/security fingerprints and keeps the caller text', () => {
    assert.ok(REAL.length >= 8000 && REAL.length <= 9000, `fixture is ~8 KiB, got ${REAL.length}`);
    const { out } = timed(REAL);
    assert.equal(/Claude Code/i.test(out), false, 'no "Claude Code"');
    assert.equal(/claude\.ai\/code/i.test(out), false, 'no claude.ai/code URL');
    assert.equal(/Model IDs|claude-fable-5|claude-opus-4-8/i.test(out), false, 'catalogue removed');
    for (const term of ['security testing', 'CTF', 'DoS attacks', 'supply chain', 'C2 frameworks']) {
      assert.equal(out.includes(term), false, `security trigger term still removed: ${term}`);
    }
    assert.ok(out.includes('RULE: Preserve the production database.'), 'caller rule kept');
    assert.ok(out.includes('TASK: add a health endpoint.'), 'task kept');
    assert.ok(out.includes('You have access to tools.'), 'tool preamble kept');
  });
});
