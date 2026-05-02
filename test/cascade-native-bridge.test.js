// v2.0.65 (#115) — Cascade native tool bridge.
//
// Validates that:
//   1. canMapAllTools correctly admits supported tools and rejects mixed/
//      unknown sets so emulation fallback fires.
//   2. Forward + reverse argument translators round-trip per known tool.
//   3. shouldUseNativeBridge auto-on heuristic fires for GPT/responses,
//      stays off for Claude/Gemini and for unmapped tools.
//   4. buildAdditionalStepsFromHistory produces decodable trajectory step
//      protos when prior assistant tool_calls + tool results are present.
//   5. windsurf.parseTrajectorySteps surfaces native cascade step kinds
//      (view_file=14, run_command=28, grep_search_v2=105, find=34,
//      list_directory=15, write_to_file=23) as toolCalls with
//      cascade_native:true and the right name + args.
//   6. buildSendCascadeMessageRequest writes additional_steps to field 9
//      (repeated CortexTrajectoryStep).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_MAP, CASCADE_STEP,
  canMapAllTools, shouldUseNativeBridge,
  buildAdditionalStep, buildAdditionalStepsFromHistory, buildReverseLookup,
} from '../src/cascade-native-bridge.js';
import {
  parseTrajectorySteps,
  buildSendCascadeMessageRequest,
} from '../src/windsurf.js';
import {
  parseFields, getField, getAllFields, writeMessageField, writeVarintField, writeStringField,
} from '../src/proto.js';

const fnTool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });

describe('canMapAllTools', () => {
  it('admits a homogeneous mapped set', () => {
    assert.equal(canMapAllTools([fnTool('Read'), fnTool('Bash'), fnTool('Glob')]), true);
  });

  it('rejects when ANY tool is unmapped', () => {
    assert.equal(canMapAllTools([fnTool('Read'), fnTool('get_weather')]), false);
  });

  it('rejects empty / non-array input', () => {
    assert.equal(canMapAllTools([]), false);
    assert.equal(canMapAllTools(null), false);
    assert.equal(canMapAllTools(undefined), false);
  });

  it('admits Codex-style cascade-native names', () => {
    assert.equal(canMapAllTools([fnTool('view_file'), fnTool('run_command'), fnTool('find')]), true);
  });

  it('admits mixed Claude Code + Codex names', () => {
    assert.equal(canMapAllTools([fnTool('Read'), fnTool('run_command'), fnTool('Grep')]), true);
  });
});

