import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateRiskyReadToolResult, handleMessages } from '../src/handlers/messages.js';
import { applyJsonResponseHint, isExplicitJsonRequested } from '../src/handlers/chat.js';

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

  it('detects explicit JSON requests without response_format', () => {
    assert.equal(isExplicitJsonRequested([
      { role: 'user', content: 'Read package.json and answer only compact JSON with name and version.' },
    ]), true);
    assert.equal(isExplicitJsonRequested([
      { role: 'user', content: 'Tell me about JSON as a data format.' },
    ]), false);
  });

  it('adds JSON-only guidance for clients that ask for JSON in text', () => {
    const messages = applyJsonResponseHint([
      { role: 'user', content: 'Read package.json and answer only compact JSON with name and version.' },
    ]);

    assert.match(messages[0].content, /Respond with valid JSON only/);
    assert.match(messages.at(-1).content, /single parseable JSON object/);
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
});
