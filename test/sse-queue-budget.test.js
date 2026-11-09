// T07 — queued-byte budget in addition to the 64MB frame cap.
//
// The frame cap bounds payload bytes. It does not bound what the framer
// RETAINS while assembling a frame: every retained `data:` line is an array
// slot plus a string object, so a flood of one-byte lines stays far under the
// payload cap while holding hundreds of MB of JS objects. The queued-byte
// budget therefore charges ONLY the per-line overhead (the payload bytes are
// already bounded by the frame cap) and fails typed (`SSE_QUEUE_OVERFLOW`)
// before the object count grows without bound:
//
//   * a line over the 64MB frame cap trips 'frame', not 'queue';
//   * an event flood trips on the queue budget, which counts lines not bytes;
//   * a legitimate multi-megabyte image event fits — the queue budget must
//     NOT silently cap frames at its own (smaller) number;
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

  it('dispatches a single data line over the queue budget but under the frame cap', () => {
    // 40MB > 8MB queue budget, < 64MB frame cap. The queue budget bounds
    // retained OBJECT overhead (one array slot + one string here), not payload
    // bytes — payload is the frame cap's job. Charging value bytes into the
    // queue budget silently capped every frame at ~8MB and made the documented
    // 64MB frame cap unreachable.
    const { framer, frames, state } = collect();
    const value = 'a'.repeat(40 * MB);
    framer.push(`data: ${value}\n\n`);
    assert.equal(framer.failed, false);
    assert.equal(state.overflow, null);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data, value);
    // The retained payload is accounted on the frame budget; dispatch clears both.
    assert.equal(framer.bufferedBytes, 0);
    assert.equal(framer.queuedBytes, 0);
  });

  it('still trips the frame cap, not the queue cap, on a line over 64MB', () => {
    const { framer, frames, state } = collect();
    framer.push('data: ' + 'a'.repeat(65 * MB) + '\n\n');
    assert.equal(framer.failed, true);
    assert.equal(state.overflow?.code, 'SSE_FRAME_TOO_LARGE');
    assert.equal(framer.bufferedBytes, 0, 'the line must not stay retained');
    assert.equal(framer.queuedBytes, 0);
    // A frame-cap failure reports through onOverflow only; the typed error
    // frame is reserved for the queue budget's transport failure.
    assert.equal(frames.length, 0);
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
    // The queue budget charges per-segment overhead only; the retained payload
    // bytes are the frame budget's business, so the charge stays far below the
    // retained byte count here.
    assert.ok(framer.queuedBytes > 0, 'the retained segment is still charged to the queue budget');
    assert.ok(framer.queuedBytes < framer.bufferedBytes,
      'payload bytes are charged to the frame budget, not the queue budget');
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
