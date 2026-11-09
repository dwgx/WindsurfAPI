// T07 — queued-byte budget in addition to the 64MB frame cap.
//
// The frame cap bounds payload bytes. It does not bound what the framer
// RETAINS while assembling a frame: every retained `data:` line is an array
// slot plus a string object, so a flood of one-byte lines stays far under the
// payload cap while holding hundreds of MB of JS objects, and one 40MB line is
// retained long before the frame is complete. The queued-byte budget charges a
// per-line overhead on top of the value bytes and fails typed
// (`SSE_QUEUE_OVERFLOW`) before RSS grows without bound:
//
//   * an oversized line trips at once;
//   * an event flood trips before the 64MB frame cap;
//   * a legitimate 5MB image event still fits;
//   * a failed or cancelled framer releases the queued bytes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_QUEUED_BYTES,
  SseFramer,
} from '../src/sse-framer.js';
import { createDeferredSseResponse } from '../src/sse-commit.js';

const MB = 1024 * 1024;

function collect(options = {}) {
  const frames = [];
  const state = { overflow: null };
  const framer = new SseFramer({
    ...options,
    onFrame: (f) => frames.push(f),
    onOverflow: (e) => { state.overflow = e; },
  });
  return { framer, frames, state };
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

describe('SseFramer queued-byte budget', () => {
  it('ships a budget below the frame cap', () => {
    assert.ok(DEFAULT_MAX_QUEUED_BYTES < DEFAULT_MAX_FRAME_BYTES);
  });

  it('fails an oversized 40MB line typed and releases what it retained', () => {
    const { framer, frames, state } = collect();
    framer.push('data: ' + 'a'.repeat(40 * MB) + '\n\n');
    assert.equal(framer.failed, true);
    assert.equal(state.overflow?.code, 'SSE_QUEUE_OVERFLOW');
    assert.equal(framer.bufferedBytes, 0, 'the line must not stay retained');
    assert.equal(framer.queuedBytes, 0, 'the queued budget must be released');
    assert.equal(frames.length, 1, 'the failure must reach the consumer as a typed frame');
    const body = JSON.parse(frames[0].data);
    assert.equal(body.error.code, 'SSE_QUEUE_OVERFLOW');
    assert.equal(body.error.type, 'api_error');
  });

  it('fails a flood of one-byte events before the 64MB frame cap', () => {
    const flood = 'data: a\n'.repeat(1_000_000);
    assert.ok(flood.length < DEFAULT_MAX_FRAME_BYTES,
      'the payload alone stays under the frame cap; only the queue budget catches this');
    const { framer, frames, state } = collect();
    framer.push(flood);
    assert.equal(framer.failed, true);
    assert.equal(state.overflow?.code, 'SSE_QUEUE_OVERFLOW');
    assert.equal(framer.queuedBytes, 0);
    assert.equal(framer.bufferedBytes, 0);
    assert.equal(frames.length, 1);
    assert.equal(JSON.parse(frames[0].data).error.code, 'SSE_QUEUE_OVERFLOW');
  });

  it('keeps a legitimate 5MB image event', () => {
    const { framer, frames, state } = collect();
    const value = 'a'.repeat(5 * MB);
    framer.push(`data: ${value}\n\n`);
    assert.equal(framer.failed, false);
    assert.equal(state.overflow, null);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data.length, 5 * MB);
  });

  it('still uses the frame cap as its own independent limit', () => {
    const { framer, state } = collect({ maxFrameBytes: 8, maxQueuedBytes: 1024 });
    framer.push('data: 1234567890\n\n');
    assert.equal(state.overflow?.code, 'SSE_FRAME_TOO_LARGE');
  });

  it('dispose releases a partially retained line', () => {
    const { framer } = collect();
    framer.push('data: ' + 'a'.repeat(1024));
    assert.ok(framer.bufferedBytes > 1024, 'the whole partial line, prefix included, is retained');
    assert.ok(framer.queuedBytes >= framer.bufferedBytes);
    framer.dispose();
    assert.equal(framer.bufferedBytes, 0);
    assert.equal(framer.queuedBytes, 0);
    framer.push('data: b\n\n');
    assert.equal(framer.bufferedBytes, 0, 'a disposed framer retains nothing');
  });
});

describe('deferred commit gate releases queued bytes on cancellation', () => {
  it('dispose drops a held bootstrap frame without writing it', () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { status: 200 });
    gate.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    assert.equal(real.body, '', 'the bootstrap frame is held, not written');
    assert.equal(gate.headersSent, false);

    gate.dispose();
    assert.equal(real.body, '', 'cancellation must not flush the held bytes');
    assert.equal(real.statusCode, null);
    assert.equal(gate.write('data: x\n\n'), false, 'a disposed gate accepts no more bytes');
    assert.equal(real.body, '');
  });
});
