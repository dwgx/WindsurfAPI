import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repairToolCallArguments } from '../src/handlers/chat.js';
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
    assert.ok(compact.length < 2000, `compact must be tiny, got ${compact.length}B`);
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
