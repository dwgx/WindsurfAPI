import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateRiskyReadToolResult, extractCallerSubKey, handleMessages, handleCountTokens, toAnthropicError } from '../src/handlers/messages.js';
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
    // Anthropic thinking blocks must carry a `signature` field (empty-string
    // proxy placeholder since upstream supplies none) so the block schema is
    // spec-complete for the client SDK.
    assert.equal(result.body.content[0].signature, '');
    assert.equal(result.body.content[1].type, 'text');
    assert.equal(result.body.content[1].text, 'done');
  });

  it('round-trips a real upstream reasoning_signature on the non-stream thinking block', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', reasoning_content: 'plan', reasoning_signature: 'sig-abc', content: 'done' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.equal(result.body.content[0].type, 'thinking');
    assert.equal(result.body.content[0].signature, 'sig-abc');
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

  // BUG1: an upstream stream that delivers content then dies WITHOUT a
  // finish_reason / [DONE] / error frame must surface an `error` event, not a
  // fake end_turn message_stop. Otherwise Claude Code treats a truncated answer
  // as complete.
  it('surfaces an error event (not fake end_turn) when the stream is cut off mid-content', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'write a long answer' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'partial ' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'answer that never' }, finish_reason: null }] }));
            // Abnormal cutoff: end the stream with NO finish_reason and NO [DONE].
            res.end();
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const errEvent = events.find(e => e.event === 'error' || e.data.type === 'error');
    assert.ok(errEvent, 'a truncated stream emits an error event');
    assert.equal(errEvent.data.error.type, 'overloaded_error', 'truncation maps to a retryable 529 overloaded_error');
    // It must NOT have faked a normal completion.
    const stopDelta = events.find(e => e.event === 'message_delta' && e.data.delta?.stop_reason === 'end_turn');
    assert.ok(!stopDelta, 'no fake end_turn message_delta on a cut-off stream');
  });

  // BUG1 (negative): a normal stream that DOES send finish_reason still ends with
  // a proper end_turn message_delta + message_stop, not an error.
  it('still emits end_turn + message_stop for a normally-terminated text stream', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.write(chatChunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const errEvent = events.find(e => e.event === 'error' || e.data.type === 'error');
    assert.ok(!errEvent, 'a normally terminated stream emits no error');
    const stopDelta = events.find(e => e.event === 'message_delta');
    assert.equal(stopDelta.data.delta.stop_reason, 'end_turn');
    assert.ok(events.some(e => e.event === 'message_stop'), 'message_stop is sent on normal completion');
  });

  // BUG1 (negative): a [DONE]-terminated stream with no explicit finish_reason
  // is still a clean end — [DONE] is the authoritative terminator.
  it('treats a [DONE]-only terminator as a clean stream end', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'done text' }, finish_reason: null }] }));
            res.write('data: [DONE]\n\n');
            res.end();
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    assert.ok(!events.find(e => e.event === 'error' || e.data.type === 'error'), '[DONE] is a clean terminator, no error');
    assert.ok(events.some(e => e.event === 'message_stop'), 'message_stop sent after [DONE]');
  });

  // A1: message_start.usage must carry a non-zero local input estimate when the
  // request has input — official SDKs read input_tokens from message_start and
  // only accumulate output_tokens from message_delta, so an all-zero start made
  // the SDK's final input read 0. message_delta must then only add output_tokens
  // (input stays the authoritative upstream value) and never regress input to 0.
  it('prefills message_start.usage.input_tokens (>0) and lets message_delta carry authoritative usage (A1)', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'a reasonably long user prompt that should estimate to more than zero tokens' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            // Authoritative upstream usage lands with the terminal chunk.
            res.write(chatChunk({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);

    const start = events.find(e => e.event === 'message_start');
    assert.ok(start, 'message_start emitted');
    // S1: message_start must carry the top-level `container` field (null) to match
    // the non-stream response shape and official Anthropic message_start events.
    assert.equal(start.data.message.container, null, 'message_start.message.container is null (S1 shape alignment)');
    assert.ok('container' in start.data.message, 'container key present, not merely undefined');
    assert.ok(start.data.message.usage.input_tokens > 0, 'message_start.usage.input_tokens is a non-zero local estimate');
    assert.equal(start.data.message.usage.output_tokens, 0, 'message_start.usage.output_tokens starts at 0');

    // F6: a typed `event: ping` (data {"type":"ping"}) must follow message_start,
    // matching the canonical Anthropic event ordering.
    const startIdx = events.findIndex(e => e.event === 'message_start');
    const ping = events.find((e, i) => i > startIdx && e.event === 'ping');
    assert.ok(ping, 'a typed ping event is emitted after message_start');
    assert.equal(ping.data.type, 'ping', 'ping data payload is {"type":"ping"}');

    const delta = events.find(e => e.event === 'message_delta');
    assert.ok(delta, 'message_delta emitted');
    // The delta carries the AUTHORITATIVE upstream numbers (prompt 42 → input 42,
    // completion 7 → output 7), overriding the local start estimate.
    assert.equal(delta.data.usage.input_tokens, 42, 'message_delta.usage.input_tokens is the authoritative upstream value');
    assert.equal(delta.data.usage.output_tokens, 7, 'message_delta.usage.output_tokens is the accumulated output');
  });

  // A1 + cache: with a cache_control breakpoint and no upstream cache numbers,
  // the local prefix estimate should already be visible in message_start (not
  // only in the final delta), so SDKs budget cache from the very first event.
  it('prefills message_start.usage.cache_creation from the local cache policy estimate (A1)', async () => {
    // Prefix must clear the C2 minimum cacheable size (~1024 tokens) for the
    // estimate to be emitted rather than floored to 0.
    const cachedPrefix = 'system prompt cached prefix. '.repeat(160);
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      system: [{ type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hello there' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            // Upstream (free tier) reports NO usage at all.
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);

    const start = events.find(e => e.event === 'message_start');
    assert.ok(start.data.message.usage.cache_creation_input_tokens > 0, 'message_start prefills cache_creation from the local estimate');
    assert.equal(
      start.data.message.usage.cache_creation_input_tokens,
      start.data.message.usage.cache_creation.ephemeral_5m_input_tokens,
      'flat cache_creation equals the 5m bucket (default TTL) in message_start',
    );
  });

  // G2: when the upstream never sends a usage object, output_tokens falls back to
  // 0 (we can't invent one) while input_tokens still reflects the local estimate
  // rather than regressing to 0 — the delta stays consistent with message_start.
  it('falls back to the local input estimate (output_tokens 0) when upstream omits usage (A1/G2)', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'some prompt text with a handful of tokens' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'reply' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);

    const start = events.find(e => e.event === 'message_start');
    const delta = events.find(e => e.event === 'message_delta');
    assert.ok(start.data.message.usage.input_tokens > 0, 'message_start has a non-zero local input estimate');
    // No upstream usage → delta reuses the same local input estimate, output 0.
    assert.equal(delta.data.usage.input_tokens, start.data.message.usage.input_tokens, 'message_delta input matches the local start estimate (no regression to 0)');
    assert.equal(delta.data.usage.output_tokens, 0, 'output_tokens falls back to 0 when upstream omits usage (G2)');
  });

  // BUG3: when a text delta interleaves between a tool's arg fragments, the
  // tool_use block is closed (content_block_stop). Any later arg fragment for
  // that tool must NOT be emitted as input_json_delta against the now-closed
  // index — Anthropic requires input_json_delta inside the tool_use open window.
  it('never emits input_json_delta against a closed tool_use block when deltas interleave', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'read it' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            // Tool opens and gets a first arg fragment.
            res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path"' } }] }, finish_reason: null }] }));
            // A text delta interleaves → closes the tool_use block (block 0).
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'thinking out loud' }, finish_reason: null }] }));
            // A late arg fragment for the SAME tool arrives after its block closed.
            res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);

    // Map every content_block_stop index to the order it was stopped.
    const stoppedIndices = events
      .filter(e => e.event === 'content_block_stop')
      .map(e => e.data.index);
    // Every input_json_delta must target a block that is NOT yet stopped at the
    // moment it is emitted. Walk the event stream in order and track open blocks.
    const closed = new Set();
    for (const e of events) {
      if (e.event === 'content_block_stop') closed.add(e.data.index);
      if (e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta') {
        assert.ok(!closed.has(e.data.index), `input_json_delta sent to already-closed block ${e.data.index}`);
      }
    }
    // The tool_use block (index 0) was the first block; it must have been stopped.
    assert.ok(stoppedIndices.includes(0), 'tool_use block was stopped');
  });

  // Anthropic thinking-block sequence: content_block_start(thinking) →
  // thinking_delta* → signature_delta → content_block_stop. The proxy emits an
  // empty-string signature (upstream supplies none) but the event must exist and
  // land before the block's stop.
  it('emits exactly one signature_delta before content_block_stop for a streamed thinking block', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'let me think' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_content: ' more' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'the answer' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);

    // Find the thinking block's index from its content_block_start.
    const thinkingStart = events.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking');
    assert.ok(thinkingStart, 'a thinking content_block_start was emitted');
    const thinkingIdx = thinkingStart.data.index;

    const sigDeltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'signature_delta');
    assert.equal(sigDeltas.length, 1, 'exactly one signature_delta emitted');
    assert.equal(sigDeltas[0].data.index, thinkingIdx, 'signature_delta targets the thinking block');
    assert.equal(sigDeltas[0].data.delta.signature, '', 'empty-string placeholder signature');

    // Ordering: signature_delta must come AFTER all thinking_delta and BEFORE the
    // thinking block's content_block_stop.
    const order = events.map((e, i) => ({ i, e }));
    const sigPos = order.find(o => o.e.event === 'content_block_delta' && o.e.data.delta?.type === 'signature_delta').i;
    const stopPos = order.find(o => o.e.event === 'content_block_stop' && o.e.data.index === thinkingIdx).i;
    const lastThinkingDeltaPos = Math.max(...order
      .filter(o => o.e.event === 'content_block_delta' && o.e.data.delta?.type === 'thinking_delta' && o.e.data.index === thinkingIdx)
      .map(o => o.i));
    assert.ok(lastThinkingDeltaPos < sigPos, 'signature_delta comes after all thinking_delta');
    assert.ok(sigPos < stopPos, 'signature_delta comes before content_block_stop');
  });

  it('does not emit signature_delta for text or tool_use blocks', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'plain text' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path":"x"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const sigDeltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'signature_delta');
    assert.equal(sigDeltas.length, 0, 'no signature_delta for text/tool_use-only stream');
  });

  it('round-trips a real upstream reasoning_signature in the streamed signature_delta', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'think', reasoning_signature: 'sig-xyz' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const sigDeltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'signature_delta');
    assert.equal(sigDeltas.length, 1, 'one signature_delta');
    assert.equal(sigDeltas[0].data.delta.signature, 'sig-xyz', 'real upstream signature forwarded');
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

  // Batch 2 — multimodal / document input (GATE A2, A3, B2)

  async function captureBody(body) {
    let captured = null;
    await handleMessages(body, {
      async handleChatCompletions(b) {
        captured = b;
        return {
          status: 200,
          body: {
            model: b.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    return captured;
  }

  it('A3: normalizes a base64 image block into an OpenAI image_url data URI', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] }],
    });
    const userMsg = captured.messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content), 'content is a multipart array');
    const img = userMsg.content.find(p => p.type === 'image_url');
    assert.ok(img, 'an image_url part exists (not the raw Anthropic image block)');
    assert.equal(img.image_url.url, 'data:image/png;base64,AAAA');
    // The raw Anthropic {type:'image',source} shape must NOT survive.
    assert.ok(!userMsg.content.some(p => p.type === 'image'), 'no raw Anthropic image block leaks through');
  });

  it('A3: forwards a url image source as an OpenAI image_url', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
      ] }],
    });
    const userMsg = captured.messages.find(m => m.role === 'user');
    const img = userMsg.content.find(p => p.type === 'image_url');
    assert.ok(img, 'url image forwarded as image_url');
    assert.equal(img.image_url.url, 'https://example.com/x.png');
  });

  it('A2: extracts inline text from a text-source document block instead of dropping it', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'summarize' },
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'DOCUMENT_BODY_TEXT' } },
      ] }],
    });
    const userMsg = captured.messages.find(m => m.role === 'user');
    const text = typeof userMsg.content === 'string'
      ? userMsg.content
      : userMsg.content.map(p => p.text || '').join('\n');
    assert.match(text, /DOCUMENT_BODY_TEXT/, 'document text is not silently dropped');
  });

  it('A2: emits a text placeholder (not silence) for a base64 PDF document block', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [
        { type: 'document', title: 'report', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } },
      ] }],
    });
    const userMsg = captured.messages.find(m => m.role === 'user');
    const text = typeof userMsg.content === 'string'
      ? userMsg.content
      : (userMsg.content || []).map(p => p.text || '').join('\n');
    assert.match(text, /document: report/, 'undecoded PDF becomes a labeled placeholder, not empty');
  });

  it('B2: keeps an image sub-block in tool_result content as a placeholder, not empty', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Screenshot', input: {} },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [
            { type: 'text', text: 'here is the screen' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ] },
        ] },
      ],
    });
    const toolMsg = captured.messages.find(m => m.role === 'tool');
    assert.match(toolMsg.content, /here is the screen/, 'text sub-block preserved');
    assert.match(toolMsg.content, /\[image: image\/png\]/, 'image sub-block is not flattened to empty');
  });

  it('F1: passes top_k through to the converted chat body', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      top_k: 40,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(captured.top_k, 40, 'top_k reaches the chat handler (chat.js reads it off the converted body)');
  });

  it('F1: omits top_k when the request does not set it', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal('top_k' in captured, false, 'no top_k key when the caller sent none');
  });

  it('F2: maps tool_choice.disable_parallel_tool_use to parallel_tool_calls:false', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(captured.parallel_tool_calls, false, 'disable_parallel_tool_use maps to parallel_tool_calls:false');
  });

  it('F2: omits parallel_tool_calls when disable_parallel_tool_use is absent', async () => {
    const captured = await captureBody({
      model: 'claude-sonnet-4.6',
      tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal('parallel_tool_calls' in captured, false, 'no parallel_tool_calls key by default');
  });
});

