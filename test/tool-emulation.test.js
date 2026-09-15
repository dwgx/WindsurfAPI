import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repairToolCallArguments } from '../src/handlers/chat.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import {
  ToolCallStreamParser,
  parseToolCallsFromText,
  stripToolMarkupFromText,
  buildToolPreamble,
  buildToolPreambleForProto,
  buildCompactToolPreambleForProto,
  buildSchemaCompactToolPreambleForProto,
  buildSkinnyToolPreambleForProto,
  normalizeMessagesForCascade,
  pickToolDialect,
  interleaveParallelToolMessages,
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

  it('can leave bare JSON untouched when stripping non-emulated Cascade markup', () => {
    const json = '{"name":"not_a_tool","arguments":{"message":"plain response"}}';
    assert.equal(stripToolMarkupFromText(json), json);
    assert.equal(
      stripToolMarkupFromText(`A<tool_call>{"name":"Read","arguments":{"path":"x"}}</tool_call>B`),
      'AB',
    );
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

  it('handles GLM47 call split across chunks', () => {
    const parser = new ToolCallStreamParser({ modelKey: 'glm-5.1' });
    const r1 = parser.feed('<tool_call>Read<arg_key>file_path</arg_key>');
    const r2 = parser.feed('<arg_value>README.md</arg_value></tool_call>');
    const r3 = parser.flush();
    const allCalls = [...r1.toolCalls, ...r2.toolCalls, ...r3.toolCalls];
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'Read');
    assert.equal(JSON.parse(allCalls[0].argumentsJson).file_path, 'README.md');
    assert.equal(r1.text + r2.text + r3.text, '');
  });

  it('parses GLM47 zero-arg <tool_call> block', () => {
    const parser = new ToolCallStreamParser({ modelKey: 'glm-5.1' });
    const r = parser.feed('<tool_call>pwd</tool_call>');
    const flush = parser.flush();
    const allCalls = [...r.toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'pwd');
    assert.equal(allCalls[0].argumentsJson, '{}');
    assert.equal((r.text + flush.text).trim(), '');
  });

  it('parses GLM47 single-arg block with arg_key / arg_value format', () => {
    const parser = new ToolCallStreamParser({ modelKey: 'glm-5.1' });
    const input = '<tool_call>Read<arg_key>file_path</arg_key><arg_value>README.md</arg_value></tool_call>';
    const r = parser.feed(input);
    const flush = parser.flush();
    const allCalls = [...r.toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'Read');
    assert.equal(JSON.parse(allCalls[0].argumentsJson).file_path, 'README.md');
  });

  it('parses GLM47 multi-arg block and number values', () => {
    const parser = new ToolCallStreamParser({ modelKey: 'glm-5.1' });
    const input = '<tool_call>Bash<arg_key>command</arg_key><arg_value>ls -la</arg_value><arg_key>timeout</arg_key><arg_value>5000</arg_value></tool_call>';
    const { toolCalls } = parser.feed(input);
    const flush = parser.flush();
    const allCalls = [...toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 1);
    const parsedArgs = JSON.parse(allCalls[0].argumentsJson);
    assert.equal(parsedArgs.command, 'ls -la');
    assert.equal(parsedArgs.timeout, 5000);
    assert.equal(typeof parsedArgs.timeout, 'number');
  });

  it('parses multiple GLM47 tool calls back-to-back', () => {
    const parser = new ToolCallStreamParser({ modelKey: 'glm-5.1' });
    const input = '<tool_call>Read<arg_key>file_path</arg_key><arg_value>README.md</arg_value></tool_call><tool_call>Bash<arg_key>command</arg_key><arg_value>ls</arg_value></tool_call>';
    const { toolCalls } = parser.feed(input);
    const flush = parser.flush();
    const allCalls = [...toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 2);
    assert.equal(allCalls[0].name, 'Read');
    assert.equal(allCalls[1].name, 'Bash');
  });

  it('parses Kimi K2 section-token tool_call format', () => {
    const parser = new ToolCallStreamParser({ modelKey: 'kimi-k2-thinking' });
    const input = '<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path":"README.md"}<|tool_call_end|><|tool_calls_section_end|>';
    const { toolCalls, text } = parser.feed(input);
    const flush = parser.flush();
    const allCalls = [...toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'Read');
    assert.equal(JSON.parse(allCalls[0].argumentsJson).file_path, 'README.md');
    assert.equal(text + flush.text, '');
  });

  it('streams plain prose through GLM47 dialect when no tool tag arrives', () => {
    // Regression: previously the GLM/Kimi paths buffered everything until
    // flush(), so a non-tool prose response from GLM looked silent in SSE
    // until end-of-stream. Now we emit text up to a hold-back tail so
    // partial open tags still get caught on the next chunk.
    const parser = new ToolCallStreamParser({ modelKey: 'glm-5.1' });
    const r1 = parser.feed('Hello world ');
    assert.equal(r1.text, 'Hello world ');
    const r2 = parser.feed('and goodbye.');
    assert.equal(r2.text, 'and goodbye.');
    const f = parser.flush();
    assert.equal(f.toolCalls.length, 0);
  });

  it('emits prefix text then parses GLM47 tool call from the same stream', () => {
    const parser = new ToolCallStreamParser({ modelKey: 'glm-5.1' });
    const r1 = parser.feed('Sure, reading the file. ');
    assert.equal(r1.text, 'Sure, reading the file. ');
    const r2 = parser.feed('<tool_call>Read<arg_key>file_path</arg_key><arg_value>x.md</arg_value></tool_call>');
    // No more text should be emitted from feed (call is buffered until flush)
    assert.equal(r2.text, '');
    const f = parser.flush();
    assert.equal(f.toolCalls.length, 1);
    assert.equal(f.toolCalls[0].name, 'Read');
  });

  it('holds back partial GLM47 open-tag prefix at chunk boundary', () => {
    const parser = new ToolCallStreamParser({ modelKey: 'glm-5.1' });
    const r1 = parser.feed('Reading: <tool_ca');
    // Should emit "Reading: " but hold "<tool_ca" in case the next chunk completes
    assert.equal(r1.text, 'Reading: ');
    const r2 = parser.feed('ll>pwd</tool_call>');
    assert.equal(r2.text, '');
    const f = parser.flush();
    assert.equal(f.toolCalls.length, 1);
    assert.equal(f.toolCalls[0].name, 'pwd');
  });

  it('picks GLM / Kimi / OpenAI dialects by model or provider', () => {
    assert.equal(pickToolDialect('glm-5.1'), 'glm47');
    assert.equal(pickToolDialect('kimi-k2-thinking'), 'kimi_k2');
    assert.equal(pickToolDialect('gpt-4o'), 'openai_json_xml');
    assert.equal(pickToolDialect(null, 'zhipu'), 'glm47');
    // Bare provider="moonshot" with no specific model defaults to the
    // openai dialect now (#102) — only the verified-working SKUs get
    // the vLLM dialect.
    assert.equal(pickToolDialect(null, 'moonshot'), 'openai_json_xml');
  });

  it('routes only original kimi-k2 / kimi-k2-thinking to vLLM dialect (#102 cookire)', () => {
    // The Kimi K2 vLLM tool-call format only works on the SKUs we
    // explicitly tested. Newer Moonshot models (kimi-k2.5, kimi-k2-6,
    // ...) are served by a different runtime that rejects vLLM markup
    // with cascade error "The model produced an invalid tool call".
    assert.equal(pickToolDialect('kimi-k2'), 'kimi_k2');
    assert.equal(pickToolDialect('kimi-k2-thinking'), 'kimi_k2');
    // Newer SKUs default to openai_json_xml regardless of provider
    assert.equal(pickToolDialect('kimi-k2.5'), 'openai_json_xml');
    assert.equal(pickToolDialect('kimi-k2-6'), 'openai_json_xml');
    assert.equal(pickToolDialect('kimi-k2.5', 'moonshot'), 'openai_json_xml');
    assert.equal(pickToolDialect('kimi-k2-6', 'moonshot'), 'openai_json_xml');
  });

  it('routes glm-5.2 to gpt_native while older GLM stays on glm47 (#204)', () => {
    // glm-5.2 ignores the glm47 XML markup and answers in plain text; the
    // gpt_native bare-JSON function_call dialect is emitted and parsed
    // reliably. Older GLM SKUs keep the glm47 dialect.
    assert.equal(pickToolDialect('glm-5.2'), 'gpt_native');
    assert.equal(pickToolDialect('glm-5.2', 'zhipu'), 'gpt_native');
    assert.equal(pickToolDialect('glm-5-2-thinking'), 'gpt_native');
    // Future dotted SKUs (glm-5.2-fast / glm-5.2-thinking) must also stay on
    // gpt_native, not silently fall through to the wrong glm47 dialect.
    assert.equal(pickToolDialect('glm-5.2-fast'), 'gpt_native');
    assert.equal(pickToolDialect('glm-5.2-thinking'), 'gpt_native');
    assert.equal(pickToolDialect('glm-5'), 'glm47');
    assert.equal(pickToolDialect('glm-5.1'), 'glm47');
    // 5.2+ future SKUs (dashed or dotted) keep gpt_native
    assert.equal(pickToolDialect('glm-5.3', 'zhipu'), 'gpt_native');
    assert.equal(pickToolDialect('glm-5-9', 'zhipu'), 'gpt_native');
    assert.equal(pickToolDialect('glm-5.2-x1', 'zhipu'), 'gpt_native');
  });

  it('honors WINDSURFAPI_FORCE_TOOL_DIALECT override (#204)', () => {
    const prev = process.env.WINDSURFAPI_FORCE_TOOL_DIALECT;
    try {
      process.env.WINDSURFAPI_FORCE_TOOL_DIALECT = 'kimi_k2';
      assert.equal(pickToolDialect('glm-5.1', 'zhipu'), 'kimi_k2');
      assert.equal(pickToolDialect('gpt-4o', 'openai'), 'kimi_k2');
      // An unrecognized value is ignored and normal routing applies.
      process.env.WINDSURFAPI_FORCE_TOOL_DIALECT = 'bogus';
      assert.equal(pickToolDialect('glm-5.1'), 'glm47');
    } finally {
      if (prev === undefined) delete process.env.WINDSURFAPI_FORCE_TOOL_DIALECT;
      else process.env.WINDSURFAPI_FORCE_TOOL_DIALECT = prev;
    }
  });

  it('routes observed SWE SKUs to Kimi K2 without claiming future variants', () => {
    // SWE-1.5 / SWE-1.6 / SWE-1.7 observed variants share the section-token
    // tool-call format as Kimi K2. The slow deployment and unknown future
    // variants must retain the safe default dialect.
    assert.equal(pickToolDialect('swe-1.5'), 'kimi_k2');
    assert.equal(pickToolDialect('swe-1.5-fast'), 'kimi_k2');
    assert.equal(pickToolDialect('swe-1.5-thinking'), 'kimi_k2');
    assert.equal(pickToolDialect('swe-1.6'), 'kimi_k2');
    assert.equal(pickToolDialect('swe-1.6-fast'), 'kimi_k2');
    assert.equal(pickToolDialect('swe-1-7'), 'kimi_k2');
    assert.equal(pickToolDialect('swe-1-7-lightning'), 'openai_json_xml');
    assert.equal(pickToolDialect('swe-1-7-medium'), 'kimi_k2');
    assert.equal(pickToolDialect('swe-1-6-slow'), 'openai_json_xml');
    assert.equal(pickToolDialect('swe-1-8'), 'openai_json_xml');
    assert.equal(pickToolDialect('swe-2-0'), 'openai_json_xml');
    assert.equal(pickToolDialect('swe-2'), 'openai_json_xml');
    assert.equal(pickToolDialect('swe-2-medium'), 'openai_json_xml');
    assert.equal(pickToolDialect('swe-1-7-future-slow'), 'openai_json_xml');
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

  it('preserves text/tool order in items within one chunk', () => {
    const parser = new ToolCallStreamParser();
    const r = parser.feed('A<tool_call>{"name":"Read","arguments":{"path":"x"}}</tool_call>B');
    assert.deepEqual(r.items, [
      { type: 'text', text: 'A' },
      {
        type: 'tool_call',
        toolCall: {
          id: r.toolCalls[0].id,
          name: 'Read',
          argumentsJson: '{"path":"x"}',
        },
      },
      { type: 'text', text: 'B' },
    ]);
    assert.equal(r.text, 'AB');
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'Read');
  });

  it('handles multiple tool calls in one chunk', () => {
    const parser = new ToolCallStreamParser();
    const input = '<tool_call>{"name":"A","arguments":{}}</tool_call>text<tool_call>{"name":"B","arguments":{}}</tool_call>';
    const r = parser.feed(input);
    const flush = parser.flush();
    const allCalls = [...r.toolCalls, ...flush.toolCalls];
    assert.equal(allCalls.length, 2);
  });

  it('caps unclosed <tool_call> body at 65KB to avoid OOM', () => {
    const parser = new ToolCallStreamParser();
    parser.feed('<tool_call>{"name":"x","arguments":{"data":"');
    parser.feed('A'.repeat(70_000));
    // Oversize drop keeps inToolCall until the close marker (swallow), so the
    // trailing </tool_call> cannot leak as text. The call is dropped, buffer bounded.
    assert.equal(parser._oversizeDropped, true);
    assert.ok(parser.buffer.length < 1024);
  });

  it('caps unclosed <tool_result> body at 65KB', () => {
    const parser = new ToolCallStreamParser();
    parser.feed('<tool_result tool_call_id="abc">');
    parser.feed('B'.repeat(70_000));
    assert.equal(parser.inToolResult, false);
    assert.equal(parser.buffer.length, 0);
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

  it('keeps legacy Gemimi-style XML format working', () => {
    const input = '<tool_call>{"name":"Read","arguments":{"path":"README.md"}}</tool_call>';
    const { text, toolCalls } = parseToolCallsFromText(input, { modelKey: 'gemini-2.5-flash' });
    assert.equal(text, '');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, 'Read');
    assert.equal(JSON.parse(toolCalls[0].argumentsJson).path, 'README.md');
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
    assert.ok(preamble.length < 640, `preamble must stay compact (<640 chars); got ${preamble.length}`);
  });

  it('still describes the <tool_call> protocol and lists every tool name', () => {
    assert.ok(preamble.includes('<tool_call>'), 'must describe emission format');
    for (const t of manyTools) {
      assert.ok(preamble.includes(t.function.name), `must include function name ${t.function.name}`);
    }
    assert.ok(preamble.includes('arguments.command'), 'must carry the short Bash argument hint');
    assert.ok(preamble.includes('arguments.file_path'), 'must carry the short Read argument hint');
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

  it('uses GLM47 arg_key/arg_value protocol in proto preamble', () => {
    const glm = buildToolPreambleForProto(manyTools, 'auto', '', 'glm-5.1');
    assert.ok(glm.includes('<arg_key>'));
    assert.ok(glm.includes('<arg_value>'));
    assert.ok(!glm.includes('"name":"'));
  });

  it('uses Kimi section-token protocol in proto preamble', () => {
    const kimi = buildToolPreambleForProto(manyTools, 'auto', '', 'kimi-k2-thinking');
    assert.ok(kimi.includes('<|tool_calls_section_begin|>'));
    assert.ok(kimi.includes('<|tool_call_begin|>functions.FUNCTION_NAME:INDEX'));
    assert.ok(kimi.includes('<|tool_call_end|>'));
    assert.ok(kimi.includes('## Return of functions.FUNCTION_NAME:INDEX'));
  });

  it('adds Bash and Read argument fidelity rules only to the proto preamble', () => {
    const full = buildToolPreambleForProto(manyTools, 'auto');
    assert.match(full, /Tool argument fidelity rules:/);
    assert.match(full, /Bash: arguments MUST include the full command string/);
    assert.match(full, /Preserve quotes, flags, pipes, redirections/);
    assert.match(full, /Read: use "file_path" exactly/);
    assert.ok(!preamble.includes('Tool argument fidelity rules:'),
      'user-message fallback must not include the long proto-only rule block');
    assert.ok(preamble.includes('arguments.command'),
      'user-message fallback should include the compact Bash argument hint');
  });
});

describe('buildToolPreamble tool_choice passthrough (#G2)', () => {
  // The DEVIN_CONNECT path has no native function-calling slot, so tool_choice
  // can only reach the model via the prompt. Before #G2 the user-message
  // fallback hard-coded 'auto' and silently dropped required/forced/none.
  // These assertions lock the four tool_choice values to their prompt clauses.
  // NB: whether the upstream model actually OBEYS a forced/required constraint
  // under text emulation needs a live/paid token to confirm — TODO(unverified).
  const tools = [
    { type: 'function', function: { name: 'Bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    { type: 'function', function: { name: 'Read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
  ];

  it('auto (default) emits no tool_choice constraint clause — no regression', () => {
    const auto = buildToolPreamble(tools, 'auto');
    const bare = buildToolPreamble(tools);
    assert.equal(auto, bare, 'explicit auto must equal the default-arg output');
    assert.ok(!/MUST call/i.test(auto), 'auto must not force a call');
    assert.ok(!/Do NOT call any function/i.test(auto), 'auto must not forbid calls');
  });

  it('required injects a "must call at least one" constraint', () => {
    const req = buildToolPreamble(tools, 'required');
    assert.match(req, /MUST call at least one of these functions/i);
    assert.ok(!/the function "/.test(req), 'required (no name) must not name a specific function');
  });

  it('forced {function:{name}} injects a "must call X" constraint', () => {
    const forced = buildToolPreamble(tools, { type: 'function', function: { name: 'Bash' } });
    assert.match(forced, /MUST call the function "Bash"/);
    assert.match(forced, /no other function and no plain-text answer/i);
  });

  it('forced bare {name} shape is honoured too', () => {
    const forced = buildToolPreamble(tools, { name: 'Read' });
    assert.match(forced, /MUST call the function "Read"/);
  });

  it('none injects a "do not call" constraint', () => {
    const none = buildToolPreamble(tools, 'none');
    assert.match(none, /Do NOT call any function this turn/i);
  });

  it('tool_choice clauses stay free of injection-guard trigger phrases and system-prompt shape', () => {
    for (const tc of ['required', 'none', { function: { name: 'Bash' } }]) {
      const out = buildToolPreamble(tools, tc);
      assert.doesNotMatch(out, /\bIGNORE\b/i);
      assert.doesNotMatch(out, /for this request only/i);
      assert.doesNotMatch(out, /disregard/i);
      assert.ok(!/^### /m.test(out), 'no ### headers');
      assert.ok(!/```json/i.test(out), 'no json fences');
      assert.ok(out.length < 768, `stays compact; got ${out.length}`);
    }
  });

  it('normalizeMessagesForCascade threads toolChoice into the injected preamble', () => {
    const out = normalizeMessagesForCascade(
      [{ role: 'user', content: 'do the thing' }],
      tools,
      { route: 'devin_connect', toolChoice: { type: 'function', function: { name: 'Bash' } } },
    );
    const last = out[out.length - 1];
    assert.equal(last.role, 'user');
    assert.ok(last.content.endsWith('do the thing'));
    assert.match(last.content, /MUST call the function "Bash"/);
  });

  it('normalizeMessagesForCascade defaults to auto (no constraint) when toolChoice omitted', () => {
    const out = normalizeMessagesForCascade(
      [{ role: 'user', content: 'hi' }],
      tools,
      { route: 'devin_connect' },
    );
    const last = out[out.length - 1];
    assert.ok(!/MUST call/i.test(last.content), 'omitted toolChoice must stay auto');
  });
});

describe('buildCompactToolPreambleForProto (payload budget fallback)', () => {
  // Issue #67-adjacent: Claude Code can ship 30+ tools, each with multi-KB
  // parameter schemas. The full proto-level preamble was being doubled into
  // both field 12 and field 10 of CascadeConversationalPlannerConfig and
  // pushing total LS panel state past ~30KB, causing tools to silently fail
  // when deployed to cloud. The compact path keeps the protocol contract
  // and tool names but drops every parameter schema.
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
          }])
        ),
        required: Array.from({ length: 15 }, (_, j) => `param_${j}`),
      },
    },
  }));

  it('compact form is dramatically smaller than full schemas', () => {
    const full = buildToolPreambleForProto(bigTools, 'auto');
    const compact = buildCompactToolPreambleForProto(bigTools, 'auto');
    assert.ok(full.length > 20000, `expected full to be heavy, got ${full.length}B`);
    // v2.0.71 (#120): protocol headers grew ~75B with anti-fabrication
    // ruleset; threshold bumped from 2000 → 2500.
    // v2.0.81 (#125): bumped 2500 → 3500 after Chinese anti-narrate
    // bilingual rules added (~250B per dialect). Still 10x+ smaller
    // than full and well under panel-state ceiling.
    assert.ok(compact.length < 3500, `compact must be tiny, got ${compact.length}B`);
    assert.ok(compact.length < full.length / 5, 'compact must be at least 5x smaller');
  });

  it('compact form still names every tool and describes the protocol', () => {
    const compact = buildCompactToolPreambleForProto(bigTools, 'auto');
    for (let i = 0; i < bigTools.length; i++) {
      assert.ok(compact.includes(`tool_${i}`), `must mention tool_${i}`);
    }
    assert.ok(compact.includes('<tool_call>'), 'must describe emission format');
  });

  it('compact form omits parameter schemas entirely', () => {
    const compact = buildCompactToolPreambleForProto(bigTools, 'auto');
    assert.ok(!compact.includes('param_0'), 'must NOT include parameter names');
    assert.ok(!compact.includes('option_a'), 'must NOT include enum values');
    assert.ok(!compact.includes('```json'), 'must NOT include JSON schema fences');
  });

  it('compact form preserves environment block when provided', () => {
    const compact = buildCompactToolPreambleForProto(
      bigTools, 'auto',
      '- Working directory: /home/user/project\n- Platform: linux'
    );
    assert.ok(compact.includes('Environment facts'));
    assert.ok(compact.includes('/home/user/project'));
  });

  it('compact form respects tool_choice=required', () => {
    const compact = buildCompactToolPreambleForProto(bigTools, 'required');
    assert.ok(compact.includes('You MUST call at least one function'));
  });

  it('compact form returns empty for no tools', () => {
    assert.equal(buildCompactToolPreambleForProto([], 'auto'), '');
    assert.equal(buildCompactToolPreambleForProto(null, 'auto'), '');
    assert.equal(buildCompactToolPreambleForProto([{ type: 'function' }], 'auto'), '');
  });

  it('compact form does not contain jailbreak phrasing', () => {
    const compact = buildCompactToolPreambleForProto(bigTools, 'auto');
    const banned = [
      /IGNORE any earlier/i,
      /ignore previous instructions/i,
      /for this request only/i,
      /\[Tool-calling context/i,
    ];
    for (const re of banned) {
      assert.ok(!re.test(compact), `compact preamble must not match ${re}`);
    }
  });

  it('compact form keeps known-tool argument fidelity rules even without schemas', () => {
    const tools = [
      { type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
      { type: 'function', function: { name: 'Read', description: 'Read file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
    ];
    const compact = buildCompactToolPreambleForProto(tools, 'auto');
    assert.match(compact, /Tool argument fidelity rules:/);
    assert.match(compact, /Bash: arguments MUST include the full command string/);
    assert.match(compact, /Read: use "file_path" exactly/);
    assert.ok(!compact.includes('"properties"'), 'compact form must still avoid full schemas');
  });
});

describe('buildSchemaCompactToolPreambleForProto', () => {
  it('inlines local refs and preserves dictionary value schemas', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'WriteMap',
        description: 'Write a typed key-value map.',
        parameters: {
          type: 'object',
          properties: {
            payload: { $ref: '#/$defs/Payload' },
          },
          required: ['payload'],
          $defs: {
            Payload: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'display name' },
                labels: {
                  type: 'object',
                  additionalProperties: { type: 'string', description: 'label value' },
                },
                sealed: {
                  type: 'object',
                  additionalProperties: false,
                },
              },
              required: ['name', 'labels'],
            },
          },
        },
      },
    }];

    const preamble = buildSchemaCompactToolPreambleForProto(tools, 'auto');
    const schema = JSON.parse(preamble.match(/^Params: (.+)$/m)[1]);

    assert.equal(schema.properties.payload.type, 'object');
    assert.equal(schema.properties.payload.properties.name.type, 'string');
    assert.equal(schema.properties.payload.properties.labels.additionalProperties.type, 'string');
    assert.equal(schema.properties.payload.properties.sealed.additionalProperties, false);
    assert.equal(schema.$defs, undefined);
    assert.equal(schema.properties.payload.$ref, undefined);
    assert.ok(!preamble.includes('display name'));
    assert.ok(!preamble.includes('label value'));
  });

  it('replaces cyclic refs with a placeholder so output has no dangling $ref', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'Cycle',
        parameters: {
          type: 'object',
          properties: { node: { $ref: '#/$defs/Node' } },
          $defs: {
            Node: {
              type: 'object',
              properties: {
                next: { $ref: '#/$defs/Node' },
              },
            },
          },
        },
      },
    }];

    const preamble = buildSchemaCompactToolPreambleForProto(tools, 'auto');
    const schema = JSON.parse(preamble.match(/^Params: (.+)$/m)[1]);
    assert.deepEqual(schema.properties.node.properties.next, { type: 'object' });
    // Output must not carry $defs (those were stripped) nor any dangling $ref.
    assert.equal(JSON.stringify(schema).includes('$ref'), false, 'output must not contain $ref after $defs strip');
    assert.equal(JSON.stringify(schema).includes('$defs'), false, 'output must not retain $defs');
  });

  it('replaces a top-level self-cycle with a placeholder (no infinite recursion, no dangling ref)', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'TopCycle',
        parameters: {
          $ref: '#/$defs/Tree',
          $defs: {
            Tree: {
              type: 'object',
              properties: {
                children: { type: 'array', items: { $ref: '#/$defs/Tree' } },
              },
            },
          },
        },
      },
    }];
    const preamble = buildSchemaCompactToolPreambleForProto(tools, 'auto');
    const schema = JSON.parse(preamble.match(/^Params: (.+)$/m)[1]);
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.properties.children.items, { type: 'object' });
    assert.equal(JSON.stringify(schema).includes('$ref'), false);
  });

  it('skinny form remains available for the final low-budget tier', () => {
    const skinny = buildSkinnyToolPreambleForProto([
      { type: 'function', function: { name: 'Read', description: 'Read file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
    ], 'auto');
    assert.match(skinny, /Read/);
    assert.match(skinny, /file_path/);
  });
});

