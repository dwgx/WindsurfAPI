import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateRiskyReadToolResult, extractCallerSubKey, handleMessages } from '../src/handlers/messages.js';
import { applyJsonResponseHint, extractRequestedJsonKeys, isExplicitJsonRequested, stabilizeJsonPayload } from '../src/handlers/chat.js';

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
    // Only the client-side Read tool survives translation; all three
    // server-side types must be stripped.
    assert.equal(capturedBody.tools?.length, 1);
    assert.equal(capturedBody.tools[0].function.name, 'Read');
    const names = capturedBody.tools.map(t => t.function.name);
    for (const banned of ['advisor', 'web_search', 'code_execution']) {
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
  });

  it('extracts explicitly requested final JSON keys', () => {
    assert.deepEqual(extractRequestedJsonKeys([
      { role: 'user', content: 'answer only compact JSON with exact keys readVersion, bashVersion, versionsMatch and no other keys.' },
    ]), ['readVersion', 'bashVersion', 'versionsMatch']);
    assert.deepEqual(extractRequestedJsonKeys(applyJsonResponseHint([
      { role: 'user', content: 'answer only compact JSON with exact keys readVersion, bashVersion, versionsMatch and no other keys.' },
    ])), ['readVersion', 'bashVersion', 'versionsMatch']);
  });

  it('adds JSON-only guidance for clients that ask for JSON in text', () => {
    const messages = applyJsonResponseHint([
      { role: 'user', content: 'Read package.json and answer only compact JSON with name and version.' },
    ]);

    assert.match(messages[0].content, /Respond with valid JSON only/);
    assert.match(messages.at(-1).content, /single parseable JSON object/);
    assert.match(messages.at(-1).content, /Preserve the exact JSON field names requested/);
    assert.match(messages.at(-1).content, /do not add extra fields/);
    assert.match(messages.at(-1).content, /copying the full tool result/);
  });

  it('keeps JSON-only guidance on the latest real user turn when the current turn is a tool_result', () => {
    const messages = applyJsonResponseHint([
      { role: 'user', content: 'Read package.json and answer only compact JSON with name and version.' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } },
      ] },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"name":"windsurf-api","version":"2.0.11"}' },
    ]);

    const realUser = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Read package.json'));
    const toolResult = messages.find(m => m.role === 'tool');
    assert.match(realUser.content, /single parseable JSON object/);
    assert.doesNotMatch(toolResult.content, /single parseable JSON object/);
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
