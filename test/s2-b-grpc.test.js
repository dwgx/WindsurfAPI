import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loadGrpc, startStream, startUnary, grpcFrame } from './helpers/s2-b-grpc-harness.mjs';

const old = await loadGrpc({ before: true }), current = await loadGrpc();
// The framing-parity cases below compare the current reader against the frozen
// pre-optimization one; a terminal grpc-status is what makes both of them end
// the stream successfully, so it is part of the comparison fixture, not the
// assertion. Missing-status behaviour has its own arms further down.
function compare(chunks, trailer = { 'grpc-status': '0' }) {
  const a = startStream(old), b = startStream(current);
  try {
    for (const chunk of chunks) {
      a.req.emit('data', chunk); b.req.emit('data', chunk);
      assert.deepEqual(b.events, a.events); assert.deepEqual(b.payloads, a.payloads);
    }
    if (trailer) { a.req.emit('trailers', trailer); b.req.emit('trailers', trailer); }
    a.req.emit('end'); b.req.emit('end');
    assert.deepEqual(b.events, a.events); assert.deepEqual(b.closeCodes, a.closeCodes);
    return { events: b.events, payloads: b.payloads };
  } finally { a.cleanup(); b.cleanup(); }
}

test('S2-B gRPC: all split positions and one-byte chunks match the original', () => {
  const data = Buffer.concat([grpcFrame(Buffer.from('one')), grpcFrame(Buffer.alloc(0)), grpcFrame(Buffer.from('two'))]);
  for (let i = 0; i <= data.length; i++) compare([data.subarray(0, i), Buffer.alloc(0), data.subarray(i)]);
  compare(Array.from(data, (_, i) => data.subarray(i, i + 1)));
});

test('S2-B gRPC: unsupported compression is skipped, not newly decoded', () => {
  const data = Buffer.concat([grpcFrame(Buffer.from('ignored'), 1), grpcFrame(Buffer.from('also ignored'), 128), grpcFrame(Buffer.from('kept'))]);
  const result = compare([data]);
  assert.deepEqual(result.payloads.map(p => p.toString()), ['kept']);
});

test('S2-B gRPC: an absurd advertised length alone does not trigger the pending-byte cap', () => {
  const header = Buffer.alloc(5); header.writeUInt32BE(0xFFFFFFFF, 1);
  const result = compare([header]);
  assert.deepEqual(result.events, [['end']]);
});

test('S2-B gRPC: errors in trailers still follow any delivered payloads', () => {
  const result = compare([grpcFrame(Buffer.from('partial answer'))], { 'grpc-status': '13', 'grpc-message': 'bad%20request' });
  assert.deepEqual(result.events, [['data', 14], ['error', 'Error', 'bad request']]);
});

test('S2-B gRPC: incomplete frames do not concatenate or allocate payloads', () => {
  const data = grpcFrame(Buffer.alloc(65536, 5)), stream = startStream(current);
  const savedConcat = Buffer.concat, savedAlloc = Buffer.alloc;
  let concats = 0, allocations = 0, partial;
  Buffer.concat = function (...args) { concats++; return Reflect.apply(savedConcat, this, args); };
  Buffer.alloc = function (...args) { allocations++; return Reflect.apply(savedAlloc, this, args); };
  try {
    for (let pos = 0; pos < data.length - 1; pos += 1024) stream.req.emit('data', data.subarray(pos, Math.min(data.length - 1, pos + 1024)));
    partial = [concats, allocations, stream.payloads.length];
    stream.req.emit('data', data.subarray(data.length - 1));
  } finally {
    Buffer.concat = savedConcat; Buffer.alloc = savedAlloc; stream.cleanup();
  }
  assert.deepEqual(partial, [0, 0, 0]);
  assert.equal(concats, 0); assert.equal(allocations, 1);
  assert.deepEqual(stream.payloads, [data.subarray(5)]);
});

