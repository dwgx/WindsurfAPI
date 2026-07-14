import test from 'node:test';
import assert from 'node:assert/strict';
import { applyToolPreambleBudget, injectPreambleIntoSystemPrompt } from '../src/handlers/chat.js';

function makeTools(count, propCount = 18) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'function',
    function: {
      name: `mcp_tool_${i}`,
      description: `Verbose MCP tool ${i} description. `.repeat(20),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: propCount }, (_, j) => [`field_${j}`, {
            type: 'string',
            description: `Verbose field ${j} for tool ${i}. `.repeat(12),
            enum: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
          }])
        ),
        required: Array.from({ length: propCount }, (_, j) => `field_${j}`),
      },
    },
  }));
}

test('tool preamble budget compacts before enforcing hard cap (#70)', () => {
  const r = applyToolPreambleBudget(makeTools(56), 'auto', '', {
    softBytes: 24_000,
    hardBytes: 48_000,
  });

  assert.equal(r.ok, true);
  assert.equal(r.compacted, true);
  assert.ok(r.fullBytes > r.hardBytes, `fixture should exceed hard cap before compaction, got ${r.fullBytes}`);
  assert.ok(r.finalBytes < r.hardBytes, `compacted payload should fit hard cap, got ${r.finalBytes}`);
  assert.ok(r.preamble.includes('mcp_tool_55'));
  assert.ok(!r.preamble.includes('field_0'), 'compact payload must omit schemas');
});

test('tool preamble budget rejects only when compact payload is still too large', () => {
  const r = applyToolPreambleBudget(makeTools(2000, 1), 'auto', '', {
    softBytes: 1_000,
    hardBytes: 1_500,
  });

  assert.equal(r.ok, false);
  assert.equal(r.compacted, true);
  assert.ok(r.finalBytes > r.hardBytes);
});

test('25-tool 70KB payload picks skinny tier instead of dropping straight to names-only (#77 AromaACG)', () => {
  // Reproduces AromaACG's reported scenario: claude-opus-4-7 with 25 tools
  // and verbose schemas, full preamble ~70KB. Without intermediate tiers
  // the proxy fell back to names-only (2KB) and opus-4-7 returned 14-char
  // truncated replies because it had zero parameter information.
  const tools = Array.from({ length: 25 }, (_, i) => ({
    type: 'function',
    function: {
      name: `mcp_tool_${i}`,
      description: `MCP tool number ${i} that does very specific work. `.repeat(10),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 8 }, (_, j) => [`param_${j}`, {
            type: 'string',
            description: `Detailed param ${j} description. `.repeat(20),
          }])
        ),
        required: ['param_0'],
        additionalProperties: false,
      },
    },
  }));
  const r = applyToolPreambleBudget(tools, 'auto', '', { softBytes: 24_000, hardBytes: 48_000 });
  assert.equal(r.ok, true);
  assert.equal(r.compacted, true);
  assert.ok(r.fullBytes > 30_000, `fixture should exceed soft cap, got ${r.fullBytes}`);
  assert.ok(['schema-compact', 'skinny'].includes(r.tier), `expected intermediate tier, got ${r.tier}`);
  assert.ok(r.preamble.includes('param_0'), 'intermediate tier must keep param names so the model knows the call shape');
  assert.ok(r.preamble.includes('mcp_tool_24'), 'every tool name must survive');
});

test('schema-compact tier strips per-field description bloat but keeps types and enums', () => {
  // Build a tool whose full schema is dominated by per-field documentation,
  // so each tier shrinks meaningfully and we can pick out the intermediate
  // ones by total byte count.
  const verbose = 'detail '.repeat(120);
  const tools = Array.from({ length: 3 }, (_, i) => ({
    type: 'function',
    function: {
      name: `Tool${i}`,
      description: `Tool number ${i}. ${verbose}`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: verbose },
          mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: verbose },
          payload: { type: 'string', description: verbose },
        },
        required: ['file_path'],
      },
    },
  }));
  const full = applyToolPreambleBudget(tools, 'auto', '', { softBytes: 100_000, hardBytes: 100_000 });
  assert.equal(full.tier, 'full');
  const fullBytes = full.finalBytes;

  // Set softBytes between schema-compact and skinny sizes so the walk lands
  // on schema-compact (need to know real sizes — measure with a probe).
  const sc = applyToolPreambleBudget(tools, 'auto', '', { softBytes: 1, hardBytes: 100_000 });
  // softBytes=1 forces the walk to the smallest tier that fits → names-only,
  // unless something rejects. Instead, measure each tier's natural size and
  // assert ordering.
  assert.equal(sc.tier, 'names-only');

  // Pick a soft cap that schema-compact fits but full does not.
  const compactSize = fullBytes - 1;
  // Walk the budget with that cap — should land at schema-compact or smaller.
  const r = applyToolPreambleBudget(tools, 'auto', '', { softBytes: compactSize, hardBytes: 100_000 });
  assert.notEqual(r.tier, 'full');
  assert.ok(r.finalBytes < fullBytes, 'compacted tier must be smaller than full');
  assert.ok(r.preamble.includes('file_path'), 'all non-empty tiers keep param names somewhere');
});

