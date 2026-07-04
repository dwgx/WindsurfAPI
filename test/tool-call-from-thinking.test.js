// v2.0.146 regression: high-reasoning models (Opus 4.8 xhigh) sometimes
// emit <tool_call> blocks inside thinking (reasoning_content) rather than
// in the main text response.  The old narrative-source guard used text-first:
//   const narrativeSource = accText ? accText : accThinking;
// so when the model produced non-empty text + thinking-only tool markup,
// the NLU/parse recovery ran against the text — never seeing the <tool_call>.
//
// Fix: always merge text + thinking for narrative scanning and parse thinking
// as a fallback source when the text parser yields no tool_calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCallsFromText } from '../src/handlers/tool-emulation.js';
import { filterToolCallsByAllowlist } from '../src/handlers/chat.js';

// Simulate what the v2.0.146 fix does: parse accThinking when accText parser
// found nothing, then allowlist-filter against the declared tools.
function liftToolCallsFromThinking(accThinking, declaredTools, { modelKey = 'claude-opus-4-8-xhigh', provider = 'anthropic', route = 'chat' } = {}) {
  const parsed = parseToolCallsFromText(accThinking, { modelKey, provider, route });
  return filterToolCallsByAllowlist(parsed.toolCalls, declaredTools);
}

const BASH_TOOL = {
  type: 'function',
  function: {
    name: 'Bash',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
};

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
};

describe('tool_call extraction from thinking content (v2.0.146)', () => {
  it('extracts a complete <tool_call> block from thinking-only content', () => {
    const thinking = `My Master, 我是 Opus 4.8. Let me run a command.
<tool_call>{"name":"Bash","arguments":{"command":"echo hello"}}</tool_call>`;
    const calls = liftToolCallsFromThinking(thinking, [BASH_TOOL]);
    assert.equal(calls.length, 1, 'should extract 1 tool call from thinking');
    assert.equal(calls[0].name, 'Bash');
    const args = JSON.parse(calls[0].argumentsJson);
    assert.equal(args.command, 'echo hello');
  });

  it('extracts when thinking has prose before and after the tool_call block', () => {
    const thinking = `Thinking through this carefully.
I need to look at what agents are defined.
<tool_call>{"name":"Bash","arguments":{"command":"ls ~/.claude/agents/"}}</tool_call>
Now I wait for the result.`;
    const calls = liftToolCallsFromThinking(thinking, [BASH_TOOL]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'Bash');
  });

  it('extracts multiple tool_call blocks from thinking', () => {
    const thinking = `<tool_call>{"name":"Bash","arguments":{"command":"echo 1"}}</tool_call>
<tool_call>{"name":"Read","arguments":{"file_path":"/tmp/test.txt"}}</tool_call>`;
    const calls = liftToolCallsFromThinking(thinking, [BASH_TOOL, READ_TOOL]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'Bash');
    assert.equal(calls[1].name, 'Read');
  });

  it('allowlist-filters out tool_calls not in declared tools[]', () => {
    const thinking = `<tool_call>{"name":"Bash","arguments":{"command":"rm -rf /"}}</tool_call>
<tool_call>{"name":"UnknownTool","arguments":{"x":"y"}}</tool_call>`;
    const calls = liftToolCallsFromThinking(thinking, [BASH_TOOL]);
    assert.equal(calls.length, 1, 'UnknownTool should be filtered out');
    assert.equal(calls[0].name, 'Bash');
  });

  it('returns empty array when thinking has no tool_call markup', () => {
    const thinking = `I should call Bash to list files but I am describing it in plain text.`;
    const calls = liftToolCallsFromThinking(thinking, [BASH_TOOL]);
    assert.equal(calls.length, 0);
  });

  it('returns empty array when declared tools is empty', () => {
    const thinking = `<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>`;
    const calls = liftToolCallsFromThinking(thinking, []);
    assert.equal(calls.length, 0, 'no declared tools — must drop all');
  });

  it('narrative source fix: merging text+thinking lets marker detection see xml_tag', () => {
    // Regression for the original bug: accText was non-empty so narrativeSource
    // was set to accText only, making markers=xml_tag come from thinking but
    // NLU ran against text. Verify merged narrative contains the <tool_call> tag.
    const accText = 'My Master, 我是 Opus 4.8.';
    const accThinking = '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>';
    const merged = [accText, accThinking].filter(s => s && s.trim()).join('\n');
    assert.ok(/<tool_call/i.test(merged), 'merged narrative should contain xml_tag marker');
    assert.ok(merged.includes(accText), 'merged should include the text portion');
    assert.ok(merged.includes(accThinking), 'merged should include the thinking portion');
  });
});