test('S2-B gRPC: partition fuzz preserves order and partial tails', () => {
  let seed = 0x53320002;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let round = 0; round < 32; round++) {
    const data = Buffer.concat(Array.from({ length: 12 }, (_, i) => grpcFrame(Buffer.alloc(random() % 65, i), i % 5 === 0 ? 1 : 0)));
    const chunks = [];
    for (let pos = 0; pos < data.length;) { const end = Math.min(data.length, pos + 1 + random() % 19); chunks.push(data.subarray(pos, end)); pos = end; }
    compare(chunks);
  }
});

const connectMessage = Buffer.from([0x0a, 0x02, 0x68, 0x69]);
const connectSuccessFrame = grpcFrame(Buffer.from('{}'), 2);

test('S2-B gRPC: Connect mode still parses gzip and end-stream frames', async () => {
  const before = await loadGrpc({ before: true, connect: true }), after = await loadGrpc({ connect: true });
  const a = startStream(before), b = startStream(after);
  const data = Buffer.concat([grpcFrame(gzipSync(connectMessage), 1), connectSuccessFrame]);
  try {
    for (let i = 0; i < data.length; i++) { a.req.emit('data', data.subarray(i, i + 1)); b.req.emit('data', data.subarray(i, i + 1)); }
    a.req.emit('end'); b.req.emit('end');
    assert.deepEqual(b.events, a.events); assert.deepEqual(b.payloads, a.payloads);
    assert.deepEqual(b.events, [['data', connectMessage.length], ['end']]);
    assert.deepEqual(b.payloads, [connectMessage]);
  } finally { a.cleanup(); b.cleanup(); }
});

// ─── Unary terminal truth (D7: audit G1/G2/G3/G4) ───────────
//
// Every arm below drives the real grpcUnary from src/grpc.js through the same
// stubbed session the stream arms use. "Control" means a legitimate response
// that must keep working; the gap arms must reject instead of resolving.

async function unary(module, steps, options = {}) {
  const call = startUnary(module, options);
  try {
    for (const [event, arg] of steps) call.req.emit(event, arg);
    return await call.settled;
  } finally { call.cleanup(); }
}

test('S2-B gRPC unary: a status-0 trailer resolves the message (control)', async () => {
  const grpc = await loadGrpc();
  const result = await unary(grpc, [
    ['response', { ':status': 200 }],
    ['data', grpcFrame(Buffer.from('answer'))],
    ['trailers', { 'grpc-status': '0' }],
    ['end'],
  ], { body: grpc.grpcFrame(Buffer.from('request')) });
  assert.equal(result.ok, true);
  assert.equal(result.payload.toString(), 'answer');
});

test('S2-B gRPC unary: a 200 response with no grpc-status is an error, not an empty success', async () => {
  const grpc = await loadGrpc();
  const result = await unary(grpc, [
    ['response', { ':status': 200 }],
    ['data', grpcFrame(Buffer.from('partial answer'))],
    ['end'],
  ], { body: grpc.grpcFrame(Buffer.from('request')) });
  assert.equal(result.ok, false, 'a response without a terminal status must never resolve');
  assert.equal(result.error.message, 'gRPC response ended without grpc-status');
});

test('S2-B gRPC unary: a Trailers-Only error status rejects with the decoded message', async () => {
  const grpc = await loadGrpc();
  const result = await unary(grpc, [
    ['response', { ':status': 200, 'grpc-status': '13', 'grpc-message': 'ls%20crashed' }],
    ['end'],
  ], { body: grpc.grpcFrame(Buffer.from('request')) });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'ls crashed');
});

test('S2-B gRPC unary: Connect HTTP 500 reports the upstream status, not a frame-size error', async () => {
  const grpc = await loadGrpc({ connect: true });
  const result = await unary(grpc, [
    ['response', { ':status': 500 }],
    ['data', Buffer.from('<html>upstream exploded</html>')],
    ['end'],
  ], { body: grpc.grpcFrame(Buffer.from('request')) });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'upstream HTTP 500');
  assert.doesNotMatch(result.error.message, /frame size/);
});

