import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateRiskyReadToolResult, extractCallerSubKey, handleMessages } from '../src/handlers/messages.js';
import { applyJsonResponseHint, extractRequestedJsonKeys, isExplicitJsonRequested, stabilizeJsonPayload } from '../src/handlers/chat.js';

function chatChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      const cbs = listeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseAnthropicEvents(raw) {
  return raw
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const lines = frame.split('\n');
      return {
        event: lines.find(line => line.startsWith('event: '))?.slice(7),
        data: JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'),
      };
    });
}

describe('Anthropic messages request translation', () => {
  afterEach(() => {
    // No shared mutable state in these tests, but keep the hook here so this
    // file stays symmetric with the stateful auth/rate-limit tests.
  });

  it('passes thinking through to the chat handler and preserves reasoning in the response', async () => {
    let capturedBody = null;
    const thinking = { type: 'enabled', budget_tokens: 64 };
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      thinking,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', reasoning_content: 'plan', content: 'done' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });

    assert.deepEqual(capturedBody.thinking, thinking);
    assert.equal(result.status, 200);
    assert.equal(result.body.content[0].type, 'thinking');
    assert.equal(result.body.content[0].thinking, 'plan');
    assert.equal(result.body.content[1].type, 'text');
    assert.equal(result.body.content[1].text, 'done');
  });

  it('maps Anthropic tool_choice variants to OpenAI shapes', async () => {
    const cases = [
      { input: { type: 'auto' }, expected: 'auto' },
      { input: { type: 'any' }, expected: 'required' },
      { input: { type: 'tool', name: 'Read' }, expected: { type: 'function', function: { name: 'Read' } } },
      { input: { type: 'none' }, expected: 'none' },
    ];

    for (const testCase of cases) {
      let capturedBody = null;
      const result = await handleMessages({
        model: 'claude-sonnet-4.6',
        tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
        tool_choice: testCase.input,
        messages: [{ role: 'user', content: 'hi' }],
      }, {
        async handleChatCompletions(body) {
          capturedBody = body;
          return {
            status: 200,
            body: {
              model: body.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          };
        },
      });

      assert.equal(result.status, 200);
      assert.deepEqual(capturedBody.tool_choice, testCase.expected);
    }
  });

  it('annotates risky Read tool_result stubs before Cascade sees them', async () => {
    let capturedBody = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'review files' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'big.md' } },
        ] },
        { role: 'user', content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: 'File content (377.3KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.',
          },
        ] },
      ],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });

    const toolMsg = capturedBody.messages.find(m => m.role === 'tool');
    assert.match(toolMsg.content, /does not prove the full file body/);
    assert.match(toolMsg.content, /offset\/limit/);
  });

  it('preserves falsy Anthropic tool_use input values', async () => {
    let capturedBody = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'toolu_false', name: 'flag', input: false },
          { type: 'tool_use', id: 'toolu_zero', name: 'count', input: 0 },
          { type: 'tool_use', id: 'toolu_empty', name: 'empty', input: '' },
        ] },
      ],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });

    const toolCalls = capturedBody.messages[0].tool_calls;
    assert.equal(toolCalls[0].function.arguments, 'false');
    assert.equal(toolCalls[1].function.arguments, '0');
    assert.equal(toolCalls[2].function.arguments, '""');
  });

  it('does not annotate normal Read output or non-Read tool results', () => {
    const normal = '1\t# README\n2\tActual content';
    assert.equal(
      annotateRiskyReadToolResult(normal, { toolName: 'Read' }),
      normal,
    );
    const bashStub = 'File content (377.3KB) exceeds maximum allowed size (256KB). Use offset and limit parameters.';
    assert.equal(
      annotateRiskyReadToolResult(bashStub, { toolName: 'Bash', isError: true }),
      bashStub,
    );
  });

  it('does not annotate line-numbered real body that contains stub keywords', () => {
    const realBody = '1\t// previously cached value\n2\tconst x = 1;\n3\t// content was truncated last run\n4\tconst y = 2;';
    assert.equal(
      annotateRiskyReadToolResult(realBody, { toolName: 'Read' }),
      realBody,
    );
    const cnBody = '1\t// 内容未变更：保留旧值\n2\tconst foo = 1;';
    assert.equal(
      annotateRiskyReadToolResult(cnBody, { toolName: 'Read' }),
      cnBody,
    );
  });

  it('annotates real Claude Code cached-unchanged stub', () => {
    const cachedStub = 'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current.';
    const out = annotateRiskyReadToolResult(cachedStub, { toolName: 'Read' });
    assert.match(out, /does not prove the full file body/);
  });

  it('translates Anthropic output_config.effort into reasoning_effort', async () => {
    let capturedBody = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.equal(capturedBody.reasoning_effort, 'high');
  });

  it('translates Anthropic output_config.format json_schema into response_format', async () => {
    let capturedBody = null;
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    };
    await handleMessages({
      model: 'claude-haiku-4-5',
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'extract a title' }],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: '{"title":"x"}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.equal(capturedBody.response_format?.type, 'json_schema');
    assert.deepEqual(capturedBody.response_format.json_schema.schema, schema);
    assert.equal(capturedBody.response_format.json_schema.strict, true);
  });

  it('extracts a stable per-user sub key from Claude Code metadata.user_id JSON', () => {
    const userIdJson = JSON.stringify({
      device_id: '42a4480e6ef9848582c0452f45ea155a89ed9b296d91700b7226973bb83f4495',
      account_uuid: '',
      session_id: '76f83892-d2e3-4248-8006-6d3c64955db4',
    });
    const a = extractCallerSubKey({ metadata: { user_id: userIdJson } });
    assert.equal(typeof a, 'string');
    assert.equal(a.length, 16);
    // Same input -> same key (stability)
    assert.equal(extractCallerSubKey({ metadata: { user_id: userIdJson } }), a);
    // Different device_id -> different key (multi-user isolation)
    const b = extractCallerSubKey({
      metadata: { user_id: JSON.stringify({ device_id: 'different-device', session_id: '76f83892-d2e3-4248-8006-6d3c64955db4' }) },
    });
    assert.notEqual(a, b);
  });

  it('falls back through user_id fields when device_id is missing', () => {
    const sessionOnly = extractCallerSubKey({
      metadata: { user_id: JSON.stringify({ session_id: 'sess-1' }) },
    });
    const acctOnly = extractCallerSubKey({
      metadata: { user_id: JSON.stringify({ account_uuid: 'acct-1' }) },
    });
    assert.equal(sessionOnly.length, 16);
    assert.equal(acctOnly.length, 16);
    assert.notEqual(sessionOnly, acctOnly);
  });

  it('treats plain-string user_id as the tag (older Anthropic SDK shape)', () => {
    const out = extractCallerSubKey({ metadata: { user_id: 'plain-string-id' } });
    assert.equal(out.length, 16);
  });

  it('returns empty when metadata or user_id is missing or empty', () => {
    assert.equal(extractCallerSubKey({}), '');
    assert.equal(extractCallerSubKey({ metadata: {} }), '');
    assert.equal(extractCallerSubKey({ metadata: { user_id: '' } }), '');
    assert.equal(extractCallerSubKey(null), '');
    assert.equal(extractCallerSubKey(undefined), '');
  });

  it('augments context.callerKey with metadata.user_id sub-key on the chat handler call', async () => {
    let capturedContext = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      metadata: { user_id: JSON.stringify({ device_id: 'device-A' }) },
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      callerKey: 'api:abc123',
      async handleChatCompletions(_body, ctx) {
        capturedContext = ctx;
        return {
          status: 200,
          body: {
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.match(capturedContext.callerKey, /^api:abc123:user:[0-9a-f]{16}$/);
  });

  it('leaves callerKey unchanged when no metadata.user_id is present', async () => {
    let capturedContext = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      callerKey: 'api:abc123',
      async handleChatCompletions(_body, ctx) {
        capturedContext = ctx;
        return {
          status: 200,
          body: {
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.equal(capturedContext.callerKey, 'api:abc123');
  });

  it('drops Anthropic server-side tool types (advisor / web_search / code_execution) before forwarding', async () => {
    let capturedBody = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      tools: [
        { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-6' },
        { type: 'web_search_20250305', name: 'web_search' },
        { type: 'code_execution_20250522', name: 'code_execution' },
        { name: 'Read', description: 'read files', input_schema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    // v2.0.93: web_search_20250305 is now converted to a function tool
    // (not dropped). advisor + code_execution are still stripped.
    assert.equal(capturedBody.tools?.length, 2);
    const names = capturedBody.tools.map(t => t.function.name);
    assert.ok(names.includes('Read'), 'Read should survive');
    assert.ok(names.includes('web_search'), 'web_search should be converted to function');
    for (const banned of ['advisor', 'code_execution']) {
      assert.equal(names.includes(banned), false, `${banned} should not be forwarded`);
    }
  });

  it('omits tools entirely when the only declared tool is server-side', async () => {
    let capturedBody = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-6' }],
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    // No tools key at all (chat.js relies on this to skip preamble injection)
    assert.equal(capturedBody.tools, undefined);
  });

  it('drops a forced server-side tool_choice when the matching tool was stripped', async () => {
    let capturedBody = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      tools: [
        { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-6' },
        { name: 'Read', description: 'read files', input_schema: { type: 'object' } },
      ],
      tool_choice: { type: 'tool', name: 'advisor' },
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.equal(capturedBody.tools.length, 1);
    assert.equal(capturedBody.tools[0].function.name, 'Read');
    assert.equal(capturedBody.tool_choice, undefined);
  });

  it('buffers streaming tool argument deltas until tool id and name arrive', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'read package.json' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path"' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: ':"package.json"' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.write(chatChunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const blockStart = events.find(e => e.event === 'content_block_start');
    assert.deepEqual(blockStart.data.content_block, {
      type: 'tool_use',
      id: 'call_1',
      name: 'Read',
      input: {},
    });
    const partialJson = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')
      .map(e => e.data.delta.partial_json)
      .join('');
    assert.equal(partialJson, '{"file_path":"package.json"}');
  });

  it('preserves thinking.type=adaptive (Claude Code 2.x sonnet default) when forwarding', async () => {
    let capturedBody = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.deepEqual(capturedBody.thinking, { type: 'adaptive' });
    assert.equal(capturedBody.reasoning_effort, 'high');
  });

  it('detects explicit JSON requests without response_format', () => {
    assert.equal(isExplicitJsonRequested([
      { role: 'user', content: 'Read package.json and answer only compact JSON with name and version.' },
    ]), true);
    assert.equal(isExplicitJsonRequested([
      { role: 'user', content: 'Tell me about JSON as a data format.' },
    ]), false);
    assert.equal(isExplicitJsonRequested([
      { role: 'user', content: 'Answer only compact JSON with name and version.' },
      { role: 'assistant', content: '{"name":"windsurf-api","version":"2.0.14"}' },
      { role: 'user', content: 'Now explain what changed in prose.' },
    ]), false);
  });

  it('extracts explicitly requested final JSON keys', () => {
    assert.deepEqual(extractRequestedJsonKeys([
      { role: 'user', content: 'answer only compact JSON with exact keys readVersion, bashVersion, versionsMatch and no other keys.' },
    ]), ['readVersion', 'bashVersion', 'versionsMatch']);
    assert.deepEqual(extractRequestedJsonKeys(applyJsonResponseHint([
      { role: 'user', content: 'answer only compact JSON with exact keys readVersion, bashVersion, versionsMatch and no other keys.' },
    ])), ['readVersion', 'bashVersion', 'versionsMatch']);
    assert.deepEqual(extractRequestedJsonKeys([
      { role: 'user', content: 'answer only compact JSON with exact keys name and version.' },
      { role: 'assistant', content: '{"name":"windsurf-api","version":"2.0.14"}' },
      { role: 'user', content: 'Now answer normally.' },
    ]), []);
  });

  it('adds JSON-only guidance via a system message only (no user-content append)', () => {
    // Earlier behavior also appended the hint to the latest user turn,
    // which polluted the cascade reuse trajectory upstream and caused
    // every follow-up turn to inherit JSON-only mode (#104). The fix is
    // to inject ONLY a system message — it's authoritative for cascade
    // routing and isn't persisted in the conversation history.
    const original = { role: 'user', content: 'Read package.json and answer only compact JSON with name and version.' };
    const messages = applyJsonResponseHint([original]);

    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /Respond with valid JSON only/);
    assert.match(messages[0].content, /Preserve the exact JSON field names requested/);
    assert.match(messages[0].content, /copying the full tool result/);

    // The user message must be unchanged byte-for-byte. Anything appended
    // here will leak into the cascade upstream's stored trajectory and
    // contaminate later turns that don't ask for JSON.
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, original.content,
      'applyJsonResponseHint must not modify user content (cascade trajectory pollution, #104)');
  });

  it('does not modify user content even when later turns are tool_results', () => {
    const userMsg = { role: 'user', content: 'Read package.json and answer only compact JSON with name and version.' };
    const toolMsg = { role: 'tool', tool_call_id: 'toolu_1', content: '{"name":"windsurf-api","version":"2.0.11"}' };
    const messages = applyJsonResponseHint([
      userMsg,
      { role: 'assistant', content: '', tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } },
      ] },
      toolMsg,
    ]);

    const realUser = messages.find(m => m.role === 'user');
    const toolResult = messages.find(m => m.role === 'tool');
    assert.equal(realUser.content, userMsg.content, 'user content must remain pristine');
    assert.equal(toolResult.content, toolMsg.content, 'tool content must remain pristine');
    // System message carries the JSON guidance instead.
    assert.match(messages[0].content, /Respond with valid JSON only/);
  });

  it('does not contaminate the cascade trajectory across turns (regression for #104)', () => {
    // The bug: turn-1 says "respond in JSON only", proxy appends the
    // JSON-only suffix to turn-1 user content, cascade upstream stores
    // it in trajectory; turn-2 reuses the cascade for a plain "你好"
    // greeting — and gets back `{"reply":"你好"}` because the upstream
    // still sees the JSON-only instruction in the prior user turn.
    //
    // After the fix, applyJsonResponseHint only touches the system
    // message. Building a turn-2 message list from the original (un-
    // hinted) user content + a new user turn must contain ZERO trace
    // of the JSON-only instruction.
    const turn1User = { role: 'user', content: 'Answer only compact JSON with name and version.' };
    const turn1Hinted = applyJsonResponseHint([turn1User]);

    // Simulate what a caller would store in conversation history: the
    // original user message, NOT the hinted one. (The proxy hands the
    // hinted version to upstream but the conversation history feeds
    // back the original.) The user content in the hinted list must
    // equal the original — that's the invariant.
    const userInHinted = turn1Hinted.find(m => m.role === 'user');
    assert.equal(userInHinted.content, turn1User.content);
    assert.doesNotMatch(userInHinted.content, /JSON only/i,
      'user content must not carry the JSON-only instruction into the next turn');
  });

  it('projects final JSON onto requested keys using tool results when the model drifts', () => {
    const messages = [
      { role: 'user', content: 'After both tool results, answer only compact JSON with exact keys readVersion, bashVersion, versionsMatch and no other keys.' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_read', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_read', content: '{"name":"windsurf-api","version":"2.0.11"}' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_bash', type: 'function', function: { name: 'Bash', arguments: '{"command":"node -p \\"require(\\\'./package.json\\\').version\\""}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_bash', content: '2.0.11' },
    ];

    assert.equal(
      stabilizeJsonPayload('{"name":"windsurf-api","version":"2.0.11"}', messages),
      '{"readVersion":"2.0.11","bashVersion":"2.0.11","versionsMatch":true}',
    );
  });
});
