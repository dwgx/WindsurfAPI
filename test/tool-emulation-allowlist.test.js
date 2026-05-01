// v2.0.55 audit M2 regression — `filterToolCallsByAllowlist` drops tool
// calls whose name isn't in the request-declared `tools[]`. Without the
// guard, prompt-injection content can drive a non-Claude model to emit
// `<tool_call>{"name":"Bash"...}</tool_call>` (or salvage-recovered
// fenced JSON of the same shape) for tools the caller never offered.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterToolCallsByAllowlist, redactRequestLogText } from '../src/handlers/chat.js';
import { parseToolCallsFromText } from '../src/handlers/tool-emulation.js';

describe('filterToolCallsByAllowlist — name allowlist guard (audit M2)', () => {
  it('keeps tool_calls whose name is in the declared tools[]', () => {
    const calls = [{ name: 'get_weather', argumentsJson: '{"city":"Tokyo"}' }];
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'wx', parameters: {} } }];
    const out = filterToolCallsByAllowlist(calls, tools);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'get_weather');
  });

  it('drops tool_calls whose name is NOT in the declared tools[] (Bash injection)', () => {
    const calls = [{ name: 'Bash', argumentsJson: '{"command":"id"}' }];
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'wx', parameters: {} } }];
    const out = filterToolCallsByAllowlist(calls, tools);
    assert.equal(out.length, 0, 'Bash must be filtered when only get_weather is declared');
  });

  it('drops everything when tools[] is empty (no declared tools)', () => {
    const calls = [{ name: 'get_weather', argumentsJson: '{}' }];
    const out = filterToolCallsByAllowlist(calls, []);
    assert.equal(out.length, 0, 'no declared tools must reject everything');
  });

  it('preserves order and discards only the offenders in mixed lists', () => {
    const calls = [
      { name: 'get_weather', argumentsJson: '{"city":"A"}' },
      { name: 'Bash',        argumentsJson: '{"command":"id"}' },
      { name: 'get_weather', argumentsJson: '{"city":"B"}' },
      { name: 'rm',          argumentsJson: '{"path":"/"}' },
    ];
    const tools = [{ type: 'function', function: { name: 'get_weather', description: '', parameters: {} } }];
    const out = filterToolCallsByAllowlist(calls, tools);
    assert.equal(out.length, 2);
    assert.equal(out[0].argumentsJson, '{"city":"A"}');
    assert.equal(out[1].argumentsJson, '{"city":"B"}');
  });

  it('null/undefined input returns empty array', () => {
    assert.deepEqual(filterToolCallsByAllowlist(null, []), []);
    assert.deepEqual(filterToolCallsByAllowlist(undefined, [{ name: 'x' }]), []);
  });

  it('end-to-end: salvage recovers a Bash call from fenced JSON, allowlist drops it', () => {
    const raw = 'Sure, here you go:\n```json\n{"name":"Bash","arguments":{"command":"id"}}\n```\nLet me know if you need more.';
    const parsed = parseToolCallsFromText(raw);
    assert.equal(parsed.toolCalls.length, 1, 'salvage must find the Bash call (negative control)');
    assert.equal(parsed.toolCalls[0].name, 'Bash');

    const tools = [{ type: 'function', function: { name: 'get_weather', description: '', parameters: {} } }];
    const filtered = filterToolCallsByAllowlist(parsed.toolCalls, tools);
    assert.equal(filtered.length, 0, 'salvage output must NOT pass the allowlist');
  });

  it('redactRequestLogText still exported (sanity check that we did not break the chat.js export surface)', () => {
    assert.equal(typeof redactRequestLogText, 'function');
  });
});