describe('Anthropic response robustness (B3/B4/B5/F3)', () => {
  async function respond(upstreamBody, requestBody = {}) {
    return handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      ...requestBody,
    }, {
      async handleChatCompletions() {
        return { status: 200, body: upstreamBody };
      },
    });
  }

  it('B3: falls back to a generated toolu_ id when the upstream tool_call omits one', async () => {
    const result = await respond({
      model: 'claude-sonnet-4.6',
      choices: [{
        index: 0,
        message: { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'Read', arguments: '{"x":1}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    assert.equal(result.status, 200);
    const toolUse = result.body.content.find(c => c.type === 'tool_use');
    assert.ok(toolUse.id && toolUse.id.startsWith('toolu_'), `tool_use id should be a generated toolu_ id, got ${toolUse.id}`);
  });

  it('B4: keeps raw arguments and does not crash when tool_use JSON fails to parse', async () => {
    const result = await respond({
      model: 'claude-sonnet-4.6',
      choices: [{
        index: 0,
        message: { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"x":' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    assert.equal(result.status, 200);
    const toolUse = result.body.content.find(c => c.type === 'tool_use');
    assert.equal(toolUse.input.__raw_arguments, '{"x":', 'malformed args preserved under __raw_arguments instead of silently becoming {}');
  });

  it('B5: maps content_filter finish_reason to refusal', async () => {
    const result = await respond({
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'no' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    assert.equal(result.body.stop_reason, 'refusal', 'content_filter maps to refusal, not end_turn');
  });

  it('B5: back-fills stop_reason=stop_sequence and the matched stop_sequence (non-stream)', async () => {
    const result = await respond({
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello END' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { stop_sequences: ['END'] });
    assert.equal(result.body.stop_reason, 'stop_sequence', 'text ending with a stop sequence yields stop_sequence');
    assert.equal(result.body.stop_sequence, 'END', 'the matched sequence is echoed');
  });

  it('B5: leaves stop_reason=end_turn and stop_sequence=null on a plain finish', async () => {
    const result = await respond({
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { stop_sequences: ['END'] });
    assert.equal(result.body.stop_reason, 'end_turn');
    assert.equal(result.body.stop_sequence, null);
  });

  it('F3: non-stream response carries container:null and shaped usage fields', async () => {
    const result = await respond({
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    assert.equal(result.body.container, null, 'top-level container:null present');
    assert.deepEqual(result.body.usage.server_tool_use, { web_search_requests: 0 }, 'server_tool_use shape present');
    assert.equal(result.body.usage.service_tier, 'standard', 'service_tier default present');
  });

  it('B5 (stream): back-fills stop_sequence in the final message_delta', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      stop_sequences: ['STOP'],
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'answer then STOP' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const delta = events.find(e => e.event === 'message_delta');
    assert.equal(delta.data.delta.stop_reason, 'stop_sequence', 'streamed stop-sequence hit maps to stop_sequence');
    assert.equal(delta.data.delta.stop_sequence, 'STOP', 'matched sequence echoed in the stream');
  });

  it('B5 (stream): content_filter finish_reason maps to refusal in message_delta', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'no' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const delta = events.find(e => e.event === 'message_delta');
    assert.equal(delta.data.delta.stop_reason, 'refusal');
    assert.equal(delta.data.delta.stop_sequence, null);
  });

  it('B1: completes cleanly (no crash, still stops) when late tool-arg fragments arrive after the block closed', async () => {
    // A tool block opens + gets a first fragment, a text delta interleaves and
    // permanently closes it, then a late fragment for the SAME tool arrives. The
    // late fragment can no longer be emitted (its block is closed) — the stream
    // must still finish with a proper message_delta/message_stop, not throw.
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'read it' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path"' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'interleave' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const delta = events.find(e => e.event === 'message_delta');
    assert.ok(delta, 'stream still emits a final message_delta despite the dropped fragment');
    assert.equal(delta.data.delta.stop_reason, 'tool_use');
    assert.ok(events.some(e => e.event === 'message_stop'), 'stream ends with message_stop');
    // The late fragment for the closed block must never target a closed index.
    const closed = new Set();
    for (const e of events) {
      if (e.event === 'content_block_stop') closed.add(e.data.index);
      if (e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta') {
        assert.ok(!closed.has(e.data.index), `input_json_delta sent to closed block ${e.data.index}`);
      }
    }
  });
});

describe('Anthropic error mapping (valid error enum + correct retry status)', () => {
  it('maps internal error types to the Anthropic error enum', () => {
    // The critical one: CAPACITY (503 capacity_error) → 529 overloaded_error,
    // which Anthropic SDKs auto-retry with backoff (P0 #56/#57).
    const cap = toAnthropicError(503, 'capacity_error', 'high demand');
    assert.equal(cap.status, 529);
    assert.equal(cap.body.error.type, 'overloaded_error');
    assert.equal(cap.body.type, 'error');

    assert.equal(toAnthropicError(402, 'insufficient_quota').body.error.type, 'rate_limit_error');
    assert.equal(toAnthropicError(402, 'insufficient_quota').status, 429);
    assert.equal(toAnthropicError(402, 'model_blocked').body.error.type, 'permission_error');
    assert.equal(toAnthropicError(402, 'model_blocked').status, 403);
  });

  it('falls back on HTTP status for unnamed internal types', () => {
    assert.equal(toAnthropicError(400, 'some_validation').body.error.type, 'invalid_request_error');
    assert.equal(toAnthropicError(401, 'upstream_error').body.error.type, 'authentication_error');
    assert.equal(toAnthropicError(404, undefined).body.error.type, 'not_found_error');
    // D1: 413 body-too-large → request_too_large (dedicated official type).
    const e413 = toAnthropicError(413, undefined);
    assert.equal(e413.status, 413);
    assert.equal(e413.body.error.type, 'request_too_large');
    assert.equal(toAnthropicError(429, 'upstream_error').body.error.type, 'rate_limit_error');
    // 502/503 upstream-unavailable → overloaded_error (retryable), not a leaked type.
    const u502 = toAnthropicError(502, 'upstream_error');
    assert.equal(u502.status, 529);
    assert.equal(u502.body.error.type, 'overloaded_error');
    // D6: bare 402 (non-official status) → 429 rate_limit_error, not leaked.
    const e402 = toAnthropicError(402, undefined);
    assert.equal(e402.status, 429);
    assert.equal(e402.body.error.type, 'rate_limit_error');
    // D3: bare 504 (non-official status) → 529 overloaded_error, retryable.
    const e504 = toAnthropicError(504, undefined);
    assert.equal(e504.status, 529);
    assert.equal(e504.body.error.type, 'overloaded_error');
    // Unknown 5xx → api_error; unknown 4xx → invalid_request_error.
    assert.equal(toAnthropicError(500, 'weird').body.error.type, 'api_error');
    assert.equal(toAnthropicError(418, 'weird').body.error.type, 'invalid_request_error');
  });

  it('D3: internal timeout_error (504) remaps to a retryable 529 overloaded_error', () => {
    // chat.js connectErrorToHttp('TIMEOUT') → { status: 504, type: 'timeout_error' }.
    // 504 is not in the Anthropic status set; it must join the transient bucket.
    const t = toAnthropicError(504, 'timeout_error', 'upstream timed out');
    assert.equal(t.status, 529);
    assert.equal(t.body.error.type, 'overloaded_error');
    assert.equal(t.body.type, 'error');
  });

  it('D5: generalizes leaky internal detail but keeps clean upstream messages', () => {
    // A message carrying DEVIN_CONNECT / session-token internals must NOT reach
    // the client verbatim — it collapses to the generic per-type message.
    const leaky = toAnthropicError(401, 'upstream_error', 'all DEVIN_CONNECT accounts exhausted (dead session tokens)');
    assert.equal(leaky.body.error.type, 'authentication_error');
    assert.doesNotMatch(leaky.body.error.message, /DEVIN_CONNECT/i);
    assert.doesNotMatch(leaky.body.error.message, /session token/i);
    // A clean upstream message (no internal markers) passes through unchanged —
    // e.g. Anthropic's own capacity text.
    const clean = toAnthropicError(503, 'capacity_error', "We're currently facing high demand for this model. Please try again later.");
    assert.match(clean.body.error.message, /high demand/);
  });

  it('never leaks a proxy-specific error type to an Anthropic client (non-stream)', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return { status: 503, body: { error: { type: 'capacity_error', message: "We're currently facing high demand for this model. Please try again later." } } };
      },
    });
    assert.equal(result.status, 529, 'capacity surfaces as 529 so the SDK backs off');
    assert.equal(result.body.type, 'error');
    assert.equal(result.body.error.type, 'overloaded_error');
    assert.match(result.body.error.message, /high demand/);
  });

  it('D5: never leaks internal failover detail through handleMessages (non-stream)', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        // chat.js failover-exhausted body — carries provider/session internals.
        return { status: 401, body: { error: { type: 'authentication_error', message: 'all DEVIN_CONNECT accounts exhausted (dead session tokens)', code: 'UNAUTHORIZED' } } };
      },
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.type, 'authentication_error');
    assert.doesNotMatch(result.body.error.message, /DEVIN_CONNECT/i, 'internal provider name is not exposed');
    assert.doesNotMatch(result.body.error.message, /session token/i, 'session internals are not exposed');
  });

  it('maps a pre-stream error (handler returned non-stream) to the Anthropic enum', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        // Stream was requested but the handler short-circuited with an error.
        return { status: 402, body: { error: { type: 'model_blocked', message: 'paid entitlement required' } } };
      },
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.type, 'permission_error');
  });

  it('maps a mid-stream CAPACITY error frame to an overloaded_error event', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            // chat.js emits this exact mid-stream error shape via chatStreamError.
            res.write(chatChunk({ error: { message: 'high demand, try again later', type: 'upstream_error', code: 'CAPACITY' } }));
            res.end();
          },
        };
      },
    });
    assert.equal(result.status, 200, 'stream already opened with 200');
    const fr = fakeRes();
    await result.handler(fr);
    const events = parseAnthropicEvents(fr.body);
    const errEvent = events.find(e => e.event === 'error' || e.data.type === 'error');
    assert.ok(errEvent, 'an error event was emitted');
    assert.equal(errEvent.data.error.type, 'overloaded_error', 'CAPACITY code → overloaded_error, not a leaked type');
  });
});