describe('normalizeMessagesForCascade (preamble placement regression)', () => {
  // Live-confirmed bug against Claude Code v2.1.114 / Opus 4.7: prepending
  // the "Tools available this turn: …" banner to the LAST user message at
  // every turn means that on multi-turn conversations the banner lands
  // immediately before a synthetic <tool_result> block (because tool_result
  // turns are rewritten into role:'user'). Opus pattern-matches that shape
  // as a truncated/injected conversation and refuses to keep using tools,
  // emitting "the conversation got mixed up — fragments of tool output
  // without a clear request" and rambling for tens of KB until max_wait.
  // The fix: only inject the user-message preamble on real user turns,
  // never on synthetic tool_result turns.
  const tools = [
    { type: 'function', function: { name: 'Bash', description: 'Shell.', parameters: { type: 'object' } } },
  ];

  it('injects preamble on a first-turn real user message', () => {
    const out = normalizeMessagesForCascade(
      [{ role: 'user', content: '帮我读一下 README' }],
      tools,
    );
    assert.equal(out.length, 1);
    assert.ok(out[0].content.startsWith('Tools available this turn:'),
      `expected preamble prefix, got: ${out[0].content.slice(0, 80)}`);
    assert.ok(out[0].content.endsWith('帮我读一下 README'));
  });

  it('does NOT inject preamble when the last user message is a synthetic tool_result', () => {
    const out = normalizeMessagesForCascade(
      [
        { role: 'user', content: '帮我读一下 README' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"cat README.md"}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: 'README contents…' },
      ],
      tools,
    );
    // The first user turn must NOT have a preamble (it isn't the LAST user
    // message); the rewritten tool_result turn must NOT have a preamble
    // (it's a synthetic wrapper, not a real user message).
    assert.equal(out[0].role, 'user');
    assert.ok(!out[0].content.startsWith('Tools available this turn:'),
      'first-turn user must not be polluted when a tool_result follows');
    const last = out[out.length - 1];
    assert.equal(last.role, 'user');
    assert.ok(last.content.startsWith('<tool_result'),
      `expected pure tool_result wrapper, got: ${last.content.slice(0, 80)}`);
    assert.ok(!last.content.includes('Tools available this turn:'),
      'tool_result turn must not be polluted with the user-message preamble');
  });

  it('still injects on the latest real user turn even when older turns contain tool_results', () => {
    const out = normalizeMessagesForCascade(
      [
        { role: 'user', content: 'first request' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: '/tmp' },
        { role: 'assistant', content: 'done.' },
        { role: 'user', content: 'follow-up question' },
      ],
      tools,
    );
    const last = out[out.length - 1];
    assert.equal(last.role, 'user');
    assert.ok(last.content.startsWith('Tools available this turn:'),
      'latest real user turn must receive the preamble');
    assert.ok(last.content.endsWith('follow-up question'));
  });

  it('preserves multimodal user content when adding the fallback preamble', () => {
    const imageData = 'a'.repeat(200);
    const out = normalizeMessagesForCascade(
      [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: '解释这张图' },
      ] }],
      tools,
    );
    assert.equal(out.length, 1);
    assert.ok(Array.isArray(out[0].content), 'multimodal content must stay as content blocks');
    assert.equal(out[0].content[0].type, 'text');
    assert.ok(out[0].content[0].text.startsWith('Tools available this turn:'));
    assert.equal(out[0].content[1].type, 'image');
    const injectedText = out[0].content
      .filter(p => p?.type === 'text')
      .map(p => p.text)
      .join('\n');
    assert.ok(!injectedText.includes(imageData), 'base64 must not be copied into text blocks');
  });

  it('can disable user-message fallback for Opus 4.7 multimodal turns', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b'.repeat(200) } };
    const out = normalizeMessagesForCascade(
      [{ role: 'user', content: [image, { type: 'text', text: 'what is this?' }] }],
      tools,
      { injectUserPreamble: false },
    );
    assert.ok(Array.isArray(out[0].content));
    assert.deepEqual(out[0].content[0], image);
    assert.equal(out[0].content[1].text, 'what is this?');
  });

  // Issue #86 follow-up: "上下文会丢" — when GLM/Kimi history was serialized
  // back into the cascade in OpenAI-JSON-XML format, the next turn saw its own
  // past tool calls in a foreign syntax and dropped the conversation thread.
  it('serializes assistant tool_calls into GLM47 dialect for GLM history', () => {
    const out = normalizeMessagesForCascade(
      [
        { role: 'user', content: 'read README' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call_g1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"README.md"}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_g1', content: 'README contents…' },
        { role: 'user', content: 'next' },
      ],
      tools,
      { modelKey: 'glm-5.1', provider: 'zhipu' },
    );
    const asst = out.find(m => m.role === 'assistant');
    assert.ok(asst.content.includes('<arg_key>file_path</arg_key>'),
      `expected GLM47 arg_key, got: ${asst.content}`);
    assert.ok(asst.content.includes('<arg_value>README.md</arg_value>'));
    assert.ok(!asst.content.includes('"name":"'),
      'GLM history must not include OpenAI JSON-XML format');
  });

  it('serializes assistant tool_calls into Kimi K2 section tokens for Kimi history', () => {
    const out = normalizeMessagesForCascade(
      [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call_k1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"x.md"}' } },
        ] },
      ],
      tools,
      { modelKey: 'kimi-k2-thinking', provider: 'moonshot' },
    );
    const asst = out.find(m => m.role === 'assistant');
    assert.ok(asst.content.includes('<|tool_call_begin|>functions.Read:0'));
    assert.ok(asst.content.includes('<|tool_call_argument_begin|>'));
    assert.ok(asst.content.includes('<|tool_calls_section_end|>'));
  });

  it('pairs Kimi/SWE history calls and results with canonical function IDs', () => {
    // Production regression: Hermes stores opaque OpenAI IDs (call_…), but
    // Kimi's history template pairs each result with functions.<name>:<index>.
    // Serializing the call as `todo:0` and the result as `call_…` made SWE
    // repeatedly recreate the same plan because it could not see completion.
    const out = normalizeMessagesForCascade(
      [
        { role: 'user', content: 'inspect the project' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call_todo', type: 'function', function: { name: 'todo', arguments: '{"todos":[]}' } },
          { id: 'call_terminal', type: 'function', function: { name: 'terminal', arguments: '{"command":"pwd"}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_todo', content: 'todo updated' },
        { role: 'tool', tool_call_id: 'call_terminal', content: '/workspace' },
      ],
      tools,
      { modelKey: 'swe-1-7-medium' },
    );
    const assistant = out.find(m => m.role === 'assistant');
    assert.equal(
      (assistant.content.match(/<\|tool_calls_section_begin\|>/g) || []).length,
      1,
      'one assistant tool-call turn must remain one native Kimi section',
    );
    assert.match(assistant.content, /<\|tool_call_begin\|>functions\.todo:0<\|tool_call_argument_begin\|>/);
    assert.match(assistant.content, /<\|tool_call_begin\|>functions\.terminal:1<\|tool_call_argument_begin\|>/);
    const results = out.filter(m => m.role === 'user' && String(m.content).startsWith('## Return of '));
    assert.deepEqual(results.map(m => m.content), [
      '## Return of functions.todo:0\ntodo updated\n\n## Return of functions.terminal:1\n/workspace',
    ]);
    assert.ok(!results.some(m => m.content.includes('<tool_result')),
      'Kimi/SWE history must not wrap native results in foreign XML');
  });

  it('keeps OpenAI JSON-XML serializer for Anthropic/OpenAI/Gemini history', () => {
    const out = normalizeMessagesForCascade(
      [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call_a1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"x.md"}' } },
        ] },
      ],
      tools,
      { modelKey: 'claude-opus-4.7', provider: 'anthropic' },
    );
    const asst = out.find(m => m.role === 'assistant');
    assert.ok(asst.content.includes('"name":"Read"'),
      `expected JSON-XML, got: ${asst.content}`);
    assert.ok(asst.content.includes('"file_path":"x.md"'));
    assert.ok(!asst.content.includes('<arg_key>'));
  });
});