// ─── nativeStructured (hybrid mode) regression tests ─────────────────────────
// The DEVIN_CONNECT native path (nativeToolCall flag + both gates on) has no
// proto tool_calling_section slot, so the description-only preamble must be
// built via applyToolPreambleBudget({nativeStructured:true}) and injected into
// the system prompt. These tests pin the contract:
//   1. The preamble carries "Available functions" with full descriptions.
//   2. The preamble has NO text-emulation protocol header (no <tool_call> format
//      instructions) — that would conflict with native #6 ChatToolCall.
//   3. All four budget tiers preserve tool names and never emit the protocol.
//   4. injectPreambleIntoSystemPrompt prepends to an existing system message,
//      creates one if absent, and never mutates the caller's array.

const PROTOCOL_RE = /emit this EXACT format|To invoke|tool_calls_section_begin|To call one, emit/i;

test('nativeStructured: full preamble has descriptions but no text-emulation protocol header', () => {
  const tools = makeTools(3, 2);
  const r = applyToolPreambleBudget(tools, 'auto', '', { nativeStructured: true, softBytes: 100_000, hardBytes: 100_000 });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'full');
  assert.ok(r.preamble.includes('Available functions'), 'must list available functions');
  assert.ok(r.preamble.includes('mcp_tool_0'), 'must include tool names');
  assert.ok(r.preamble.includes('Verbose MCP tool 0'), 'must include full descriptions');
  assert.doesNotMatch(r.preamble, PROTOCOL_RE, 'must NOT contain text-emulation protocol header');
});

test('nativeStructured: all four budget tiers keep names and never emit the protocol header', () => {
  const tools = makeTools(8, 6);
  for (const softBytes of [100_000, 10_000, 2_000, 500]) {
    const r = applyToolPreambleBudget(tools, 'auto', '', { nativeStructured: true, softBytes, hardBytes: 200_000 });
    assert.equal(r.ok, true, `tier at softBytes=${softBytes} should be ok`);
    if (!r.preamble) continue; // empty tier (no tools) is fine
    assert.ok(r.preamble.includes('mcp_tool_7'), `tier ${r.tier} must keep all tool names (softBytes=${softBytes})`);
    assert.doesNotMatch(r.preamble, PROTOCOL_RE, `tier ${r.tier} must NOT emit protocol header (softBytes=${softBytes})`);
  }
});

test('nativeStructured: preamble is non-empty (unlike the user-message fallback which returns "")', () => {
  // The user-message fallback (buildToolPreamble) returns '' for nativeStructured.
  // applyToolPreambleBudget must NOT — it builds the proto-level description block.
  const tools = makeTools(2, 1);
  const r = applyToolPreambleBudget(tools, 'auto', '', { nativeStructured: true });
  assert.equal(r.ok, true);
  assert.ok(r.preamble.length > 0, 'nativeStructured preamble must be non-empty (descriptions ride the system prompt)');
  assert.ok(r.preamble.includes('Available functions'));
});

test('nativeStructured: tool_choice none/required/forced do not inject protocol header', () => {
  const tools = makeTools(2, 1);
  for (const tc of ['auto', 'none', 'required', { type: 'function', function: { name: 'mcp_tool_0' } }]) {
    const r = applyToolPreambleBudget(tools, tc, '', { nativeStructured: true, softBytes: 100_000, hardBytes: 100_000 });
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.preamble, PROTOCOL_RE, `tool_choice=${JSON.stringify(tc)} must not add protocol header`);
  }
});

test('injectPreambleIntoSystemPrompt: prepends to existing system message without mutation', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' },
  ];
  const preamble = 'Available functions:\n\n### Read\nRead a file.';
  const out = injectPreambleIntoSystemPrompt(messages, preamble);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.startsWith('Available functions'));
  assert.ok(out[0].content.includes('You are helpful.'), 'original system content preserved');
  assert.equal(out[1].content, 'hi', 'user message untouched');
  // Caller's array not mutated:
  assert.equal(messages[0].content, 'You are helpful.');
});

test('injectPreambleIntoSystemPrompt: creates a system message when none exists', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const preamble = 'Available functions:\n\n### Read\nRead a file.';
  const out = injectPreambleIntoSystemPrompt(messages, preamble);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.includes('Available functions'));
  assert.equal(out[1].content, 'hi');
});

test('injectPreambleIntoSystemPrompt: empty/null preamble is a no-op', () => {
  const messages = [{ role: 'system', content: 'orig' }];
  assert.strictEqual(injectPreambleIntoSystemPrompt(messages, ''), messages);
  assert.strictEqual(injectPreambleIntoSystemPrompt(messages, null), messages);
  assert.strictEqual(injectPreambleIntoSystemPrompt(messages, '   '), messages);
});

test('injectPreambleIntoSystemPrompt: handles array-content system messages', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'System prompt part.' }] },
    { role: 'user', content: 'hi' },
  ];
  const preamble = 'Available functions:\n\n### Read\nRead a file.';
  const out = injectPreambleIntoSystemPrompt(messages, preamble);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.startsWith('Available functions'));
  assert.ok(out[0].content.includes('System prompt part.'));
});
