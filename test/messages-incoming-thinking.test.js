// Thinking-core T2: incoming reasoning captured as continuity source.
// Single __-prefixed body carrier (__incomingThinking, same convention as
// __route); chat.js reads it as fallback continuity-store source.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages, openAIToAnthropic } from '../src/handlers/messages.js';

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

describe('T2: incoming thinking captured as continuity source', () => {
  it('captures the LAST assistant turn\u2019s thinking; history stays thinking-free', async () => {
    let capturedBody = null;
    let capturedContext = null;
    await handleMessages({
      model: 'swe-1-7',
      messages: [
        { role: 'user', content: 't1' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'first turn reasoning' },
          { type: 'text', text: 'a1' },
        ] },
        { role: 'user', content: 't2' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'last turn reasoning' },
          { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }] },
      ],
    }, {
      async handleChatCompletions(body, context) {
        capturedBody = body;
        capturedContext = context;
        return {
          status: 200,
          body: { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        };
      },
    });

    assert.equal(capturedBody.__incomingThinking, 'last turn reasoning', 'only the last assistant thinking is captured');
    assert.equal(capturedContext.incomingReasoning, undefined, 'single __-prefixed body path, no context duplicate');
    for (const m of capturedBody.messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        assert.equal(m.content.some(b => b.type === 'thinking'), false, 'thinking stays dropped on the wire');
      }
    }
  });

  it('redacted_thinking stays dropped and uncaptured', async () => {
    let capturedBody = null;
    let capturedContext = null;
    await handleMessages({
      model: 'swe-1-7',
      messages: [
        { role: 'user', content: 't1' },
        { role: 'assistant', content: [
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'a1' },
        ] },
      ],
    }, {
      async handleChatCompletions(body, context) {
        capturedBody = body;
        capturedContext = context;
        return { status: 200, body: { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
      },
    });
    assert.equal(capturedBody.__incomingThinking, undefined, 'redacted_thinking never feeds the store');
    assert.equal(capturedContext?.incomingReasoning, undefined);
  });
});
