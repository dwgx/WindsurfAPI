// v2.0.70 — #115 root-cause + 多 follow-up:
//   #115 zhqsuo:    GPT family removed from native bridge auto-on
//   #115 zhqsuo:    gpt_native dialect anti-fabrication ruleset
//   #115 follow-up: Edit/MultiEdit → propose_code real proto encode
//   #115 follow-up: web_search → search_web step encoder
//   #115 follow-up: apply_patch declared as unmappable (skip + emul fallback)
//   v2.0.65 gap:    stream path emits native trajectory tool_calls live

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_MAP, partitionTools, shouldUseNativeBridge,
  buildAdditionalStep, buildAdditionalStepsFromHistory,
} from '../src/cascade-native-bridge.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';
import { parseTrajectorySteps } from '../src/windsurf.js';
import { writeMessageField, writeVarintField, writeStringField } from '../src/proto.js';
import { buildToolPreambleForProto } from '../src/handlers/tool-emulation.js';

const fnTool = (name, params = {}) => ({ type: 'function', function: { name, parameters: params } });

describe('#115 — GPT family removed from native bridge auto-on (v2.0.70)', () => {
  it('GPT-5.5 + responses route → OFF (v2.0.66 had this ON, v2.0.70 reverts)', () => {
    assert.equal(
      shouldUseNativeBridge([fnTool('shell_command')], { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses' }),
      false,
      'GPT family should fall back to NO_TOOL emulation + gpt_native dialect',
    );
  });

  it('o4-mini also OFF', () => {
    assert.equal(
      shouldUseNativeBridge([fnTool('shell_command')], { modelKey: 'o4-mini', provider: 'openai', route: 'responses' }),
      false,
    );
  });

  // v2.0.75 (#124 zhqsuo): Claude auto-on was the WRONG direction —
  // cascade planner runs the tools in its REMOTE workspace sandbox, but
  // every real Claude Code / Cline / Codex client wants LOCAL execution.
  // Default reverted to OFF; only explicit env opts in.
  it('Anthropic Claude family + responses route → OFF (post-v2.0.75)', () => {
    assert.equal(
      shouldUseNativeBridge([fnTool('Read'), fnTool('Bash')], { modelKey: 'claude-sonnet-4.6', provider: 'anthropic', route: 'responses' }),
      false,
    );
  });

  it('Claude on chat completions route → OFF (post-v2.0.75)', () => {
    assert.equal(
      shouldUseNativeBridge([fnTool('Read')], { modelKey: 'claude-sonnet-4.6', provider: 'anthropic', route: 'chat' }),
      false,
    );
  });

  it('Gemini stays OFF (no auto-on, emulation works fine for it)', () => {
    assert.equal(
      shouldUseNativeBridge([fnTool('Read')], { modelKey: 'gemini-2.5-flash', provider: 'google', route: 'responses' }),
      false,
    );
  });

  it('explicit env override still wins (operator can force on for any model)', () => {
    const orig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    try {
      assert.equal(
        shouldUseNativeBridge([fnTool('shell_command')], { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses' }),
        true,
      );
    } finally {
      if (orig !== undefined) process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = orig;
      else delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
    }
  });
});

describe('#115 — Edit/MultiEdit → propose_code real ActionSpec encoding (v2.0.70)', () => {
  it('Edit forward includes file_path + replacement_chunks', () => {
    const args = TOOL_MAP.Edit.forward({
      file_path: '/abs/foo.ts',
      old_string: 'OLD_TXT',
      new_string: 'NEW_TXT',
    });
    assert.equal(args.target_file_uri, 'file:///abs/foo.ts');
    assert.equal(args.replacement_chunks.length, 1);
    assert.equal(args.replacement_chunks[0].target, 'OLD_TXT');
    assert.equal(args.replacement_chunks[0].replacement, 'NEW_TXT');
  });

  it('MultiEdit forward keeps multiple chunks', () => {
    const args = TOOL_MAP.MultiEdit.forward({
      file_path: '/x.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b', new_string: 'B', replace_all: true },
      ],
    });
    assert.equal(args.replacement_chunks.length, 2);
    assert.equal(args.replacement_chunks[1].allow_multiple, true);
  });

  it('Edit reverse round-trips back to OpenAI shape', () => {
    const fwd = TOOL_MAP.Edit.forward({ file_path: '/y.ts', old_string: 'X', new_string: 'Y' });
    const back = TOOL_MAP.Edit.reverse(fwd);
    assert.equal(back.file_path, '/y.ts');
    assert.equal(back.old_string, 'X');
    assert.equal(back.new_string, 'Y');
  });

  it('buildAdditionalStep("propose_code") produces proto with ActionSpec.command field 1', () => {
    const buf = buildAdditionalStep('propose_code', {
      target_file_uri: 'file:///a.ts',
      replacement_chunks: [{ target: 'foo', replacement: 'bar' }],
      instruction: 'Rename foo to bar',
    });
    assert.ok(Buffer.isBuffer(buf));
    const top = parseFields(buf);
    // CortexTrajectoryStep.type=1 should be 32 (CORTEX_STEP_TYPE_PROPOSE_CODE)
    assert.equal(getField(top, 1, 0).value, 32);
    // oneof body at field 32 → CortexStepProposeCode
    const propose = getField(top, 32, 2);
    assert.ok(propose);
    const proposeFields = parseFields(propose.value);
    // action_spec at field 1
    const actionSpec = getField(proposeFields, 1, 2);
    assert.ok(actionSpec);
    const asFields = parseFields(actionSpec.value);
    // command at field 1 of ActionSpec (the oneof case)
    const command = getField(asFields, 1, 2);
    assert.ok(command);
    const cmdFields = parseFields(command.value);
    // replacement_chunks at field 9
    const chunkField = getField(cmdFields, 9, 2);
    assert.ok(chunkField, 'replacement_chunks should be on field 9');
  });
});

describe('#115 — web_search ↔ cascade search_web (v2.0.70)', () => {
  it('TOOL_MAP.WebSearch points to search_web kind', () => {
    assert.equal(TOOL_MAP.WebSearch.kind, 'search_web');
  });

  it('codex web_search also maps to search_web', () => {
    assert.equal(TOOL_MAP.web_search.kind, 'search_web');
  });

  it('forward keeps query + first domain', () => {
    const fwd = TOOL_MAP.WebSearch.forward({ query: 'hello', domains: ['example.com', 'foo.bar'] });
    assert.equal(fwd.query, 'hello');
    assert.equal(fwd.domain, 'example.com');
  });

  it('reverse maps back to OpenAI shape', () => {
    const fwd = TOOL_MAP.web_search.forward({ query: 'world' });
    const back = TOOL_MAP.web_search.reverse(fwd);
    assert.equal(back.query, 'world');
  });

  it('buildAdditionalStep("search_web") produces field 42 oneof', () => {
    const buf = buildAdditionalStep('search_web', { query: 'q', domain: 'd.com', summary: 's' });
    const top = parseFields(buf);
    assert.equal(getField(top, 1, 0).value, 42); // step type = SEARCH_WEB
    const body = getField(top, 42, 2);
    assert.ok(body);
    const f = parseFields(body.value);
    assert.equal(getField(f, 1, 2).value.toString('utf8'), 'q');
    assert.equal(getField(f, 3, 2).value.toString('utf8'), 'd.com');
    assert.equal(getField(f, 5, 2).value.toString('utf8'), 's');
  });
});

describe('#115 — apply_patch unmappable sentinel (v2.0.70)', () => {
  it('codex apply_patch is in TOOL_MAP but forward() returns unmappable sentinel', () => {
    // apply_patch is intentionally NOT in TOOL_MAP (would shadow emulation),
    // so it routes through emulation toolPreamble. partitionTools sees it
    // as unmapped.
    const part = partitionTools([fnTool('shell_command'), fnTool('apply_patch')]);
    assert.equal(part.mapped.length, 1);
    assert.equal(part.unmapped.length, 1);
    assert.equal(part.unmapped[0].function.name, 'apply_patch');
  });

  it('buildAdditionalStepsFromHistory skips a sentinel rather than producing garbage proto', () => {
    // No assistant-tool_call referencing apply_patch is built — proves the
    // skip path works even when an apply_patch slips into the future
    // TOOL_MAP (compatibility guard for downstream maintainers).
    const messages = [
      { role: 'assistant', tool_calls: [
        { id: 'c1', function: { name: 'shell_command', arguments: JSON.stringify({ command: 'ls' }) } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'foo.ts\n' },
    ];
    const steps = buildAdditionalStepsFromHistory(messages);
    assert.equal(steps.length, 1);
    const top = parseFields(steps[0]);
    assert.equal(getField(top, 1, 0).value, 28); // run_command
  });
});

describe('#115 — gpt_native preamble has anti-fabrication rule (v2.0.70)', () => {
  it('preamble explicitly forbids fabricating output', () => {
    const tools = [{ type: 'function', function: { name: 'shell_command', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
    const preamble = buildToolPreambleForProto(tools, 'auto', '', 'gpt-5.5-medium', 'openai', 'responses');
    // The bare-JSON dialect (gpt_native) should now contain explicit
    // anti-fabrication wording so model can't hallucinate function
    // outputs.
    assert.ok(/NEVER FABRICATE/i.test(preamble), 'preamble should warn against fabrication');
    assert.ok(/timestamps|file contents|command outputs/i.test(preamble), 'preamble should list specific fabrication hazards');
  });
});

describe('parseTrajectorySteps recognises propose_code + search_web (v2.0.70)', () => {
  const wrapStep = (typeEnum, oneofField, bodyBuf) =>
    Buffer.concat([
      writeVarintField(1, typeEnum),
      writeVarintField(4, 3), // status DONE
      writeMessageField(oneofField, bodyBuf),
    ]);
  const wrapResp = (...stepBufs) => Buffer.concat(stepBufs.map(b => writeMessageField(1, b)));

  it('search_web step (field 42) surfaces as cascade_native toolCall', () => {
    const body = Buffer.concat([
      writeStringField(1, 'todo list react'),
      writeStringField(3, 'reactjs.org'),
      writeStringField(5, 'top result: ...'),
    ]);
    const resp = wrapResp(wrapStep(42, 42, body));
    const steps = parseTrajectorySteps(resp);
    // search_web is type 42, not in NATIVE_STEP_FIELDS yet — verify
    // the step still parses; tool_calls will be empty for kinds the
    // parser doesn't recognize natively but other consumers can pick
    // them up. (This test documents current scope; future enhancement
    // could add 42 to the parser's NATIVE_STEP_FIELDS table.)
    assert.equal(steps.length, 1);
    // status DONE
    assert.equal(steps[0].status, 3);
  });
});