describe('Anthropic count_tokens', () => {
  it('rejects an empty/missing messages array', () => {
    assert.equal(handleCountTokens({}).status, 400);
    assert.equal(handleCountTokens({ messages: [] }).status, 400);
    assert.equal(handleCountTokens({ messages: [] }).body.error.type, 'invalid_request_error');
  });

  it('returns a positive deterministic input_tokens estimate', () => {
    const r1 = handleCountTokens({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hello world' }] });
    assert.equal(r1.status, 200);
    assert.ok(r1.body.input_tokens >= 1);
    // Deterministic — same input, same estimate.
    const r2 = handleCountTokens({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hello world' }] });
    assert.equal(r1.body.input_tokens, r2.body.input_tokens);
  });

  it('counts system prompt, content blocks, and tool schemas', () => {
    const small = handleCountTokens({ messages: [{ role: 'user', content: 'hi' }] });
    const big = handleCountTokens({
      system: 'You are a careful assistant. '.repeat(20),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'analyze this'.repeat(50) }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'long query '.repeat(20) } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result '.repeat(40) }] },
      ],
      tools: [{ name: 'search', description: 'searches the web for things', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    });
    assert.ok(big.body.input_tokens > small.body.input_tokens, 'larger prompt yields more tokens');
  });

  it('applies a flat per-image estimate instead of base64 length', () => {
    const withImage = handleCountTokens({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100000) } },
      ] }],
    });
    // Image contributes ~1500 tokens (≈6000 chars / 4), NOT 100000/4 = 25000.
    assert.ok(withImage.body.input_tokens < 3000, 'image base64 length is not counted verbatim');
    assert.ok(withImage.body.input_tokens > 1000, 'image still contributes a meaningful estimate');
  });

  // A2: count_tokens must match the request-conversion 口径 for documents — a
  // text-source document is inlined as text there, so it is counted as its real
  // text tokens here (not a flat 1500 attachment estimate).
  it('counts a text-source document by its text, not a flat attachment estimate', () => {
    const docText = 'a'.repeat(400); // ~100 tokens by chars/4
    const r = handleCountTokens({
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: docText } },
      ] }],
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.input_tokens >= 90 && r.body.input_tokens <= 130, `text document ~chars/4 (~100), got ${r.body.input_tokens}`);
  });

  it('still uses the flat attachment estimate for a base64/PDF document', () => {
    const r = handleCountTokens({
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'A'.repeat(100000) } },
      ] }],
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.input_tokens > 1000 && r.body.input_tokens < 3000, `binary document is a flat estimate, got ${r.body.input_tokens}`);
  });

  // BUG2: CJK text was under-counted ~4× by the old flat chars/4 heuristic.
  it('estimates CJK text near 1 token/char, not chars/4', () => {
    const cjk = '你好世界这是一个测试用的中文句子需要正确估算上下文预算'; // 26 Han chars
    const charCount = [...cjk].length;
    const r = handleCountTokens({ messages: [{ role: 'user', content: cjk }] });
    assert.equal(r.status, 200);
    // chars/4 would be ~6-7; a correct CJK estimate is near the character count.
    assert.ok(r.body.input_tokens >= charCount * 0.8, `CJK estimate ${r.body.input_tokens} should be near char count ${charCount}, not chars/4`);
    assert.ok(r.body.input_tokens > Math.ceil(charCount / 4) * 3, 'CJK estimate is several times larger than the old chars/4 heuristic');
  });

  it('still estimates pure ASCII near chars/4', () => {
    const ascii = 'a'.repeat(400);
    const r = handleCountTokens({ messages: [{ role: 'user', content: ascii }] });
    assert.equal(r.status, 200);
    // 400 ASCII chars ≈ 100 tokens (chars/4). Allow a small band.
    assert.ok(r.body.input_tokens >= 90 && r.body.input_tokens <= 110, `ASCII estimate ${r.body.input_tokens} should be ~chars/4 (100)`);
  });

  it('is deterministic and handles mixed CJK + ASCII without crashing on surrogate pairs', () => {
    const mixed = 'Hello 世界 \u{20000}\u{2A6DF} world'; // includes astral-plane CJK (Ext B)
    const a = handleCountTokens({ messages: [{ role: 'user', content: mixed }] });
    const b = handleCountTokens({ messages: [{ role: 'user', content: mixed }] });
    assert.equal(a.body.input_tokens, b.body.input_tokens, 'deterministic for the same input');
    assert.ok(a.body.input_tokens >= 1);
  });
});
