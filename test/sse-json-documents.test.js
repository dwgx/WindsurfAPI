// T06 — concatenated JSON documents in one `data:` line.
//
// An upstream may put several complete JSON documents on one `data:` line
// instead of one document per frame:
//
//   data: {"choices":[{"delta":{"content":"a"}}]}{"choices":[{"delta":{"content":"b"}}]}
//
// `JSON.parse` rejects that payload as a whole. Before the repair, a consumer
// that dropped the frame finished the turn with ZERO content and a clean
// `stop` — the silent-empty failure. The contract pinned here:
//
//   * repair is per `data:` line, not per frame (a frame's data is the joined
//     value of its data lines);
//   * every document reaches `onFrame` on its own, so both deltas are emitted;
//   * an unrepairable JSON-looking payload becomes a typed
//     `SSE_MALFORMED_JSON` error frame/response, never a silent drop;
//   * `[DONE]` and plain-text data are not JSON frames and pass through.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SseFramer, parseSseDataJson, splitJsonDocuments } from '../src/sse-framer.js';
import { createDeferredSseResponse } from '../src/sse-commit.js';
import { handleMessages } from '../src/handlers/messages.js';

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (text) => ({ choices: [{ index: 0, delta: { content: text } }] });

function collect(options = {}) {
  const frames = [];
  const framer = new SseFramer({ ...options, onFrame: (f) => frames.push(f) });
  return { framer, frames };
}

function fakeRes() {
  return {
    body: '', writableEnded: false, statusCode: null, headers: null,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.body += String(c); this.writableEnded = true; },
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    flushHeaders() {},
    on() { return this; }, once() { return this; }, off() { return this; },
    setHeader() {}, getHeader() { return undefined; }, removeHeader() {},
  };
}

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

function eventsOf(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const event = block.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
    const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || data.trim() === '[DONE]') return { event, data: null };
    return { event, data: JSON.parse(data) };
  });
}

