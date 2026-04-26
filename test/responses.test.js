import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleResponses, responsesToChat, chatToResponse } from '../src/handlers/responses.js';

function chatChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function parseEvents(raw) {
  return raw
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const lines = frame.split('\n');
      const event = lines.find(line => line.startsWith('event: '))?.slice(7);
      const data = JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}');
      return { event, data };
    });
}

function assertSequenceNumbers(events) {
  events.forEach((event, index) => {
    assert.equal(event.data.sequence_number, index);
  });
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

describe('responsesToChat', () => {
  it('maps string input and instructions to chat messages', () => {
    const out = responsesToChat({
      model: 'claude-sonnet-4.6',
      instructions: 'Be concise.',
      input: 'Hello',
      max_output_tokens: 123,
      reasoning: { effort: 'medium' },
    });
    assert.deepEqual(out.messages, [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ]);
    assert.equal(out.max_tokens, 123);
    assert.equal(out.reasoning_effort, 'medium');
  });

  it('maps message item arrays and function tools', () => {
    const out = responsesToChat({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run it' }] },
      ],
      tools: [
        { type: 'function', name: 'Bash', description: 'Run shell', parameters: { type: 'object' } },
      ],
    });
    assert.equal(out.messages.length, 1);
    assert.deepEqual(out.messages[0], { role: 'user', content: [{ type: 'text', text: 'Run it' }] });
    assert.deepEqual(out.tools, [
      { type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } }, __response_tool: { type: 'function', namespace: '', originalName: 'Bash' } },
    ]);
  });

  it('flattens namespace tools with a separator-safe encoded name', () => {
    const out = responsesToChat({
      tools: [
        {
          type: 'namespace',
          name: 'mcp__desktop_commander',
          tools: [
            { type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object' } },
          ],
        },
      ],
    });
    assert.equal(out.tools[0].function.name, 'mcp__desktop_commander__read_file');
    assert.deepEqual(out.tools[0].__response_tool, {
      type: 'namespace',
      namespace: 'mcp__desktop_commander',
      originalName: 'read_file',
    });
  });

  it('maps function_call and function_call_output items to chat tool turns', () => {
    const out = responsesToChat({
      input: [
        { type: 'message', role: 'user', content: 'List files' },
        { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'README.md' },
      ],
    });
    assert.equal(out.messages[1].role, 'assistant');
    assert.deepEqual(out.messages[1].tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
    ]);
    assert.deepEqual(out.messages[2], { role: 'tool', tool_call_id: 'call_1', content: 'README.md' });
  });
});

