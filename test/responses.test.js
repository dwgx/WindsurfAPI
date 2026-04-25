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
        { type: 'web_search_preview' },
      ],
    });
    assert.equal(out.messages.length, 1);
    assert.deepEqual(out.messages[0], { role: 'user', content: [{ type: 'text', text: 'Run it' }] });
    assert.deepEqual(out.tools, [
      { type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } } },
    ]);
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
    assert.equal(response.output[1].type, 'function_call');
    assert.equal(response.output[1].call_id, 'call_1');
    assert.equal(response.output[1].name, 'Bash');
    assert.equal(response.output[1].arguments, '{"command":"pwd"}');
  });
});

describe('handleResponses streaming', () => {
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
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assert.equal(events[3].data.delta, 'Hel');
    assert.equal(events[4].data.delta, 'lo');
    assert.equal(events[5].data.text, 'Hello');
    assert.equal(events.at(-1).data.status, 'completed');
    assert.deepEqual(events.at(-1).data.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
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
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assert.equal(events[1].data.item.type, 'function_call');
    assert.equal(events[4].data.arguments, '{"command":"pwd"}');
    assert.equal(events[5].data.item.call_id, 'call_1');
    assert.equal(events.at(-1).data.status, 'completed');
    assert.equal(events.at(-1).data.output[0].type, 'function_call');
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
    assert.deepEqual(events.map(e => e.event), ['response.created', 'error']);
    assert.equal(events[1].data.error.message, 'boom');
    assert.equal(res.writableEnded, true);
  });
});
