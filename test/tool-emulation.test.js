import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolCallStreamParser,
  parseToolCallsFromText,
  buildToolPreamble,
  normalizeMessagesForCascade,
} from '../src/handlers/tool-emulation.js';

describe('ToolCallStreamParser', () => {
  it('parses XML-format tool calls', () => {
    const parser = new ToolCallStreamParser();
    const r = parser.feed(
      'Here is the result:\n<tool_call>{"name":"Read","arguments":{"path":"./file.js"}}</tool_call>\nDone.'
    );
    const flush = parser.flush();
    const allCalls = [...r.toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'Read');
    assert.ok(JSON.parse(allCalls[0].argumentsJson).path === './file.js');
    assert.ok(r.text.includes('Here is the result:'));
  });

  it('parses bare JSON tool calls', () => {
    const parser = new ToolCallStreamParser();
    const r = parser.feed(
      '{"name":"Write","arguments":{"path":"a.txt","content":"hello"}}'
    );
    const flush = parser.flush();
    const allCalls = [...r.toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'Write');
  });

  it('handles tool call split across chunks', () => {
    const parser = new ToolCallStreamParser();
    const r1 = parser.feed('<tool_call>{"name":"Rea');
    const r2 = parser.feed('d","arguments":{"path":"x"}}</tool_call>');
    const r3 = parser.flush();
    const allCalls = [...r1.toolCalls, ...r2.toolCalls, ...r3.toolCalls];
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'Read');
  });

  it('emits text before and after tool calls', () => {
    const parser = new ToolCallStreamParser();
    const r = parser.feed(
      'Before\n<tool_call>{"name":"X","arguments":{}}</tool_call>\nAfter'
    );
    const flush = parser.flush();
    const text = r.text + flush.text;
    assert.ok(text.includes('Before'));
    assert.ok(text.includes('After'));
    assert.ok(!text.includes('<tool_call>'));
  });

  it('handles multiple tool calls in one chunk', () => {
    const parser = new ToolCallStreamParser();
    const input = '<tool_call>{"name":"A","arguments":{}}</tool_call>text<tool_call>{"name":"B","arguments":{}}</tool_call>';
    const r = parser.feed(input);
    const flush = parser.flush();
    const allCalls = [...r.toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 2);
  });
});

describe('parseToolCallsFromText', () => {
  it('extracts tool calls and strips them from text', () => {
    const input = 'Hello\n<tool_call>{"name":"Read","arguments":{"path":"x.js"}}</tool_call>\nWorld';
    const { text, toolCalls } = parseToolCallsFromText(input);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, 'Read');
    assert.ok(!text.includes('<tool_call>'));
    assert.ok(text.includes('Hello'));
  });

  it('returns empty array when no tool calls', () => {
    const { text, toolCalls } = parseToolCallsFromText('Just normal text');
    assert.equal(toolCalls.length, 0);
    assert.equal(text, 'Just normal text');
  });
});

describe('buildToolPreamble (injection-guard safety)', () => {
  // Regression guard: Claude Code / Opus-class prompt-injection detectors
  // refuse to honour the injected tool scaffolding when:
  //   (a) it uses jailbreak-shaped phrasing, OR
  //   (b) it has the SHAPE of a Claude Code system prompt (a wall of
  //       `### ToolName` blocks with per-tool ```json schemas) appearing
  //       in a user turn — the model flags that as "someone pasted a
  //       system prompt into my user slot" and refuses to call tools.
  // The fallback stays minimal: protocol one-liner + tool name list only.
  // Full schemas live in the proto-level tool_calling_section override.
  const manyTools = [
    { type: 'function', function: { name: 'Bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    { type: 'function', function: { name: 'Read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
    { type: 'function', function: { name: 'Edit', description: 'Edit a file.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } } } },
  ];
  const preamble = buildToolPreamble(manyTools);

  it('does not contain jailbreak-shaped phrasing', () => {
    const banned = [
      /IGNORE any earlier/i,
      /ignore previous instructions/i,
      /for this request only/i,
      /disregard .* (system|prior) /i,
      /\[Tool-calling context/i,
      /\[End tool-calling context\]/i,
    ];
    for (const re of banned) {
      assert.ok(!re.test(preamble), `preamble must not match ${re}: got ${preamble}`);
    }
  });

  it('does not have the shape of a Claude Code system prompt', () => {
    // No `### ToolName` section headers
    assert.ok(!/^### /m.test(preamble), `preamble must not use '### ' headers: got ${preamble}`);
    // No `parameters schema:` / `Parameters:` schema-dump labels
    assert.ok(!/parameters schema:/i.test(preamble), 'preamble must not dump per-tool schemas');
    assert.ok(!/^Parameters:/m.test(preamble), 'preamble must not dump per-tool schemas');
    // No fenced ```json blocks (schemas would live inside these)
    assert.ok(!/```json/i.test(preamble), 'preamble must not contain fenced json schema blocks');
    // Stays well under a "system prompt wall of text" size even with many tools
    assert.ok(preamble.length < 512, `preamble must stay compact (<512 chars); got ${preamble.length}`);
  });

  it('still describes the <tool_call> protocol and lists every tool name', () => {
    assert.ok(preamble.includes('<tool_call>'), 'must describe emission format');
    for (const t of manyTools) {
      assert.ok(preamble.includes(t.function.name), `must include function name ${t.function.name}`);
    }
  });

  it('normalizeMessagesForCascade prepends preamble to last user message without jailbreak or system-prompt shape', () => {
    const out = normalizeMessagesForCascade(
      [{ role: 'user', content: 'hello' }],
      manyTools,
    );
    const last = out[out.length - 1];
    assert.equal(last.role, 'user');
    assert.ok(last.content.endsWith('hello'));
    assert.ok(!/IGNORE any earlier/i.test(last.content));
    assert.ok(!/\[Tool-calling context/i.test(last.content));
    assert.ok(!/^### /m.test(last.content), 'prepended content must not use ### headers');
    assert.ok(!/```json/i.test(last.content), 'prepended content must not contain ```json fences');
  });

  it('emits empty string when no usable function tools are present', () => {
    assert.equal(buildToolPreamble([]), '');
    assert.equal(buildToolPreamble([{ type: 'other' }]), '');
    assert.equal(buildToolPreamble([{ type: 'function' }]), '');
  });
});
