import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyToolPreambleBudget } from '../src/handlers/chat.js';
import { buildToolPreambleForProto } from '../src/handlers/tool-emulation.js';

describe('applyToolPreambleBudget', () => {
  const bigTools = Array.from({ length: 30 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: `Description for tool ${i} that goes on for a while to bulk up the schema.`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 15 }, (_, j) => [`param_${j}`, {
            type: 'string',
            description: `Parameter ${j} of tool ${i}, with verbose explanation that runs long.`,
            enum: ['option_a', 'option_b', 'option_c', 'option_d', 'option_e'],
          }]),
        ),
        required: Array.from({ length: 15 }, (_, j) => `param_${j}`),
      },
    },
  }));

  it('falls back to compact preamble before rejecting when full schema exceeds the hard cap', () => {
    const full = buildToolPreambleForProto(bigTools, 'auto');
    const result = applyToolPreambleBudget(full, bigTools, 'auto', '- Working directory: /repo', {
      softBytes: 24_000,
      hardBytes: 48_000,
    });

    assert.equal(result.decision, 'compact');
    assert.ok(result.fullBytes > result.hardBytes, `expected fullBytes > hardBytes, got ${result.fullBytes} <= ${result.hardBytes}`);
    assert.ok(result.compactBytes > 0 && result.compactBytes <= result.hardBytes, `expected compactBytes <= hardBytes, got ${result.compactBytes}`);
    assert.ok(result.toolPreamble.includes('Available functions:'));
    assert.ok(!result.toolPreamble.includes('param_0'), 'compact preamble must omit parameter schema details');
  });

  it('rejects only when neither full nor compact form fits within the hard cap', () => {
    const full = buildToolPreambleForProto(bigTools, 'auto');
    const result = applyToolPreambleBudget(full, bigTools, 'auto', '- Working directory: /repo', {
      softBytes: 1,
      hardBytes: 512,
    });

    assert.equal(result.decision, 'reject');
    assert.ok(result.fullBytes > result.hardBytes);
    assert.ok(result.compactBytes > result.hardBytes, `expected compact fallback to exceed hard cap, got ${result.compactBytes}`);
  });
});