describe('splitJsonDocuments', () => {
  it('parses concatenated documents in one string', () => {
    assert.deepEqual(splitJsonDocuments('{"a":1}{"b":2}'), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(splitJsonDocuments('{"a":1} {"b":2}'), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(splitJsonDocuments('{"a":1}\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
  });

  it('does not invent a document from truncated or trailing garbage', () => {
    assert.deepEqual(splitJsonDocuments('{"a":1}'), [{ a: 1 }]);
    assert.equal(splitJsonDocuments('{"a":1}garbage'), null);
    assert.equal(splitJsonDocuments('{"a":'), null);
    assert.equal(splitJsonDocuments('[DONE]'), null);
  });

  it('keeps braces and quotes inside strings from ending the document early', () => {
    assert.deepEqual(
      splitJsonDocuments('{"s":"a}b\\"c"}{"t":2}'),
      [{ s: 'a}b"c' }, { t: 2 }],
    );
  });
});

describe('parseSseDataJson', () => {
  it('repairs two documents on one data line', () => {
    const parsed = parseSseDataJson('{"a":1}{"b":2}');
    assert.equal(parsed.malformed, false);
    assert.deepEqual(parsed.docs, [{ a: 1 }, { b: 2 }]);
  });

  it('repairs documents that arrive on separate data lines', () => {
    const parsed = parseSseDataJson('{"a":1}\n{"b":2}');
    assert.equal(parsed.malformed, false);
    assert.deepEqual(parsed.docs, [{ a: 1 }, { b: 2 }]);
  });

  it('flags a JSON-looking payload that cannot be repaired', () => {
    const parsed = parseSseDataJson('{"a":1}garbage');
    assert.equal(parsed.malformed, true);
    assert.equal(parsed.docs, null);
  });

  it('passes non-JSON payloads through untouched', () => {
    assert.deepEqual(parseSseDataJson('[DONE]'), { docs: null, malformed: false });
    assert.deepEqual(parseSseDataJson('plain text'), { docs: null, malformed: false });
    assert.deepEqual(parseSseDataJson(''), { docs: [], malformed: false });
  });
});

describe('SseFramer concatenated-document repair', () => {
  it('dispatches one frame per document, preserving both deltas', () => {
    const { framer, frames } = collect();
    framer.push('data: {"choices":[{"delta":{"content":"a"}}]}{"choices":[{"delta":{"content":"b"}}]}\n\n');
    framer.end();
    assert.equal(frames.length, 2);
    assert.equal(JSON.parse(frames[0].data).choices[0].delta.content, 'a');
    assert.equal(JSON.parse(frames[1].data).choices[0].delta.content, 'b');
  });

  it('keeps a single JSON frame byte-identical', () => {
    const { framer, frames } = collect();
    const body = frame(delta('hi'));
    framer.push(body);
    framer.end();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data, JSON.stringify(delta('hi')));
  });

  it('emits a typed SSE_MALFORMED_JSON frame instead of dropping the payload', () => {
    const { framer, frames } = collect();
    framer.push('data: {"choices":[{"delta":{"content":"a"}}]}garbage\n\n');
    framer.end();
    assert.equal(frames.length, 1, 'the turn must not finish with zero frames');
    const body = JSON.parse(frames[0].data);
    assert.equal(body.error.code, 'SSE_MALFORMED_JSON');
    assert.equal(body.error.type, 'api_error');
    assert.equal(framer.failed, false, 'repair failure is an emitted error, not a framer overflow');
  });

  it('emits a typed error for a truncated/unclosed JSON object', () => {
    const { framer, frames } = collect();
    framer.push('data: {"choices":[{"delta":{"content":"a"}}\n\n');
    framer.end();
    assert.equal(frames.length, 1);
    assert.equal(JSON.parse(frames[0].data).error.code, 'SSE_MALFORMED_JSON');
  });

  it('does not mistake a brace inside a string for a document boundary', () => {
    const { framer, frames } = collect();
    framer.push('data: {"choices":[{"delta":{"content":"a}{b"}}]}\n\n');
    framer.end();
    assert.equal(frames.length, 1);
    assert.equal(JSON.parse(frames[0].data).choices[0].delta.content, 'a}{b');
  });

  it('still passes [DONE] through as one untouched frame', () => {
    const { framer, frames } = collect();
    framer.push('data: [DONE]\n\n');
    framer.end();
    assert.deepEqual(frames, [{ event: null, data: '[DONE]' }]);
  });

  it('delivers both deltas to the Messages translator (client sees "ab")', async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}{"choices":[{"index":0,"delta":{"content":"b"}}]}\n\n',
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ];
    const result = await handleMessages({
      model: 'claude-haiku-5-5-low', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, streamDeps(frames));
    const res = fakeRes();
    await result.handler(res);
    const text = eventsOf(res.body)
      .filter((e) => e.data?.delta?.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('');
    assert.equal(text, 'ab');
  });
});

describe('deferred commit gate concatenated-document handling', () => {
  it('maps a concatenated pre-content error document to its real status', () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { status: 200 });
    gate.write('data: {"choices":[{"delta":{"content":"x"}}]}{"error":{"message":"busy","code":"RATE_LIMITED","retry_after_ms":2500}}\n\n');
    gate.end();
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], '30');
    assert.equal(JSON.parse(real.body).error.code, 'RATE_LIMITED');
  });

  it('commits a concatenated content frame and forwards it byte-identically', () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const body = 'data: {"choices":[{"delta":{"content":"a"}}]}{"choices":[{"delta":{"content":"b"}}]}\n\n';
    gate.write(body);
    gate.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, body);
  });

  it('treats a frame as bootstrap only when every document is bootstrap', () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { status: 200 });
    gate.write('data: {"choices":[{"delta":{"role":"assistant"}}]}{"choices":[{"delta":{"content":"real"}}]}\n\n');
    assert.equal(gate.headersSent, true, 'a content document must commit the gate');
    gate.end();
    assert.equal(real.statusCode, 200);
  });

  it('fails a pre-content unrepairable payload with a typed 502', () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { status: 200 });
    gate.write('data: {"choices":[{"delta":{"content":"a"}}]}garbage\n\n');
    gate.end();
    assert.equal(real.statusCode, 502);
    assert.match(real.headers['content-type'], /^application\/json/);
    const body = JSON.parse(real.body);
    assert.equal(body.error.code, 'SSE_MALFORMED_JSON');
    assert.equal(real.body.includes('data:'), false, 'no SSE bytes were committed');
  });
});
