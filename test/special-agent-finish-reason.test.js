import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapFinishReason } from '../src/special-agent.js';

// cline-01 regression: the ACP/print runners are text-only, so a tool-ish
// upstream stop_reason must NOT produce finish_reason:'tool_calls' (which makes
// Cline's @ai-sdk client retry to death on the missing tool_calls array —
// cline#9622). It degrades to 'stop' unless tool_calls were actually emitted.
describe('mapFinishReason (cline-01)', () => {
  it('maps length/truncation reasons to "length"', () => {
    assert.equal(mapFinishReason('max_tokens'), 'length');
    assert.equal(mapFinishReason('length'), 'length');
    assert.equal(mapFinishReason('truncated'), 'length');
  });

  it('maps content/safety reasons to "content_filter"', () => {
    assert.equal(mapFinishReason('content_filter'), 'content_filter');
    assert.equal(mapFinishReason('safety'), 'content_filter');
    assert.equal(mapFinishReason('refusal'), 'content_filter');
  });

  it('maps clean completion reasons to "stop"', () => {
    assert.equal(mapFinishReason('end_turn'), 'stop');
    assert.equal(mapFinishReason('stop'), 'stop');
    assert.equal(mapFinishReason('eos'), 'stop');
    assert.equal(mapFinishReason(''), 'stop');
    assert.equal(mapFinishReason(null), 'stop');
    assert.equal(mapFinishReason('some_unknown_reason'), 'stop');
  });

  it('does NOT emit "tool_calls" for a tool-ish reason when no tool_calls were sent', () => {
    // The #9622 trap: a text-only response with a tool-ish stop reason.
    assert.equal(mapFinishReason('tool_use'), 'stop');
    assert.equal(mapFinishReason('tool_calls'), 'stop');
    assert.equal(mapFinishReason('end_tool'), 'stop');
  });

  it('emits "tool_calls" for a tool-ish reason ONLY when tool_calls were actually emitted', () => {
    assert.equal(mapFinishReason('tool_use', true), 'tool_calls');
    assert.equal(mapFinishReason('tool_calls', true), 'tool_calls');
    // a non-tool reason with tool_calls present still maps by its own rule
    assert.equal(mapFinishReason('end_turn', true), 'stop');
    assert.equal(mapFinishReason('max_tokens', true), 'length');
  });
});
