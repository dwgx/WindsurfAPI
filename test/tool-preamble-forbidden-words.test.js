import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolPreamble,
  buildToolPreambleForProto,
  buildCompactToolPreambleForProto,
  buildSchemaCompactToolPreambleForProto,
  buildSkinnyToolPreambleForProto,
} from '../src/handlers/tool-emulation.js';

describe('tool preamble forbidden wording', () => {
  it('does not emit injection-guard trigger phrases from any preamble path', () => {
    const tools = [{ type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } } }];
    const outputs = [
      buildToolPreamble(tools),
      buildToolPreambleForProto(tools, 'auto', '- Working directory: /repo'),
      buildToolPreambleForProto(tools, 'required', ''),
      buildCompactToolPreambleForProto(tools, 'auto', '- Working directory: /repo'),
      buildCompactToolPreambleForProto(tools, 'required', ''),
      buildSchemaCompactToolPreambleForProto(tools, 'auto', '- Working directory: /repo'),
      buildSchemaCompactToolPreambleForProto(tools, 'required', ''),
      buildSkinnyToolPreambleForProto(tools, 'auto', '- Working directory: /repo'),
      buildSkinnyToolPreambleForProto(tools, 'required', ''),
    ];
    for (const out of outputs) {
      assert.doesNotMatch(out, /\bIGNORE\b/i);
      assert.doesNotMatch(out, /for this request only/i);
      assert.doesNotMatch(out, /---\[Tool-calling context\]/i);
      assert.doesNotMatch(out, /Disregard the above/i);
    }
  });
});
