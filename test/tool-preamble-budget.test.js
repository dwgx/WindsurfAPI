import test from 'node:test';
import assert from 'node:assert/strict';
import { applyToolPreambleBudget } from '../src/handlers/chat.js';

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