test('S2-B gRPC unary: a Connect trailer-only body resolves an empty message, never the envelope', async () => {
  const grpc = await loadGrpc({ connect: true });
  const envelope = grpcFrame(Buffer.from('{}'), 2);
  const result = await unary(grpc, [
    ['response', { ':status': 200 }],
    ['data', envelope],
    ['end'],
  ], { body: grpc.grpcFrame(Buffer.from('request')) });
  assert.equal(result.ok, true);
  assert.equal(result.payload.length, 0, 'the envelope bytes must never be returned as the message');
  assert.notDeepEqual([...result.payload], [...envelope]);
});

test('S2-B gRPC unary: a Connect error trailer rejects instead of resolving', async () => {
  const grpc = await loadGrpc({ connect: true });
  const trailer = grpcFrame(Buffer.from(JSON.stringify({ error: { code: 'unavailable', message: 'ls down' } })), 2);
  const result = await unary(grpc, [
    ['response', { ':status': 200 }],
    ['data', trailer],
    ['end'],
  ], { body: grpc.grpcFrame(Buffer.from('request')) });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'ls down');
});

test('S2-B gRPC unary: Connect sends application/proto and a bare message (control)', async () => {
  const grpc = await loadGrpc({ connect: true });
  const call = startUnary(grpc, { body: grpc.grpcFrame(Buffer.from('request')) });
  try {
    // grpcFrame() still envelopes (streaming RPCs need it); unary must unwrap.
    assert.equal(call.headers['content-type'], 'application/proto');
    assert.equal(call.headers['connect-protocol-version'], '1');
    assert.equal(call.headers['connect-accept-encoding'], undefined, 'unary RPCs do not negotiate connect framing compression');
    assert.deepEqual([...call.body], [...Buffer.from('request')]);
    call.req.emit('response', { ':status': 200 });
    call.req.emit('data', Buffer.from('answer'));
    call.req.emit('end');
    const result = await call.settled;
    assert.equal(result.ok, true);
    assert.equal(result.payload.toString(), 'answer', 'a bare protobuf response must be returned unchanged');
  } finally { call.cleanup(); }
});

test('S2-B gRPC unary: a bare protobuf Connect response is not parsed as frames (control)', async () => {
  const grpc = await loadGrpc({ connect: true });
  // 0x0a = field 1, wire type 2 — a legal protobuf prefix, and the first byte
  // that must NOT be mistaken for envelope flags.
  const message = Buffer.from([0x0a, 0x03, 0x61, 0x62, 0x63]);
  const result = await unary(grpc, [
    ['response', { ':status': 200 }],
    ['data', message],
    ['end'],
  ], { body: grpc.grpcFrame(Buffer.from('request')) });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.payload], [...message]);
});

test('S2-B gRPC stream: a status-0 trailer ends the stream (control)', () => {
  const stream = startStream(current);
  try {
    stream.req.emit('response', { ':status': 200 });
    stream.req.emit('data', grpcFrame(Buffer.from('chunk')));
    stream.req.emit('trailers', { 'grpc-status': '0' });
    stream.req.emit('end');
    assert.deepEqual(stream.events, [['data', 5], ['end']]);
  } finally { stream.cleanup(); }
});

test('S2-B gRPC stream: ending without grpc-status is an error, not an empty success', () => {
  const stream = startStream(current);
  try {
    stream.req.emit('response', { ':status': 200 });
    stream.req.emit('data', grpcFrame(Buffer.from('chunk')));
    stream.req.emit('end');
    assert.deepEqual(stream.events, [['data', 5], ['error', 'Error', 'gRPC response ended without grpc-status']]);
  } finally { stream.cleanup(); }
});

const connectDataFrame = grpcFrame(connectMessage);
const connectErrorFrame = grpcFrame(
  Buffer.from('{"error":{"code":"unavailable","message":"temporarily unavailable"}}'), 2,
);

