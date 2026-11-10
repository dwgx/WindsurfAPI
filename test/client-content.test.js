import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compactSystemPromptForCascade, contentToString } from '../src/client.js';

describe('Cascade text conversion safety', () => {
  it('does not serialize image base64 into replayed text history', () => {
    const imageData = 'iVBORw0KGgo'.repeat(30);
    const text = contentToString([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
    ]);
    assert.ok(text.includes('look at this'));
    assert.ok(text.includes('[Image omitted from text history]'));
    assert.ok(!text.includes(imageData));
  });

  it('rewrites a short Claude Code identity at the start of a sentence (#41)', () => {
    const input = "You are Claude Code, Anthropic's official CLI tool for Claude.\nWorking directory: /repo\nAnother sentence. You are an agent. mid-sentence you are stays.";
    const out = compactSystemPromptForCascade(input);
    assert.match(out, /^The assistant is Claude Code, Anthropic's official CLI tool for Claude\./);
    assert.match(out, /Another sentence\. The assistant is an agent\./, 'sentence-initial identity after a period is rewritten');
    assert.match(out, /mid-sentence you are stays\./, 'lowercase mid-sentence text is not rewritten');
    assert.doesNotMatch(out, /(^|[\n.!?]\s*)You are /, 'no sentence-initial second-person identity survives');
  });

  it('compacts Claude Code system prompts before they ride in Cascade user text', () => {
    const systemPrompt = [
      'x-anthropic-billing-header: cc_version=2.1.119; cc_entrypoint=cli;',
      "You are Claude Code, Anthropic's official CLI for Claude.",
      'You are an interactive agent that helps users with software engineering tasks.',
      'Tool protocol details: content_block tool_use tool_result '.repeat(120),
      'Working directory: /Users/blithe/Downloads/Code/Test',
      'Platform: darwin',
    ].join('\n');

    const compact = compactSystemPromptForCascade(systemPrompt);
    assert.ok(compact.length < 1000, `expected compact prompt, got ${compact.length} chars`);
    assert.ok(!/x-anthropic-billing-header/i.test(compact));
    assert.ok(!/Claude Code/i.test(compact));
    assert.ok(compact.includes('Working directory: /Users/blithe/Downloads/Code/Test'));
  });

  // L3b-F2: the `(?:^|\n)\s*…` anchors let `\s` consume newlines, so each
  // `\n` in a whitespace run re-anchored a scan of the whole remaining run —
  // O(n²) on caller system text (64 KiB measured ~3.5 s; body cap is 10 MiB).
  // The fix narrows the gap classes to horizontal whitespace: any gap that
  // contained `\n` re-anchors at that `\n` instead, so the rewrites are
  // leftmost-match equivalent and linear.
  it('neutralizer stays linear on caller text padded with newline runs', () => {
    const bomb = 'header line.\n' + '\n'.repeat(128 * 1024) + '  tail';
    const t0 = performance.now();
    const out = compactSystemPromptForCascade(bomb);
    const ms = performance.now() - t0;
    assert.equal(typeof out, 'string');
    assert.ok(ms < 500, `neutralize+extract on 128 KiB newline run took ${ms.toFixed(1)} ms`);
  });

  it('still rewrites sentence-initial identity after blank lines', () => {
    const out = compactSystemPromptForCascade('Intro done.\n\n  You are Devin, an agent.');
    assert.doesNotMatch(out, /You are Devin/, 'identity after newline gap must still be rewritten');
  });
});
