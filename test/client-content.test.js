import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