describe('shouldUseNativeBridge — auto-on heuristic', () => {
  const tools = [fnTool('Read'), fnTool('Bash')];

  it('GPT family on /v1/responses route → on', () => {
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses' }),
      true,
    );
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'o4-mini', provider: 'openai', route: 'responses' }),
      true,
    );
  });

  it('GPT family on /v1/chat/completions → off (no regression for non-Codex)', () => {
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'chat' }),
      false,
    );
  });

  it('Anthropic/Gemini on responses route → off (emulation already works)', () => {
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'claude-sonnet-4-6', provider: 'anthropic', route: 'responses' }),
      false,
    );
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'gemini-2.5-flash', provider: 'google', route: 'responses' }),
      false,
    );
  });

  it('any model with unmapped tools → off (canMapAllTools gates first)', () => {
    assert.equal(
      shouldUseNativeBridge([fnTool('Read'), fnTool('get_weather')], {
        modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses',
      }),
      false,
    );
  });

  it('explicit env override forces on for any mapped tool set', () => {
    const orig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    try {
      assert.equal(
        shouldUseNativeBridge(tools, { modelKey: 'claude-sonnet-4-6', provider: 'anthropic', route: 'chat' }),
        true,
      );
    } finally {
      if (orig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = orig;
    }
  });

  it('OFF override beats auto-on', () => {
    const offOrig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF = '1';
    try {
      assert.equal(
        shouldUseNativeBridge(tools, { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses' }),
        false,
      );
    } finally {
      if (offOrig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF = offOrig;
    }
  });
});

describe('TOOL_MAP — forward / reverse round-trip per kind', () => {
  it('Read ↔ view_file preserves file_path / offset / limit', () => {
    const original = { file_path: '/abs/path/foo.ts', offset: 10, limit: 200 };
    const cascade = TOOL_MAP.Read.forward(original);
    assert.equal(cascade.absolute_path_uri, 'file:///abs/path/foo.ts');
    assert.equal(cascade.offset, 10);
    assert.equal(cascade.limit, 200);
    const back = TOOL_MAP.Read.reverse(cascade);
    assert.deepEqual(back, original);
  });

  it('Bash ↔ run_command preserves command (and cwd if present)', () => {
    const original = { command: 'npm test --silent' };
    const cascade = TOOL_MAP.Bash.forward(original);
    assert.equal(cascade.command_line, 'npm test --silent');
    const back = TOOL_MAP.Bash.reverse(cascade);
    assert.equal(back.command, 'npm test --silent');
    // cwd round-trip
    const withCwd = TOOL_MAP.Bash.forward({ command: 'ls', cwd: '/tmp' });
    assert.equal(TOOL_MAP.Bash.reverse(withCwd).cwd, '/tmp');
  });

  it('Grep ↔ grep_search_v2 preserves pattern + flags', () => {
    const original = { pattern: 'foo', '-i': true, head_limit: 50, glob: '*.js' };
    const cascade = TOOL_MAP.Grep.forward(original);
    assert.equal(cascade.pattern, 'foo');
    assert.equal(cascade.case_insensitive, true);
    assert.equal(cascade.head_limit, 50);
    assert.equal(cascade.glob, '*.js');
    const back = TOOL_MAP.Grep.reverse(cascade);
    assert.equal(back.pattern, 'foo');
    assert.equal(back['-i'], true);
    assert.equal(back.head_limit, 50);
    assert.equal(back.glob, '*.js');
  });

  it('Glob ↔ find preserves pattern + path', () => {
    const cascade = TOOL_MAP.Glob.forward({ pattern: '**/*.ts', path: 'src' });
    assert.equal(cascade.pattern, '**/*.ts');
    assert.equal(cascade.search_directory, 'src');
    const back = TOOL_MAP.Glob.reverse(cascade);
    assert.equal(back.pattern, '**/*.ts');
    assert.equal(back.path, 'src');
  });

  it('Write ↔ write_to_file preserves file_path + content', () => {
    const cascade = TOOL_MAP.Write.forward({ file_path: '/tmp/x.txt', content: 'hello\n' });
    assert.equal(cascade.target_file_uri, 'file:///tmp/x.txt');
    assert.deepEqual(cascade.code_content, ['hello\n']);
    const back = TOOL_MAP.Write.reverse(cascade);
    assert.equal(back.file_path, '/tmp/x.txt');
    assert.equal(back.content, 'hello\n');
  });
});

describe('buildReverseLookup', () => {
  it('inverts caller tools by cascade kind', () => {
    const lookup = buildReverseLookup([fnTool('Read'), fnTool('Bash'), fnTool('Grep')]);
    assert.deepEqual(lookup.get('view_file'), ['Read']);
    assert.deepEqual(lookup.get('run_command'), ['Bash']);
    assert.deepEqual(lookup.get('grep_search_v2'), ['Grep']);
  });

  it('returns empty map for empty input', () => {
    const lookup = buildReverseLookup([]);
    assert.equal(lookup.size, 0);
  });

  it('handles caller declaring multiple tools that map to same kind', () => {
    const lookup = buildReverseLookup([fnTool('Read'), fnTool('view_file'), fnTool('read_file')]);
    const list = lookup.get('view_file');
    assert.ok(list.includes('Read'));
    assert.ok(list.includes('view_file'));
    assert.ok(list.includes('read_file'));
  });
});

describe('buildAdditionalStep / buildAdditionalStepsFromHistory', () => {
  it('view_file step encodes envelope with type=14 + content overlay', () => {
    const buf = buildAdditionalStep('view_file', {
      absolute_path_uri: 'file:///foo.ts',
      content: 'console.log("hi")',
    });
    assert.ok(Buffer.isBuffer(buf));
    const fields = parseFields(buf);
    const typeField = getField(fields, 1, 0);
    assert.equal(typeField.value, 14);
    const oneof = getField(fields, 14, 2);
    assert.ok(oneof, 'view_file body should be on field 14');
    const body = parseFields(oneof.value);
    assert.equal(getField(body, 1, 2).value.toString('utf8'), 'file:///foo.ts');
    assert.equal(getField(body, 4, 2).value.toString('utf8'), 'console.log("hi")');
  });

  it('run_command step puts command_line on field 23 + combined_output on 21', () => {
    const buf = buildAdditionalStep('run_command', {
      command_line: 'echo hi',
      full_output: 'hi\n',
      exit_code: 0,
    });
    const fields = parseFields(buf);
    assert.equal(getField(fields, 1, 0).value, 28);
    const body = parseFields(getField(fields, 28, 2).value);
    assert.equal(getField(body, 23, 2).value.toString('utf8'), 'echo hi');
    const combined = parseFields(getField(body, 21, 2).value);
    assert.equal(getField(combined, 1, 2).value.toString('utf8'), 'hi\n');
  });

  it('full assistant→tool history → trajectory step buffers', () => {
    const messages = [
      { role: 'user', content: 'find me a file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: JSON.stringify({ file_path: '/etc/hosts' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '127.0.0.1 localhost\n' },
    ];
    const steps = buildAdditionalStepsFromHistory(messages);
    assert.equal(steps.length, 1);
    const fields = parseFields(steps[0]);
    assert.equal(getField(fields, 1, 0).value, 14); // CortexStepType view_file = 14
    const body = parseFields(getField(fields, 14, 2).value);
    assert.equal(getField(body, 4, 2).value.toString('utf8'), '127.0.0.1 localhost\n');
  });

  it('skips unmapped tool_calls (fall back to emulation path)', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_x',
          function: { name: 'get_weather', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_x', content: 'sunny' },
    ];
    const steps = buildAdditionalStepsFromHistory(messages);
    assert.equal(steps.length, 0);
  });
});

describe('parseTrajectorySteps — native step recognition', () => {
  // Helpers to build a CortexTrajectoryStep envelope by hand. We avoid
  // calling buildAdditionalStep here so tests double-cover encoder / decoder
  // independently.
  const wrapStep = (typeEnum, oneofField, bodyBuf) =>
    Buffer.concat([
      writeVarintField(1, typeEnum),
      writeVarintField(4, 3), // status DONE
      writeMessageField(oneofField, bodyBuf),
    ]);

  // GetCascadeTrajectoryStepsResponse is `repeated CortexTrajectoryStep steps = 1`
  const wrapResponse = (...stepBufs) =>
    Buffer.concat(stepBufs.map(b => writeMessageField(1, b)));

  it('view_file step → toolCall with name=view_file + arguments + result', () => {
    const body = Buffer.concat([
      writeStringField(1, 'file:///abs/foo.ts'),
      writeVarintField(11, 0),
      writeVarintField(12, 100),
      writeStringField(4, 'console.log("hi")\n'),
    ]);
    const resp = wrapResponse(wrapStep(14, 14, body));
    const steps = parseTrajectorySteps(resp);
    assert.equal(steps.length, 1);
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'view_file');
    const args = JSON.parse(calls[0].argumentsJson);
    assert.equal(args.absolute_path_uri, 'file:///abs/foo.ts');
    assert.equal(args.limit, 100);
    assert.equal(calls[0].result, 'console.log("hi")\n');
  });

  it('run_command step → toolCall with combined_output observation', () => {
    const combinedOutput = writeStringField(1, 'hi\n');
    const body = Buffer.concat([
      writeStringField(23, 'echo hi'),
      writeMessageField(21, combinedOutput),
    ]);
    const resp = wrapResponse(wrapStep(28, 28, body));
    const steps = parseTrajectorySteps(resp);
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'run_command');
    assert.equal(calls[0].result, 'hi\n');
    const args = JSON.parse(calls[0].argumentsJson);
    assert.equal(args.command_line, 'echo hi');
  });

  it('grep_search_v2 step (field 105) → toolCall name grep_search_v2', () => {
    const body = Buffer.concat([
      writeStringField(2, 'todo'),
      writeStringField(3, 'src'),
      writeStringField(15, 'src/foo.ts:10:// todo\n'),
    ]);
    const resp = wrapResponse(wrapStep(105, 105, body));
    const steps = parseTrajectorySteps(resp);
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'grep_search_v2');
    assert.equal(calls[0].result, 'src/foo.ts:10:// todo\n');
  });

  it('list_directory step → children joined as result', () => {
    const body = Buffer.concat([
      writeStringField(1, 'file:///src'),
      writeStringField(2, 'foo.ts'),
      writeStringField(2, 'bar.ts'),
    ]);
    const resp = wrapResponse(wrapStep(15, 15, body));
    const steps = parseTrajectorySteps(resp);
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'list_directory');
    assert.equal(calls[0].result, 'foo.ts\nbar.ts');
  });

  it('multiple native steps in same trajectory all surface', () => {
    const viewBody = Buffer.concat([writeStringField(1, 'file:///a.ts'), writeStringField(4, 'A')]);
    const cmdBody = Buffer.concat([writeStringField(23, 'ls'), writeMessageField(21, writeStringField(1, 'a.ts\n'))]);
    const resp = wrapResponse(wrapStep(14, 14, viewBody), wrapStep(28, 28, cmdBody));
    const steps = parseTrajectorySteps(resp);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].toolCalls.filter(tc => tc.cascade_native).length, 1);
    assert.equal(steps[1].toolCalls.filter(tc => tc.cascade_native).length, 1);
  });
});