for (const { name, body, payloads } of [
  { name: 'after data', body: connectDataFrame, payloads: [connectMessage] },
  { name: 'after headers alone', body: null, payloads: [] },
  {
    name: 'partway through the final envelope',
    body: Buffer.concat([connectDataFrame, connectSuccessFrame.subarray(0, -1)]),
    payloads: [connectMessage],
  },
  { name: 'with a zero-byte end payload', body: grpcFrame(Buffer.alloc(0), 2), payloads: [] },
]) {
  test(`S2-B Connect stream: EOF ${name} reports one interrupted stream`, async () => {
    const grpc = await loadGrpc({ connect: true });
    const stream = startStream(grpc);
    try {
      stream.req.emit('response', { ':status': 200, 'content-type': 'application/connect+proto' });
      if (body) stream.req.emit('data', body);
      stream.req.emit('end');
      stream.req.emit('error', new Error('late transport error'));
      assert.deepEqual(stream.payloads, payloads);
      assert.deepEqual(stream.events.map(([event]) => event), [...payloads.map(() => 'data'), 'error']);
      assert.match(stream.events.at(-1)[2], /EndStreamResponse/);
    } finally { stream.cleanup(); }
  });
}

test('S2-B Connect stream: a success envelope alone completes an empty stream', async () => {
  const grpc = await loadGrpc({ connect: true });
  const stream = startStream(grpc);
  try {
    stream.req.emit('response', { ':status': 200, 'content-type': 'application/connect+proto' });
    stream.req.emit('data', connectSuccessFrame);
    assert.deepEqual(stream.events, [], 'the terminal envelope must not be emitted as data');
    stream.req.emit('end');
    assert.deepEqual(stream.events, [['end']]);
  } finally { stream.cleanup(); }
});

test('S2-B Connect stream: an error envelope keeps the server error', async () => {
  const grpc = await loadGrpc({ connect: true });
  const stream = startStream(grpc);
  try {
    stream.req.emit('response', { ':status': 200, 'content-type': 'application/connect+proto' });
    stream.req.emit('data', connectErrorFrame);
    stream.req.emit('end');
    assert.deepEqual(stream.events, [['error', 'Error', 'temporarily unavailable']]);
  } finally { stream.cleanup(); }
});

for (const callbackThrows of [false, true]) {
  const callback = callbackThrows ? 'throws after abort' : 'aborts';
  test(`S2-B Connect stream: a data handler that ${callback} settles once`, async () => {
    const grpc = await loadGrpc({ connect: true });
    const controller = new AbortController();
    const stream = startStream(grpc, {
      signal: controller.signal,
      onData() {
        controller.abort();
        if (callbackThrows) throw new Error('consumer stopped');
      },
    });
    try {
      stream.req.emit('response', { ':status': 200, 'content-type': 'application/connect+proto' });
      stream.req.emit('data', Buffer.concat([connectDataFrame, connectDataFrame, connectErrorFrame]));
      stream.req.emit('end');
      assert.deepEqual(stream.payloads, [connectMessage]);
      assert.deepEqual(stream.events, [['data', connectMessage.length], ['error', 'Error', 'The operation was aborted']]);
      assert.deepEqual(stream.closeCodes, [8]);
    } finally { stream.cleanup(); }
  });
}

test('S2-B gRPC stream: Connect HTTP 500 fails at the headers, not in the frame reader', async () => {
  const grpc = await loadGrpc({ connect: true });
  const stream = startStream(grpc);
  try {
    stream.req.emit('response', { ':status': 502 });
    stream.req.emit('data', Buffer.from('<html>bad gateway</html>'));
    stream.req.emit('end');
    assert.deepEqual(stream.events, [['error', 'Error', 'upstream HTTP 502']]);
    assert.deepEqual(stream.closeCodes, [8], 'the error body must not be drained');
  } finally { stream.cleanup(); }
});