describe('repairToolCallArguments', () => {
  it('repairs Bash command prefix truncation when the user gave an exact command', () => {
    const tc = {
      name: 'Bash',
      argumentsJson: JSON.stringify({ command: 'node -p' }),
    };
    const repaired = repairToolCallArguments(tc, [
      {
        role: 'user',
        content: 'Tool 2: Bash with command exactly node -p "require(\'./package.json\').version".',
      },
    ]);
    assert.equal(
      JSON.parse(repaired.argumentsJson).command,
      'node -p "require(\'./package.json\').version"'
    );
  });

  it('does not invent Bash arguments when the model command is not a prefix', () => {
    const tc = {
      name: 'Bash',
      argumentsJson: JSON.stringify({ command: 'npm test' }),
    };
    const repaired = repairToolCallArguments(tc, [
      {
        role: 'user',
        content: 'Run exactly node -p "require(\'./package.json\').version".',
      },
    ]);
    assert.equal(JSON.parse(repaired.argumentsJson).command, 'npm test');
  });
});

describe('interleaveParallelToolMessages', () => {
  it('splits batch tool_calls with matching results into alternating pairs', () => {
    const messages = [
      { role: 'user', content: 'run two commands' },
      {
        role: 'assistant',
        content: 'Executing both tools',
        reasoning_content: 'Need to run tool 1 then tool 2',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
          { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '/workspace' },
      { role: 'tool', tool_call_id: 'call_2', content: 'file.txt' },
      { role: 'user', content: 'next' },
    ];

    const out = interleaveParallelToolMessages(messages);
    assert.equal(out.length, 6, '1 user + 2 pairs (4 msgs) + 1 user = 6 messages');

    // Turn 1
    assert.equal(out[1].role, 'assistant');
    assert.equal(out[1].content, 'Executing both tools');
    assert.equal(out[1].reasoning_content, 'Need to run tool 1 then tool 2');
    assert.deepEqual(out[1].tool_calls.map((t) => t.id), ['call_1']);
    assert.equal(out[2].role, 'tool');
    assert.equal(out[2].tool_call_id, 'call_1');

    // Turn 2
    assert.equal(out[3].role, 'assistant');
    assert.equal(out[3].content, null, 'subsequent turns should have null content');
    assert.equal(out[3].reasoning_content, undefined, 'reasoning stripped on subsequent turns');
    assert.deepEqual(out[3].tool_calls.map((t) => t.id), ['call_2']);
    assert.equal(out[4].role, 'tool');
    assert.equal(out[4].tool_call_id, 'call_2');

    // Subsequent user message
    assert.equal(out[5].content, 'next');
  });

  it('interleaves consecutive single-tool assistant turns from Responses clients', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f1', arguments: '{}' } }] },
      { role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'f2', arguments: '{}' } }] },
      { role: 'assistant', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'f3', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      { role: 'tool', tool_call_id: 'c3', content: 'r3' },
    ];

    const out = interleaveParallelToolMessages(messages);
    assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']);
    assert.deepEqual(out.map((m) => m.tool_calls?.[0]?.id || m.tool_call_id), ['c1', 'c1', 'c2', 'c2', 'c3', 'c3']);
  });

  it('preserves unmatched tool results and non-parallel messages intact', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'f1', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'f2', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c_extra', content: 'r_extra' },
    ];

    const out = interleaveParallelToolMessages(messages);
    assert.equal(out.length, 4);
    assert.equal(out[0].tool_calls[0].id, 'c1');
    assert.equal(out[1].tool_call_id, 'c1');
    assert.equal(out[2].tool_calls[0].id, 'c2');
    assert.equal(out[3].tool_call_id, 'c_extra', 'unmatched tool result appended without drop');
  });

  it('leaves single-tool calls or unresponded calls untouched', () => {
    const single = [
      { role: 'assistant', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ];
    assert.deepEqual(interleaveParallelToolMessages(single), single);

    const pending = [
      { role: 'assistant', tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
    ];
    assert.deepEqual(interleaveParallelToolMessages(pending), pending);
  });

  it('absorbs a text-only assistant inside a parallel-call run instead of breaking it', () => {
    // Codex emits parallel function_calls as separate items, then an assistant
    // text item, then the results — i.e. [tc, tc, text, tool, tool]. Letting
    // that through verbatim encodes as three consecutive ASSISTANT wire
    // messages (call, call, text), which the upstream validator rejects with
    // invalid_argument ("an internal error occurred"). The stray text belongs
    // to the same turn, so fold it into the first call's assistant entry.
    const messages = [
      { role: 'user', content: 'list resources' },
      { role: 'assistant', tool_calls: [{ id: 'a:0#x1', type: 'function', function: { name: 'list_mcp_resources', arguments: '{"server":"a"}' } }] },
      { role: 'assistant', tool_calls: [{ id: 'a:1#x2', type: 'function', function: { name: 'list_mcp_resources', arguments: '{"server":"b"}' } }] },
      { role: 'assistant', content: 'checking both servers' },
      { role: 'tool', tool_call_id: 'a:0#x1', content: 'err1' },
      { role: 'tool', tool_call_id: 'a:1#x2', content: 'ok1' },
      { role: 'user', content: 'go on' },
    ];

    const out = interleaveParallelToolMessages(messages);
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
    assert.equal(out[1].content, 'checking both servers', 'stray text folded into first call turn');
    assert.deepEqual(out[1].tool_calls.map((t) => t.id), ['a:0#x1']);
    assert.deepEqual(out[3].tool_calls.map((t) => t.id), ['a:1#x2']);
  });

  it('preserves the full run verbatim when no tool results match', () => {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f1', arguments: '{}' } }] },
      { role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'f2', arguments: '{}' } }] },
      { role: 'assistant', content: 'no results yet' },
      { role: 'user', content: 'next' },
    ];
    assert.deepEqual(interleaveParallelToolMessages(messages), messages);
  });
});

