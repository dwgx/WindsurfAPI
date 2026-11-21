import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleGemini } from '../src/handlers/gemini.js';
import { handleMessages } from '../src/handlers/messages.js';
import { ToolNamePrefixBuffer } from '../src/stream-tool-names.js';
import { handleResponses } from '../src/handlers/responses.js';

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; },
    setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const sseJson = (body) => body.split(/\r?\n\r?\n/).filter(Boolean)
  .map((f) => f.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
  .filter((data) => data && data.trim() !== '[DONE]')
  .map((data) => JSON.parse(data));

const SPLIT = [
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'foo' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: '_bar', arguments: '{}' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
];

function streamDeps(frames) {
  return {
    async handleChatCompletions() {
      return {
        status: 200, stream: true,
        async handler(res) { for (const f of frames) res.write(f); res.end(); },
      };
    },
  };
}

describe('streaming split function.name is settled before egress', () => {
  it('fails a held name explicitly when its following frames exceed the queue limit', () => {
    const output = [];
    const buffer = new ToolNamePrefixBuffer(['inspect', 'inspect_detail'], frame => output.push(frame), 15);
    buffer.write({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'inspect' } }] } }] }, 10);
    buffer.write({ choices: [{ delta: { content: 'later text' } }] }, 10);
    buffer.finish();
    assert.equal(output.length, 1);
    assert.match(output[0].error.message, /buffer limit/);
  });

  for (const api of ['messages', 'responses']) {
    it(`${api} terminates on a pending-name buffer overflow and discards later output`, async t => {
      const write = ToolNamePrefixBuffer.prototype.write;
      t.mock.method(ToolNamePrefixBuffer.prototype, 'write', function (frame, size) {
        this.limit = 1;
        return write.call(this, frame, size);
      });
      const frames = [
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'inspect' } }] } }] }),
        chunk({ choices: [{ delta: { content: 'after terminal failure' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n',
      ];
      const names = ['inspect', 'inspect_detail'];
      const result = api === 'messages'
        ? await handleMessages({ model: 'claude-sonnet-4.6', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'Inspect.' }],
          tools: names.map(name => ({ name, input_schema: { type: 'object' } })) }, streamDeps(frames))
        : await handleResponses({ model: 'gpt-5.2', stream: true, input: 'Inspect.',
          tools: names.map(name => ({ type: 'function', name, parameters: { type: 'object' } })) }, streamDeps(frames));
      const res = fakeRes();
      await result.handler(res);
      const events = sseJson(res.body);
      assert.equal(events.filter(e => e.type === (api === 'messages' ? 'error' : 'response.failed')).length, 1);
      assert.doesNotMatch(res.body, /response\.completed|after terminal failure/);
    });

    it(`${api} preserves tool, text, tool, text order for overlapping names`, async () => {
      const delta = value => chunk({ choices: [{ index: 0, delta: value }] });
      const call = (index, fn) => delta({ tool_calls: [{ index, id: 'call_' + index, type: 'function', function: fn }] });
      const frames = [
        call(0, { name: 'inspect', arguments: '{}' }), delta({ content: 'MID' }),
        call(1, { name: 'inspect' }), call(1, { name: '_detail', arguments: '{}' }), delta({ content: 'TAIL' }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n',
      ];
      const names = ['inspect', 'inspect_detail'];
      const deps = streamDeps(frames);
      const result = api === 'messages'
        ? await handleMessages({ model: 'claude-sonnet-4.6', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'Inspect.' }],
          tools: names.map(name => ({ name, input_schema: { type: 'object' } })) }, deps)
        : await handleResponses({ model: 'gpt-5.2', stream: true, input: 'Inspect.',
          tools: names.map(name => ({ type: 'function', name, parameters: { type: 'object' } })) }, deps);
      const res = fakeRes();
      await result.handler(res);
      const events = sseJson(res.body);
      if (api === 'messages') {
        const parts = events.flatMap(e => e.content_block?.type === 'tool_use' ? [e.content_block.name] : e.delta?.text ? [e.delta.text] : []);
        assert.deepEqual(parts, ['inspect', 'MID', 'inspect_detail', 'TAIL']);
      } else {
        assert.deepEqual(events.filter(e => e.type === 'response.output_item.added').map(e => e.output_index), [0, 1, 2, 3]);
        const response = events.find(e => e.type === 'response.completed').response;
        assert.deepEqual(response.output.map(i => i.name || i.content[0].text), ['inspect', 'MID', 'inspect_detail', 'TAIL']);
      }
    });

    for (const [expected, suffix] of [['inspect_detail', '_detail'], ['inspect', '']]) {
      it(`${api} publishes ${expected} once when a declared name is also a prefix`, async () => {
        const toolDelta = fn => chunk({ choices: [{ index: 0, delta: { tool_calls: [fn] } }] });
        const frames = [
          toolDelta({ index: 0, id: 'call_prefix', type: 'function', function: { name: 'inspect' } }),
          toolDelta({ index: 0, function: { arguments: '{"value":' } }),
          toolDelta({ index: 0, function: { name: suffix, arguments: '1}' } }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ];
        const names = ['inspect', 'inspect_detail'];
        const schema = { type: 'object', properties: { value: { type: 'integer' } } };
        const deps = streamDeps(frames);
        const result = api === 'messages'
          ? await handleMessages({ model: 'claude-sonnet-4.6', max_tokens: 32, stream: true,
            messages: [{ role: 'user', content: 'Inspect.' }], tools: names.map(name => ({ name, input_schema: schema })) }, deps)
          : await handleResponses({ model: 'gpt-5.2', stream: true, input: 'Inspect.',
            tools: names.map(name => ({ type: 'function', name, parameters: schema })) }, deps);
        const res = fakeRes();
        await result.handler(res);
        const events = sseJson(res.body);
        if (api === 'messages') {
          const blocks = events.filter(e => e.content_block?.type === 'tool_use');
          assert.deepEqual(blocks.map(e => e.content_block.name), [expected]);
          assert.equal(events.map(e => e.delta?.partial_json || '').join(''), '{"value":1}');
        } else {
          for (const kind of ['response.output_item.added', 'response.output_item.done']) {
            assert.deepEqual(events.filter(e => e.type === kind && e.item.type === 'function_call').map(e => e.item.name), [expected]);
          }
          assert.equal(events.find(e => e.type === 'response.function_call_arguments.done')?.arguments, '{"value":1}');
        }
      });
    }
  }

  it('Gemini functionCall carries the restored full name', async () => {
    const result = await handleGemini('m', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
      tools: [{ functionDeclarations: [{ name: 'foo.bar' }] }],
    }, streamDeps(SPLIT), { stream: true, alt: 'sse' });
    const res = fakeRes();
    await result.handler(res);
    const calls = sseJson(res.body)
      .flatMap((f) => f.candidates?.[0]?.content?.parts || [])
      .map((p) => p.functionCall)
      .filter(Boolean);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'foo.bar');
  });

  it('Responses output_item.added carries the restored full name', async () => {
    const result = await handleResponses({
      model: 'gpt-5.2', stream: true, input: 'hi',
      tools: [{ type: 'function', name: 'foo.bar', parameters: { type: 'object', properties: {} } }],
    }, { ...streamDeps(SPLIT), context: { callerKey: 'api:split:user:t' } });
    const res = fakeRes();
    await result.handler(res);
    const events = sseJson(res.body);
    const added = events.find((e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
    const done = events.find((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
    assert.equal(added?.item?.name, 'foo.bar');
    assert.equal(done?.item?.name, 'foo.bar');
  });


  it('keeps text after a split-name tool call in a later message item', async () => {
    const frames = [
      chunk({ choices: [{ index: 0, delta: { content: 'BEFORE ' } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'foo' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: '_bar', arguments: '{}' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { content: 'AFTER' } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const result = await handleResponses({
      model: 'gpt-5.2', stream: true, input: 'hi',
      tools: [{ type: 'function', name: 'foo.bar', parameters: { type: 'object', properties: {} } }],
    }, { ...streamDeps(frames), context: { callerKey: 'api:split-text:user:t' } });
    const res = fakeRes();
    await result.handler(res);
    const events = sseJson(res.body);
    const added = events.filter((e) => e.type === 'response.output_item.added').map((e) => e.item.type);
    assert.deepEqual(added, ['message', 'function_call', 'message']);
    const tool = events.find((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    assert.equal(tool.item.name, 'foo.bar');
    const done = events.filter((e) => e.type === 'response.output_item.done');
    assert.deepEqual(done.map((e) => e.output_index), [0, 1, 2]);
  });


  it('keeps a split custom tool name on a custom_tool_call item', async () => {
    const frames = [
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_custom', type: 'function', function: { name: 'run' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'ner', arguments: '{"input":"echo hi"}' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const result = await handleResponses({
      model: 'gpt-5.2', stream: true, input: 'hi',
      tools: [{ type: 'custom', name: 'runner', description: 'Run shell' }],
    }, { ...streamDeps(frames), context: { callerKey: 'api:split-custom:user:t' } });
    const res = fakeRes();
    await result.handler(res);
    const events = sseJson(res.body);
    const added = events.find((e) => e.type === 'response.output_item.added');
    const done = events.find((e) => e.type === 'response.output_item.done');
    assert.equal(added.item.type, 'custom_tool_call');
    assert.equal(added.item.name, 'runner');
    assert.equal(done.item.type, 'custom_tool_call');
    assert.equal(done.item.name, 'runner');
    assert.equal(done.item.input, 'echo hi');
  });

});