describe('chatToResponse', () => {
  it('maps a non-stream text chat completion to a Response object', () => {
    const response = chatToResponse({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.equal(response.id, 'resp_test');
    assert.equal(response.object, 'response');
    assert.equal(response.status, 'completed');
    assert.deepEqual(response.output[0], {
      type: 'message',
      id: 'msg_test',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hi', annotations: [] }],
    });
    assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  });

  it('maps chat tool_calls to function_call output items', () => {
    const response = chatToResponse({
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.equal(response.status, 'incomplete');
    assert.equal(response.output[0].type, 'function_call');
    assert.equal(response.output[0].call_id, 'call_1');
    assert.equal(response.output[0].name, 'Bash');
    assert.equal(response.output[0].arguments, '{"command":"pwd"}');
  });

  it('preserves flattened metadata for custom, web_search, and namespace tools', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Use native tools',
      tools: [
        { type: 'custom', name: 'runner', description: 'Run shell' },
        { type: 'web_search', description: 'Search the web' },
        {
          type: 'namespace',
          name: 'mcp__desktop_commander',
          tools: [
            { type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object' } },
          ],
        },
      ],
    }, {
      async handleChatCompletions(body) {
        assert.equal(body.tools[0].function.name, 'runner');
        assert.equal(body.tools[1].function.name, 'web_search');
        assert.equal(body.tools[2].function.name, 'mcp__desktop_commander__read_file');
        return {
          status: 200,
          body: {
            created: 123,
            model: body.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_custom', type: 'function', function: { name: 'runner', arguments: '{"input":"echo hi"}' } },
                  { id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"codex"}' } },
                  { id: 'call_ns', type: 'function', function: { name: 'mcp__desktop_commander__read_file', arguments: '{"path":"README.md"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          },
        };
      },
    });
    assert.equal(result.status, 200);
    const response = result.body;
    assert.equal(response.output[0].type, 'custom_tool_call');
    assert.equal(response.output[0].name, 'runner');
    assert.equal(response.output[0].input, 'echo hi');
    assert.equal(response.output[1].type, 'web_search_call');
    assert.equal(response.output[1].action.query, 'codex');
    assert.equal(response.output[2].type, 'function_call');
    assert.equal(response.output[2].name, 'read_file');
    assert.equal(response.output[2].namespace, 'mcp__desktop_commander');
  });

  it('maps non-stream reasoning_content to a reasoning output item', () => {
    const response = chatToResponse({
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'thinking', content: 'answer' }, finish_reason: 'stop' }],
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.equal(response.output[0].type, 'reasoning');
    assert.equal(response.output[0].summary[0].text, 'thinking');
    assert.equal(response.output[1].type, 'message');
  });

  it('omits empty assistant message items for function-call-only responses', () => {
    const response = chatToResponse({
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.deepEqual(response.output.map(item => item.type), ['function_call']);
  });
});

describe('handleResponses streaming', () => {
  it('rejects unsupported Responses-native tool types with a 400', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Hello',
      tools: [{ type: 'web_search_preview' }],
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.equal(result.body.error.message, 'Unsupported Responses tool type: web_search_preview');
  });

  it('emits the Responses text event sequence and response.completed', async () => {
    const result = await handleResponses({ model: 'claude-sonnet-4.6', input: 'Hello', stream: true }, {
      async handleChatCompletions(body) {
        assert.equal(body.stream, true);
        assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
            res.write('data: [DONE]\n\n');
            res.end();
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assertSequenceNumbers(events);
    assert.equal(events[0].data.response.status, 'in_progress');
    assert.equal(events[1].data.response.status, 'in_progress');
    assert.equal(events[4].data.delta, 'Hel');
    assert.equal(events[5].data.delta, 'lo');
    assert.equal(events[6].data.text, 'Hello');
    assert.equal(events.at(-1).data.response.status, 'completed');
    assert.deepEqual(events.at(-1).data.response.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  });

  it('emits function_call events before the message and still completes on tool_calls finish', async () => {
    const result = await handleResponses({ model: 'claude-sonnet-4.6', input: 'Use a tool', stream: true }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [], usage: { input_tokens: 4, completion_tokens: 1, total_tokens: 5 } }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assertSequenceNumbers(events);
    assert.equal(events[2].data.item.type, 'function_call');
    assert.equal(events[5].data.arguments, '{"command":"pwd"}');
    assert.equal(events[6].data.item.call_id, 'call_1');
    assert.equal(events.at(-1).data.response.status, 'completed');
    assert.equal(events.at(-1).data.response.output[0].type, 'function_call');
    assert.equal(events.at(-1).data.response.output.length, 1);
  });

  it('preserves Responses-native tool metadata in streaming output items', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Use native tools',
      stream: true,
      tools: [
        { type: 'custom', name: 'runner', description: 'Run shell' },
        { type: 'web_search', description: 'Search the web' },
        {
          type: 'namespace',
          name: 'mcp__desktop_commander',
          tools: [
            { type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object' } },
          ],
        },
      ],
    }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_custom', type: 'function', function: { name: 'runner', arguments: '{"input":"echo hi"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"codex"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 2, id: 'call_ns', type: 'function', function: { name: 'mcp__desktop_commander__read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    const doneItems = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item);
    assert.equal(doneItems[0].type, 'custom_tool_call');
    assert.equal(doneItems[0].name, 'runner');
    assert.equal(doneItems[0].input, 'echo hi');
    assert.equal(doneItems[1].type, 'web_search_call');
    assert.equal(doneItems[1].action.query, 'codex');
    assert.equal(doneItems[2].type, 'function_call');
    assert.equal(doneItems[2].name, 'read_file');
    assert.equal(doneItems[2].namespace, 'mcp__desktop_commander');
  });

  it('recovers Responses-native metadata when the streaming tool name arrives later', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Use native tools',
      stream: true,
      tools: [
        { type: 'custom', name: 'runner', description: 'Run shell' },
      ],
    }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_custom', type: 'function', function: { arguments: '{"input":"echo ' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'runner', arguments: 'hi"}' } }] }, finish_reason: null }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    const doneItem = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item)[0];
    assert.equal(doneItem.type, 'custom_tool_call');
    assert.equal(doneItem.name, 'runner');
    assert.equal(doneItem.input, 'echo hi');
  });

  it('emits error event and closes when the upstream stream throws', async () => {
    const result = await handleResponses({ input: 'Hello', stream: true }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler() {
            throw new Error('boom');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), ['response.created', 'response.in_progress', 'response.failed']);
    assertSequenceNumbers(events);
    assert.equal(events[2].data.response.error.message, 'boom');
    assert.equal(res.writableEnded, true);
  });

  it('translates chat reasoning_content deltas to Responses reasoning events', async () => {
    const result = await handleResponses({ model: 'claude-sonnet-4.6', input: 'Hello', stream: true }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { reasoning_content: 'plan' }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    assert.ok(events.some(e => e.event === 'response.reasoning_summary_text.delta' && e.data.delta === 'plan'));
    assert.equal(events.at(-1).data.response.output[0].type, 'reasoning');
  });
});