// ─── The call site: normalizeMessagesForCascade must interleave on the native
// structured path ────────────────────────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS (separate from the helper's own tests above).
//
// The helper being correct says nothing about whether the normalizer CALLS it.
// Measured 2026-09-13: commenting out `messages = interleaveParallelToolMessages(
// messages)` in tool-emulation.js left the entire suite green (4172 tests) — the
// helper's three unit tests never touch the call site. These assertions pin the
// call site itself, so deleting or re-gating that line fails here.
//
// Root cause this guards: devin-connect.js encodes one assistant turn carrying N
// tool_calls as N CONSECUTIVE role=2 frames and only then emits the role=4
// tool_results. Upstream's state machine answers that shape with an internal
// error (reproduced live: 529, or UPSTREAM_INTERNAL) and the session stays
// poisoned for every later turn. Alternating 2/4/2/4 clears it.
describe('normalizeMessagesForCascade — native structured path interleaves parallel tool history', () => {
  const history = () => [
    { role: 'user', content: 'run two commands' },
    {
      role: 'assistant',
      content: 'Executing both tools',
      reasoning_content: 'need both',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
        { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '/workspace' },
    { role: 'tool', tool_call_id: 'call_2', content: 'file.txt' },
  ];
  const opts = (nativeStructured) => ({
    modelKey: 'swe-1-7', provider: null, route: 'devin_connect',
    injectUserPreamble: false, nativeStructured,
  });

  it('nativeStructured:true keeps structural turns and pairs each call with its own result', () => {
    const out = normalizeMessagesForCascade(history(), [], opts(true));

    // The interleave is the whole point: roles alternate assistant/tool.
    assert.deepEqual(
      out.map((m) => m.role),
      ['user', 'assistant', 'tool', 'assistant', 'tool'],
      'parallel batch must be split into alternating call/result pairs',
    );
    assert.deepEqual(out[1].tool_calls.map((t) => t.id), ['call_1']);
    assert.equal(out[2].tool_call_id, 'call_1');
    assert.deepEqual(out[3].tool_calls.map((t) => t.id), ['call_2']);
    assert.equal(out[4].tool_call_id, 'call_2');

    // Structural fidelity: no folding to text, no synthesized user turns, and
    // the duplicate first call id that the un-interleaved shape produced is gone.
    assert.equal(out.filter((m) => m.role === 'user').length, 1);
    assert.equal(out.filter((m) => m.role === 'tool').length, 2);
    assert.ok(!/<tool_result/.test(JSON.stringify(out)), 'no text markup on the native path');
  });

  // Control: the same input on the emulation path must still FOLD (2 calls stay
  // one assistant, results become user turns). If a future change makes the
  // interleave unconditional, this control is what fails.
  it('emulation path still folds the same history (control)', () => {
    const out = normalizeMessagesForCascade(history(), [], opts(false));
    assert.equal(out.filter((m) => m.role === 'assistant').length, 1);
    assert.equal(out.filter((m) => m.role === 'tool').length, 0, 'role:tool is folded away');
    assert.ok(out.length >= 3);
  });
});

// ─── The wire the upstream actually receives ─────────────────────────────────
//
// This is the assertion that cannot be fooled by shape-level reasoning: it reads
// the #2 role field out of the encoded protobuf frames. Before the fix the
// sequence is [2,2,4,4] (two consecutive assistant frames, then both results);
// after it is [2,4,2,4]. The bug report is about exactly this byte-level shape.
describe('native history assembles to an interleaved role sequence on the wire', () => {
  // Minimal top-level protobuf walker: returns [{field, wireType, value}] in order.
  function walk(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
      let shift = 0; let key = 0; let b;
      do { b = buf[i++]; key |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      const field = key >>> 3; const wireType = key & 7;
      if (wireType === 0) {
        let v = 0; shift = 0;
        do { b = buf[i++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        out.push({ field, wireType, value: v });
      } else if (wireType === 2) {
        let len = 0; shift = 0;
        do { b = buf[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        out.push({ field, wireType, value: buf.subarray(i, i + len) });
        i += len;
      } else if (wireType === 1) { out.push({ field, wireType, value: buf.subarray(i, i + 8) }); i += 8; }
      else if (wireType === 5) { out.push({ field, wireType, value: buf.subarray(i, i + 4) }); i += 4; }
      else throw new Error(`unsupported wire type ${wireType} for field ${field} at ${i}`);
    }
    return out;
  }
  // ChatMessage is the repeated #3 field (see buildGetChatMessageRequest: `for (const cm
  // of chatMessages) parts.push(writeMessageField(3, cm))`). Roles come from each
  // frame's #2 varint, in frame order — i.e. exactly what upstream's state machine sees.
  const roles = (buf) => walk(buf)
    .filter((f) => f.field === 3 && f.wireType === 2)
    .flatMap((f) => walk(f.value))
    .filter((f) => f.field === 2 && f.wireType === 0)
    .map((f) => f.value);

  const request = (messages, nativeToolCall) => buildGetChatMessageRequest({
    token: 'x', model: 'swe-1-7', messages, nativeToolCall, env: {},
  });

  const parallelHistory = [
    { role: 'user', content: 'run two commands' },
    {
      role: 'assistant',
      content: 'Executing both tools',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
        { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '/workspace' },
    { role: 'tool', tool_call_id: 'call_2', content: 'file.txt' },
  ];

  it('normalized native history encodes as text + 2/4/2/4 rather than text + 2/2/4/4', () => {
    const normalized = normalizeMessagesForCascade(parallelHistory, [], {
      modelKey: 'swe-1-7', provider: null, route: 'devin_connect',
      injectUserPreamble: false, nativeStructured: true,
    });
    const seq = roles(request(normalized, true));
    // Leading 1 = the user turn; leading 2 = the assistant's own text, which the
    // encoder emits as its own role=2 frame (devin-connect.js:1065-1073) BEFORE the
    // per-call frames. The interleave changes what follows: 2/4 pairs, not 2/2/4/4.
    assert.deepEqual(seq, [1, 2, 2, 4, 2, 4], `expected interleaved roles, got ${JSON.stringify(seq)}`);
  });

  // Premise pin: if the encoder ever stops emitting one role=2 frame per call,
  // the assertion above would stop measuring what it claims to measure.
  it('premise: the encoder emits one role=2 frame PER tool_call (the shape the fix answers)', () => {
    const seq = roles(request(parallelHistory, true));
    assert.deepEqual(seq, [1, 2, 2, 2, 4, 4], `expected batched roles, got ${JSON.stringify(seq)}`);
  });
});