describe('buildSendCascadeMessageRequest — additional_steps on field 9', () => {
  it('includes each step as repeated field 9', () => {
    const stepA = buildAdditionalStep('view_file', { absolute_path_uri: 'file:///a', content: 'A' });
    const stepB = buildAdditionalStep('run_command', { command_line: 'ls', full_output: 'a\n' });
    const proto = buildSendCascadeMessageRequest(
      'k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess',
      { additionalSteps: [stepA, stepB] },
    );
    const fields = parseFields(proto);
    const additional = getAllFields(fields, 9).filter(f => f.wireType === 2);
    assert.equal(additional.length, 2, 'two repeated additional_steps expected on field 9');
  });

  it('omits field 9 when no additionalSteps provided', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {});
    const fields = parseFields(proto);
    assert.equal(getAllFields(fields, 9).length, 0);
  });

  it('nativeMode=true switches planner_mode to DEFAULT (1) and adds tool_config', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      nativeMode: true,
      nativeAllowlist: ['view_file', 'run_command'],
    });
    const top = parseFields(proto);
    const cfgField = getField(top, 5, 2);
    assert.ok(cfgField, 'cascade_config required on field 5');
    const cfg = parseFields(cfgField.value);
    const planner = parseFields(getField(cfg, 1, 2).value);
    // CascadePlannerConfig.tool_config = field 13 (CascadeToolConfig)
    const toolCfg = getField(planner, 13, 2);
    assert.ok(toolCfg, 'CascadePlannerConfig.tool_config (field 13) should be set in nativeMode');
    const tc = parseFields(toolCfg.value);
    const allow = getAllFields(tc, 32).map(f => f.value.toString('utf8'));
    assert.ok(allow.includes('view_file'));
    assert.ok(allow.includes('run_command'));
    // conversational planner sub-config (field 2) → planner_mode (field 4) = DEFAULT (1)
    const conv = parseFields(getField(planner, 2, 2).value);
    const mode = getField(conv, 4, 0);
    assert.equal(mode.value, 1, 'planner_mode in nativeMode should be DEFAULT (1)');
  });

  it('nativeMode=false (default) keeps planner_mode = NO_TOOL (3) and skips tool_config', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {});
    const top = parseFields(proto);
    const cfg = parseFields(getField(top, 5, 2).value);
    const planner = parseFields(getField(cfg, 1, 2).value);
    assert.equal(getField(planner, 13, 2), null, 'tool_config should NOT be set when nativeMode is off');
    const conv = parseFields(getField(planner, 2, 2).value);
    assert.equal(getField(conv, 4, 0).value, 3);
  });
});

describe('CASCADE_STEP type constants — sanity', () => {
  it('matches proto field numbers used in oneof', () => {
    assert.equal(CASCADE_STEP.view_file.typeEnum, 14);
    assert.equal(CASCADE_STEP.run_command.typeEnum, 28);
    assert.equal(CASCADE_STEP.grep_search_v2.typeEnum, 105);
    assert.equal(CASCADE_STEP.find.typeEnum, 34);
    assert.equal(CASCADE_STEP.list_directory.typeEnum, 15);
    assert.equal(CASCADE_STEP.write_to_file.typeEnum, 23);
  });
});
